import { useCallback, useRef } from 'react';
import { SongProject, TrackChannel } from '../types/project';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';
import { audioEngine } from '../audio/audioEngine';
import {
  isOpfsSupported,
  isProjectPcmComplete,
} from '../storage/opfsStorage';
import {
  loadProjectStemsFromDb,
  saveProjectToDb,
  requestProjectSourceAccess,
  StoredAudioStem,
} from '../storage/projectDb';
import { pruneOpfsCache } from '../storage/cachePolicy';
import {
  optimizeProjectForStreaming,
  PcmOptimizationProgress,
} from '../storage/pcmOptimizer';

interface UseOptimizationDeps {
  isDesktopApp: boolean;
  showToast: (msg: string) => void;
  projectsRef: React.MutableRefObject<SongProject[]>;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  activateProjectRef: React.MutableRefObject<(p: SongProject) => void>;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  setIsGeneratingNativeCache: React.Dispatch<React.SetStateAction<boolean>>;
  setNativeCacheProgress: React.Dispatch<React.SetStateAction<{ percent: number; text: string }>>;
  setMissingNativeCache: React.Dispatch<React.SetStateAction<boolean>>;
  setOptimizingProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  setOptimizationProgress: React.Dispatch<React.SetStateAction<PcmOptimizationProgress | null>>;
  setPreparingIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setImportStatusText: React.Dispatch<React.SetStateAction<string | null>>;
  runAutoOptimizeRef: React.MutableRefObject<(projectId: string) => void>;
  applyPruneRef: React.MutableRefObject<() => void>;
  queuedOptimizeIdsRef: React.MutableRefObject<Set<string>>;
  modalProjectIdRef: React.MutableRefObject<string | null>;
}

