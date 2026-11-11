/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { pcmReaderClient } from './pcmReaderClient';
import {
  CHUNK_SEC,
  FADE_DURATION_SEC,
  NEXT_SONG_STAGE_SEC,
  REFILL_BELOW_SEC,
  TARGET_AHEAD_SEC,
} from './audioEngine';

interface ScheduledSource {
  source: AudioBufferSourceNode;
  fadeGain: GainNode;
  startCtxTime: number;
  endCtxTime: number;
}

export interface StreamingTrackStats {
  trackId: string;
  totalChunks: number;
  bufferedChunks: number;
  bufferedBytes: number;
  currentBufferedAheadSec: number;
  minBufferedAheadSec: number;
  inFlightChunks: number;
  underrunCount: number;
  readErrorCount: number;
  lastSeekLatencyMs: number;
  targetAheadSec: number;
  isPinned: boolean;
}

/**
 * Manages streaming playback for a single audio stem from OPFS PCM files.
 *
 * Characteristics:
 * - Ring buffer / moving window: keeps only a few seconds in RAM (~10s ahead, discards behind).
 * - Continuous gapless scheduling: computes exact start time per chunk based on integer frames.
 * - Micro-fades (8 ms) on abrupt stops or section cuts.
 * - Dynamic auto-scaling on underruns (increases targetAheadSec by +2s up to 20s).
 * - Feeds audio into the track's existing Web Audio graph gainNode (retaining meters, volume, pan, mute, solo).
 * - Pinning for short vamp loops (< 4s) so they never touch disk during repeats.
 * - Staging for next song (NEXT_SONG_STAGE_SEC = 6s) with 'next' priority.
 */
export class StreamingTrack {
  public readonly projectId: string;
  public readonly trackId: string;
  public readonly sampleRate: number;
  public readonly totalFrames: number;
  public readonly totalDurationSec: number;
  public readonly totalChunks: number;

  private ctx: AudioContext;
  private destinationNode: GainNode;

  // Chunk sizing
  private chunkFrames: number;

  // Ring buffer of decoded AudioBuffers in RAM: chunkIndex -> AudioBuffer
  private chunkBuffers = new Map<number, AudioBuffer>();
  private inFlightChunks = new Set<number>();
  private pinnedChunks = new Set<number>();

  // Active scheduled sources in Web Audio graph: chunkIndex -> ScheduledSource
  private scheduledSources = new Map<number, ScheduledSource>();
  private lastScheduledChunkIndex = -1;
  private lastScheduledEndCtxTime = -1;

  // Dynamic underrun & telemetry management
  private targetAheadSec = TARGET_AHEAD_SEC;
  private underrunCount = 0;
  private readErrorCount = 0;
  private currentBufferedAheadSec = TARGET_AHEAD_SEC;
  private minBufferedAheadSec = TARGET_AHEAD_SEC;
  private lastSeekLatencyMs = 0;

  // Pitch detune in semitones
  private pitchSemitones = 0;

  private readonly pcmChannels: 1 | 2 = 2;

  constructor(params: {
    projectId: string;
    trackId: string;
    sampleRate: number;
    totalFrames: number;
    channels?: number;
    destinationNode: GainNode;
    ctx: AudioContext;
    pitchSemitones?: number;
  }) {
    this.projectId = params.projectId;
    this.trackId = params.trackId;
    this.sampleRate = params.sampleRate || 48000;
    this.totalFrames = params.totalFrames;
    this.pcmChannels = params.channels === 1 ? 1 : 2;
    this.totalDurationSec = this.totalFrames / this.sampleRate;
    this.ctx = params.ctx;
    this.destinationNode = params.destinationNode;
    this.pitchSemitones = params.pitchSemitones ?? 0;

    this.chunkFrames = Math.round(CHUNK_SEC * this.sampleRate);
    this.totalChunks = Math.max(1, Math.ceil(this.totalFrames / this.chunkFrames));
  }

