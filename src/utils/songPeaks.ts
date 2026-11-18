import type { SongProject } from '../types/project';

/** Picos de forma de onda por ID de pista, tal como los guarda el motor (`peaks/<canción>.json`). */
export type SongPeaks = Record<string, number[]>;

/** `true` si alguna pista de la canción no trae picos (la interfaz los recibe solo de las canciones del setlist). */
export function songLacksPeaks(project: SongProject): boolean {
  return project.tracks.some((track) => !track.peaks || track.peaks.length === 0);
}

/**
 * Pone los picos pedidos al motor en las pistas que no los tienen. No pisa picos que la pista ya trae (los del
 * motor al abrir la canción mandan) y devuelve el mismo objeto si no hay nada que añadir, para no renderizar de más.
 */
export function withSongPeaks(project: SongProject, peaks: SongPeaks): SongProject {
  let changed = false;
  const tracks = project.tracks.map((track) => {
    if (track.peaks && track.peaks.length > 0) return track;
    const found = peaks[track.id];
    if (!Array.isArray(found) || found.length === 0) return track;
    changed = true;
    return { ...track, peaks: found };
  });
  return changed ? { ...project, tracks } : project;
}
