/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SongProject, TrackChannel } from '../types/project';
import {
  checkDiskQuotaForBytes,
  ensureStoragePersist,
  estimateProjectPcmBytes,
  isOpfsSupported,
  writeTrackPcmFromAudioBuffer,
} from './opfsStorage';
import {
  extractStemArrayBuffer,
  loadProjectStemsFromDb,
  saveProjectToDb,
} from './projectDb';

export interface PcmOptimizationProgress {
  currentTrackIndex: number;
  totalTracks: number;
  trackName: string;
  percent: number;
  phase: 'checking' | 'converting' | 'saving' | 'complete' | 'cancelled';
}

/**
 * Optimizes a song for streaming by converting each of its tracks from original
 * IndexedDB Blobs into OPFS Int16 stereo interleaved PCM files (pcm/{projectId}/{trackId}.pcm).
 *
 * Rules:
 * - Sequential processing (1 track at a time) to prevent RAM spikes.
 * - Does NOT delete original Blobs from IndexedDB (they serve as safe backup).
 * - Checks quota (1.2x estimated bytes) and requests storage persistence.
 * - Updates TrackChannel.pcm metadata and persists to IndexedDB.
 * - Supports cancellation via AbortSignal.
 */
export async function optimizeProjectForStreaming(
  project: SongProject,
  onProgress?: (progress: PcmOptimizationProgress) => void,
  signal?: AbortSignal
): Promise<SongProject> {
  if (!isOpfsSupported()) {
    throw new Error('Tu navegador no es compatible con OPFS (Origin Private File System).');
  }

  onProgress?.({
    currentTrackIndex: 0,
    totalTracks: project.tracks.length,
    trackName: 'Verificando cuota de disco...',
    percent: 0,
    phase: 'checking',
  });

  // 1. Ensure storage persistence and verify disk quota (1.2x)
  await ensureStoragePersist();
  const estimatedBytes = estimateProjectPcmBytes(project);
  const quota = await checkDiskQuotaForBytes(estimatedBytes);

  if (!quota.ok) {
    const neededMb = ((estimatedBytes * 1.2) / (1024 * 1024)).toFixed(0);
    const availMb = (quota.availableBytes / (1024 * 1024)).toFixed(0);
    throw new Error(
      `Espacio en disco insuficiente. Se requieren al menos ${neededMb} MB (con margen 1.2x) y solo hay ${availMb} MB disponibles.`
    );
  }

  // 2. Load original stems from IndexedDB
  const storedStems = await loadProjectStemsFromDb(project.id);
  const stemMap = new Map<string, (typeof storedStems)[0]>();
  for (const s of storedStems) {
    stemMap.set(s.trackId, s);
  }

  const updatedTracks: TrackChannel[] = [...project.tracks];
  const totalTracks = project.tracks.length;

  // 3. Sequential conversion: 1 track at a time to prevent RAM spikes
  for (let i = 0; i < totalTracks; i++) {
    if (signal?.aborted) {
      onProgress?.({
        currentTrackIndex: i,
        totalTracks,
        trackName: 'Cancelado por el usuario',
        percent: Math.round((i / Math.max(1, totalTracks)) * 100),
        phase: 'cancelled',
      });
      throw new DOMException('Optimización cancelada por el usuario', 'AbortError');
    }

    const track = updatedTracks[i];
    onProgress?.({
      currentTrackIndex: i + 1,
      totalTracks,
      trackName: track.name,
      percent: Math.round(((i + 0.1) / Math.max(1, totalTracks)) * 100),
      phase: 'converting',
    });

    const stemData = stemMap.get(track.id);
    if (!stemData) {
      console.warn(`[PcmOptimizer] No se encontró audio original en IndexedDB para "${track.name}" (${track.id})`);
      continue;
    }

    const rawBuffer = await extractStemArrayBuffer(stemData);
    if (!rawBuffer) {
      console.warn(`[PcmOptimizer] Buffer vacío para "${track.name}" (${track.id})`);
      continue;
    }

    // Temporary decode context for single stem
    const AudioContextClass =
      window.AudioContext ||
      // @ts-expect-error webkitAudioContext fallback
      window.webkitAudioContext;
    const tempCtx = new AudioContextClass();

    let decodedAudioBuffer: AudioBuffer | null = null;
    try {
      decodedAudioBuffer = await tempCtx.decodeAudioData(rawBuffer.slice(0));
    } finally {
      try {
        await tempCtx.close();
      } catch {
        // ignore
      }
    }

    if (!decodedAudioBuffer) {
      continue;
    }

    // Convert and stream write to OPFS: pcm/{projectId}/{trackId}.pcm
    const pcmMeta = await writeTrackPcmFromAudioBuffer(
      project.id,
      track.id,
      decodedAudioBuffer,
      signal
    );

    // Free AudioBuffer immediately so GC can collect Float32 data
    decodedAudioBuffer = null;

    // Attach PCM metadata to track
    updatedTracks[i] = {
      ...track,
      pcm: {
        sampleRate: pcmMeta.sampleRate,
        channels: 2,
        frames: pcmMeta.frames,
        version: 1,
      },
    };

    onProgress?.({
      currentTrackIndex: i + 1,
      totalTracks,
      trackName: track.name,
      percent: Math.round(((i + 1) / Math.max(1, totalTracks)) * 100),
      phase: 'converting',
    });
  }

  // 4. Save updated project metadata in IndexedDB
  onProgress?.({
    currentTrackIndex: totalTracks,
    totalTracks,
    trackName: 'Guardando metadatos...',
    percent: 100,
    phase: 'saving',
  });

  const updatedProject: SongProject = {
    ...project,
    tracks: updatedTracks,
    updatedAt: Date.now(),
  };

  await saveProjectToDb(updatedProject);

  onProgress?.({
    currentTrackIndex: totalTracks,
    totalTracks,
    trackName: 'Optimización completada',
    percent: 100,
    phase: 'complete',
  });

  console.info(`[PcmOptimizer] Proyecto "${project.title}" (${project.id}) optimizado exitosamente para streaming en OPFS.`);
  return updatedProject;
}