  public setPitchSemitones(semitones: number) {
    this.pitchSemitones = semitones;
    const detuneVal = semitones * 100;
    for (const item of this.scheduledSources.values()) {
      try {
        item.source.detune.setValueAtTime(detuneVal, this.ctx.currentTime);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Pre-loads the initial chunks for playback from offsetSec.
   */
  public async prefetchInitialChunks(
    startSec = 0,
    priority: 'seek' | 'active' = 'active'
  ): Promise<void> {
    const startChunk = Math.max(0, Math.floor(startSec / CHUNK_SEC));
    const chunksNeeded = Math.ceil(this.targetAheadSec / CHUNK_SEC);
    const endChunk = Math.min(this.totalChunks - 1, startChunk + chunksNeeded);

    const promises: Promise<void>[] = [];
    for (let c = startChunk; c <= endChunk; c++) {
      if (!this.chunkBuffers.has(c) && !this.inFlightChunks.has(c)) {
        promises.push(this.fetchChunk(c, priority));
      }
    }

    await Promise.all(promises);
  }

  /**
   * Fetches a chunk from OPFS via pcmReaderClient.
   */
  private async fetchChunk(
    chunkIndex: number,
    priority: 'seek' | 'active' | 'next' = 'active'
  ): Promise<void> {
    if (chunkIndex < 0 || chunkIndex >= this.totalChunks) return;
    if (this.chunkBuffers.has(chunkIndex) || this.inFlightChunks.has(chunkIndex)) return;

    this.inFlightChunks.add(chunkIndex);
    const startFrame = chunkIndex * this.chunkFrames;
    const frameCount = Math.min(this.chunkFrames, this.totalFrames - startFrame);

    if (frameCount <= 0) {
      this.inFlightChunks.delete(chunkIndex);
      return;
    }

    try {
      const res = await pcmReaderClient.readChunk({
        projectId: this.projectId,
        trackId: this.trackId,
        startFrame,
        frameCount,
        channels: this.pcmChannels,
        priority,
      });

      if (res.frameCount > 0) {
        // Convert planar Float32 to Web Audio AudioBuffer
        const buffer = this.ctx.createBuffer(this.pcmChannels, res.frameCount, this.sampleRate);
        buffer.copyToChannel(res.leftChannel as unknown as Float32Array<ArrayBuffer>, 0);
        if (this.pcmChannels === 2) {
          buffer.copyToChannel(res.rightChannel as unknown as Float32Array<ArrayBuffer>, 1);
        }
        this.chunkBuffers.set(chunkIndex, buffer);
      }
    } catch (err) {
      this.readErrorCount++;
      console.warn(
        `[StreamingTrack] Error leyendo chunk ${chunkIndex} de "${this.trackId}" (errores: ${this.readErrorCount}):`,
        err
      );
    } finally {
      this.inFlightChunks.delete(chunkIndex);
    }
  }

  public setDestinationNode(destinationNode: GainNode): void {
    this.destinationNode = destinationNode;
  }

  /**
   * Pins chunks of a short vamp section (< 4s) so they stay 100% in RAM during repeat loops,
   * avoiding any disk contention or access latency during live worship.
   */
  public pinSectionChunks(startSec: number, endSec: number): void {
    const startChunk = Math.max(0, Math.floor(startSec / CHUNK_SEC));
    const endChunk = Math.min(this.totalChunks - 1, Math.ceil(endSec / CHUNK_SEC));
    for (let c = startChunk; c <= endChunk; c++) {
      this.pinnedChunks.add(c);
      if (!this.chunkBuffers.has(c) && !this.inFlightChunks.has(c)) {
        this.fetchChunk(c, 'active').catch(() => {});
      }
    }
  }

  public unpinSectionChunks(): void {
    this.pinnedChunks.clear();
  }

  /**
   * Pre-fetches target section chunks ahead of time when a quantized section jump is queued.
   */
  public async prefetchJumpTarget(targetSec: number, countSec = 4): Promise<void> {
    const startChunk = Math.max(0, Math.floor(targetSec / CHUNK_SEC));
    const chunksCount = Math.max(1, Math.ceil(countSec / CHUNK_SEC));
    const endChunk = Math.min(this.totalChunks - 1, startChunk + chunksCount);
    const promises: Promise<void>[] = [];
    for (let c = startChunk; c <= endChunk; c++) {
      if (!this.chunkBuffers.has(c) && !this.inFlightChunks.has(c)) {
        promises.push(this.fetchChunk(c, 'seek'));
      }
    }
    await Promise.all(promises);
  }

  /**
   * Stages the first NEXT_SONG_STAGE_SEC (6s = 3 chunks) of this track in background
   * using 'next' priority so switching to the next setlist song is instant (0 ms).
   */
  public async prefetchStagedChunks(durationSec = NEXT_SONG_STAGE_SEC): Promise<void> {
    const chunksNeeded = Math.ceil(durationSec / CHUNK_SEC);
    const endChunk = Math.min(this.totalChunks - 1, chunksNeeded - 1);
    const promises: Promise<void>[] = [];
    for (let c = 0; c <= endChunk; c++) {
      if (!this.chunkBuffers.has(c) && !this.inFlightChunks.has(c)) {
        promises.push(this.fetchChunk(c, 'next'));
      }
    }
    await Promise.all(promises);
  }

  public isStagedReady(durationSec = NEXT_SONG_STAGE_SEC): boolean {
    const chunksNeeded = Math.min(this.totalChunks, Math.ceil(durationSec / CHUNK_SEC));
    for (let c = 0; c < chunksNeeded; c++) {
      if (!this.chunkBuffers.has(c)) return false;
    }
    return true;
  }

  /**
   * Refill loop executed on every lookahead tick (every 25 ms):
   * 1. Evicts chunks behind the current playhead window to keep RAM low (protecting pinned vamp chunks).
   * 2. Requests missing upcoming chunks if buffered time ahead < refill threshold.
   * 3. Schedules ready chunks into the Web Audio graph gaplessly.
   */
  public updateScheduler(params: {
    isPlaying: boolean;
    currentSongSec: number;
    playStartSongSec: number;
    playStartCtxTime: number;
    rate: number;
    lookaheadSec: number;
  }): void {
    const { isPlaying, currentSongSec, playStartSongSec, playStartCtxTime, rate, lookaheadSec } =
      params;

    const currentChunk = Math.max(0, Math.floor(currentSongSec / CHUNK_SEC));

    // 1. Evict chunks behind playhead (keep currentChunk - 1 for micro-crossfades, protecting pinned vamp chunks)
    const discardBefore = currentChunk - 1;
    for (const idx of Array.from(this.chunkBuffers.keys())) {
      if (idx < discardBefore && !this.pinnedChunks.has(idx)) {
        this.chunkBuffers.delete(idx);
      }
    }

    // 2. Count consecutive buffered seconds ahead of current position
    let bufferedChunksAhead = 0;
    while (
      currentChunk + bufferedChunksAhead < this.totalChunks &&
      this.chunkBuffers.has(currentChunk + bufferedChunksAhead)
    ) {
      bufferedChunksAhead++;
    }
    const remainingTotalSec = Math.max(0, this.totalDurationSec - currentSongSec);
    const bufferedAheadSec = Math.min(remainingTotalSec, bufferedChunksAhead * CHUNK_SEC);
    this.currentBufferedAheadSec = Number(bufferedAheadSec.toFixed(2));
    if (isPlaying && remainingTotalSec > 2.0) {
      this.minBufferedAheadSec = Number(
        Math.min(this.minBufferedAheadSec, bufferedAheadSec).toFixed(2)
      );
    }

    // Check if we need to request more chunks
    if (bufferedAheadSec < REFILL_BELOW_SEC) {
      const chunksToFetch = Math.ceil(this.targetAheadSec / CHUNK_SEC);
      const targetEndChunk = Math.min(this.totalChunks - 1, currentChunk + chunksToFetch);

      for (let c = currentChunk; c <= targetEndChunk; c++) {
        if (!this.chunkBuffers.has(c) && !this.inFlightChunks.has(c)) {
          this.fetchChunk(c, 'active').catch(() => {});
        }
      }
    }

    if (!isPlaying) return;

    // 3. Schedule upcoming chunks gaplessly into Web Audio graph
    const nowCtx = this.ctx.currentTime;
    const scheduleUntilCtx = nowCtx + lookaheadSec;

    // Start scheduling from currentChunk up to chunks falling within lookahead
    const maxScheduleChunk = Math.min(
      this.totalChunks - 1,
      currentChunk + Math.ceil(lookaheadSec / CHUNK_SEC) + 1
    );

    for (let c = currentChunk; c <= maxScheduleChunk; c++) {
      if (this.scheduledSources.has(c)) {
        continue; // Already scheduled
      }

      const chunkBuffer = this.chunkBuffers.get(c);
      const startSample = c * this.chunkFrames;
      const chunkStartSongSec = startSample / this.sampleRate;
      const chunkDurationSongSec = (chunkBuffer?.length ?? this.chunkFrames) / this.sampleRate;

      // Exact AudioContext start time calculated mathematically from integer frames
      const chunkStartCtxTime =
        playStartCtxTime + (chunkStartSongSec - playStartSongSec) / rate;
      const chunkEndCtxTime = chunkStartCtxTime + chunkDurationSongSec / rate;

      // Check if chunk falls within the scheduling window
      if (chunkStartCtxTime <= scheduleUntilCtx && chunkEndCtxTime > nowCtx) {
        if (!chunkBuffer) {
          // Underrun: chunk is needed now but not yet in RAM
          this.underrunCount++;
          this.targetAheadSec = Math.min(20, this.targetAheadSec + 2);
          console.warn(
            `[StreamingTrack][UNDERRUN] Pista "${this.trackId}" chunk ${c} no listo a tiempo. Autoescalando buffer a ${this.targetAheadSec}s (total: ${this.underrunCount})`
          );
          // Request chunk immediately with seek priority
          this.fetchChunk(c, 'seek').catch(() => {});
          continue;
        }

        // Schedule the chunk
        this.scheduleChunkSource({
          chunkIndex: c,
          buffer: chunkBuffer,
          chunkStartCtxTime,
          chunkStartSongSec,
          currentSongSec,
          rate,
          nowCtx,
        });
      }
    }

    // Clean up expired sources that have completed playback
    for (const [c, sched] of Array.from(this.scheduledSources.entries())) {
      if (sched.endCtxTime <= nowCtx) {
        this.scheduledSources.delete(c);
      }
    }
  }

  private scheduleChunkSource(params: {
    chunkIndex: number;
    buffer: AudioBuffer;
    chunkStartCtxTime: number;
    chunkStartSongSec: number;
    currentSongSec: number;
    rate: number;
    nowCtx: number;
  }): void {
    const {
      chunkIndex,
      buffer,
      chunkStartCtxTime,
      rate,
      nowCtx,
    } = params;

    let offsetInChunkSec = 0;
    let startWhen = chunkStartCtxTime;

    // A chunk starts mid-way ONLY if it was scheduled to start in the past
    // (e.g. immediate play or seek positioned inside this chunk)
    if (chunkStartCtxTime < nowCtx - 0.001) {
      const elapsedCtx = nowCtx - chunkStartCtxTime;
      offsetInChunkSec = Math.min(buffer.duration - 0.001, elapsedCtx * rate);
      startWhen = nowCtx;
    }

    const remainingSongSec = Math.max(0, buffer.duration - offsetInChunkSec);
    if (remainingSongSec <= 0) return;

    const source = this.ctx.createBufferSource();
    const fadeGain = this.ctx.createGain();

    source.buffer = buffer;
    source.detune.value = this.pitchSemitones * 100;

    // A chunk is contiguous if it directly follows the previous chunk and starts at offset 0
    const isContiguous =
      offsetInChunkSec === 0 &&
      this.lastScheduledChunkIndex >= 0 &&
      chunkIndex === this.lastScheduledChunkIndex + 1 &&
      Math.abs(this.lastScheduledEndCtxTime - startWhen) < 0.05;

    console.debug(
      `[StreamingTrack][Transition] Pista "${this.trackId}" chunk ${chunkIndex} | isContiguous=${isContiguous} | offset=${offsetInChunkSec.toFixed(5)}s | startWhen=${startWhen.toFixed(4)} | lastEnd=${this.lastScheduledEndCtxTime.toFixed(4)}`
    );

    if (isContiguous) {
      // Seamless contiguous playback: maintain 1.0 gain without dip/fade-in
      fadeGain.gain.setValueAtTime(1.0, startWhen);
    } else {
      // Starting mid-playback, play, seek, or jump: 8 ms micro-fade-in to prevent digital edge clicks
      fadeGain.gain.setValueAtTime(0.0001, startWhen);
      fadeGain.gain.linearRampToValueAtTime(1.0, startWhen + FADE_DURATION_SEC);
    }

    source.connect(fadeGain);
    fadeGain.connect(this.destinationNode);

    source.start(startWhen, offsetInChunkSec);

    const endCtxTime = startWhen + remainingSongSec / rate;
    this.lastScheduledChunkIndex = chunkIndex;
    this.lastScheduledEndCtxTime = endCtxTime;

    this.scheduledSources.set(chunkIndex, {
      source,
      fadeGain,
      startCtxTime: startWhen,
      endCtxTime,
    });
  }

  /**
   * Stops all active sources with an 8 ms micro-fade-out.
   */
  public stopSourcesWithFade(atCtxTime?: number): void {
    const now = this.ctx.currentTime;
    const fadeStart = atCtxTime !== undefined && atCtxTime > now ? atCtxTime : now;

    for (const sched of this.scheduledSources.values()) {
      try {
        sched.fadeGain.gain.setValueAtTime(sched.fadeGain.gain.value, fadeStart);
        sched.fadeGain.gain.linearRampToValueAtTime(0.0001, fadeStart + FADE_DURATION_SEC);
        sched.source.stop(fadeStart + FADE_DURATION_SEC);
      } catch {
        // ignore
      }
    }
    this.scheduledSources.clear();
    this.lastScheduledChunkIndex = -1;
    this.lastScheduledEndCtxTime = -1;
  }

  /**
   * Resets playback state for seeking to a new position.
   */
  public async seekTo(newSongSec: number): Promise<void> {
    const t0 = performance.now();
    this.stopSourcesWithFade();

    const targetChunk = Math.max(0, Math.floor(newSongSec / CHUNK_SEC));

    // Clear chunkBuffers except those near targetChunk (protecting pinned chunks)
    for (const idx of Array.from(this.chunkBuffers.keys())) {
      if ((idx < targetChunk - 1 || idx > targetChunk + 4) && !this.pinnedChunks.has(idx)) {
        this.chunkBuffers.delete(idx);
      }
    }
    this.inFlightChunks.clear();

    // Fetch target chunk and next chunk with 'seek' priority
    await this.fetchChunk(targetChunk, 'seek');
    this.lastSeekLatencyMs = Number((performance.now() - t0).toFixed(2));
  }

  public getBufferedBytes(): number {
    let bytes = 0;
    this.chunkBuffers.forEach((buf) => {
      bytes += buf.length * buf.numberOfChannels * 4;
    });
    return bytes;
  }

  public getStats(): StreamingTrackStats {
    return {
      trackId: this.trackId,
      totalChunks: this.totalChunks,
      bufferedChunks: this.chunkBuffers.size,
      bufferedBytes: this.getBufferedBytes(),
      currentBufferedAheadSec: this.currentBufferedAheadSec,
      minBufferedAheadSec: this.minBufferedAheadSec,
      inFlightChunks: this.inFlightChunks.size,
      underrunCount: this.underrunCount,
      readErrorCount: this.readErrorCount,
      lastSeekLatencyMs: this.lastSeekLatencyMs,
      targetAheadSec: this.targetAheadSec,
      isPinned: this.pinnedChunks.size > 0,
    };
  }

  public dispose(): void {
    this.stopSourcesWithFade();
    this.chunkBuffers.clear();
    this.inFlightChunks.clear();
    this.scheduledSources.clear();
  }
}
