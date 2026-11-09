/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SongProject, TrackChannel } from '../types/project';
import { pcmReaderClient } from '../audio/pcmReaderClient';

const OPFS_ROOT_DIR = 'pcm';

/**
 * Checks if Origin Private File System (OPFS) is supported in the current environment
 */
export function isOpfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.storage) &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

/**
 * Ensures storage persistence via navigator.storage.persist() if available
 */
export async function ensureStoragePersist(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      const isPersisted = await Promise.race([
        navigator.storage.persisted(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
      ]);
      if (!isPersisted) {
        return await Promise.race([
          navigator.storage.persist(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
        ]);
      }
      return true;
    }
  } catch (err) {
    console.warn('[OPFS] Error checking storage persistence:', err);
  }
  return false;
}

/**
 * Estimates storage quota and checks if at least 1.2x of the required bytes are available
 */
export async function checkDiskQuotaForBytes(neededBytes: number): Promise<{
  ok: boolean;
  availableBytes: number;
  quotaBytes: number;
  usageBytes: number;
}> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota ?? 10 * 1024 * 1024 * 1024; // fallback 10GB
      const usage = estimate.usage ?? 0;
      const available = Math.max(0, quota - usage);
      const ok = available >= neededBytes * 1.2;
      return { ok, availableBytes: available, quotaBytes: quota, usageBytes: usage };
    }
  } catch (err) {
    console.warn('[OPFS] Error checking storage quota:', err);
  }
  return {
    ok: true,
    availableBytes: 10 * 1024 * 1024 * 1024,
    quotaBytes: 10 * 1024 * 1024 * 1024,
    usageBytes: 0,
  };
}

/**
 * Gets or creates the root directory for PCM storage (pcm/)
 */
export async function getOpfsPcmRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (!isOpfsSupported()) return null;
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
}

/**
 * Gets or creates the directory for a specific project (pcm/{projectId}/)
 */
export async function getProjectPcmDir(
  projectId: string,
  create = true
): Promise<FileSystemDirectoryHandle | null> {
  const pcmRoot = await getOpfsPcmRoot();
  if (!pcmRoot) return null;
  try {
    return await pcmRoot.getDirectoryHandle(projectId, { create });
  } catch {
    return null;
  }
}

/**
 * Calculates the exact PCM size for a given track in bytes:
 * frames * 2 channels * 2 bytes/sample (Int16) = frames * 4 bytes
 */
export function calculateTrackPcmBytes(frames: number, channels: number = 2): number {
  return frames * (channels === 1 ? 2 : 4);
}

/**
 * Returns true when L and R are (almost) identical, i.e. a "dual-mono" stereo file.
 */
function isDualMono(left: Float32Array, right: Float32Array, threshold = 1e-4): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (Math.abs(left[i] - right[i]) > threshold) return false;
  }
  return true;
}

/**
 * Calculates estimated PCM size for an entire project in bytes
 */
export function estimateProjectPcmBytes(project: SongProject): number {
  const sampleRate = 48000;
  const durSec =
    project.durationSec ||
    ((project.totalBars || 24) * 4 * 60) / (project.bpm || 120);
  const totalFrames = Math.ceil(durSec * sampleRate);
  return totalFrames * 4 * Math.max(1, project.tracks.length);
}

/**
 * Writes an AudioBuffer to an OPFS PCM file: pcm/{projectId}/{trackId}.pcm
 *
 * Characteristics:
 * - Int16 little-endian
 * - Mono (or dual-mono) sources are stored as 1 channel (2 bytes/frame)
 * - Real stereo sources are stored interleaved (L0, R0, L1, R1...) (4 bytes/frame)
 * - Chunked streaming write (e.g. 65,536 frames / 256 KB) to prevent RAM spikes
 */
