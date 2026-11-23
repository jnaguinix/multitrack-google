import type { TrackChannel } from '../types/project';

/**
 * Las consolas muestran UN fader de Click y UNO de Guía. Si la canción trae varias pistas de cada una (importada con
 * dos archivos «Click»), el fader las gobierna todas: antes solo mandaba la primera y las demás sonaban sin control.
 * Al alternar mute o solo, solo se tocan las que tienen el mismo estado que la que se muestra, para que el grupo
 * quede unificado (y no cada pista al revés de la otra).
 */
export function groupToggleTargets(group: TrackChannel[], flag: 'muted' | 'soloed'): string[] {
  const first = group[0];
  if (!first) return [];
  return group.filter((t) => Boolean(t[flag]) === Boolean(first[flag])).map((t) => t.id);
}
