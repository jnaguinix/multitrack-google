import { useCallback, useEffect, useRef } from 'react';
import { audioEngine } from '../audio/audioEngine';
import { isContinuousOnly } from '../audio/controlSync';
import { loadAllProjectsFromDb } from '../storage/projectDb';
import { projectSaves } from '../storage/projectSaves';
import { flightRecorder } from '../utils/flightRecorder';
import { logAsyncError } from '../utils/asyncErrors';
import { onUserNotice } from '../utils/userNotices';
import { findDuplicateTrackIds } from '../utils/trackIds';
import type { SongProject } from '../types/project';

interface Deps {
  projects: SongProject[];
  projectsRef: React.MutableRefObject<SongProject[]>;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  showToast: (msg: string) => void;
}

/**
 * Biblioteca en memoria y su guardado: carga inicial, `updateCurrentProject` (motor + guardado, en orden), vaciar
 * lo pendiente al ocultar la ventana y el aviso de pistas con ID repetido.
 */
export function useProjectPersistence({
  projects,
  projectsRef,
  currentProjectRef,
  setProjects,
  setCurrentProject,
  showToast,
}: Deps) {
  // Avisos de las capas de almacenamiento (p. ej. el archivo de la carpeta de una canción que no se pudo escribir).
  useEffect(() => onUserNotice(showToast), [showToast]);

  // Initial load from IndexedDB: carga la lista del repertorio; montar una canción en el DAW lo hace `useAlwaysMountedSong`
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const saved = await loadAllProjectsFromDb();
        if (!mounted) return;
        setProjects(saved);
        projectsRef.current = saved;
      } catch (err) {
        // La biblioteca queda vacía, pero el fallo no puede pasar en silencio: parecería que se perdieron las canciones.
        logAsyncError('cargar la biblioteca')(err);
        showToast('No se pudo cargar la biblioteca. Revisa la consola o reinicia la app.');
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  // Mutate and persist current project helper
  const updateCurrentProject = useCallback(
    (updater: (prev: SongProject) => SongProject) => {
      // Nada de efectos secundarios dentro de un actualizador de estado: se calcula aquí, una sola vez, y el motor
      // recibe solo la diferencia, en orden. `currentProjectRef` se adelanta para que dos cambios seguidos (p. ej.
      // un solo y un volumen en el mismo instante) se compongan en vez de pisarse.
      const prev = currentProjectRef.current;
      if (!prev) return;
      const next = updater(prev);
      if (next === prev) return;
      currentProjectRef.current = next;
      setCurrentProject(next);
      const ops = audioEngine.applyProjectChange(prev, next);
      setProjects((list) => list.map((item) => (item.id === next.id ? next : item)));
      // Arrastrar un fader no escribe el disco con cada píxel: se agrupa y se guarda el último valor.
      if (isContinuousOnly(ops)) projectSaves.schedule(next);
      else void projectSaves.saveNow(next);
    },
    []
  );

  // Al ocultar o cerrar la ventana se vacía lo pendiente de guardar.
  useEffect(() => {
    const flush = () => void projectSaves.flushAll();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // Aviso (una vez por canción) si hay pistas con ID repetido: el motor solo direcciona la primera.
  const warnedDuplicateIds = useRef(new Set<string>());
  useEffect(() => {
    for (const p of projects) {
      const dup = findDuplicateTrackIds(p.tracks);
      if (dup.length === 0 || warnedDuplicateIds.current.has(p.id)) continue;
      warnedDuplicateIds.current.add(p.id);
      flightRecorder.record('ids-repetidos', `${p.title}: ${dup.join(', ')}`);
      showToast(`«${p.title}» tiene pistas con ID repetido (${dup.join(', ')}). Reimporta la carpeta para corregirlo.`);
    }
  }, [projects, showToast]);

  return updateCurrentProject;
}