export async function writeTrackPcmFromAudioBuffer(
  projectId: string,
  trackId: string,
  audioBuffer: AudioBuffer,
  signal?: AbortSignal
): Promise<{
  sampleRate: number;
  channels: 1 | 2;
  frames: number;
  bytesWritten: number;
}> {
  const projDir = await getProjectPcmDir(projectId, true);
  if (!projDir) {
    throw new Error('OPFS no está disponible en este navegador');
  }

  const fileHandle = await projDir.getFileHandle(`${trackId}.pcm`, { create: true });
  let writable: FileSystemWritableFileStream;
  try {
    writable = await fileHandle.createWritable();
  } catch (err) {
    // The streaming worker keeps sync access handles open on this project's files and OPFS
    // refuses writes while they exist: release them and retry once.
    if ((err as { name?: string })?.name !== 'NoModificationAllowedError') throw err;
    await pcmReaderClient.closeProject(projectId);
    writable = await fileHandle.createWritable();
  }

  const sampleRate = audioBuffer.sampleRate;
  const frames = audioBuffer.length;
  const numChannels = audioBuffer.numberOfChannels;

  const leftChannel = audioBuffer.getChannelData(0);
  const rightChannel = numChannels > 1 ? audioBuffer.getChannelData(1) : leftChannel;
  const outChannels: 1 | 2 = numChannels > 1 && !isDualMono(leftChannel, rightChannel) ? 2 : 1;
  const bytesPerFrame = outChannels * 2;

  // Process and write in 1M frame chunks (4 MB per write) to minimize IPC overhead
  const CHUNK_FRAMES = 1048576;
  let offset = 0;
  let bytesWritten = 0;

  try {
    while (offset < frames) {
      if (signal?.aborted) {
        throw new DOMException('Operación cancelada por el usuario', 'AbortError');
      }

      const end = Math.min(frames, offset + CHUNK_FRAMES);
      const sliceFrames = end - offset;
      const buffer = new ArrayBuffer(sliceFrames * bytesPerFrame);
      const int16View = new Int16Array(buffer);

      let outIdx = 0;
      for (let i = offset; i < end; i++) {
        // Clamp & quantize Left channel
        const l = Math.max(-1.0, Math.min(1.0, leftChannel[i] || 0));
        int16View[outIdx++] = l < 0 ? Math.round(l * 0x8000) : Math.round(l * 0x7fff);

        if (outChannels === 2) {
          const r = Math.max(-1.0, Math.min(1.0, rightChannel[i] || 0));
          int16View[outIdx++] = r < 0 ? Math.round(r * 0x8000) : Math.round(r * 0x7fff);
        }
      }

      await writable.write(buffer);
      bytesWritten += buffer.byteLength;
      offset = end;
    }

    await writable.close();
  } catch (err) {
    try {
      await writable.abort();
    } catch {
      // ignore
    }
    throw err;
  }

  return {
    sampleRate,
    channels: outChannels,
    frames,
    bytesWritten,
  };
}

/**
 * Checks if a project has 100% of its PCM files written and valid in OPFS
 */
export async function isProjectPcmComplete(project: SongProject): Promise<boolean> {
  if (!isOpfsSupported()) return false;
  if (!project.tracks || project.tracks.length === 0) return false;

  const projDir = await getProjectPcmDir(project.id, false);
  if (!projDir) return false;

  for (const track of project.tracks) {
    if (!track.pcm || track.pcm.frames <= 0) {
      return false;
    }
    try {
      const fileHandle = await projDir.getFileHandle(`${track.id}.pcm`, { create: false });
      const file = await fileHandle.getFile();
      const expectedBytes = calculateTrackPcmBytes(track.pcm.frames, track.pcm.channels);
      if (file.size < expectedBytes) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Calculates the total actual bytes stored on disk in OPFS for a project
 */
export async function getProjectPcmDiskBytes(projectId: string): Promise<number> {
  if (!isOpfsSupported()) return 0;
  const projDir = await getProjectPcmDir(projectId, false);
  if (!projDir) return 0;

  let total = 0;
  try {
    for await (const entry of projDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.pcm')) {
        const file = await entry.getFile();
        total += file.size;
      }
    }
  } catch (err) {
    console.warn('[OPFS] Error reading project disk size:', err);
  }
  return total;
}

/**
 * Deletes all PCM files and directory for a project: pcm/{projectId}/
 */
export async function deleteProjectPcm(projectId: string): Promise<void> {
  if (!isOpfsSupported()) return;
  try {
    const pcmRoot = await getOpfsPcmRoot();
    if (!pcmRoot) return;
    // Release the worker's sync access handles first, otherwise removeEntry fails silently
    await pcmReaderClient.closeProject(projectId);
    await pcmRoot.removeEntry(projectId, { recursive: true });
    console.info(`[OPFS] Directorio PCM eliminado para proyecto ${projectId}`);
  } catch {
    // Directory might not exist, silently ignore
  }
}

/**
 * Scans OPFS pcm/ directory and removes any orphan directories from projects that were deleted
 */
export async function cleanOrphanPcmDirectories(validProjectIds: Set<string>): Promise<void> {
  if (!isOpfsSupported()) return;
  try {
    const pcmRoot = await getOpfsPcmRoot();
    if (!pcmRoot) return;

    for await (const [name, handle] of pcmRoot.entries()) {
      if (handle.kind === 'directory' && !validProjectIds.has(name)) {
        console.info(`[OPFS] Limpiando directorio huérfano: pcm/${name}`);
        await pcmRoot.removeEntry(name, { recursive: true });
      }
    }
  } catch (err) {
    console.warn('[OPFS] Error en limpieza de huérfanos:', err);
  }
}
