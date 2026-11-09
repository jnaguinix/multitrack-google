/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SongProject, TrackChannel, TrackPcmMetadata } from '../types/project';
import { extractWaveformPeaks } from '../audio/demoSynthesizer';
import {
  checkDiskQuotaForBytes,
  ensureStoragePersist,
  estimateProjectPcmBytes,
  isOpfsSupported,
  isProjectPcmComplete,
  writeTrackPcmFromAudioBuffer,
} from './opfsStorage';
import {
  deleteStemsFromDb,
  extractStemArrayBuffer,
  loadProjectStemsFromDb,
  saveProjectToDb,
} from './projectDb';

/**
 * Reads the native sample rate of an audio file from its header (WAV, MP3, FLAC), or null.
 * Decoding at the native rate avoids the browser resampling to the device rate (e.g.
 * 44.1 kHz -> 48 kHz), which measured ~2.5x slower and produces ~9% bigger PCM files.
 */
export function readSourceSampleRate(buf: ArrayBuffer): number | null {
  if (buf.byteLength < 32) return null;
  const v = new DataView(buf);
  const tag = (o: number) =>
    String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  const valid = (r: number) => (r >= 8000 && r <= 192000 ? r : null);

  // WAV (RIFF)
  if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    let off = 12;
    while (off + 8 <= buf.byteLength) {
      const size = v.getUint32(off + 4, true);
      if (tag(off) === 'fmt ' && off + 16 <= buf.byteLength) return valid(v.getUint32(off + 12, true));
      off += 8 + size + (size % 2);
    }
    return null;
  }

  // FLAC: "fLaC" + STREAMINFO block (sample rate = 20 bits at byte 18)
  if (tag(0) === 'fLaC') {
    const rate = (v.getUint8(18) << 12) | (v.getUint8(19) << 4) | (v.getUint8(20) >> 4);
    return valid(rate);
  }

  // MP3: skip ID3v2 tag, then read the first frame header
  let off = 0;
  if (v.getUint8(0) === 0x49 && v.getUint8(1) === 0x44 && v.getUint8(2) === 0x33) {
    const size =
      ((v.getUint8(6) & 0x7f) << 21) |
      ((v.getUint8(7) & 0x7f) << 14) |
      ((v.getUint8(8) & 0x7f) << 7) |
      (v.getUint8(9) & 0x7f);
    off = 10 + size;
  }
  const limit = Math.min(buf.byteLength - 4, off + 65536);
  for (; off < limit; off++) {
    if (v.getUint8(off) !== 0xff || (v.getUint8(off + 1) & 0xe0) !== 0xe0) continue;
    const b1 = v.getUint8(off + 1);
    const b2 = v.getUint8(off + 2);
    const version = (b1 >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (b1 >> 1) & 0x03;
    const rateIdx = (b2 >> 2) & 0x03;
    if (version === 1 || layer === 0 || rateIdx === 3) continue;
    const base = [44100, 48000, 32000][rateIdx];
    return version === 3 ? base : version === 2 ? base / 2 : base / 4;
  }
  return null;
}

/** Decoding several stems at once uses more CPU cores (measured ~2x faster with 3-4). */
const DECODE_CONCURRENCY =
  typeof navigator !== 'undefined' && (navigator.hardwareConcurrency || 4) >= 6 ? 3 : 2;

export interface PcmOptimizationProgress {
  currentTrackIndex: number;
  totalTracks: number;
  trackName: string;
  percent: number;
  phase: 'checking' | 'converting' | 'saving' | 'complete' | 'cancelled';
}

/**
 * Optimizes a song for streaming by converting each of its tracks from original
 * IndexedDB Blobs into OPFS Int16 PCM files (mono stays mono, stereo is interleaved) (pcm/{projectId}/{trackId}.pcm).
 *
 * Rules:
 * - Decodes up to DECODE_CONCURRENCY stems in parallel; writes to disk one at a time.
 * - Keeps original Blobs in IndexedDB unless options.deleteOriginals is true (then they are
 *   removed only after the .pcm files are verified complete). Buffer mode needs the Blobs.
 * - Decodes at the file's native sample rate (WAV/MP3/FLAC header) to avoid resampling.
 * - Checks quota (1.2x estimated bytes) and requests storage persistence.
 * - Updates TrackChannel.pcm metadata and persists to IndexedDB.
 * - Supports cancellation via AbortSignal.
 */
