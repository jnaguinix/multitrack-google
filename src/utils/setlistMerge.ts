import type { SongProject } from '../types/project';

/**
 * Al terminar de montar una canción, `activateProject` guarda una copia construida con lo que sabía AL EMPEZAR. Si
 * entre tanto cambió su pertenencia al setlist (p. ej. «Montar en consola» desde la Biblioteca añade la canción y la
 * monta seguidas, y la segunda orden lee la lista todavía sin actualizar), esa copia la sacaba del setlist. Aquí se
 * toman de la lista más reciente solo `inSetlist` y `setlistOrder`; el resto es lo que montó la activación.
 */
export function withLatestSetlistState(project: SongProject, latest: SongProject | null | undefined): SongProject {
  if (!latest || latest.id !== project.id) return project;
  if (latest.inSetlist === project.inSetlist && latest.setlistOrder === project.setlistOrder) return project;
  return { ...project, inSetlist: latest.inSetlist, setlistOrder: latest.setlistOrder };
}
