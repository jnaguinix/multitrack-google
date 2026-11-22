import type { SongProject } from '../types/project';

/**
 * Resultado de cargar la biblioteca. Una biblioteca realmente vacía es `ok` con lista vacía; un fallo de lectura es
 * `ok: false` con el motivo: la pantalla no debe mostrar «sin canciones» cuando en realidad no se pudieron leer.
 */
export type LibraryLoadResult = { ok: true; projects: SongProject[] } | { ok: false; message: string };

/** Mensaje legible de un error de carga (los de Rust llegan como texto). */
export function describeLoadError(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error.trim();
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  return 'error desconocido';
}

export async function tryLoadLibrary(load: () => Promise<SongProject[]>): Promise<LibraryLoadResult> {
  try {
    return { ok: true, projects: await load() };
  } catch (error) {
    // catch-ok: el fallo no se pierde, vuelve en el resultado y quien llama lo registra y lo muestra (aviso persistente)
    return { ok: false, message: describeLoadError(error) };
  }
}
