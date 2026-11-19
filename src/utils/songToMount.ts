import type { SongProject } from '../types/project';

/**
 * Qué canción montar en el DAW cuando está vacío: la primera del setlist; sin setlist, la usada más
 * recientemente; si ninguna se usó, la última importada (las nuevas se añaden al principio de la lista).
 * Sin canciones devuelve `null`.
 */
export function pickSongToMount(projects: SongProject[], setlistQueue: SongProject[]): SongProject | null {
  if (setlistQueue.length > 0) return setlistQueue[0];
  if (projects.length === 0) return null;
  return projects.reduce((best, candidate) => {
    const bestUsed = best.lastUsedAt ?? 0;
    const used = candidate.lastUsedAt ?? 0;
    return used > bestUsed ? candidate : best;
  }, projects[0]);
}
