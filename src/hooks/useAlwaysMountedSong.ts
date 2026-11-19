import { useEffect } from 'react';
import { pickSongToMount } from '../utils/songToMount';
import type { SongProject } from '../types/project';

interface Deps {
  projects: SongProject[];
  currentProject: SongProject | null;
  setlistQueue: SongProject[];
  /** Hay una canción montándose o una importación en curso: no se monta otra encima. */
  busy: boolean;
  activateProject: (project: SongProject, predecoded?: undefined, play?: boolean) => Promise<void>;
}

/**
 * El DAW siempre tiene una canción: al abrir la app, al importar la primera o al borrar la que estaba montada se
 * monta otra (la primera del setlist o, sin setlist, la más reciente). Sin esto, Setlist y En vivo quedan vacíos.
 * Solo monta (en pausa, 00:00): nunca reproduce.
 */
export function useAlwaysMountedSong({ projects, currentProject, setlistQueue, busy, activateProject }: Deps) {
  useEffect(() => {
    if (currentProject || busy) return;
    const song = pickSongToMount(projects, setlistQueue);
    if (!song) return;
    void activateProject(song, undefined, false);
  }, [currentProject, busy, projects, setlistQueue, activateProject]);
}
