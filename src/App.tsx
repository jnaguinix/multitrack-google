/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Music, FolderOpen, AlertTriangle } from 'lucide-react';
import { audioEngine } from './audio/audioEngine';
import { nativeAudioEngine } from './audio/nativeAudioEngine';
import { inferSongMetadataFromFiles } from './audio/smartAnalyzer';
import {
  createEmptyProjectTemplate,
  deleteProjectFromDb,
  findSavedProjectPreset,
  loadAllProjectsFromDb,
  loadProjectStemsFromDb,
  mergeSavedProjectMetadata,
  registerProjectDirHandle,
  relinkProjectSources,
  requestProjectSourceAccess,
  normalizeProjectSectionsToTime,
  saveProjectToDb,
  saveStemsBatchToDb,
  StoredAudioStem,
  syncProjectSidecarNow,
} from './storage/projectDb';
import {
  AudioEngineMode,
  MetersSnapshot,
  OutputBus,
  QuantizeMode,
  RemoteSyncMessage,
  SetlistTransitionMode,
  SongProject,
  SongSection,
  TrackChannel,
  TransportState,
} from './types/project';
import { TopBar, WorkspaceView } from './components/TopBar';
import { formatTimecode, TransportDeck } from './components/TransportDeck';
import { RepertoireTreeSidebar } from './components/RepertoireTreeSidebar';
import { SetlistPageView } from './components/SetlistPageView';
import { LiveSetView } from './components/LiveSetView';
import { TimelineArranger } from './components/TimelineArranger';
import { MultitrackMixer } from './components/MultitrackMixer';
import { StageRemoteView } from './components/StageRemoteView';
import {
  cleanOrphanPcmDirectories,
  ensureStoragePersist,
  isOpfsSupported,
  isProjectPcmComplete,
} from './storage/opfsStorage';
import { pruneOpfsCache } from './storage/cachePolicy';
import {
  extractAudioFilesWithHandlesFromDataTransfer,
  getRegisteredHandle,
  isFsAccessSupported,
} from './storage/sourceFiles';
import {
  optimizeProjectForStreaming,
  PcmOptimizationProgress,
} from './storage/pcmOptimizer';
import {
  extractAudioFilesFromDataTransfer,
  extractAudioFilesFromFileList,
  extractSidecarFromFileList,
  parseWavHeaderFast,
} from './utils/fileImportHelper';
import {
  ConfirmSongActionModal,
  inferTrackRoleAndColor,
  LibraryView,
  OptimizationProgressModal,
  SectionEditorModal,
  StemImporterModal,
} from './components/LibraryAndModals';

const DesktopRemoteBridge = import.meta.env.VITE_LIBRETRACKS_DESKTOP === '1'
  ? React.lazy(() => import('../desktop/frontend/RemoteConnectionBridge'))
  : null;

const DesktopAudioSettings = import.meta.env.VITE_LIBRETRACKS_DESKTOP === '1'
  ? React.lazy(() => import('../desktop/frontend/DesktopAudioSettings'))
  : null;

const INITIAL_TRANSPORT: TransportState = {
  isPlaying: false,
  currentTimeSec: 0,
  totalDurationSec: 0,
  currentBar: 1,
  currentBeat: 1,
  beatProgress: 0,
  activeSectionId: null,
  queuedSectionId: null,
  queuedTargetBar: null,
  countdownBeats: 0,
  isVamping: false,
  lastCueMessage: null,
  isMountingSong: false,
  mountingProgressText: null,
};

function getInitialViewFromHash(): WorkspaceView {
  const hash = window.location.hash.replace('#', '').toLowerCase();
  if (
    hash === 'setlist' ||
    hash === 'live' ||
    hash === 'arranger' ||
    hash === 'mixer' ||
    hash === 'remote' ||
    hash === 'library'
  ) {
    return hash;
  }
  return 'setlist';
}

const MARKER_PALETTE = [
  '#06B6D4',
  '#3B82F6',
  '#10B981',
  '#F59E0B',
  '#8B5CF6',
  '#EC4899',
  '#EF4444',
];

