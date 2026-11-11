/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Native desktop dialog and file system import helpers for OmniTracks Desktop (Tauri v2).
 * On desktop, this completely bypasses browser file inputs and array buffer transfers,
 * passing native file system paths directly to the Rust native audio engine.
 */

export interface ScannedAudioFile {
  filePath: string;
  fileName: string;
  trackName: string;
  trackId: string;
  estDurationSec?: number | null;
}

export interface ScannedFolderInfo {
  folderPath: string;
  folderName: string;
  title: string;
  artist: string;
  bpm?: number | null;
  key?: string | null;
  sections: Array<{
    id: string;
    name: string;
    code?: string | null;
    startSec: number;
    endSec: number;
  }>;
  files: ScannedAudioFile[];
}

export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI__);
}

export async function pickNativeFolder(): Promise<string | null> {
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return null;
  try {
    const res = await invoke('plugin:dialog|open', {
      options: {
        title: 'Seleccionar carpeta de pistas',
        directory: true,
        multiple: false,
      },
    });
    if (typeof res === 'string') return res;
    if (Array.isArray(res) && res.length > 0 && typeof res[0] === 'string') return res[0];
    return null;
  } catch (err) {
    console.warn('[NativeDialog] Error abriendo selector nativo de carpeta:', err);
    return null;
  }
}

export async function pickNativeFiles(): Promise<string[] | null> {
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) return null;
  try {
    const res = await invoke('plugin:dialog|open', {
      options: {
        title: 'Seleccionar pistas de audio',
        directory: false,
        multiple: true,
        filters: [
          {
            name: 'Audio',
            extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'opus', 'aif', 'aiff', 'caf'],
          },
        ],
      },
    });
    if (Array.isArray(res)) return res as string[];
    if (typeof res === 'string') return [res];
    return null;
  } catch (err) {
    console.warn('[NativeDialog] Error abriendo selector nativo de archivos:', err);
    return null;
  }
}

export async function scanNativeFolder(folderPath: string): Promise<ScannedFolderInfo> {
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) throw new Error('Tauri no disponible');
  return await invoke('audio_scan_folder', { folderPath });
}

export async function scanNativeFiles(filePaths: string[]): Promise<ScannedFolderInfo> {
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) throw new Error('Tauri no disponible');
  return await invoke('audio_scan_files', { filePaths });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function importTrackBytesRaw(
  projectId: string,
  trackId: string,
  fileName: string,
  bytes: Uint8Array,
  targetSampleRate?: number
): Promise<any> {
  const invoke = (window as any).__TAURI__?.core?.invoke;
  if (!invoke) throw new Error('Tauri no disponible');
  return await invoke('audio_import_track_bytes_raw', bytes, {
    headers: {
      'x-project-id': projectId,
      'x-track-id': trackId,
      'x-file-name': encodeURIComponent(fileName),
      'x-sample-rate': targetSampleRate ? String(targetSampleRate) : '',
    },
  });
}