export function useOptimization({
  isDesktopApp,
  showToast,
  projectsRef,
  currentProjectRef,
  activateProjectRef,
  setProjects,
  setCurrentProject,
  setIsGeneratingNativeCache,
  setNativeCacheProgress,
  setMissingNativeCache,
  setOptimizingProject,
  setOptimizationProgress,
  setPreparingIds,
  setImportStatusText,
  runAutoOptimizeRef,
  applyPruneRef,
  queuedOptimizeIdsRef,
  modalProjectIdRef,
}: UseOptimizationDeps) {
  const autoAbortRef = useRef<Map<string, AbortController>>(new Map());
  const optimizationAbortControllerRef = useRef<AbortController | null>(null);
  const autoOptimizeChainRef = useRef<Promise<void>>(Promise.resolve());
  const accessPromisesRef = useRef<Map<string, Promise<void>>>(new Map());

  // The manual "Optimizar" button and the automatic background cache are ONE job:
  // pressing the button while the song is already being prepared just shows its progress.
  const handleStartOptimizeProject = useCallback(
    (projectToOptimize: SongProject) => {
      if (isDesktopApp) {
        setIsGeneratingNativeCache(true);
        setNativeCacheProgress({ percent: 5, text: 'Iniciando verificación...' });
        nativeAudioEngine
          .generateNativeCacheForProject(projectToOptimize, (percent, text) => {
            setNativeCacheProgress({ percent, text });
          })
          .then(async (ok) => {
            if (ok) {
              if (currentProjectRef.current?.id === projectToOptimize.id) {
                setMissingNativeCache(false);
                await nativeAudioEngine.loadProject(projectToOptimize);
              }
              showToast(`Caché nativa lista para "${projectToOptimize.title}".`);
            } else {
              showToast(`No se pudo generar la caché nativa para "${projectToOptimize.title}".`);
            }
          })
          .catch((err: any) => {
            showToast(`Error al generar caché nativa: ${err?.message || err}`);
          })
          .finally(() => {
            setIsGeneratingNativeCache(false);
          });
        return;
      }

      modalProjectIdRef.current = projectToOptimize.id;
      setOptimizingProject(projectToOptimize);
      setOptimizationProgress({
        currentTrackIndex: 0,
        totalTracks: projectToOptimize.tracks.length,
        trackName: queuedOptimizeIdsRef.current.has(projectToOptimize.id)
          ? 'Ya se está preparando en segundo plano…'
          : 'En cola…',
        percent: 0,
        phase: 'checking',
      });
      runAutoOptimizeRef.current(projectToOptimize.id);
    },
    [isDesktopApp, showToast]
  );

  const handleCancelOptimization = useCallback(() => {
    const id = modalProjectIdRef.current;
    if (id) autoAbortRef.current.get(id)?.abort();
    optimizationAbortControllerRef.current?.abort();
  }, []);

  const applyPrune = useCallback(async () => {
    try {
      const result = await pruneOpfsCache(
        projectsRef.current,
        currentProjectRef.current ? [currentProjectRef.current.id] : []
      );
      if (result.prunedIds.length === 0) return;
      const pruned = new Set(result.prunedIds);
      const strip = (p: SongProject): SongProject =>
        pruned.has(p.id)
          ? { ...p, tracks: p.tracks.map(({ pcm: _pcm, ...rest }: TrackChannel) => rest) }
          : p;
      setProjects((prev: SongProject[]) => prev.map(strip));
      showToast(
        `Caché liberada: ${result.prunedIds.length} canción(es) fuera del setlist (${(result.freedBytes / 1048576).toFixed(0)} MB). Siguen en la biblioteca.`
      );
    } catch (err) {
      console.warn('[CachePolicy] Error limpiando caché OPFS:', err);
    }
  }, [showToast]);

  // Copies a song's audio into OPFS once (sequential queue, silent, in the background)
  const runAutoOptimize = useCallback(
    (projectId: string) => {
      if (isDesktopApp || !isOpfsSupported()) return;
      if (queuedOptimizeIdsRef.current.has(projectId)) return;
      queuedOptimizeIdsRef.current.add(projectId);
      setPreparingIds(new Set(queuedOptimizeIdsRef.current));
      const controller = new AbortController();
      autoAbortRef.current.set(projectId, controller);

      autoOptimizeChainRef.current = autoOptimizeChainRef.current.then(async () => {
        try {
          if (controller.signal.aborted) {
            throw new DOMException('cancelado', 'AbortError');
          }
          const proj = projectsRef.current.find((p: SongProject) => p.id === projectId);
          if (!proj || proj.tracks.length === 0) return;
          if (await isProjectPcmComplete(proj)) return;

          const stems: StoredAudioStem[] = await loadProjectStemsFromDb(projectId);
          if (!stems.some((s: StoredAudioStem) => !s.unavailable)) {
            showToast(
              `"${proj.title}": no se pudo leer el audio original. Usa "Reubicar archivos" en la Biblioteca.`
            );
            return;
          }

          const patchTrack = (
            p: SongProject,
            trackId: string,
            info: { peaks: number[]; durationSec: number }
          ): SongProject =>
            p.id !== projectId
              ? p
              : {
                  ...p,
                  tracks: p.tracks.map((t: TrackChannel) =>
                    t.id === trackId ? { ...t, peaks: info.peaks, durationSec: info.durationSec } : t
                  ),
                };

          const updated = await optimizeProjectForStreaming(
            proj,
            (progress: PcmOptimizationProgress) => {
              setImportStatusText(
                `Preparando "${proj.title}": ${progress.percent}% (pista ${progress.currentTrackIndex}/${progress.totalTracks})`
              );
              if (modalProjectIdRef.current === projectId) setOptimizationProgress(progress);
            },
            controller.signal,
            {
              onlyMissing: true,
              onTrackDone: (trackId: string, info: { peaks: number[]; durationSec: number }) => {
                setProjects((prev: SongProject[]) => prev.map((p) => patchTrack(p, trackId, info)));
                setCurrentProject((prev: SongProject | null) => (prev ? patchTrack(prev, trackId, info) : prev));
              },
            }
          );

          // Merge pcm + peaks + exact duration into the latest project state (keeps edits made meanwhile)
          const latest = projectsRef.current.find((p: SongProject) => p.id === projectId) || updated;
          const byId = new Map(updated.tracks.map((t: TrackChannel) => [t.id, t]));
          const maxDur = Math.max(0, ...updated.tracks.map((t: TrackChannel) => t.durationSec || 0));
          const secPerBar = (60 / (latest.bpm || 120)) * (latest.beatsPerBar || 4);
          const merged: SongProject = {
            ...latest,
            durationSec: maxDur > 1 ? maxDur : latest.durationSec,
            totalBars: maxDur > 1 ? Math.max(4, Math.ceil(maxDur / secPerBar)) : latest.totalBars,
            tracks: latest.tracks.map((t: TrackChannel) => {
              const u = byId.get(t.id);
              return u?.pcm
                ? { ...t, pcm: u.pcm, peaks: u.peaks, durationSec: u.durationSec }
                : t;
            }),
          };
          audioEngine.clearProjectFallback(projectId);
          setProjects((prev: SongProject[]) => prev.map((p) => (p.id === projectId ? merged : p)));
          saveProjectToDb(merged).catch(() => {});

          if (!(await isProjectPcmComplete(merged))) {
            showToast(
              `"${merged.title}": algunas pistas no se pudieron convertir. Revisa que los archivos originales existan (Biblioteca → Reubicar archivos).`
            );
          } else {
            showToast(`"${merged.title}" lista para tocar`);
          }

          // The song is mounted in the console as an empty shell: load it from the new cache
          if (currentProjectRef.current?.id === projectId) {
            if (!audioEngine.hasPlayableAudio()) {
              activateProjectRef.current(merged);
            } else {
              setCurrentProject(merged);
            }
          }
          applyPruneRef.current();
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') {
            showToast('Preparación cancelada. Puedes reanudarla con "Optimizar para streaming".');
          } else {
            console.error('[AutoOptimize] Falló la copia a OPFS:', err);
            showToast(
              `No se pudo preparar la canción: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        } finally {
          queuedOptimizeIdsRef.current.delete(projectId);
          setPreparingIds(new Set(queuedOptimizeIdsRef.current));
          autoAbortRef.current.delete(projectId);
          setImportStatusText(null);
          if (modalProjectIdRef.current === projectId) {
            modalProjectIdRef.current = null;
            setOptimizingProject(null);
            setOptimizationProgress(null);
          }
        }
      });
    },
    [showToast]
  );

  // Makes the original files of a song readable (one permission prompt per folder); de-duplicated
  const ensureSourceAccess = useCallback(
    (projectId: string): Promise<void> => {
      const existing = accessPromisesRef.current.get(projectId);
      if (existing) return existing;
      const task = (async () => {
        try {
          const res = await requestProjectSourceAccess(projectId);
          if (res.total === 0) return;
          if (res.missing.length > 0) {
            showToast(
              `No se encuentran ${res.missing.length} archivo(s) originales. Usa "Reubicar archivos" en la Biblioteca.`
            );
          } else if (res.denied.length > 0) {
            showToast('Falta permiso para leer la carpeta original de esta canción.');
          }
        } catch (err) {
          console.warn('[SourceAccess] Error solicitando acceso:', err);
        } finally {
          accessPromisesRef.current.delete(projectId);
        }
      })();
      accessPromisesRef.current.set(projectId, task);
      return task;
    },
    [showToast]
  );

  return {
    handleStartOptimizeProject,
    handleCancelOptimization,
    applyPrune,
    runAutoOptimize,
    ensureSourceAccess,
  };
}
