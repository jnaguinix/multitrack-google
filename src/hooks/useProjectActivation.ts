import { useCallback, useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/audioEngine';
import { logAsyncError } from '../utils/asyncErrors';
import { normalizeProjectSectionsToTime, saveProjectToDb } from '../storage/projectDb';
import { resolveTransition } from '../utils/setlistTransition';
import type { SetlistTransitionMode, SongProject } from '../types/project';

interface Deps {
  currentProjectRef: React.MutableRefObject<SongProject | null>;
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
  setCurrentProject,
  setProjects,
  setlistQueue,
  setlistTransitionMode,
  isDesktopApp,
  showToast,
}: Deps) {
  // Counts in-flight activateProject() calls so next-song preload waits for the active song to finish decoding
  const activationCountRef = useRef(0);
  const [isActivatingProject, setIsActivatingProject] = useState(false);

  // Activate a project using cached AudioBuffers if available and log console.info metrics
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

        const { peaksMap, wasCancelled } = await audioEngine.loadProject(normalizedProj, cachedBuffers);

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
          currentProjectRef.current?.id === normalizedProj.id ? currentProjectRef.current : normalizedProj;
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
        saveProjectToDb(updatedProject).catch(logAsyncError('guardar la canción'));
        setProjects((prev) => {
          const exists = prev.some((p) => p.id === updatedProject.id);
          if (!exists) return [updatedProject, ...prev];
          return prev.map((p) => (p.id === updatedProject.id ? updatedProject : p));
        });

        // Never start spontaneous playback after a slow disk load;
        // only play if explicitly requested AND the song was already 100% ready in RAM / staged streaming
        if (explicitPlayIfAlreadyInRam && (cameFromCache || isDesktopApp) && audioEngine.hasPlayableAudio()) {
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
