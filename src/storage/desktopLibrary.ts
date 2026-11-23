/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SongProject } from '../types/project';
import { isDesktopApp } from '../utils/nativeDialog';
import { notifyUser } from '../utils/userNotices';
import { FailureTracker } from './failureTracker';

export interface LibraryFilePayload {
  version: number;
  updatedAt: number;
  activeSetlist: string[];
  songs: SongProject[];
}

/**
 * Loads the library index from %LOCALAPPDATA%/org.omnitracks.desktop/library.json.
 * If absent, the Rust backend creates an empty library.json and returns it.
 *
 * Devuelve `null` solo cuando no hay escritorio (navegador). Si el archivo existe pero no se puede leer (bloqueado,
 * corrupto sin respaldo válido…) LANZA el error: devolver `null` o una lista vacía haría pasar un fallo de lectura por
 * «biblioteca vacía» y el usuario creería que perdió sus canciones.
 */
export async function loadDesktopLibrary(): Promise<LibraryFilePayload | null> {
  if (!isDesktopApp()) return null;
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return null;
  try {
    return await invoke('library_load');
  } catch (err) {
    console.error('[Library] Error cargando library.json desde disco:', err);
    throw new Error(typeof err === 'string' ? err : (err as { message?: string } | null)?.message ?? String(err));
  }
}


/**
 * Upserts a single song into library.json and updates its omnitracks.project.json sidecar.
 */
export async function saveDesktopSong(song: SongProject): Promise<void> {
  if (!isDesktopApp()) return;
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return;
  try {
    const outcome = await invoke('library_save_song', { song });
    saveFailures.report('library', null);
    // La biblioteca se guardó; si el archivo de la carpeta de la canción no se pudo escribir, se avisa (una vez por
    // fallo): la mezcla no quedó junto a sus pistas.
    const sidecarError = typeof outcome?.sidecarError === 'string' ? outcome.sidecarError : null;
    if (sidecarFailures.report(song.id, sidecarError)) {
      console.warn(`[Library] Sidecar de '${song.id}' sin escribir: ${sidecarError}`);
      notifyUser(
        `«${song.title}»: se guardó en la biblioteca, pero no en su carpeta (¿sin conexión, de solo lectura o bloqueada?). Detalle en la consola.`
      );
    }
  } catch (err) {
    console.error(`[Library] Error guardando canción '${song.id}' en library.json:`, err);
    if (saveFailures.report('library', String(err))) {
      notifyUser(`No se pudo guardar «${song.title}» en la biblioteca. Detalle en la consola.`);
    }
  }
}

// Un fallo que se repite en cada guardado avisa una sola vez (ver `FailureTracker`).
const saveFailures = new FailureTracker();
const sidecarFailures = new FailureTracker();

/**
 * Permanently removes a song from library.json and deletes its native PCM cache (pcm/<id>). Si la biblioteca falla,
 * lanza; si solo falla el borrado de la caché, lo devuelve en `cacheError`.
 * Original audio files are NEVER touched or removed.
 */
export async function deleteDesktopSong(songId: string): Promise<{ cacheError: string | null }> {
  if (!isDesktopApp()) return { cacheError: null };
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return { cacheError: null };
  try {
    const outcome = await invoke('library_delete_song', { songId });
    return { cacheError: typeof outcome?.cacheError === 'string' ? outcome.cacheError : null };
  } catch (err) {
    // El error sube: si la biblioteca no pudo borrarla, quitarla de la pantalla la haría reaparecer al reabrir.
    console.error(`[Library] Error eliminando canción '${songId}' de la biblioteca:`, err);
    throw err;
  }
}

/**
 * Cambios del setlist hechos por Rust sobre la biblioteca del disco: solo cambian la pertenencia y el orden, no
 * reescriben una copia completa que la interfaz pudiera tener desactualizada. Si el comando falla, el error sube a
 * quien llama (que debe avisar al usuario: el setlist en pantalla y el del disco ya no coincidirían).
 */
export async function removeSongFromDesktopSetlist(songId: string): Promise<boolean> {
  if (!isDesktopApp()) return false;
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return false;
  return Boolean(await invoke('library_setlist_remove', { songId }));
}

export async function clearDesktopSetlist(): Promise<number> {
  if (!isDesktopApp()) return 0;
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return 0;
  return Number(await invoke('library_setlist_clear')) || 0;
}

export async function reorderDesktopSetlist(songIds: string[]): Promise<void> {
  if (!isDesktopApp()) return;
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return;
  await invoke('library_setlist_reorder', { songIds });
}

/**
 * Updates the folder path for a song that has been moved on disk.
 */
export async function updateDesktopSongFolder(
  songId: string,
  newFolderPath: string
): Promise<void> {
  if (!isDesktopApp()) return;
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return;
  try {
    await invoke('library_update_song_folder', { songId, newFolderPath });
  } catch (err) {
    console.error(`[Library] Error actualizando ruta de carpeta para '${songId}':`, err);
    throw err;
  }
}

/**
 * Reads omnitracks.project.json (or fallback .omnitracks.json) from a folder.
 */
/**
 * Picos de forma de onda de una canción, por ID de pista. La biblioteca solo trae los de las canciones del setlist;
 * esto los pide al añadir otra al setlist. Devuelve `{}` si no hay o si falla (el fallo queda en la consola).
 */
export async function loadDesktopSongPeaks(songId: string): Promise<Record<string, number[]>> {
  if (!isDesktopApp()) return {};
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return {};
  try {
    return (await invoke('library_get_song_peaks', { songId })) ?? {};
  } catch (err) {
    console.warn(`[Library] No se pudieron leer los picos de '${songId}':`, err);
    return {};
  }
}
