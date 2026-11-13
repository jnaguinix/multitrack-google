import type { SetlistTransitionMode, SongProject } from '../types/project';

export const TRANSITION_LABELS: Record<SetlistTransitionMode, string> = {
  stop: 'Detener',
  'cue-next': 'Preparar la siguiente',
  'auto-play': 'Reproducir la siguiente',
};

/**
 * Qué hacer al terminar una canción: la opción propia de esa canción (la flecha entre fichas del
 * setlist) o, si no tiene, el ajuste general de reproducción.
 */
export function resolveTransition(
  song: Pick<SongProject, 'transitionToNext'> | null | undefined,
  globalMode: SetlistTransitionMode
): SetlistTransitionMode {
  const own = song?.transitionToNext;
  return own === 'stop' || own === 'cue-next' || own === 'auto-play' ? own : globalMode;
}
