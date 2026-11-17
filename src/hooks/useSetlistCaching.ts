import { useEffect, useState } from 'react';
import { audioEngine } from '../audio/audioEngine';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';
import type { SongProject } from '../types/project';

interface Deps {
  setlistQueue: SongProject[];
  currentProjectId: string | undefined;
  isActivatingProject: boolean;
  isDesktopApp: boolean;
}

/**
 * Caché de las canciones del setlist: estado real de cada una, precarga de la siguiente y prioridad (actual +
 * siguiente). Devuelve un contador que cambia cuando cambia el estado de alguna caché, para redibujar las fichas.
 */
export function useSetlistCaching({ setlistQueue, currentProjectId, isActivatingProject, isDesktopApp }: Deps) {
  const [ramCacheVersion, setRamCacheVersion] = useState<number>(0);

  // Subscribe to RAM cache status updates to refresh Setlist card badges
  useEffect(() => {
    const unsubscribeCache = audioEngine.subscribeCache(() => {
      setRamCacheVersion((v) => v + 1);
    });
    return unsubscribeCache;
  }, []);

  // Escritorio: la caché PCM nativa avisa por nativeAudioEngine (no por audioEngine). Sin esta
  // suscripción las tarjetas del setlist y de En vivo no se redibujan al avanzar/terminar la generación.
  useEffect(() => {
    if (!isDesktopApp) return;
    return nativeAudioEngine.subscribeCache(() => {
      setRamCacheVersion((v) => v + 1);
    });
  }, [isDesktopApp]);

  // Escritorio: consultar el estado real de la caché de cada canción del setlist al abrir la app
  // y cada vez que cambia el conjunto de canciones/pistas.
  const setlistCacheKey = setlistQueue.map((s) => `${s.id}:${s.tracks.length}`).join('|');
  useEffect(() => {
    if (!isDesktopApp || setlistQueue.length === 0) return;
    nativeAudioEngine.refreshCacheStatuses(setlistQueue).catch((err) => {
      console.error('[Cache] Error consultando el estado de la caché del setlist:', err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktopApp, setlistCacheKey]);

  // CACHÉ Y PRECARGA DE LA SIGUIENTE CANCIÓN:
  // Cuando una canción del setlist queda activa o el setlist cambia, recalcula cuál es la siguiente
  // y llama a preloadProject(nextSong) en segundo plano (manteniendo máx. 2 canciones en caché: actual + siguiente).
  useEffect(() => {
    if (setlistQueue.length === 0) return;
    // Wait until loadProject() has finished: avoids competing for decodeAudioData / eviction
    if (isActivatingProject) return;

    const activeIdx = currentProjectId ? setlistQueue.findIndex((s) => s.id === currentProjectId) : -1;

    const nextSong =
      activeIdx >= 0 && activeIdx < setlistQueue.length - 1
        ? setlistQueue[activeIdx + 1]
        : activeIdx === -1 && setlistQueue.length > 0
        ? setlistQueue[0]
        : null;

    if (!nextSong || nextSong.id === currentProjectId) return;

    const timerId = window.setTimeout(() => {
      audioEngine.preloadProject(nextSong).catch((err) => {
        console.error('Error preloading next setlist song:', err);
      });
    }, 100);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [setlistQueue, currentProjectId, isActivatingProject]);

  // Keep the active song + the next setlist song as eviction-protected (priority) in RAM.
  // With nothing active yet, the first two songs of the setlist are the priority pair.
  useEffect(() => {
    const activeIdx = currentProjectId ? setlistQueue.findIndex((s) => s.id === currentProjectId) : -1;
    const ids: string[] = [];
    if (currentProjectId) ids.push(currentProjectId);
    const nextIdx = activeIdx >= 0 ? activeIdx + 1 : 0;
    if (setlistQueue[nextIdx]) ids.push(setlistQueue[nextIdx].id);
    if (!currentProjectId && setlistQueue[1]) ids.push(setlistQueue[1].id);
    audioEngine.setPriorityProjectIds(ids);
  }, [setlistQueue, currentProjectId]);

  return ramCacheVersion;
}
