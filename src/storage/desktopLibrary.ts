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
 */
export async function loadDesktopLibrary(): Promise<LibraryFilePayload | null> {
  if (!isDesktopApp()) return null;
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return null;
  try {
    return await invoke('library_load');
  } catch (err) {
    console.error('[Library] Error cargando library.json desde disco:', err);
    return null;
  }
}

/**
 * Saves the entire library state (active setlist + songs) atomically to library.json.
 */
export async function saveDesktopLibrary(library: LibraryFilePayload): Promise<void> {
  if (!isDesktopApp()) return;
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return;
  try {
    await invoke('library_save', { library });
  } catch (err) {
    console.error('[Library] Error guardando library.json:', err);
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
 * Permanently removes a song from library.json and deletes its native PCM cache (pcm/<id>).
 * Original audio files are NEVER touched or removed.
 */
export async function deleteDesktopSong(songId: string): Promise<void> {
  if (!isDesktopApp()) return;
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return;
  try {
    await invoke('library_delete_song', { songId });
  } catch (err) {
    console.error(`[Library] Error eliminando canción '${songId}' de la biblioteca:`, err);
  }
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

export async function readDesktopSidecar(folderPath: string): Promise<any | null> {
  if (!isDesktopApp()) return null;
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return null;
  try {
    return await invoke('library_read_sidecar', { folderPath });
  } catch (err) {
    console.warn(`[Sidecar] No se pudo leer sidecar de '${folderPath}':`, err);
    return null;
  }
}
