import { useState } from 'react';
import { audioEngine } from '../audio/audioEngine';
import { deleteProjectFromDb } from '../storage/projectDb';
import { deleteProjectNativeCache } from '../utils/nativeDialog';
import type { SongProject, TransportState } from '../types/project';

interface Deps {
  projects: SongProject[];
  currentProject: SongProject | null;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  transport: TransportState;
  isDesktopApp: boolean;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  showToast: (msg: string) => void;
}

/** Eliminar una canción de la biblioteca (tras confirmarlo): los archivos originales no se tocan. */
export function useLibraryDeletion({
  projects,
  currentProject,
  currentProjectRef,
  transport,
  isDesktopApp,
  setProjects,
  setCurrentProject,
  showToast,
}: Deps) {
  const [songToDeleteFromLibrary, setSongToDeleteFromLibrary] = useState<SongProject | null>(null);

  const confirmDeleteFromLibrary = async () => {
    if (!songToDeleteFromLibrary) return;
    const song = songToDeleteFromLibrary;
    setSongToDeleteFromLibrary(null);

    if (currentProjectRef.current?.id === song.id && transport.isPlaying) {
      audioEngine.stop();
    }

    audioEngine.evictSongFromRamCache(song.id);
    await deleteProjectFromDb(song.id);
    if (isDesktopApp) {
      deleteProjectNativeCache(song.id).catch((err: any) => {
        console.error('[Cache] Error al eliminar carpeta de caché nativa:', err);
      });
    }

    const remaining = projects.filter((p) => p.id !== song.id);
    setProjects(remaining);
    if (currentProject?.id === song.id) {
      setCurrentProject(null);
    }
    showToast(`"${song.title}" eliminada de la biblioteca (archivos originales intactos)`);
  };

  return { songToDeleteFromLibrary, setSongToDeleteFromLibrary, confirmDeleteFromLibrary };
}