export async function optimizeProjectForStreaming(
  project: SongProject,
  onProgress?: (progress: PcmOptimizationProgress) => void,
  signal?: AbortSignal,
  options: {
    deleteOriginals?: boolean;
    /** Skip tracks that already have a PCM cache (used by the automatic background cache) */
    onlyMissing?: boolean;
    /** Called as soon as each track is converted (peaks and exact duration come for free) */
    onTrackDone?: (
      trackId: string,
      info: { peaks: number[]; durationSec: number; pcm: TrackPcmMetadata }
    ) => void;
  } = {}
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

  // 3. One decode per track, overlapped with the previous track's disk write
  const work: number[] = [];
  for (let i = 0; i < totalTracks; i++) {
    const t = updatedTracks[i];
    if (options.onlyMissing && t.pcm && t.pcm.frames > 0) continue;
    work.push(i);
  }

  const decodeAt = async (
    i: number
  ): Promise<{ decoded: AudioBuffer; rawBytes: number; mime: string; decodeMs: number } | null> => {
    const track = updatedTracks[i];
    const stemData = stemMap.get(track.id);
    if (!stemData || stemData.unavailable) {
      console.warn(
        `[PcmOptimizer] Sin audio original legible para "${track.name}" (${stemData?.unavailable || 'no está en IndexedDB'})`
      );
      return null;
    }
    try {
      const rawBuffer = await extractStemArrayBuffer(stemData);
      if (!rawBuffer) return null;

      const nativeRate = readSourceSampleRate(rawBuffer);
      const rawBytes = rawBuffer.byteLength;
      const t0 = performance.now();
      let decoded: AudioBuffer;
      try {
        // OfflineAudioContext decodes at exactly the rate we ask for (no device, no resampling)
        const offline = new OfflineAudioContext(1, 1, nativeRate || 48000);
        decoded = await offline.decodeAudioData(rawBuffer.slice(0));
      } catch {
        const AudioContextClass =
          window.AudioContext ||
          // @ts-expect-error webkitAudioContext fallback
          window.webkitAudioContext;
        const tempCtx = new AudioContextClass();
        try {
          decoded = await tempCtx.decodeAudioData(rawBuffer);
        } finally {
          tempCtx.close().catch(() => {});
        }
      }
      return {
        decoded,
        rawBytes,
        mime: stemData.mimeType || stemData.fileName,
        decodeMs: performance.now() - t0,
      };
    } catch (err) {
      console.error(`[PcmOptimizer] No se pudo decodificar "${track.name}":`, err);
      return null;
    }
  };

  // Bounded pool: up to DECODE_CONCURRENCY decodes in flight, results consumed in order
  const decodes: Array<Promise<Awaited<ReturnType<typeof decodeAt>>> | undefined> = [];
  let launched = 0;
  const launchMore = (consumed: number) => {
    while (launched < work.length && launched < consumed + DECODE_CONCURRENCY) {
      const p = decodeAt(work[launched]);
      p.catch(() => {});
      decodes[launched] = p;
      launched++;
    }
  };
  launchMore(0);
  let done = 0;

  for (let k = 0; k < work.length; k++) {
    const i = work[k];
    const track = updatedTracks[i];
    if (signal?.aborted) {
      onProgress?.({
        currentTrackIndex: done,
        totalTracks: work.length,
        trackName: 'Cancelado por el usuario',
        percent: Math.round((done / Math.max(1, work.length)) * 100),
        phase: 'cancelled',
      });
      throw new DOMException('Optimización cancelada por el usuario', 'AbortError');
    }

    onProgress?.({
      currentTrackIndex: k + 1,
      totalTracks: work.length,
      trackName: track.name,
      percent: Math.round((done / Math.max(1, work.length)) * 100),
      phase: 'converting',
    });

    const current = await decodes[k];
    decodes[k] = undefined; // release the reference as soon as possible
    launchMore(k + 1);
    if (!current) continue;

    let decodedAudioBuffer: AudioBuffer | null = current.decoded;
    const peaks = extractWaveformPeaks(decodedAudioBuffer, 320);
    const durationSec = decodedAudioBuffer.duration;

    const tWrite = performance.now();
    const pcmMeta = await writeTrackPcmFromAudioBuffer(project.id, track.id, decodedAudioBuffer, signal);

    console.info(
      `[PcmOptimizer] "${track.name}": origen ${(current.rawBytes / 1048576).toFixed(1)} MB (${current.mime}) -> ${decodedAudioBuffer.numberOfChannels}ch @ ${decodedAudioBuffer.sampleRate} Hz -> OPFS ${pcmMeta.channels}ch ${(pcmMeta.bytesWritten / 1048576).toFixed(1)} MB | decodificar ${current.decodeMs.toFixed(0)} ms, escribir ${(performance.now() - tWrite).toFixed(0)} ms`
    );

    // Free AudioBuffer immediately so GC can collect Float32 data
    decodedAudioBuffer = null;

    const pcm: TrackPcmMetadata = {
      sampleRate: pcmMeta.sampleRate,
      channels: pcmMeta.channels,
      frames: pcmMeta.frames,
      version: 1,
    };
    updatedTracks[i] = { ...track, peaks, durationSec, pcm };
    options.onTrackDone?.(track.id, { peaks, durationSec, pcm });
    done++;

    onProgress?.({
      currentTrackIndex: k + 1,
      totalTracks: work.length,
      trackName: track.name,
      percent: Math.round((done / Math.max(1, work.length)) * 100),
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

  if (options.deleteOriginals && (await isProjectPcmComplete(updatedProject))) {
    await deleteStemsFromDb(
      project.id,
      updatedTracks.map((t) => t.id)
    );
    console.info(`[PcmOptimizer] Blobs originales de "${project.title}" eliminados de IndexedDB.`);
  }

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