export default function App() {
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  const [activeView, setActiveView] = useState<WorkspaceView>(getInitialViewFromHash);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < 1280
  );
  useEffect(() => {
    const narrowWorkspace = window.matchMedia('(max-width: 720px)');
    const collapseOnNarrowWorkspace = (event: MediaQueryListEvent) => {
      if (event.matches) setIsSidebarCollapsed(true);
    };
    narrowWorkspace.addEventListener('change', collapseOnNarrowWorkspace);
    return () => narrowWorkspace.removeEventListener('change', collapseOnNarrowWorkspace);
  }, []);
  const [isDockedMixerOpen, setIsDockedMixerOpen] = useState<boolean>(false);
  const [projects, setProjects] = useState<SongProject[]>([]);
  const [currentProject, setCurrentProject] = useState<SongProject | null>(null);
  const [remoteTriggerHost, setRemoteTriggerHost] = useState<HTMLSpanElement | null>(null);
  const [audioTriggerHost, setAudioTriggerHost] = useState<HTMLSpanElement | null>(null);
  const [transport, setTransport] = useState<TransportState>(INITIAL_TRANSPORT);
  const [ramCacheVersion, setRamCacheVersion] = useState<number>(0);
  const [engineMode, setEngineModeState] = useState<AudioEngineMode>(() =>
    audioEngine.getEngineMode()
  );
  const [ramBudgetMB, setRamBudgetMBState] = useState<number>(() =>
    audioEngine.getRamBudgetMB()
  );
  // Default transition mode is 'cue-next' (mounts at 00:00 in pause) so songs never start playing on their own unexpectedly
  const [setlistTransitionMode, setSetlistTransitionMode] =
    useState<SetlistTransitionMode>('cue-next');
  const [confirmSongCandidate, setConfirmSongCandidate] = useState<SongProject | null>(
    null
  );
  const [optimizingProject, setOptimizingProject] = useState<SongProject | null>(null);
  const [optimizationProgress, setOptimizationProgress] =
    useState<PcmOptimizationProgress | null>(null);
  const optimizationAbortControllerRef = useRef<AbortController | null>(null);
  // Counts in-flight activateProject() calls so next-song preload waits for the active song to finish decoding
  const activationCountRef = useRef(0);
  const runAutoOptimizeRef = useRef<(projectId: string) => void>(() => {});
  const applyPruneRef = useRef<() => void>(() => {});
  const activateProjectRef = useRef<(p: SongProject) => void>(() => {});
  const autoAbortRef = useRef<Map<string, AbortController>>(new Map());
  const modalProjectIdRef = useRef<string | null>(null);
  const queuedOptimizeIdsRef = useRef<Set<string>>(new Set());
  // Same set as state so the UI can show which songs are being prepared
  const [preparingIds, setPreparingIds] = useState<Set<string>>(new Set());
  const [isActivatingProject, setIsActivatingProject] = useState(false);

  // 5. Medidores en un ref (no en el estado de App) para no recargar el hilo principal
  const metersRef = useRef<MetersSnapshot>({
    tracks: {},
    master: { rms: 0, peak: 0, clipping: false },
  });

  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importStatusText, setImportStatusText] = useState<string | null>(null);
  const [dragOverlayMode, setDragOverlayMode] = useState<'files' | 'repertoire-song' | null>(
    null
  );
  const [isSectionEditorOpen, setIsSectionEditorOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const channelRef = useRef<BroadcastChannel | null>(null);
  const lastBroadcastTransportMsRef = useRef<number>(0);
  const currentProjectRef = useRef<SongProject | null>(currentProject);
  currentProjectRef.current = currentProject;
  const transportRef = useRef<TransportState>(transport);
  transportRef.current = transport;

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3400);
  }, []);

  const isDesktopApp = typeof window !== 'undefined' && Boolean((window as any).__TAURI__);
  const [isDeviceDisconnected, setIsDeviceDisconnected] = useState(false);
  const [missingNativeCache, setMissingNativeCache] = useState(false);
  const [isGeneratingNativeCache, setIsGeneratingNativeCache] = useState(false);
  const [nativeCacheProgress, setNativeCacheProgress] = useState<{ percent: number; text: string }>({ percent: 0, text: '' });

  useEffect(() => {
    if (isDesktopApp) {
      nativeAudioEngine.setOnDeviceDisconnected((disconnected) => {
        setIsDeviceDisconnected(disconnected);
      });
    }
  }, [isDesktopApp]);

  useEffect(() => {
    if (isDesktopApp && currentProject && currentProject.tracks.length > 0) {
      nativeAudioEngine.checkProjectCacheStatus(currentProject).then((st) => {
        setMissingNativeCache(!st.isReady);
      });
    } else {
      setMissingNativeCache(false);
    }
  }, [currentProject?.id, isDesktopApp]);

  // Derived ordered Setlist Queue
  const setlistQueue = useMemo(() => {
    return projects
      .filter((p) => p.inSetlist)
      .sort((a, b) => (a.setlistOrder ?? 999) - (b.setlistOrder ?? 999));
  }, [projects]);

  // Subscribe to RAM cache status updates to refresh Setlist card badges
  useEffect(() => {
    const unsubscribeCache = audioEngine.subscribeCache(() => {
      setRamCacheVersion((v) => v + 1);
    });
    return unsubscribeCache;
  }, []);

  // 2. CACHÉ Y PRECARGA DE LA SIGUIENTE CANCIÓN:
  // Cuando una canción del setlist queda activa o el setlist cambia, recalcula cuál es la siguiente
  // y llama a preloadProject(nextSong) en segundo plano (manteniendo máx. 2 canciones en caché: actual + siguiente).
  useEffect(() => {
    if (setlistQueue.length === 0) return;
    // Wait until loadProject() has finished: avoids competing for decodeAudioData / eviction
    if (isActivatingProject) return;

    const activeId = currentProject?.id;
    const activeIdx = activeId
      ? setlistQueue.findIndex((s) => s.id === activeId)
      : -1;

    const nextSong =
      activeIdx >= 0 && activeIdx < setlistQueue.length - 1
        ? setlistQueue[activeIdx + 1]
        : activeIdx === -1 && setlistQueue.length > 0
        ? setlistQueue[0]
        : null;

    if (!nextSong || nextSong.id === activeId) return;
    // Don't decode the next song into RAM while it is still being converted into the OPFS cache
    if (isOpfsSupported() && queuedOptimizeIdsRef.current.has(nextSong.id)) return;

    const timerId = window.setTimeout(() => {
      audioEngine.preloadProject(nextSong).catch((err) => {
        console.error('Error preloading next setlist song:', err);
      });
    }, 100);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [setlistQueue, currentProject?.id, ramBudgetMB, isActivatingProject]);

  // Surface engine notices (play blocked, still loading...) instead of failing silently
  useEffect(() => {
    audioEngine.setOnNotice(showToast);
    return () => audioEngine.setOnNotice(null);
  }, [showToast]);

  // Keep the active song + the next setlist song as eviction-protected (priority) in RAM.
  // With nothing active yet, the first two songs of the setlist are the priority pair.
  useEffect(() => {
    const activeIdx = currentProject
      ? setlistQueue.findIndex((s) => s.id === currentProject.id)
      : -1;
    const ids: string[] = [];
    if (currentProject) ids.push(currentProject.id);
    const nextIdx = activeIdx >= 0 ? activeIdx + 1 : 0;
    if (setlistQueue[nextIdx]) ids.push(setlistQueue[nextIdx].id);
    if (!currentProject && setlistQueue[1]) ids.push(setlistQueue[1].id);
    audioEngine.setPriorityProjectIds(ids);
  }, [setlistQueue, currentProject?.id]);

  // The manual "Optimizar" button and the automatic background cache are ONE job:
  // pressing the button while the song is already being prepared just shows its progress.
  const handleStartOptimizeProject = useCallback((projectToOptimize: SongProject) => {
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
  }, []);

  const handleCancelOptimization = useCallback(() => {
    const id = modalProjectIdRef.current;
    if (id) autoAbortRef.current.get(id)?.abort();
    optimizationAbortControllerRef.current?.abort();
  }, []);

  // ---------------------------------------------------------------------------
  // Reference-based library + automatic OPFS cache
  // ---------------------------------------------------------------------------
  const projectsRef = useRef<SongProject[]>([]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const autoOptimizeChainRef = useRef<Promise<void>>(Promise.resolve());
  const accessPromisesRef = useRef<Map<string, Promise<void>>>(new Map());

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
          ? { ...p, tracks: p.tracks.map(({ pcm: _pcm, ...rest }) => rest) }
          : p;
      setProjects((prev) => prev.map(strip));
      showToast(
        `Caché liberada: ${result.prunedIds.length} canción(es) fuera del setlist (${(result.freedBytes / 1048576).toFixed(0)} MB). Siguen en la biblioteca.`
      );
    } catch (err) {
      console.warn('[CachePolicy] Error limpiando caché OPFS:', err);
    }
  }, [showToast]);
  useEffect(() => {
    applyPruneRef.current = applyPrune;
  }, [applyPrune]);

  // Copies a song's audio into OPFS once (sequential queue, silent, in the background)
  const runAutoOptimize = useCallback(
    (projectId: string) => {
      if (!isOpfsSupported()) return;
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
          const proj = projectsRef.current.find((p) => p.id === projectId);
          if (!proj || proj.tracks.length === 0) return;
          if (await isProjectPcmComplete(proj)) return;

          const stems = await loadProjectStemsFromDb(projectId);
          if (!stems.some((s) => !s.unavailable)) {
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
                  tracks: p.tracks.map((t) =>
                    t.id === trackId ? { ...t, peaks: info.peaks, durationSec: info.durationSec } : t
                  ),
                };

          const updated = await optimizeProjectForStreaming(
            proj,
            (progress) => {
              setImportStatusText(
                `Preparando "${proj.title}": ${progress.percent}% (pista ${progress.currentTrackIndex}/${progress.totalTracks})`
              );
              if (modalProjectIdRef.current === projectId) setOptimizationProgress(progress);
            },
            controller.signal,
            {
              onlyMissing: true,
              onTrackDone: (trackId, info) => {
                setProjects((prev) => prev.map((p) => patchTrack(p, trackId, info)));
                setCurrentProject((prev) => (prev ? patchTrack(prev, trackId, info) : prev));
              },
            }
          );

          // Merge pcm + peaks + exact duration into the latest project state (keeps edits made meanwhile)
          const latest = projectsRef.current.find((p) => p.id === projectId) || updated;
          const byId = new Map(updated.tracks.map((t) => [t.id, t]));
          const maxDur = Math.max(0, ...updated.tracks.map((t) => t.durationSec || 0));
          const secPerBar = (60 / (latest.bpm || 120)) * (latest.beatsPerBar || 4);
          const merged: SongProject = {
            ...latest,
            durationSec: maxDur > 1 ? maxDur : latest.durationSec,
            totalBars: maxDur > 1 ? Math.max(4, Math.ceil(maxDur / secPerBar)) : latest.totalBars,
            tracks: latest.tracks.map((t) => {
              const u = byId.get(t.id);
              return u?.pcm
                ? { ...t, pcm: u.pcm, peaks: u.peaks, durationSec: u.durationSec }
                : t;
            }),
          };
          audioEngine.clearProjectFallback(projectId);
          setProjects((prev) => prev.map((p) => (p.id === projectId ? merged : p)));
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
  useEffect(() => {
    runAutoOptimizeRef.current = runAutoOptimize;
  }, [runAutoOptimize]);

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

  const handleRelinkProject = useCallback(
    async (proj: SongProject) => {
      if (!isFsAccessSupported()) {
        showToast('Tu navegador no permite reubicar carpetas (usa Chrome o Edge).');
        return;
      }
      try {
        let dir: any;
        try {
          dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') throw err;
          dir = await (window as any).showDirectoryPicker({ mode: 'read' });
        }
        const { relinked, total } = await relinkProjectSources(proj.id, dir);
        if (relinked === 0) {
          showToast(`No se encontró ningún stem de "${proj.title}" en esa carpeta.`);
          return;
        }
        syncProjectSidecarNow(proj, true).catch(() => {});
        showToast(`Reubicados ${relinked}/${total} stems de "${proj.title}"`);
        runAutoOptimize(proj.id);
      } catch (err) {
        if ((err as { name?: string })?.name !== 'AbortError') {
          console.warn('[Relink] Error reubicando archivos:', err);
          showToast('No se pudo reubicar la carpeta');
        }
      }
    },
    [runAutoOptimize, showToast]
  );

  const handleChangeEngineMode = useCallback(
    (mode: AudioEngineMode) => {
      audioEngine.setEngineMode(mode);
      setEngineModeState(audioEngine.getEngineMode());
      showToast(
        mode === 'stream'
          ? 'Modo Stream seleccionado (usa Buffer como respaldo si la canción aún no tiene PCM)'
          : 'Modo Buffer seleccionado (AudioBuffer completo en RAM con presupuesto)'
      );
    },
    [showToast]
  );

  const handleChangeRamBudgetMB = useCallback(
    (mb: number) => {
      audioEngine.setRamBudgetMB(mb);
      setRamBudgetMBState(audioEngine.getRamBudgetMB());
      showToast(`Presupuesto de caché RAM ajustado a ${audioEngine.getRamBudgetMB()} MB`);
    },
    [showToast]
  );

  // 2 & 6. Activate a project using cached AudioBuffers if available and log console.info metrics
  const activateProject = useCallback(
    async (
      projectToLoad: SongProject,
      predecodedBuffers?: Map<string, AudioBuffer>,
      explicitPlayIfAlreadyInRam = false
    ) => {
      const t0 = performance.now();
      activationCountRef.current++;
      setIsActivatingProject(true);
      try {
        const normalizedProj = normalizeProjectSectionsToTime(projectToLoad);
        const wasReadyBeforeLoad = audioEngine.getSongRamCacheInfo(normalizedProj).isReady;
        const cachedBuffers =
          predecodedBuffers ??
          (audioEngine.hasFullProjectInCache(normalizedProj)
            ? audioEngine.getCachedProjectBuffers(normalizedProj.id)
            : undefined);
        const cameFromCache = Boolean(cachedBuffers) || wasReadyBeforeLoad;

        // Show project UI immediately while stems mount
        setCurrentProject(normalizedProj);

        const { peaksMap, wasCancelled } = await audioEngine.loadProject(
          normalizedProj,
          cachedBuffers
        );

        // If user switched to another song while this one was still decoding, abort
        if (wasCancelled) return;

        if (normalizedProj.tracks.length > 0 && !audioEngine.hasPlayableAudio()) {
          showToast(
            `No se pudo cargar el audio de "${normalizedProj.title}". Revisa que los archivos originales existan y estén permitidos (Biblioteca → Reubicar archivos).`
          );
        }

        const elapsedMs = performance.now() - t0;
        console.info(
          `[AudioEngine][activateProject] "${normalizedProj.title}" (${normalizedProj.id}) activada en ${elapsedMs.toFixed(1)} ms | Origen: ${cameFromCache ? 'CACHÉ RAM (HIT)' : 'INDEXEDDB (MISS)'}`
        );

        const realDurationSec = audioEngine.getTotalDurationSec();
        const latestBase =
          currentProjectRef.current?.id === normalizedProj.id
            ? currentProjectRef.current
            : normalizedProj;
        const enrichedTracks = latestBase.tracks.map((t) => ({
          ...t,
          peaks: peaksMap.get(t.id) || t.peaks || [],
        }));

        const updatedProject: SongProject = {
          ...latestBase,
          durationSec: realDurationSec,
          tracks: enrichedTracks,
        };

        setCurrentProject(updatedProject);
        audioEngine.updateProjectConfig(updatedProject);
        saveProjectToDb(updatedProject).catch(() => {});
        setProjects((prev) => {
          const exists = prev.some((p) => p.id === updatedProject.id);
          if (!exists) return [updatedProject, ...prev];
          return prev.map((p) => (p.id === updatedProject.id ? updatedProject : p));
        });

        // Never start spontaneous playback after a slow disk load;
        // only play if explicitly requested AND the song was already 100% ready in RAM / staged streaming
        if (explicitPlayIfAlreadyInRam && cameFromCache && audioEngine.hasPlayableAudio()) {
          audioEngine.play();
        }
      } catch (err) {
        console.error('Error loading project into engine:', err);
      } finally {
        activationCountRef.current = Math.max(0, activationCountRef.current - 1);
        if (activationCountRef.current === 0) setIsActivatingProject(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    activateProjectRef.current = (p) => {
      activateProject(p);
    };
  }, [activateProject]);

  // Initial load from IndexedDB: ONLY loads the Repertoire list, NEVER auto-loads a song into the DAW
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const saved = await loadAllProjectsFromDb();
        if (!mounted) return;
        setProjects(saved);
        // Clean up orphan OPFS directories from projects that were previously deleted
        const validIds = new Set(saved.map((p) => p.id));
        cleanOrphanPcmDirectories(validIds).catch(() => {});
        projectsRef.current = saved;
        applyPruneRef.current();
      } catch {
        // Keep empty repertoire if IndexedDB unavailable
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  // Setlist Prev / Next Song Handlers
  const handleNextSetlistSong = useCallback(
    async (autoPlay = false) => {
      const activeId = currentProjectRef.current?.id;
      const idx = setlistQueue.findIndex((s) => s.id === activeId);
      const nextSong =
        idx >= 0 && idx < setlistQueue.length - 1
          ? setlistQueue[idx + 1]
          : idx === -1 && setlistQueue.length > 0
          ? setlistQueue[0]
          : null;

      if (!nextSong) {
        showToast('Fin del Setlist alcanzado');
        return;
      }

      const isReadyInRam = audioEngine.getSongRamCacheInfo(nextSong).isReady;
      await activateProject(nextSong, undefined, autoPlay && isReadyInRam);
      showToast(
        autoPlay && isReadyInRam
          ? `Reproduciendo siguiente en Setlist: ${nextSong.title}`
          : `Siguiente canción lista en 00:00: ${nextSong.title}`
      );
    },
    [activateProject, setlistQueue, showToast]
  );

  const handlePrevSetlistSong = useCallback(async () => {
    const activeId = currentProjectRef.current?.id;
    const idx = setlistQueue.findIndex((s) => s.id === activeId);
    if (idx > 0) {
      const prevSong = setlistQueue[idx - 1];
      await activateProject(prevSong, undefined, false);
      showToast(`Canción anterior cargada en 00:00: ${prevSong.title}`);
    }
  }, [activateProject, setlistQueue, showToast]);

  // Connect Setlist End-of-Song Transition Callback
  useEffect(() => {
    audioEngine.setOnSongEnded(() => {
      if (setlistTransitionMode === 'cue-next') {
        handleNextSetlistSong(false);
      } else if (setlistTransitionMode === 'auto-play') {
        handleNextSetlistSong(true);
      }
    });
    return () => audioEngine.setOnSongEnded(null);
  }, [handleNextSetlistSong, setlistTransitionMode]);

  // 5. BroadcastChannel: send full project ONLY when currentProject changes
  useEffect(() => {
    if (!channelRef.current || !currentProject) return;
    const msg: RemoteSyncMessage = {
      type: 'STATE_SYNC',
      project: {
        ...currentProject,
        tracks: currentProject.tracks.map(({ peaks: _peaks, ...rest }) => rest),
      },
      transport: transportRef.current,
    };
    channelRef.current.postMessage(msg);
  }, [currentProject]);

  // 5. Subscribe to transport updates (already throttled to ~20fps by audioEngine)
  // and send transport-only BroadcastChannel updates throttled to ~10fps (100ms)
  useEffect(() => {
    const unsubscribe = audioEngine.subscribe((newTransport) => {
      setTransport(newTransport);

      if (channelRef.current && currentProjectRef.current) {
        const nowMs = performance.now();
        if (nowMs - lastBroadcastTransportMsRef.current >= 100) {
          lastBroadcastTransportMsRef.current = nowMs;
          const msg: RemoteSyncMessage = {
            type: 'TRANSPORT_SYNC',
            transport: newTransport,
          };
          channelRef.current.postMessage(msg);
        }
      }
    });

    return unsubscribe;
  }, []);

  // Mutate and persist current project helper
  const updateCurrentProject = useCallback(
    (updater: (prev: SongProject) => SongProject) => {
      setCurrentProject((prev) => {
        if (!prev) return null;
        const next = updater(prev);
        if (next === prev) return prev;
        audioEngine.updateProjectConfig(next);
        saveProjectToDb(next).catch(() => {});
        setProjects((list) => list.map((item) => (item.id === next.id ? next : item)));
        return next;
      });
    },
    []
  );

  // Setup BroadcastChannel for multi-tab / tablet Stage Remote control
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel('libretracks_remote_sync');
    channelRef.current = bc;

    bc.onmessage = (ev: MessageEvent<RemoteSyncMessage>) => {
      const data = ev.data;
      if (!data) return;

      switch (data.type) {
        case 'CMD_PLAY_PAUSE':
          audioEngine.togglePlayPause();
          break;
        case 'CMD_STOP':
          audioEngine.stop();
          break;
        case 'CMD_JUMP_SECTION':
          audioEngine.queueSectionJump(data.sectionId);
          break;
        case 'CMD_TOGGLE_VAMP':
          audioEngine.toggleVamp();
          break;
        case 'CMD_TOGGLE_CLICK':
          updateCurrentProject((p) => ({ ...p, clickEnabled: !p.clickEnabled }));
          break;
        case 'CMD_TOGGLE_GUIDE':
          updateCurrentProject((p) => ({ ...p, guideCuesEnabled: !p.guideCuesEnabled }));
          break;
        case 'CMD_SET_QUANTIZE':
          updateCurrentProject((p) => ({ ...p, quantizeMode: data.mode }));
          break;
        case 'CMD_SET_TRACK_MUTE':
          updateCurrentProject((p) => ({
            ...p,
            tracks: p.tracks.map((t) =>
              t.id === data.trackId ? { ...t, muted: data.muted } : t
            ),
          }));
          break;
        case 'CMD_SET_CLICK_GAIN':
          updateCurrentProject((p) => ({ ...p, clickGain: data.gain }));
          break;
        case 'CMD_SET_GUIDE_GAIN':
          updateCurrentProject((p) => ({ ...p, guideGain: data.gain }));
          break;
        case 'CMD_SET_MASTER_GAIN':
          updateCurrentProject((p) => ({ ...p, masterGain: data.gain }));
          break;
        case 'CMD_NEXT_SONG':
          handleNextSetlistSong(false);
          break;
        case 'CMD_PREV_SONG':
          handlePrevSetlistSong();
          break;
        default:
          break;
      }
    };

    return () => {
      bc.close();
      channelRef.current = null;
    };
  }, [handleNextSetlistSong, handlePrevSetlistSong, updateCurrentProject]);

  // Global Studio Keyboard Shortcuts (Space = Play/Pause, V = Vamp, 1-9 = Section Jumps)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (!currentProjectRef.current) return;

      if (e.code === 'Space') {
        e.preventDefault();
        audioEngine.togglePlayPause();
      } else if (e.key.toLowerCase() === 'v') {
        e.preventDefault();
        audioEngine.toggleVamp();
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        const sec = currentProjectRef.current.sections[idx];
        if (sec) {
          e.preventDefault();
          audioEngine.queueSectionJump(sec.id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSelectView = (view: WorkspaceView) => {
    setActiveView(view);
    window.history.replaceState(null, '', `#${view}`);
  };

  /**
   * INSTANT NON-BLOCKING STEM & FOLDER IMPORT PIPELINE
   * Uses controlled parallel decoding (batches of 3), immediate SetlistRamCache storage,
   * and a single atomic IndexedDB transaction storing native File Blobs.
   */
  const handleInstantImportFiles = useCallback(
    async (
      fileList: FileList | File[],
      defaultBus: OutputBus = 'main',
      importMode: 'new-song' | 'current-song' = 'new-song'
    ) => {
      const t0 = performance.now();
      // Conditional branch: Desktop native audio import vs Web Audio import
      const isDesktopApp = typeof window !== 'undefined' && Boolean((window as any).__TAURI__);
      if (isDesktopApp) {
        // En escritorio (Fase 1 preparada / Fase 2 ejecución), el motor nativo
        // asume el procesamiento en Rust. La ruta web inferior se mantiene 100% intacta.
        console.info('[AudioImport][Desktop] Importación de audio en entorno nativo Tauri');
      }

      const validFiles = extractAudioFilesFromFileList(fileList);

      if (validFiles.length === 0) {
        showToast('No se encontraron archivos de audio compatibles (.wav, .mp3, .ogg, .flac, .m4a)');
        return;
      }

      const effectiveMode =
        importMode === 'current-song' && currentProjectRef.current
          ? 'current-song'
          : 'new-song';

      const baseTimestamp = Date.now();
      const targetProjectId =
        effectiveMode === 'new-song'
          ? `song-${baseTimestamp}`
          : currentProjectRef.current!.id;

      const { songTitle, detectedBpm, detectedKey, cleanTrackNames } =
        inferSongMetadataFromFiles(validFiles);

      // Check if the imported folder contains an omnitracks.project.json sidecar (or local preset memory)
      const folderSidecar =
        effectiveMode === 'new-song' ? await extractSidecarFromFileList(fileList) : null;
      const savedMetadata =
        effectiveMode === 'new-song'
          ? folderSidecar ||
            findSavedProjectPreset(
              songTitle,
              validFiles.map((f) => f.name)
            )
          : null;

      const bpm =
        effectiveMode === 'new-song'
          ? savedMetadata?.bpm || detectedBpm || 120
          : currentProjectRef.current!.bpm;
      const beatsPerBar =
        effectiveMode === 'new-song'
          ? savedMetadata?.beatsPerBar || 4
          : currentProjectRef.current!.beatsPerBar;
      const secPerBar = (60 / bpm) * beatsPerBar;

      // Request storage persistence in background without blocking
      ensureStoragePersist().catch(() => {});

      // =========================================================================
      // PHASE 1: SUB-MILLISECOND WAV HEADER INSPECTION & INSTANT UI/ENGINE MOUNT
      // =========================================================================
      const wavHeaders = await Promise.all(validFiles.map((f) => parseWavHeaderFast(f)));

      const initialTracks: TrackChannel[] = [];
      const stemsToSaveBatch: StoredAudioStem[] = [];
      let headerMaxDurationSec = 0;

      for (let idx = 0; idx < validFiles.length; idx++) {
        const file = validFiles[idx];
        const trackId = `stem-${baseTimestamp}-${String(idx).padStart(2, '0')}`;
        const trackLabel = cleanTrackNames[idx] || file.name.replace(/\.[^/.]+$/, '');
        const inferred = inferTrackRoleAndColor(trackLabel, idx);
        const wavInfo = wavHeaders[idx];
        const estDuration = wavInfo?.durationSec || 0;

        if (estDuration > headerMaxDurationSec) {
          headerMaxDurationSec = estDuration;
        }

        const newTrack: TrackChannel = {
          id: trackId,
          name: trackLabel,
          role: inferred.role,
          color: inferred.color,
          gain: 1.0,
          pan: 0,
          muted: false,
          soloed: false,
          bus: inferred.bus === 'cue-click' ? 'cue-click' : defaultBus,
          peaks: [],
          isCustomAudio: true,
          fileName: file.name,
          durationSec: estDuration > 0 ? estDuration : undefined,
        };

        initialTracks.push(newTrack);
        // Reference-based library: keep a handle to the original file when the browser gives
        // one (Chrome/Edge); otherwise fall back to copying the Blob into IndexedDB.
        const sourceHandle = getRegisteredHandle(file);
        if (sourceHandle?.dir) {
          registerProjectDirHandle(targetProjectId, sourceHandle.dir);
        }
        stemsToSaveBatch.push(
          sourceHandle
            ? {
                key: `${targetProjectId}:${trackId}`,
                projectId: targetProjectId,
                trackId,
                fileHandle: sourceHandle.file,
                dirHandle: sourceHandle.dir,
                mimeType: file.type || 'audio/wav',
                fileName: file.name,
              }
            : {
                key: `${targetProjectId}:${trackId}`,
                projectId: targetProjectId,
                trackId,
                blob: file,
                mimeType: file.type || 'audio/wav',
                fileName: file.name,
              }
        );
      }

      // Desktop Native Audio Import Pipeline (Fase 2: Decodificación y Caché en Rust)
      if (isDesktopApp) {
        try {
          const invoke = (window as any).__TAURI__?.core?.invoke;
          if (invoke) {
            const hasPaths = validFiles.some((f) => Boolean((f as any).path));
            if (hasPaths) {
              const filesToImport = validFiles
                .filter((f) => Boolean((f as any).path))
                .map((f, idx) => ({
                  filePath: (f as any).path as string,
                  trackId: initialTracks[idx].id,
                }));

              const importResult: { tracks: any[]; errors: string[] } = await invoke('audio_import_tracks', {
                projectId: targetProjectId,
                files: filesToImport,
                targetSampleRate: null,
              });

              for (const meta of importResult.tracks) {
                const matchedTrack = initialTracks.find((t) => t.id === meta.trackId);
                if (matchedTrack) {
                  matchedTrack.peaks = meta.peaks;
                  matchedTrack.durationSec = meta.durationSec;
                  matchedTrack.pcm = {
                    sampleRate: meta.targetSampleRate,
                    channels: meta.channels,
                    frames: meta.frameCount,
                    version: 1,
                  };
                  if (meta.durationSec > headerMaxDurationSec) {
                    headerMaxDurationSec = meta.durationSec;
                  }
                }
              }
            } else {
              // Si los archivos se seleccionaron mediante el selector HTML o drag-and-drop sin path nativo en Chromium:
              // No se omite: enviamos los bytes directamente a Rust (audio_import_track_bytes) para asegurar la caché nativa!
              console.info('[AudioImport][Desktop] Transfiriendo stems a Rust para generar caché nativa...');
              for (let idx = 0; idx < validFiles.length; idx++) {
                const file = validFiles[idx];
                const trackId = initialTracks[idx].id;
                try {
                  const arrayBuf = await file.arrayBuffer();
                  const bytes = Array.from(new Uint8Array(arrayBuf));
                  const meta: any = await invoke('audio_import_track_bytes', {
                    projectId: targetProjectId,
                    trackId,
                    fileName: file.name,
                    bytes,
                    targetSampleRate: null,
                  });
                  const matchedTrack = initialTracks.find((t) => t.id === trackId);
                  if (matchedTrack && meta) {
                    matchedTrack.peaks = meta.peaks;
                    matchedTrack.durationSec = meta.durationSec;
                    matchedTrack.pcm = {
                      sampleRate: meta.targetSampleRate,
                      channels: meta.channels,
                      frames: meta.frameCount,
                      version: 1,
                    };
                    if (meta.durationSec > headerMaxDurationSec) {
                      headerMaxDurationSec = meta.durationSec;
                    }
                  }
                } catch (byteErr) {
                  console.warn(`[AudioImport][Desktop] Error importando pista ${trackId} por bytes:`, byteErr);
                }
              }
            }
          }
        } catch (desktopErr) {
          console.warn('[AudioImport][Desktop] Fallo en decodificación nativa Rust:', desktopErr);
        }
      }

      const initialDurationSec =
        headerMaxDurationSec > 1
          ? headerMaxDurationSec
          : effectiveMode === 'current-song'
          ? currentProjectRef.current?.durationSec || 180
          : savedMetadata?.durationSec && savedMetadata.durationSec > 1
          ? savedMetadata.durationSec
          : 180;

      const initialBars = Math.max(4, Math.ceil(initialDurationSec / secPerBar));
      let effectiveSongTitle = songTitle;
      let restoredSectionsCount = 0;

      if (effectiveMode === 'new-song') {
        const baseSongProject: SongProject = {
          id: targetProjectId,
          title: songTitle,
          artist: 'Sesión Importada',
          folder: 'imported',
          inSetlist: true,
          setlistOrder: projects.length,
          bpm,
          beatsPerBar: 4,
          beatUnit: 4,
          keySignature: detectedKey || 'C Major',
          totalBars: initialBars,
          durationSec: initialDurationSec,
          quantizeMode: 'immediate',
          splitRoutingMode: 'stereo',
          clickEnabled: false,
          clickGain: 1.0,
          clickSubdivision: 1,
          guideCuesEnabled: true,
          guideVoiceReadout: true,
          guideGain: 1.0,
          masterGain: 1.0,
          cueMasterGain: 1.0,
          pitchSemitones: 0,
          sections: [],
          tracks: initialTracks,
          updatedAt: Date.now(),
        };

        const newSongProject: SongProject = savedMetadata
          ? mergeSavedProjectMetadata(baseSongProject, savedMetadata)
          : baseSongProject;

        effectiveSongTitle = newSongProject.title;
        restoredSectionsCount = newSongProject.sections.length;

        // Mount project shell and mixer nodes in < 1 ms
        audioEngine.prepareProjectShell(newSongProject);
        setCurrentProject(newSongProject);
        setProjects((prev) => [newSongProject, ...prev]);
        saveProjectToDb(newSongProject).catch(() => {});
      } else {
        const current = currentProjectRef.current!;
        const combinedTracks = [...current.tracks, ...initialTracks];
        const nextDurationSec = Math.max(current.durationSec || 0, initialDurationSec);
        const nextTotalBars = Math.max(current.totalBars, initialBars);

        const updatedProject: SongProject = {
          ...current,
          totalBars: nextTotalBars,
          durationSec: nextDurationSec,
          tracks: combinedTracks,
          updatedAt: Date.now(),
        };

        audioEngine.updateProjectConfig(updatedProject);
        setCurrentProject(updatedProject);
        setProjects((prev) =>
          prev.map((p) => (p.id === updatedProject.id ? updatedProject : p))
        );
        saveProjectToDb(updatedProject).catch(() => {});
      }

      // Save native File Blob pointers to IndexedDB in background (zero re-encoding)
      const stemsSavePromise = saveStemsBatchToDb(stemsToSaveBatch).catch((err) =>
        console.warn('Background IndexedDB batch stem save warning:', err)
      );

      const mountMs = performance.now() - t0;
      console.info(
        `[AudioEngine][InstantImport] "${effectiveSongTitle}" (${initialTracks.length} pistas, ${restoredSectionsCount} marcadores) montada en consola en ${mountMs.toFixed(1)} ms`
      );

      // Desktop Native: Registramos la disponibilidad de la caché PCM nativa generada en Rust.
      // Hasta la Fase 6 (cuando el reproductor nativo reemplace por completo al Web Audio),
      // se conserva la ruta de optimización OPFS para que WebView2 siga sonando sin caídas a RAM.
      const isNativePcmReady =
        isDesktopApp &&
        initialTracks.length > 0 &&
        initialTracks.every((t) => Boolean(t.pcm) && t.pcm!.frames > 0);

      if (isNativePcmReady) {
        console.info(
          `[AudioImport][Desktop] Caché PCM nativa en Rust lista para "${effectiveSongTitle}" (${initialTracks.length} pistas).`
        );
      }

      // Single-pass pipeline: decode each stem ONCE, straight into the OPFS cache (peaks and
      // duration come from the same pass). No RAM decode of the whole song at import time.
      // En escritorio (isDesktopApp), la caché OPFS se omite por completo: el motor nativo usa su propia caché PCM en disco.
      if (isDesktopApp) {
        showToast(
          restoredSectionsCount > 0
            ? `"${effectiveSongTitle}" importada en motor nativo (${initialTracks.length} pistas · ${restoredSectionsCount} marcadores restaurados).`
            : `"${effectiveSongTitle}" importada en motor nativo (${initialTracks.length} pistas).`
        );
        await stemsSavePromise;
        return;
      }

      if (effectiveMode === 'new-song' && isOpfsSupported()) {
        showToast(
          restoredSectionsCount > 0
            ? `"${effectiveSongTitle}" importada (${initialTracks.length} pistas · ${restoredSectionsCount} marcadores restaurados). Preparando audio…`
            : `"${effectiveSongTitle}" importada (${initialTracks.length} pistas). Preparando el audio en segundo plano…`
        );
        await stemsSavePromise;
        runAutoOptimizeRef.current(targetProjectId);
        return;
      }

      showToast(
        effectiveMode === 'new-song'
          ? restoredSectionsCount > 0
            ? `Canción "${effectiveSongTitle}" montada (${initialTracks.length} pistas · ${restoredSectionsCount} marcadores restaurados)`
            : `Canción "${effectiveSongTitle}" montada en ${Math.max(1, Math.round(mountMs))} ms (${initialTracks.length} pistas)`
          : `${initialTracks.length} stem(s) montado(s) en ${Math.max(1, Math.round(mountMs))} ms`
      );

      // =========================================================================
      // PHASE 2: PARALLEL NATIVE C++ AUDIO BUFFER HYDRATION (ZERO OPFS WRITES)
      // =========================================================================
      let completedCount = 0;
      let maxDecodedDurationSec = headerMaxDurationSec;
      let anyDecoded = false;

      setImportStatusText(
        `Preparando audio 0/${validFiles.length} en segundo plano...`
      );

      const BATCH_SIZE = 4;
      for (let i = 0; i < validFiles.length; i += BATCH_SIZE) {
        const batchFiles = validFiles.slice(i, i + BATCH_SIZE);
        const batchTracks = initialTracks.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batchFiles.map(async (file, batchIdx) => {
            const trk = batchTracks[batchIdx];
            try {
              const rawBuf = await file.arrayBuffer();
              const { audioBuffer, peaks, durationSec } =
                await audioEngine.decodeStemBuffer(rawBuf, trk.name, false);

              anyDecoded = true;
              completedCount++;
              if (durationSec > maxDecodedDurationSec) {
                maxDecodedDurationSec = durationSec;
              }

              setImportStatusText(
                completedCount < validFiles.length
                  ? `Preparando audio ${completedCount}/${validFiles.length}: ${trk.name}`
                  : null
              );

              const enrichedTrack: TrackChannel = {
                ...trk,
                peaks,
                durationSec,
              };

              // If this project is still the active project in the console, mount buffer live
              if (currentProjectRef.current?.id === targetProjectId) {
                audioEngine.mountDecodedTrack(enrichedTrack, audioBuffer);
              } else {
                // Otherwise store in RAM cache for instant switching
                const cachedMap =
                  audioEngine.getCachedProjectBuffers(targetProjectId) ||
                  new Map<string, AudioBuffer>();
                cachedMap.set(trk.id, audioBuffer);
                audioEngine.storeProjectBuffersInRamCache(targetProjectId, cachedMap);
              }

              // Update track peaks & duration progressively in React state
              const updateProjectWithTrack = (proj: SongProject): SongProject => {
                if (proj.id !== targetProjectId) return proj;
                const nextDur = Math.max(
                  headerMaxDurationSec > 0 ? proj.durationSec || 0 : 0,
                  maxDecodedDurationSec
                );
                const finalDur = nextDur > 0 ? nextDur : proj.durationSec || 180;
                const finalBars = Math.max(4, Math.ceil(finalDur / secPerBar));
                return {
                  ...proj,
                  durationSec: finalDur,
                  totalBars: finalBars,
                  tracks: proj.tracks.map((t) =>
                    t.id === enrichedTrack.id
                      ? { ...t, peaks, durationSec }
                      : t
                  ),
                };
              };

              setCurrentProject((prev) =>
                prev && prev.id === targetProjectId ? updateProjectWithTrack(prev) : prev
              );
              setProjects((prev) =>
                prev.map((p) =>
                  p.id === targetProjectId ? updateProjectWithTrack(p) : p
                )
              );
            } catch (err) {
              completedCount++;
              console.error(
                `[AudioEngine][Import Decode Error] Falló "${trk.name}":`,
                err
              );
            }
          })
        );
      }

      setImportStatusText(null);

      if (!anyDecoded) {
        showToast('No se pudo decodificar el audio seleccionado');
        return;
      }

      // Persist final peaks and exact duration to IndexedDB
      if (currentProjectRef.current?.id === targetProjectId) {
        saveProjectToDb(currentProjectRef.current).catch(() => {});
      }

      // One-time background copy into the OPFS cache (the song is in the setlist from import)
      await stemsSavePromise;
      runAutoOptimizeRef.current(targetProjectId);
    },
    [projects.length, showToast]
  );

  // Add a Section Marker directly at the current playhead time (mm:ss.d)
  const handleAddMarkerAtPlayhead = () => {
    if (!currentProject) return;
    const playheadSec = Math.round(transport.currentTimeSec * 100) / 100;
    const totalSec = Math.max(
      10,
      Math.round((transport.totalDurationSec || currentProject.durationSec || 60) * 100) / 100
    );
    const clampedStart = Math.max(0, Math.min(totalSec - 0.5, playheadSec));

    updateCurrentProject((prev) => {
      const nextNum = prev.sections.length + 1;
      const sortedExisting = [...prev.sections].sort(
        (a, b) => a.startTimeSec - b.startTimeSec
      );
      const nextExisting = sortedExisting.find((s) => s.startTimeSec > clampedStart);
      const defaultEnd = nextExisting ? nextExisting.startTimeSec : totalSec;

      const newSec: SongSection = {
        id: `sec-${Date.now()}`,
        name: `Sección ${nextNum}`,
        code: `S${nextNum}`,
        color: MARKER_PALETTE[prev.sections.length % MARKER_PALETTE.length],
        startTimeSec: clampedStart,
        endTimeSec: Math.max(clampedStart + 0.1, defaultEnd),
        vampByDefault: false,
        cueName: `Sección ${nextNum}`,
      };

      const combined = [...prev.sections, newSec].sort(
        (a, b) => a.startTimeSec - b.startTimeSec
      );
      const recalculated = combined.map((s, idx) => {
        const nextItem = combined[idx + 1];
        const targetEnd = nextItem ? nextItem.startTimeSec : totalSec;
        return {
          ...s,
          startTimeSec: Math.round(s.startTimeSec * 100) / 100,
          endTimeSec: Math.round(Math.max(s.startTimeSec + 0.05, targetEnd) * 100) / 100,
        };
      });

      const next: SongProject = {
        ...prev,
        sections: recalculated,
      };
      syncProjectSidecarNow(next, true).catch(() => {});
      return next;
    });

    showToast(`Marcador creado en ${formatTimecode(clampedStart)}`);
  };

  // Transport & Mixer Handlers
  const handlePlayPause = () => audioEngine.togglePlayPause();
  const handleStop = () => audioEngine.stop();
  const handleToggleVamp = () => audioEngine.toggleVamp();
  const handleJumpSection = (sectionId: string) => audioEngine.queueSectionJump(sectionId);
  const handleCancelQueuedJump = () => audioEngine.cancelQueuedJump();
  const handleSeekSeconds = (sec: number) => audioEngine.seekToSeconds(sec);

  const handleChangeBpm = (bpm: number) => {
    updateCurrentProject((p) => ({ ...p, bpm }));
  };

  const handleChangePitch = (pitchSemitones: number) => {
    updateCurrentProject((p) => ({ ...p, pitchSemitones }));
  };

  const handleChangeQuantize = (quantizeMode: QuantizeMode) => {
    updateCurrentProject((p) => ({ ...p, quantizeMode }));
  };

  const handleToggleClick = () => {
    updateCurrentProject((p) => ({ ...p, clickEnabled: !p.clickEnabled }));
  };

  const handleToggleGuide = () => {
    updateCurrentProject((p) => ({ ...p, guideCuesEnabled: !p.guideCuesEnabled }));
  };

  const handleToggleSplitRouting = () => {
    updateCurrentProject((p) => ({
      ...p,
      splitRoutingMode: p.splitRoutingMode === 'stereo' ? 'split-mono' : 'stereo',
    }));
  };

  const handleToggleTrackMute = (trackId: string) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
    }));
  };

  const handleToggleTrackSolo = (trackId: string) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, soloed: !t.soloed } : t)),
    }));
  };

  const handleChangeTrackGain = (trackId: string, gain: number) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, gain } : t)),
    }));
  };

  const handleChangeTrackPan = (trackId: string, pan: number) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, pan } : t)),
    }));
  };

  const handleChangeTrackBus = (trackId: string, bus: OutputBus) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, bus } : t)),
    }));
  };

  const handleDeleteTrack = (trackId: string) => {
    audioEngine.removeTrack(trackId);
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.filter((t) => t.id !== trackId),
    }));
    showToast('Pista eliminada del proyecto');
  };

  const handleResetMixer = () => {
    updateCurrentProject((p) => ({
      ...p,
      clickGain: 1.0,
      clickPan: 0,
      guideGain: 1.0,
      guidePan: 0,
      masterGain: 1.0,
      cueMasterGain: 1.0,
      tracks: p.tracks.map((t) => ({
        ...t,
        gain: 1.0,
        pan: 0,
        muted: false,
        soloed: false,
      })),
    }));
    showToast('Mezcla restablecida a 0.0 dB');
  };

  // Section Arrangement Save Handler (Time-based mm:ss)
  const handleSaveSections = (sections: SongSection[]) => {
    updateCurrentProject((prev) => {
      const next: SongProject = {
        ...prev,
        sections,
      };
      syncProjectSidecarNow(next, true).catch(() => {});
      return next;
    });
    showToast('Marcadores de sección (mm:ss) guardados en canción y carpeta');
  };

  // Load Song Immediately into DAW (Used when confirmed in modal, clicked Play on Setlist card, or dragged onto DAW)
  const handleLoadProjectImmediately = async (projectId: string, autoPlay = false) => {
    const found = projects.find((p) => p.id === projectId);
    if (!found) return;
    if (isOpfsSupported() && queuedOptimizeIdsRef.current.has(projectId)) {
      showToast(`"${found.title}" se está preparando en segundo plano; espera a que termine.`);
      return;
    }
    // Songs already cached in OPFS don't need the original files; others do
    const isOpfsReady = await isProjectPcmComplete(found);
    if (!isOpfsReady) {
      await ensureSourceAccess(projectId);
      runAutoOptimize(projectId);
    }
    await activateProject(found, undefined, autoPlay);
    if (activeView === 'library') {
      handleSelectView('setlist');
    }
    showToast(`Canción montada en consola: ${found.title}`);
  };

  // Setlist Management Handlers
  const handleAddToSetlist = (projectId: string) => {
    // Adding to the setlist = copy the audio into the OPFS cache once (in the background)
    const p = projectsRef.current.find((x) => x.id === projectId);
    if (p) {
      isProjectPcmComplete(p).then((complete) => {
        if (!complete) {
          ensureSourceAccess(projectId).then(() => runAutoOptimize(projectId));
        }
      });
    }
    setProjects((prev) => {
      const maxOrder = prev.reduce(
        (max, item) =>
          item.inSetlist ? Math.max(max, item.setlistOrder ?? 0) : max,
        -1
      );
      return prev.map((p) => {
        if (p.id !== projectId) return p;
        const updated: SongProject = {
          ...p,
          inSetlist: true,
          setlistOrder: p.inSetlist ? p.setlistOrder : maxOrder + 1,
        };
        saveProjectToDb(updated).catch(() => {});
        if (currentProject?.id === projectId) {
          setCurrentProject(updated);
        }
        showToast(`"${p.title}" añadida al Setlist`);
        return updated;
      });
    });
  };

  const handleRemoveFromSetlist = (projectId: string) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const updated: SongProject = { ...p, inSetlist: false };
        saveProjectToDb(updated).catch(() => {});
        if (currentProject?.id === projectId) {
          setCurrentProject(updated);
        }
        return updated;
      })
    );
    showToast('Canción quitada del Setlist');
  };

  const handleReorderSetlist = (fromIndex: number, toIndex: number) => {
    const queue = [...setlistQueue];
    const [moved] = queue.splice(fromIndex, 1);
    if (!moved) return;
    queue.splice(toIndex, 0, moved);

    const orderMap = new Map<string, number>();
    queue.forEach((item, idx) => orderMap.set(item.id, idx));

    setProjects((prev) =>
      prev.map((p) => {
        if (!orderMap.has(p.id)) return p;
        const updated = { ...p, setlistOrder: orderMap.get(p.id)! };
        saveProjectToDb(updated).catch(() => {});
        return updated;
      })
    );
  };

  // Live page: make a song the one that plays after the current one
  const handleSetAsNextSong = (projectId: string) => {
    const cur = setlistQueue.findIndex((s) => s.id === currentProjectRef.current?.id);
    const from = setlistQueue.findIndex((s) => s.id === projectId);
    if (from === -1 || from === cur) return;
    const to = cur === -1 ? 0 : from > cur ? cur + 1 : cur;
    if (from !== to) handleReorderSetlist(from, to);
    showToast(`"${setlistQueue[from].title}" sonará a continuación`);
  };

  const handleMoveInSetlist = (projectId: string, direction: 'up' | 'down') => {
    const idx = setlistQueue.findIndex((s) => s.id === projectId);
    if (idx === -1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= setlistQueue.length) return;
    handleReorderSetlist(idx, targetIdx);
  };

  const handleCreateNewProject = async (
    title: string,
    artist: string,
    bpm: number,
    keySignature: string
  ) => {
    const newProj = createEmptyProjectTemplate(title, artist, bpm, keySignature);
    newProj.inSetlist = true;
    newProj.setlistOrder = projects.length;
    await activateProject(newProj);
    handleSelectView('setlist');
    showToast(`Nueva canción creada: ${title}`);
  };

  const handleDeleteProject = async (projectId: string) => {
    audioEngine.evictSongFromRamCache(projectId);
    await deleteProjectFromDb(projectId);
    const remaining = projects.filter((p) => p.id !== projectId);
    setProjects(remaining);
    if (currentProject?.id === projectId) {
      audioEngine.stop();
      setCurrentProject(null);
    }
    showToast('Canción quitada de la biblioteca (tus archivos en disco no se modifican)');
  };

  const handleExportJson = (proj: SongProject) => {
    const blob = new Blob([JSON.stringify(proj, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${proj.title.toLowerCase().replace(/\s+/g, '-')}.omnitracks.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Archivo .omnitracks.json exportado');
  };

  const handleImportJsonFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SongProject;
      if (!parsed.title || !Array.isArray(parsed.tracks)) {
        showToast('El archivo JSON no tiene un formato de OmniTracks válido');
        return;
      }
      const importedProj: SongProject = normalizeProjectSectionsToTime({
        ...parsed,
        id: `imported-${Date.now()}`,
        folder: 'imported',
        updatedAt: Date.now(),
      });
      await activateProject(importedProj);
      handleSelectView('setlist');
      showToast(`Proyecto importado: ${importedProj.title}`);
    } catch {
      showToast('No se pudo leer el archivo JSON');
    }
  };

  // Drag-and-Drop on DAW Workspace (Handles both Repertoire Song Drag & Audio File Drag)
  const handleDragOverDaw = (e: React.DragEvent) => {
    e.preventDefault();
    if (
      e.dataTransfer.types.includes('application/x-libretracks-song-id') &&
      !e.dataTransfer.types.includes('application/x-libretracks-setlist-index')
    ) {
      setDragOverlayMode('repertoire-song');
    } else if (e.dataTransfer.types.includes('Files')) {
      setDragOverlayMode('files');
    }
  };

  const handleDragLeaveDaw = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) {
      setDragOverlayMode(null);
    }
  };

  const handleDropOnDaw = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverlayMode(null);

    const songId = e.dataTransfer.getData('application/x-libretracks-song-id');
    if (songId) {
      handleAddToSetlist(songId);
      handleLoadProjectImmediately(songId, false);
      return;
    }

    // Start both extractors synchronously (DataTransfer is only valid during the event)
    const withHandles = extractAudioFilesWithHandlesFromDataTransfer(e.dataTransfer);
    const classic = extractAudioFilesFromDataTransfer(e.dataTransfer);
    const handleFiles = await withHandles;
    const audioFiles = handleFiles.length > 0 ? handleFiles : await classic;
    if (audioFiles.length > 0) {
      handleInstantImportFiles(audioFiles, 'main', 'new-song');
    } else {
      showToast('No se encontraron archivos de audio compatibles (.wav, .mp3, .ogg, .flac, .m4a)');
    }
  };

  const transportProject = activeView === 'live' ? null : currentProject;
  const remoteTriggerRef = DesktopRemoteBridge && window.location.origin === 'https://tauri.localhost'
    ? setRemoteTriggerHost : undefined;
  const audioTriggerRef = DesktopAudioSettings && window.location.origin === 'https://tauri.localhost'
    ? setAudioTriggerHost : undefined;

  return (
    <div className="min-h-screen h-dvh flex flex-col bg-studio-ground text-neutral-100 overflow-hidden relative">
      {/* Top Navigation Bar */}
      <TopBar
        activeView={activeView}
        setlistCount={setlistQueue.length}
        engineMode={engineMode}
        ramBudgetMB={ramBudgetMB}
        cachedRamMB={audioEngine.getTotalCachedMB()}
        remoteTriggerRef={transportProject ? undefined : remoteTriggerRef}
        audioTriggerRef={audioTriggerRef}
        onChangeEngineMode={handleChangeEngineMode}
        onChangeRamBudgetMB={handleChangeRamBudgetMB}
        onSelectView={handleSelectView}
        onOpenImportModal={() => setIsImportModalOpen(true)}
      />

      {/* Banner de alerta: Desconexión de interfaz de audio en caliente */}
      {isDeviceDisconnected && (
        <div className="bg-rose-950/95 border-b border-rose-800 text-rose-200 px-4 py-2 flex items-center justify-between text-xs z-50 shadow-lg">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>
              <strong>Dispositivo de audio desconectado.</strong> La reproducción se ha pausado y la posición se conserva en{' '}
              <strong className="font-mono text-white">
                {Math.floor(transport.currentTimeSec / 60)}:{String(Math.floor(transport.currentTimeSec % 60)).padStart(2, '0')}.{Math.floor((transport.currentTimeSec % 1) * 10)}
              </strong>. Conéctalo de nuevo y pulsa Reabrir.
            </span>
          </div>
          <button
            type="button"
            onClick={() => void nativeAudioEngine.reopenDevice()}
            className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded font-medium cursor-pointer transition-colors shrink-0"
          >
            Reabrir dispositivo
          </button>
        </div>
      )}

      {/* Banner de aviso: Canción sin caché nativa a la frecuencia del dispositivo */}
      {missingNativeCache && (
        <div className="bg-amber-950/90 border-b border-amber-800/80 text-amber-200 px-4 py-2 flex items-center justify-between text-xs z-50 shadow-md">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              La canción actual <strong>"{currentProject?.title}"</strong> no dispone de caché PCM nativa para este dispositivo.
              {isGeneratingNativeCache ? ` (${nativeCacheProgress.percent}% - ${nativeCacheProgress.text})` : ''}
            </span>
          </div>
          <button
            type="button"
            disabled={isGeneratingNativeCache}
            onClick={async () => {
              if (!currentProject) return;
              setIsGeneratingNativeCache(true);
              const ok = await nativeAudioEngine.generateNativeCacheForProject(currentProject, (percent, text) => {
                setNativeCacheProgress({ percent, text });
              });
              setIsGeneratingNativeCache(false);
              if (ok) {
                setMissingNativeCache(false);
                await nativeAudioEngine.loadProject(currentProject);
                showToast(`Caché nativa lista para "${currentProject.title}".`);
              }
            }}
            className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded cursor-pointer transition-colors disabled:opacity-50 shrink-0"
          >
            {isGeneratingNativeCache ? 'Generando...' : 'Generar caché nativa'}
          </button>
        </div>
      )}

      {/* Studio Transport Deck (Shown when a song is loaded; the Live page has its own) */}
      {transportProject && (
        <TransportDeck
          project={transportProject}
          transport={transport}
          remoteTriggerRef={remoteTriggerRef}
          setlistQueue={setlistQueue}
          setlistTransitionMode={setlistTransitionMode}
          importStatusText={importStatusText}
          onPlayPause={handlePlayPause}
          onStop={handleStop}
          onToggleVamp={handleToggleVamp}
          onPrevSetlistSong={handlePrevSetlistSong}
          onNextSetlistSong={() => handleNextSetlistSong(false)}
          onChangeSetlistTransitionMode={setSetlistTransitionMode}
          onChangeBpm={handleChangeBpm}
          onChangePitch={handleChangePitch}
          onChangeQuantize={handleChangeQuantize}
          onToggleClick={handleToggleClick}
          onToggleGuide={handleToggleGuide}
          onToggleSplitRouting={handleToggleSplitRouting}
          onAddMarkerAtPlayhead={handleAddMarkerAtPlayhead}
          onOpenSectionEditor={() => setIsSectionEditorOpen(true)}
          onCancelQueuedJump={handleCancelQueuedJump}
        />
      )}

      {/* Main Body: Dockable Left Repertoire Sidebar + Active Workspace */}
      <div className="relative flex-1 flex overflow-hidden min-h-0">
        {(activeView === 'setlist' || activeView === 'library') && (
          <RepertoireTreeSidebar
            projects={projects}
            setlistQueue={setlistQueue}
            currentProjectId={currentProject?.id || null}
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed((prev) => !prev)}
            onRequestSongAction={(song) => setConfirmSongCandidate(song)}
            onAddToSetlist={handleAddToSetlist}
            onDeleteProject={handleDeleteProject}
            onExportJson={handleExportJson}
            onQuickImportNewSongFiles={(files) =>
              handleInstantImportFiles(files, 'main', 'new-song')
            }
            onOpenNewSongModal={() => handleSelectView('library')}
          />
        )}

        {/* Active Workspace Drop Zone */}
        <div
          onDragOver={handleDragOverDaw}
          onDragLeave={handleDragLeaveDaw}
          onDrop={handleDropOnDaw}
          className="lt-workspace flex-1 flex flex-col overflow-hidden relative"
        >
          {/* Visual Drop Overlay when dragging a Repertoire Song or Audio Files */}
          {dragOverlayMode && (
            <div className="absolute inset-0 z-50 bg-studio-ground/90 border-2 border-dashed border-studio-line flex items-center justify-center p-8 pointer-events-none">
              <div className="bg-studio-panel border border-neutral-700 rounded-2xl p-8 text-center shadow-2xl max-w-md">
                {dragOverlayMode === 'repertoire-song' ? (
                  <>
                    <Music className="w-12 h-12 text-studio-ink mx-auto mb-3" />
                    <h2 className="text-xl font-bold text-neutral-100">
                      Suelta aquí para montar la canción en consola
                    </h2>
                    <p className="text-xs text-neutral-400 mt-1">
                      Se cargará en el Setlist y en el DAW inmediatamente.
                    </p>
                  </>
                ) : (
                  <>
                    <Upload className="w-12 h-12 text-studio-ink mx-auto mb-3" />
                    <h2 className="text-xl font-bold text-neutral-100">
                      Suelta tus Stems o Carpeta Aquí
                    </h2>
                    <p className="text-xs text-neutral-400 mt-1">
                      Se guardará como una sola canción en tu repertorio con su duración real en minutos y segundos.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* 1. DEDICATED SETLIST PAGE VIEW */}
          {activeView === 'setlist' && (
            <SetlistPageView
              project={currentProject}
              allProjects={projects}
              setlistQueue={setlistQueue}
              transport={transport}
              ramCacheVersion={ramCacheVersion}
              setlistTransitionMode={setlistTransitionMode}
              metersRef={metersRef}
              onPlayPause={handlePlayPause}
              onStop={handleStop}
              onToggleVamp={handleToggleVamp}
              onLoadAndPlaySong={(songId, autoPlay) =>
                handleLoadProjectImmediately(songId, autoPlay)
              }
              onRequestSongAction={(song) => setConfirmSongCandidate(song)}
              onAddToSetlist={handleAddToSetlist}
              onRemoveFromSetlist={handleRemoveFromSetlist}
              onMoveInSetlist={handleMoveInSetlist}
              onReorderSetlist={handleReorderSetlist}
              onOptimizeProject={handleStartOptimizeProject}
              onChangeSetlistTransitionMode={setSetlistTransitionMode}
              onChangeQuantize={handleChangeQuantize}
              onChangePitch={handleChangePitch}
              onChangeBpm={handleChangeBpm}
              onSeekSeconds={handleSeekSeconds}
              onJumpSection={handleJumpSection}
              onCancelQueuedJump={handleCancelQueuedJump}
              onAddMarkerAtPlayhead={handleAddMarkerAtPlayhead}
              onOpenSectionEditor={() => setIsSectionEditorOpen(true)}
              onAddStemsToCurrentSong={(files) =>
                handleInstantImportFiles(files, 'main', 'current-song')
              }
              onQuickImportNewSongFiles={(files) =>
                handleInstantImportFiles(files, 'main', 'new-song')
              }
              onToggleTrackMute={handleToggleTrackMute}
              onToggleTrackSolo={handleToggleTrackSolo}
              onChangeTrackGain={handleChangeTrackGain}
              onChangeTrackPan={handleChangeTrackPan}
              onChangeTrackBus={handleChangeTrackBus}
              onChangeClickGain={(gain) =>
                updateCurrentProject((p) => ({ ...p, clickGain: gain }))
              }
              onChangeClickPan={(pan) =>
                updateCurrentProject((p) => ({ ...p, clickPan: pan }))
              }
              onToggleClick={handleToggleClick}
              onChangeGuideGain={(gain) =>
                updateCurrentProject((p) => ({ ...p, guideGain: gain }))
              }
              onChangeGuidePan={(pan) =>
                updateCurrentProject((p) => ({ ...p, guidePan: pan }))
              }
              onToggleGuide={handleToggleGuide}
              onChangeMasterGain={(gain) =>
                updateCurrentProject((p) => ({ ...p, masterGain: gain }))
              }
              onChangeCueMasterGain={(gain) =>
                updateCurrentProject((p) => ({ ...p, cueMasterGain: gain }))
              }
              onResetMixer={handleResetMixer}
            />
          )}

          {/* LIVE SET: performance page */}
          {activeView === 'live' && (
            <LiveSetView
              project={currentProject}
              transport={transport}
              setlistQueue={setlistQueue}
              setlistTransitionMode={setlistTransitionMode}
              preparingIds={preparingIds}
              onPlayPause={handlePlayPause}
              onStop={handleStop}
              onPrevSong={handlePrevSetlistSong}
              onNextSong={() => handleNextSetlistSong(false)}
              onLoadSong={(songId) => handleLoadProjectImmediately(songId, false)}
              onSetAsNext={handleSetAsNextSong}
              onJumpSection={handleJumpSection}
              onCancelQueuedJump={handleCancelQueuedJump}
              onToggleVamp={handleToggleVamp}
              onChangeQuantize={handleChangeQuantize}
              onChangeTransitionMode={setSetlistTransitionMode}
              onGoToSetlist={() => handleSelectView('setlist')}
            />
          )}

          {/* 2. ARRANGER (DAW) VIEW */}
          {activeView === 'arranger' &&
            (currentProject ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <TimelineArranger
                  project={currentProject}
                  transport={transport}
                  metersRef={metersRef}
                  isDarkMode={true}
                  isDockedMixerOpen={isDockedMixerOpen}
                  onToggleDockedMixer={() => setIsDockedMixerOpen((prev) => !prev)}
                  onJumpSection={handleJumpSection}
                  onSeekSeconds={handleSeekSeconds}
                  onToggleTrackMute={handleToggleTrackMute}
                  onToggleTrackSolo={handleToggleTrackSolo}
                  onChangeTrackGain={handleChangeTrackGain}
                  onChangeTrackPan={handleChangeTrackPan}
                  onChangeTrackBus={handleChangeTrackBus}
                  onDeleteTrack={handleDeleteTrack}
                  onAddStemsToCurrentSong={(files) =>
                    handleInstantImportFiles(files, 'main', 'current-song')
                  }
                  onAddMarkerAtPlayhead={handleAddMarkerAtPlayhead}
                  onOpenImportModal={() => setIsImportModalOpen(true)}
                  onOpenSectionEditor={() => setIsSectionEditorOpen(true)}
                />

                {isDockedMixerOpen && (
                  <div
                    onClick={() => setIsDockedMixerOpen(false)}
                    className="fixed inset-0 z-50 bg-black/60 flex items-end justify-center p-3 sm:p-5"
                  >
                    <div
                      role="dialog"
                      aria-modal="true"
                      aria-label="Consola Mixer Flotante"
                      onClick={(e) => e.stopPropagation()}
                      className="w-full max-w-[1440px] bg-studio-panel border-2 border-studio-line rounded-2xl shadow-[0_24px_70px_rgba(0,0,0,0.9)] overflow-hidden flex flex-col max-h-[86vh]"
                    >
                      <div className="px-5 py-3 bg-studio-panel border-b border-studio-line flex items-center justify-between gap-4 shrink-0">
                        <div>
                          <h2 className="text-base font-bold text-white">
                            Consola Mixer — {currentProject.title}
                          </h2>
                          <p className="text-xs text-neutral-400">
                            Doble clic en fader = 0.0 dB · Doble clic en knob = Centrar (C) · Clic fuera para cerrar
                          </p>
                        </div>
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={handleResetMixer}
                            className="h-9 px-3.5 rounded-lg bg-studio-strip hover:bg-neutral-800 border border-studio-line text-xs font-semibold text-neutral-200 cursor-pointer"
                          >
                            Restablecer 0 dB
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsDockedMixerOpen(false)}
                            className="lt-control"
                          >
                            Cerrar mezcla
                          </button>
                        </div>
                      </div>
                      <div className="overflow-y-auto">
                        <MultitrackMixer
                          project={currentProject}
                          transport={transport}
                          metersRef={metersRef}
                          docked={true}
                          onToggleTrackMute={handleToggleTrackMute}
                          onToggleTrackSolo={handleToggleTrackSolo}
                          onChangeTrackGain={handleChangeTrackGain}
                          onChangeTrackPan={handleChangeTrackPan}
                          onChangeTrackBus={handleChangeTrackBus}
                          onChangeClickGain={(gain) =>
                            updateCurrentProject((p) => ({ ...p, clickGain: gain }))
                          }
                          onChangeClickPan={(pan) =>
                            updateCurrentProject((p) => ({ ...p, clickPan: pan }))
                          }
                          onToggleClick={handleToggleClick}
                          onChangeGuideGain={(gain) =>
                            updateCurrentProject((p) => ({ ...p, guideGain: gain }))
                          }
                          onChangeGuidePan={(pan) =>
                            updateCurrentProject((p) => ({ ...p, guidePan: pan }))
                          }
                          onToggleGuide={handleToggleGuide}
                          onChangeMasterGain={(gain) =>
                            updateCurrentProject((p) => ({ ...p, masterGain: gain }))
                          }
                          onChangeCueMasterGain={(gain) =>
                            updateCurrentProject((p) => ({ ...p, cueMasterGain: gain }))
                          }
                          onResetMixer={handleResetMixer}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-5 text-center">
                <FolderOpen className="w-12 h-12 text-studio-ink mb-3 opacity-80" />
                <h2 className="text-lg font-bold text-neutral-100">
                  Arreglo
                </h2>
                <p className="text-xs text-neutral-400 max-w-md mt-1 mb-5">
                  Abre una canción desde el Setlist o importa pistas para ver su forma de onda.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  <button type="button" onClick={() => handleSelectView('setlist')} className="lt-control">
                    Ir al Setlist
                  </button>
                  <button type="button" onClick={() => setIsImportModalOpen(true)} className="lt-primary">
                    Importar pistas
                  </button>
                </div>
              </div>
            ))}

          {/* 3. FULL MIXER VIEW */}
          {activeView === 'mixer' &&
            (currentProject ? (
              <MultitrackMixer
                project={currentProject}
                transport={transport}
                metersRef={metersRef}
                docked={false}
                onToggleTrackMute={handleToggleTrackMute}
                onToggleTrackSolo={handleToggleTrackSolo}
                onChangeTrackGain={handleChangeTrackGain}
                onChangeTrackPan={handleChangeTrackPan}
                onChangeTrackBus={handleChangeTrackBus}
                onChangeClickGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, clickGain: gain }))
                }
                onChangeClickPan={(pan) =>
                  updateCurrentProject((p) => ({ ...p, clickPan: pan }))
                }
                onToggleClick={handleToggleClick}
                onChangeGuideGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, guideGain: gain }))
                }
                onChangeGuidePan={(pan) =>
                  updateCurrentProject((p) => ({ ...p, guidePan: pan }))
                }
                onToggleGuide={handleToggleGuide}
                onChangeMasterGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, masterGain: gain }))
                }
                onChangeCueMasterGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, cueMasterGain: gain }))
                }
                onResetMixer={handleResetMixer}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-5 text-center">
                <Music className="w-10 h-10 text-studio-ink mb-3 opacity-80" />
                <h2 className="text-base font-bold text-neutral-100">
                  Mezcla
                </h2>
                <p className="text-xs text-neutral-400 max-w-md mt-1">
                  Abre una canción desde el Setlist para mezclar sus pistas.
                </p>
                <button type="button" onClick={() => handleSelectView('setlist')} className="lt-control mt-3">
                  Ir al Setlist
                </button>
              </div>
            ))}

          {/* 4. STAGE REMOTE VIEW */}
          {activeView === 'remote' &&
            (currentProject ? (
              <StageRemoteView
                project={currentProject}
                transport={transport}
                setlistQueue={setlistQueue}
                onJumpSection={handleJumpSection}
                onToggleClick={handleToggleClick}
                onToggleGuide={handleToggleGuide}
                onChangeQuantize={handleChangeQuantize}
                onChangeClickGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, clickGain: gain }))
                }
                onChangeGuideGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, guideGain: gain }))
                }
                onChangeMasterGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, masterGain: gain }))
                }
                onToggleTrackMute={handleToggleTrackMute}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-5 text-center">
                <Music className="w-10 h-10 text-studio-ink mb-3 opacity-80" />
                <h2 className="text-base font-bold text-neutral-100">
                  Control rápido
                </h2>
                <p className="text-xs text-neutral-400 max-w-md mt-1 mb-4">
                  Abre una canción desde Setlist o Arreglo para acceder a sus secciones y ajustes de mezcla.
                </p>
                <button
                  type="button"
                  onClick={() => handleSelectView('setlist')}
                  className="px-4 py-2 rounded-lg bg-studio-ink text-studio-ground hover:bg-neutral-200 text-xs font-bold cursor-pointer"
                >
                  Ir a Setlist
                </button>
              </div>
            ))}

          {/* 5. LIBRARY VIEW */}
          {activeView === 'library' && (
            <LibraryView
              projects={projects}
              currentProjectId={currentProject?.id || null}
              onSelectProject={(projectId) => {
                const found = projects.find((p) => p.id === projectId);
                if (found) setConfirmSongCandidate(found);
              }}
              onAddToSetlist={handleAddToSetlist}
              onCreateNewProject={handleCreateNewProject}
              onDeleteProject={handleDeleteProject}
              onExportJson={handleExportJson}
              onImportJsonFile={handleImportJsonFile}
              onOpenStemImporter={() => setIsImportModalOpen(true)}
              onOptimizeProject={handleStartOptimizeProject}
              onRelinkProject={handleRelinkProject}
            />
          )}
        </div>
      </div>

      {/* Repertoire Click Confirmation Modal */}
      <ConfirmSongActionModal
        song={confirmSongCandidate}
        currentSongId={currentProject?.id || null}
        isInSetlist={
          confirmSongCandidate
            ? setlistQueue.some((s) => s.id === confirmSongCandidate.id)
            : false
        }
        onClose={() => setConfirmSongCandidate(null)}
        onConfirmLoadInDaw={(songId) => {
          handleAddToSetlist(songId);
          handleLoadProjectImmediately(songId, false);
        }}
        onConfirmAddToSetlist={(songId) => handleAddToSetlist(songId)}
      />

      {/* Stem Importer Modal */}
      <StemImporterModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImportFiles={(files, defaultBus, importMode) =>
          handleInstantImportFiles(files, defaultBus, importMode)
        }
      />

      {/* Time-Based (MM:SS) Section Editor Modal */}
      {isSectionEditorOpen && currentProject && (
        <SectionEditorModal
          isOpen={isSectionEditorOpen}
          project={currentProject}
          currentTimeSec={transport.currentTimeSec}
          totalDurationSec={transport.totalDurationSec}
          onClose={() => setIsSectionEditorOpen(false)}
          onSaveSections={handleSaveSections}
        />
      )}

      {/* OPFS Streaming PCM Optimization Progress Modal */}
      <OptimizationProgressModal
        isOpen={Boolean(optimizingProject)}
        songTitle={optimizingProject?.title || ''}
        progress={optimizationProgress}
        onCancel={handleCancelOptimization}
        onHide={() => {
          modalProjectIdRef.current = null;
          setOptimizingProject(null);
          setOptimizationProgress(null);
        }}
      />

      {DesktopRemoteBridge && remoteTriggerRef && (
        <React.Suspense fallback={null}>
          <DesktopRemoteBridge
            project={currentProject}
            setlist={setlistQueue}
            activationCount={activationCountRef}
            updateProject={updateCurrentProject}
            triggerHost={remoteTriggerHost}
          />
        </React.Suspense>
      )}

      {DesktopAudioSettings && audioTriggerRef && (
        <React.Suspense fallback={null}>
          <DesktopAudioSettings triggerHost={audioTriggerHost} />
        </React.Suspense>
      )}

      {/* Non-intrusive Action Feedback Toast */}
      {toastMessage && (
        <div
          role="status"
          className="fixed bottom-3 right-3 z-50 bg-neutral-800 border border-studio-line text-white px-4 py-2.5 rounded-xl text-xs font-medium shadow-lg"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
