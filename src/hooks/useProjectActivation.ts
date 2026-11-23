import { useCallback, useEffect, useRef, useState } from 'react';
import { projectSaves } from '../storage/projectSaves';
import { audioEngine } from '../audio/audioEngine';
import { logAsyncError } from '../utils/asyncErrors';
import { debugMode } from '../utils/debugMode';
import { normalizeProjectSectionsToTime } from '../storage/projectDb';
import { resolveTransition } from '../utils/setlistTransition';
import { withLatestSetlistState } from '../utils/setlistMerge';
import type { SetlistTransitionMode, SongProject } from '../types/project';

/** `mounted`: la canción quedó montada; `superseded`: se eligió otra después (no es un fallo); `failed`: no se pudo montar. */
export type ActivationResult = 'mounted' | 'superseded' | 'failed';

interface Deps {
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  /** La lista de canciones más reciente (se lee al terminar de montar, no al empezar). */
  projectsRef: React.MutableRefObject<SongProject[]>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setlistQueue: SongProject[];
  setlistTransitionMode: SetlistTransitionMode;
  isDesktopApp: boolean;
  showToast: (msg: string) => void;
}

/**
 * Montar una canción en el motor (`activateProject`), pasar a la anterior o a la siguiente del setlist y qué
 * hacer al terminar una canción (la flecha de la propia canción manda; sin ella, el ajuste general).
 */
export function useProjectActivation({
  currentProjectRef,
  projectsRef,
  setCurrentProject,
  setProjects,
  setlistQueue,
  setlistTransitionMode,
  isDesktopApp,
  showToast,
}: Deps) {
  // Counts in-flight activateProject() calls so next-song preload waits for the active song to finish decoding
  const activationCountRef = useRef(0);
  /** Número de la última activación pedida: solo esa puede publicar su resultado (la última orden manda). */
  const activationSeqRef = useRef(0);
  const [isActivatingProject, setIsActivatingProject] = useState(false);

  // Activate a project using cached AudioBuffers if available and log console.info metrics
  const activateProject = useCallback(
    async (
      projectToLoad: SongProject,
      predecodedBuffers?: Map<string, AudioBuffer>,
      explicitPlayIfAlreadyInRam = false
    ): Promise<ActivationResult> => {
      const t0 = performance.now();
      const seq = ++activationSeqRef.current;
      const superseded = () => seq !== activationSeqRef.current;
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

        const { peaksMap, wasCancelled } = await audioEngine.loadProject(normalizedProj, cachedBuffers);

        // Si el usuario eligió otra canción mientras esta se montaba, esta ya no publica nada ni reproduce.
        if (wasCancelled || superseded()) {
          debugMode.trace('carga', () => `activación de ${normalizedProj.id} descartada (superada por otra más reciente)`);
          return 'superseded';
        }

        const playable = normalizedProj.tracks.length === 0 || audioEngine.hasPlayableAudio();
        if (!playable) {
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
          currentProjectRef.current?.id === normalizedProj.id ? currentProjectRef.current : normalizedProj;
        const enrichedTracks = latestBase.tracks.map((t) => ({
          ...t,
          peaks: peaksMap.get(t.id) || t.peaks || [],
        }));

        const updatedProject: SongProject = withLatestSetlistState(
          {
            ...latestBase,
            durationSec: realDurationSec,
            tracks: enrichedTracks,
          },
          projectsRef.current.find((p) => p.id === normalizedProj.id)
        );

        setCurrentProject(updatedProject);
        audioEngine.updateProjectConfig(updatedProject);
        void projectSaves.saveNow(updatedProject);
        setProjects((prev) => {
          const exists = prev.some((p) => p.id === updatedProject.id);
          if (!exists) return [updatedProject, ...prev];
          return prev.map((p) => (p.id === updatedProject.id ? updatedProject : p));
        });

        // Never start spontaneous playback after a slow disk load;
        // only play if explicitly requested AND the song was already 100% ready in RAM / staged streaming
        if (explicitPlayIfAlreadyInRam && (cameFromCache || isDesktopApp) && audioEngine.hasPlayableAudio()) {
          void audioEngine.play();
        }
        return playable ? 'mounted' : 'failed';
      } catch (err) {
        console.error('Error loading project into engine:', err);
        debugMode.error(`montar «${projectToLoad.title}»`, err);
        return 'failed';
      } finally {
        activationCountRef.current = Math.max(0, activationCountRef.current - 1);
        if (activationCountRef.current === 0) setIsActivatingProject(false);
      }
    },
    [showToast, projectsRef]
  );

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

      // «Lista» lo dice el motor (caché en disco al día), no el campo `pcm` de las pistas en React, que puede estar
      // sin rellenar aunque la caché exista y dejaba la siguiente montada y en pausa en pleno servicio.
      let cacheReady = false;
      if (autoPlay) {
        try {
          cacheReady = (await audioEngine.checkProjectCacheStatus(nextSong)).isReady;
        } catch (err) {
          debugMode.error('comprobar la caché de la siguiente canción', err);
        }
      }
      const result = await activateProject(nextSong, undefined, autoPlay && cacheReady);
      if (result === 'superseded') return;
      if (result === 'failed') {
        showToast(`No se pudo montar la siguiente canción: ${nextSong.title}. Revisa sus archivos o pulsa «Generar caché nativa».`);
        return;
      }
      showToast(
        autoPlay && cacheReady
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
      const result = await activateProject(prevSong, undefined, false);
      if (result === 'superseded') return;
      showToast(
        result === 'mounted'
          ? `Canción anterior cargada en 00:00: ${prevSong.title}`
          : `No se pudo montar la canción anterior: ${prevSong.title}.`
      );
    }
  }, [activateProject, setlistQueue, showToast]);

  // Connect Setlist End-of-Song Transition Callback
  useEffect(() => {
    audioEngine.setOnSongEnded(() => {
      // La flecha de la propia canción manda; sin ella, el ajuste general.
      const mode = resolveTransition(currentProjectRef.current, setlistTransitionMode);
      if (mode === 'cue-next') {
        handleNextSetlistSong(false);
      } else if (mode === 'auto-play') {
        handleNextSetlistSong(true);
      }
    });
    return () => audioEngine.setOnSongEnded(null);
  }, [handleNextSetlistSong, setlistTransitionMode]);

  return { activateProject, activationCountRef, isActivatingProject, handleNextSetlistSong, handlePrevSetlistSong };
}
