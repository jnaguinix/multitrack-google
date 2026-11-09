/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference-based source files (File System Access API).
 *
 * Instead of copying every imported stem into IndexedDB, the library keeps a *handle* to the
 * original file/folder on disk (a few bytes per track). Audio is only copied once, into the OPFS
 * cache, when a song is added to the setlist. Chrome/Edge only; other browsers fall back to the
 * old behaviour (copy the Blob into IndexedDB).
 */

import { isAudioFileCandidate } from '../utils/fileImportHelper';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SourceHandleInfo {
  file: any; // FileSystemFileHandle
  dir?: any; // FileSystemDirectoryHandle (folder the file came from, when known)
}

const handleRegistry = new WeakMap<File, SourceHandleInfo>();

export function registerFileHandle(file: File, info: SourceHandleInfo): void {
  handleRegistry.set(file, info);
}

export function getRegisteredHandle(file: File): SourceHandleInfo | undefined {
  return handleRegistry.get(file);
}

export function isFsAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as any).showDirectoryPicker === 'function' &&
    typeof (window as any).showOpenFilePicker === 'function'
  );
}

const AUDIO_PICKER_TYPES = [
  {
    description: 'Audio',
    accept: {
      'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac', '.webm', '.opus', '.aif', '.aiff', '.caf'],
    },
  },
];

function isAbortError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

/**
 * Recursively collects audio files from a directory handle, registering each file's handle.
 * `rootDir` is kept as the "source folder" of every file found beneath it.
 */
export async function collectAudioFromDirectory(
  dir: any,
  rootDir: any = dir,
  pathPrefix = ''
): Promise<File[]> {
  const out: File[] = [];
  const prefix = pathPrefix ? `${pathPrefix}/${dir.name}` : dir.name;
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') {
      try {
        const file: File = await entry.getFile();
        if (!isAudioFileCandidate(file)) continue;
        try {
          Object.defineProperty(file, 'webkitRelativePath', {
            value: `${prefix}/${file.name}`,
            writable: false,
            configurable: true,
          });
        } catch {
          // ignore
        }
        registerFileHandle(file, { file: entry, dir: rootDir });
        out.push(file);
      } catch {
        // unreadable file: skip
      }
    } else if (entry.kind === 'directory') {
      out.push(...(await collectAudioFromDirectory(entry, rootDir, prefix)));
    }
  }
  return out;
}

/** Opens the native file picker and returns files with their handles registered. */
export async function pickAudioFilesWithHandles(): Promise<File[]> {
  try {
    const handles: any[] = await (window as any).showOpenFilePicker({
      multiple: true,
      types: AUDIO_PICKER_TYPES,
    });
    const files: File[] = [];
    for (const h of handles) {
      const file: File = await h.getFile();
      registerFileHandle(file, { file: h });
      files.push(file);
    }
    return files;
  } catch (err) {
    if (isAbortError(err)) return [];
    throw err;
  }
}

/** Opens the native folder picker and returns the audio files with their handles registered. */
export async function pickAudioFolderWithHandles(): Promise<File[]> {
  try {
    const dir = await (window as any).showDirectoryPicker({ mode: 'read' });
    return await collectAudioFromDirectory(dir);
  } catch (err) {
    if (isAbortError(err)) return [];
    throw err;
  }
}

/**
 * Opens a picker (with handles when supported) or falls back to the hidden <input type=file>.
 * Must be called directly from a click handler (needs user activation).
 */
export async function pickAudioSources(
  kind: 'files' | 'folder',
  fallbackInput: HTMLInputElement | null,
  onFiles: (files: File[]) => void
): Promise<void> {
  if (!isFsAccessSupported()) {
    fallbackInput?.click();
    return;
  }
  try {
    const files =
      kind === 'files' ? await pickAudioFilesWithHandles() : await pickAudioFolderWithHandles();
    if (files.length > 0) onFiles(files);
  } catch (err) {
    console.warn('[SourceFiles] El selector con handles falló, usando selector clásico:', err);
    fallbackInput?.click();
  }
}

/**
 * Extracts audio files from a drag & drop, keeping file-system handles when the browser
 * supports `DataTransferItem.getAsFileSystemHandle()`. Returns [] when nothing could be
 * resolved so the caller can fall back to the classic extractor.
 *
 * NOTE: all getAsFileSystemHandle() calls must be issued synchronously (before any await).
 */
export async function extractAudioFilesWithHandlesFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<File[]> {
  const items = dataTransfer.items;
  if (!items || items.length === 0) return [];
  if (typeof (items[0] as any).getAsFileSystemHandle !== 'function') return [];

  const handlePromises: Promise<any>[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    handlePromises.push(
      (item as any).getAsFileSystemHandle().catch(() => null) as Promise<any>
    );
  }

  const files: File[] = [];
  try {
    const handles = await Promise.all(handlePromises);
    for (const h of handles) {
      if (!h) continue;
      if (h.kind === 'directory') {
        files.push(...(await collectAudioFromDirectory(h)));
      } else if (h.kind === 'file') {
        const file: File = await h.getFile();
        if (isAudioFileCandidate(file)) {
          registerFileHandle(file, { file: h });
          files.push(file);
        }
      }
    }
  } catch (err) {
    console.warn('[SourceFiles] Drag & drop con handles falló:', err);
    return [];
  }
  return files;
}

export type PermissionState = 'granted' | 'denied' | 'prompt';

export async function queryReadPermission(handle: any): Promise<PermissionState> {
  try {
    if (typeof handle?.queryPermission === 'function') {
      return (await handle.queryPermission({ mode: 'read' })) as PermissionState;
    }
  } catch {
    // ignore
  }
  return 'granted';
}

/** Asks for read permission. Must be called from a user gesture. */
export async function requestReadPermission(handle: any): Promise<PermissionState> {
  try {
    if (typeof handle?.requestPermission === 'function') {
      return (await handle.requestPermission({ mode: 'read' })) as PermissionState;
    }
  } catch {
    // ignore
  }
  return 'denied';
}
