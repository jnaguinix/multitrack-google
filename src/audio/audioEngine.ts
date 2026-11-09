import {
  AudioEngineMode,
  MetersSnapshot,
  QuantizeMode,
  SongProject,
  SongRamCacheInfo,
  SongSection,
  TrackChannel,
  TrackMeterReading,
  TransportState,
} from '../types/project';
import { isEffectivelyMono } from './monoDetect';
import { extractStemArrayBuffer, loadProjectStemsFromDb } from '../storage/projectDb';
import { extractWaveformPeaks } from './demoSynthesizer';
import { pcmReaderClient } from './pcmReaderClient';
import { StreamingTrack, StreamingTrackStats } from './streamingTrack';

/**
 * UNIFIED ENGINE CONSTANTS (Configurable in a single place)
 */
export const CHUNK_SEC = 2;
export const TARGET_AHEAD_SEC = 10;
export const REFILL_BELOW_SEC = 6;
export const NEXT_SONG_STAGE_SEC = 6;

export const DEFAULT_RAM_BUDGET_MB = 1200;
export const MIN_RAM_BUDGET_MB = 256;
export const MAX_RAM_BUDGET_MB = 4096;
export const FADE_DURATION_SEC = 0.008; // 8 ms micro-fade to prevent clicks/pops

const STORAGE_KEY_RAM_BUDGET_MB = 'ramBudgetMB';
const STORAGE_KEY_ENGINE_MODE = 'audioEngineMode';

/**
 * Lookahead scheduler constants:
 * - Worker ticks every 25 ms (unthrottled in background tabs)
 * - Schedules audio events falling within the next 120 ms (0.120 s)
 */
const SCHEDULER_TICK_MS = 25;
const SCHEDULER_LOOKAHEAD_SEC = 0.12;

/**
 * UI notification throttle (~20 fps = 50 ms)
 */
const UI_EMIT_INTERVAL_MS = 50;

interface ActiveTrackNodes {
  source: AudioBufferSourceNode | null;
  sourceFadeGain: GainNode | null;
  gainNode: GainNode;
  panNode: StereoPannerNode;
  analyser: AnalyserNode;
  timeDomainData: Float32Array<ArrayBuffer>;
}

type TransportListener = (state: TransportState) => void;
type CacheListener = () => void;

function readInitialRamBudgetBytes(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_RAM_BUDGET_MB);
    if (raw) {
      const parsedMb = Number(raw);
      if (Number.isFinite(parsedMb) && parsedMb >= MIN_RAM_BUDGET_MB && parsedMb <= MAX_RAM_BUDGET_MB) {
        return Math.round(parsedMb * 1024 * 1024);
      }
    }
  } catch {
    // Ignore localStorage access errors in restricted environments
  }
  return DEFAULT_RAM_BUDGET_MB * 1024 * 1024;
}

function readInitialEngineMode(): AudioEngineMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ENGINE_MODE);
    if (raw === 'stream' || raw === 'buffer') {
      return raw;
    }
  } catch {
    // Ignore localStorage access errors
  }
  // Hybrid by default: songs with an OPFS cache stream, the rest fall back to RAM buffers
  return 'stream';
}

export class LibreTracksAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGainNode: GainNode | null = null;
  private mainBusGain: GainNode | null = null;
  private mainBusPan: StereoPannerNode | null = null;
  private cueBusGain: GainNode | null = null;
  private cueBusPan: StereoPannerNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private masterTimeData: Float32Array<ArrayBuffer> = new Float32Array(256);

  private project: SongProject | null = null;
  private trackBuffers: Map<string, AudioBuffer> = new Map();
  private trackNodes: Map<string, ActiveTrackNodes> = new Map();
  private streamingTracks: Map<string, StreamingTrack> = new Map();

  /**
   * Engine mode switch ('buffer' | 'stream'), persisted in localStorage.
   * Defaults to 'buffer'. If a song has no PCM generated, falls back to 'buffer' for that song.
   */
  private engineMode: AudioEngineMode = readInitialEngineMode();

  /**
   * ETAPA 1 — Presupuesto de RAM en bytes (MAX_CACHE_BYTES).
   * Replaces fixed project count limit with byte-level budget (default 1200 MB).
   */
  private maxCacheBytes: number = readInitialRamBudgetBytes();
  private projectBufferCache: Map<string, Map<string, AudioBuffer>> = new Map();
  private cacheOrder: string[] = [];
  private pinnedNextProjectId: string | null = null;
  private priorityProjectIds = new Set<string>();
  /** Real channel count (after mono compaction) per trackId, used to estimate RAM */
  private trackChannelHints = new Map<string, number>();
  private skippedByRamBudgetIds: Set<string> = new Set();
  private preloadingProjectIds: Set<string> = new Set();
  private inFlightPreloads: Map<string, Promise<Map<string, AudioBuffer>>> = new Map();

  // ETAPA 5 — Puesta en escena (staging) de la siguiente canción para cambio instantáneo
  private stagedNextProject: SongProject | null = null;
  private stagedNextTracks: Map<string, StreamingTrack> = new Map();
  private pendingStageNextProject: SongProject | null = null;
  private isStagingNextProject = false;
  private activePlaybackStableSec = 0;
  private lastRecordedUnderruns = 0;

  // ETAPA 6 — Telemetría [AudioEngine][Stream] y recuperación ante fallos OPFS
  private fallbackBufferProjectIds: Set<string> = new Set();
  private lastStreamLogTimeMs = 0;

  private loadGenerationId = 0;
  private isMountingSong = false;
  private mountingProgressText: string | null = null;

  private isPlaying = false;
  private playStartCtxTime = 0;
  private playStartSongSec = 0;
  private pausedSongSec = 0;

  private activeSectionId: string | null = null;
  private queuedSectionId: string | null = null;
  private queuedTargetSec: number | null = null;
  private isVamping = false;
  private lastCueMessage: string | null = null;

  private lastScheduledSubStep = -1;
  private lastAnnouncedSectionId: string | null = null;
  private pendingTransitionCtxTime: number | null = null;

  private schedulerWorker: Worker | null = null;
  private rafId: number | null = null;
  private lastUiEmitTimeMs = 0;

  private listeners: Set<TransportListener> = new Set();
  private cacheListeners: Set<CacheListener> = new Set();
  private onSongEndedCallback: (() => void) | null = null;

  public setOnSongEnded(cb: (() => void) | null) {
    this.onSongEndedCallback = cb;
  }

  public getEngineMode(): AudioEngineMode {
    return this.engineMode;
  }

  public setEngineMode(mode: AudioEngineMode) {
    this.engineMode = mode;
    try {
      localStorage.setItem(STORAGE_KEY_ENGINE_MODE, mode);
    } catch {
      // Ignore localStorage errors
    }
    console.info(`[AudioEngine] Modo de motor configurado a: '${mode}'`);
    this.emitCacheUpdate();
    this.emitTransport(true);
  }

  public isProjectPcmReady(project: SongProject | null = this.project): boolean {
    if (!project || project.tracks.length === 0) return false;
    return project.tracks.every((t) => Boolean(t.pcm) && t.pcm!.frames > 0);
  }

  public getProjectPcmEstimatedMB(project: SongProject): number {
    // Int16: 2 bytes per sample * real channel count (mono tracks take half)
    const totalBytes = project.tracks.reduce((sum, t) => {
      if (t.pcm?.frames) return sum + t.pcm.frames * 2 * (t.pcm.channels === 1 ? 1 : 2);
      const dur = t.durationSec || project.durationSec || 60;
      return sum + Math.ceil(dur * 48000) * 4;
    }, 0);
    return Math.round(totalBytes / (1024 * 1024));
  }

  public clearProjectFallback(projectId: string) {
    this.fallbackBufferProjectIds.delete(projectId);
    this.emitCacheUpdate();
  }

  /**
   * Returns the effective engine mode for a given project.
   * If a song does not have PCM generated on all tracks or failed OPFS validation, falls back to 'buffer'.
   */
  public getEffectiveEngineModeForProject(project: SongProject | null = this.project): AudioEngineMode {
    if (!project || this.engineMode === 'buffer') return 'buffer';
    if (this.fallbackBufferProjectIds.has(project.id)) return 'buffer';
    return this.isProjectPcmReady(project) ? 'stream' : 'buffer';
  }

  public getRamBudgetMB(): number {
    return Math.round(this.maxCacheBytes / (1024 * 1024));
  }

  public setRamBudgetMB(budgetMB: number) {
    const clampedMB = Math.max(
      MIN_RAM_BUDGET_MB,
      Math.min(MAX_RAM_BUDGET_MB, Math.round(budgetMB))
    );
    this.maxCacheBytes = clampedMB * 1024 * 1024;
    try {
      localStorage.setItem(STORAGE_KEY_RAM_BUDGET_MB, String(clampedMB));
    } catch {
      // Ignore localStorage errors
    }
    // Immediately evict any non-active songs that exceed the new budget
    this.evictBeforeDecode(0, this.project ? [this.project.id] : []);
    this.logCacheRamMetrics(`setRamBudgetMB(${clampedMB} MB)`);
    this.emitCacheUpdate();
  }

  public getPcmReaderMetrics() {
    return pcmReaderClient.getMetrics();
  }

  public isStreamingMode(): boolean {
    return this.getEffectiveEngineModeForProject(this.project) === 'stream';
  }

  public getStreamingStats(): StreamingTrackStats[] {
    return Array.from(this.streamingTracks.values()).map((st) => st.getStats());
  }

  /**
   * ETAPA 6 — Estadísticas globales de streaming expuestas vía `window.__streamStats()`
   */
  public getGlobalStreamStats() {
    const readerMetrics = pcmReaderClient.getMetrics();
    const trackStats = this.getStreamingStats();
    const minBufferedAheadSec =
      trackStats.length > 0
        ? Math.min(...trackStats.map((t) => t.minBufferedAheadSec))
        : TARGET_AHEAD_SEC;
    const currentBufferedAheadSec =
      trackStats.length > 0
        ? Math.min(...trackStats.map((t) => t.currentBufferedAheadSec))
        : 0;
    const maxSeekLatencyMs =
      trackStats.length > 0
        ? Math.max(...trackStats.map((t) => t.lastSeekLatencyMs))
        : 0;
    const totalUnderruns = trackStats.reduce((sum, t) => sum + t.underrunCount, 0);
    const totalReadErrors = trackStats.reduce((sum, t) => sum + t.readErrorCount, 0);

    return {
      engineMode: this.engineMode,
      effectiveMode: this.getEffectiveEngineModeForProject(this.project),
      activeProjectId: this.project?.id || null,
      activeProjectTitle: this.project?.title || null,
      stagedNextProjectId: this.stagedNextProject?.id || null,
      stagedNextProjectTitle: this.stagedNextProject?.title || null,
      totalStreamRamMB: this.getTotalCachedMB(),
      ramBudgetMB: this.getRamBudgetMB(),
      avgReadMs: Number(readerMetrics.avgReadMs.toFixed(2)),
      p95ReadMs: Number(readerMetrics.p95ReadMs.toFixed(2)),
      maxReadMs: Number(readerMetrics.maxReadMs.toFixed(2)),
      totalReads: readerMetrics.totalReads,
      syncHandlesSupported: readerMetrics.syncHandlesSupported,
      currentBufferedAheadSec,
      minBufferedAheadSec,
      totalUnderruns,
      totalReadErrors,
      maxSeekLatencyMs,
      activePlaybackStableSec: Number(this.activePlaybackStableSec.toFixed(1)),
      tracks: trackStats,
    };
  }

  public logStreamMetrics(reason: string) {
    const s = this.getGlobalStreamStats();
    console.info(
      `[AudioEngine][Stream] ${reason} | Canción: "${s.activeProjectTitle || 'ninguna'}" | RAM motor: ${s.totalStreamRamMB.toFixed(1)} MB | Reserva mín: ${s.minBufferedAheadSec.toFixed(1)}s (actual: ${s.currentBufferedAheadSec.toFixed(1)}s) | Lectura media: ${s.avgReadMs.toFixed(2)} ms (p95: ${s.p95ReadMs.toFixed(2)} ms) | Underruns: ${s.totalUnderruns} | Seek lat: ${s.maxSeekLatencyMs.toFixed(1)} ms | Stage sig: ${s.stagedNextProjectTitle ? `"${s.stagedNextProjectTitle}"` : 'ninguna'}`
    );
  }

  public subscribeCache(listener: CacheListener): () => void {
    this.cacheListeners.add(listener);
    return () => {
      this.cacheListeners.delete(listener);
    };
  }

  private emitCacheUpdate() {
    this.cacheListeners.forEach((cb) => cb());
  }

  public ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();

      this.masterGainNode = this.ctx.createGain();
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 256;
      this.masterTimeData = new Float32Array(this.masterAnalyser.fftSize);

      this.mainBusGain = this.ctx.createGain();
      this.mainBusPan = this.ctx.createStereoPanner();

      this.cueBusGain = this.ctx.createGain();
      this.cueBusPan = this.ctx.createStereoPanner();

      this.mainBusGain.connect(this.mainBusPan);
      this.mainBusPan.connect(this.masterGainNode);

      this.cueBusGain.connect(this.cueBusPan);
      this.cueBusPan.connect(this.masterGainNode);

      this.masterGainNode.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.ensureSchedulerWorker();
    return this.ctx;
  }

  /**
   * Creates the dedicated Web Worker that emits a tick every 25ms,
   * unaffected by background tab timer throttling.
   */
  private ensureSchedulerWorker() {
    if (this.schedulerWorker || typeof Worker === 'undefined') return;

    const workerScript = `
      let timerId = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (timerId !== null) clearInterval(timerId);
          timerId = setInterval(function() {
            self.postMessage('tick');
          }, ${SCHEDULER_TICK_MS});
        } else if (e.data === 'stop') {
          if (timerId !== null) {
            clearInterval(timerId);
            timerId = null;
          }
        }
      };
    `;

    const blob = new Blob([workerScript], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    this.schedulerWorker = new Worker(url);
    URL.revokeObjectURL(url);

    this.schedulerWorker.onmessage = () => {
      this.runLookaheadSchedulerTick();
    };
  }

  public subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    listener(this.getTransportState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Emits transport state to UI listeners.
   * Continuous updates are throttled to ~20 fps (50 ms); discrete state changes pass immediate = true.
   */
  private emitTransport(immediate = true) {
    const nowMs = performance.now();
    if (!immediate && nowMs - this.lastUiEmitTimeMs < UI_EMIT_INTERVAL_MS) {
      return;
    }
    this.lastUiEmitTimeMs = nowMs;
    const state = this.getTransportState();
    this.listeners.forEach((cb) => cb(state));
  }

  /**
   * Real size of a cached song in bytes = sum(length * numberOfChannels * 4)
   */
  public getCachedProjectBytes(projectId: string): number {
    const trackMap = this.projectBufferCache.get(projectId);
    if (!trackMap) return 0;
    let bytes = 0;
    trackMap.forEach((buf) => {
      bytes += buf.length * buf.numberOfChannels * 4;
    });
    return bytes;
  }

  /**
   * Total real bytes across all songs currently in projectBufferCache and streaming buffers
   */
  public getTotalCachedBytes(): number {
    let total = 0;
    this.projectBufferCache.forEach((_, projId) => {
      total += this.getCachedProjectBytes(projId);
    });
    if (this.isStreamingMode()) {
      this.streamingTracks.forEach((st) => {
        total += st.getStats().bufferedBytes;
      });
    }
    if (this.stagedNextTracks.size > 0) {
      this.stagedNextTracks.forEach((st) => {
        total += st.getStats().bufferedBytes;
      });
    }
    return total;
  }

  public getTotalCachedMB(): number {
    return Number((this.getTotalCachedBytes() / (1024 * 1024)).toFixed(1));
  }

  /**
   * Estimates the RAM in bytes a project will occupy BEFORE decoding:
   * durationSec * ctx.sampleRate * 4 bytes * sum(channels per track)
   * (channels = known real value, else pcm metadata, else 2)
   */
  public estimateProjectBytes(project: SongProject): number {
    if (!project || project.tracks.length === 0) return 0;
    const sampleRate = this.ctx?.sampleRate || 48000;
    const secPerBar = (60 / (project.bpm || 120)) * (project.beatsPerBar || 4);
    let durationSec =
      project.durationSec && project.durationSec > 1
        ? project.durationSec
        : Math.max(8, (project.totalBars || 24) * secPerBar);

    // If individual tracks carry known durationSec, use the max track duration
    for (const trk of project.tracks) {
      if (trk.durationSec && trk.durationSec > durationSec) {
        durationSec = trk.durationSec;
      }
    }

    let totalChannels = 0;
    for (const trk of project.tracks) {
      totalChannels += this.trackChannelHints.get(trk.id) ?? trk.pcm?.channels ?? 2;
    }
    return Math.ceil(durationSec * sampleRate * 4 * totalChannels);
  }

  /**
   * Logs [AudioEngine][RAM] with total in MB, budget in MB, and cached songs.
   */
  public logCacheRamMetrics(reason: string) {
    const totalBytes = this.getTotalCachedBytes();
    const totalMb = totalBytes / (1024 * 1024);
    const budgetMb = this.maxCacheBytes / (1024 * 1024);
    const perSongSummary: string[] = [];

    this.projectBufferCache.forEach((trackMap, projId) => {
      const songBytes = this.getCachedProjectBytes(projId);
      const isAct = projId === this.project?.id ? ' [ACTIVA]' : '';
      perSongSummary.push(
        `${projId}${isAct}: ${(songBytes / (1024 * 1024)).toFixed(2)} MB (${trackMap.size} pistas)`
      );
    });

    console.info(
      `[AudioEngine][RAM] ${reason} | Total en caché: ${totalMb.toFixed(2)} MB / Presupuesto: ${budgetMb.toFixed(0)} MB | Canciones cacheadas (${this.projectBufferCache.size}): [${perSongSummary.join(' | ') || 'ninguna'}]`
    );
  }

  /**
   * Evicts non-active cached songs BEFORE decoding so that `currentTotalBytes + incomingBytes <= maxCacheBytes`.
   * The active song (`this.project?.id`) is NEVER evicted while active.
   */
  private evictBeforeDecode(incomingBytes: number, protectedIds: string[] = []) {
    const activeId = this.project?.id;
    const protectedSet = new Set<string>(protectedIds.filter(Boolean));
    if (activeId) protectedSet.add(activeId);
    if (this.pinnedNextProjectId) protectedSet.add(this.pinnedNextProjectId);
    this.priorityProjectIds.forEach((id) => protectedSet.add(id));

    // Only evict while over budget. Unprotected songs go first (oldest first); if that is
    // not enough, protected songs other than the active one go next (oldest first).
    const evict = (victimId: string, why: string) => {
      const victimMap = this.projectBufferCache.get(victimId);
      if (victimMap) victimMap.clear();
      this.projectBufferCache.delete(victimId);
      this.cacheOrder = this.cacheOrder.filter((id) => id !== victimId);
      console.info(`[AudioEngine][RAM] Expulsada ${why} (${this.getRamBudgetMB()} MB): ${victimId}`);
    };

    while (this.getTotalCachedBytes() + incomingBytes > this.maxCacheBytes) {
      const victimId =
        this.cacheOrder.find((id) => id !== activeId && !protectedSet.has(id)) ??
        this.cacheOrder.find((id) => id !== activeId);
      if (!victimId) break;
      evict(victimId, 'por límite de presupuesto');
    }
  }

  /**
   * Songs that should stay in RAM whenever possible (e.g. first two of the setlist,
   * or active + next). They are evicted only after every other song.
   */
  public setPriorityProjectIds(ids: string[]) {
    this.priorityProjectIds = new Set(ids.filter(Boolean));
  }

  private touchCacheOrder(projectId: string) {
    this.cacheOrder = this.cacheOrder.filter((id) => id !== projectId);
    this.cacheOrder.push(projectId);
  }

  public getCachedProjectBuffers(projectId: string): Map<string, AudioBuffer> | undefined {
    const cached = this.projectBufferCache.get(projectId);
    if (cached && cached.size > 0) {
      return cached;
    }
    return undefined;
  }

  public hasFullProjectInCache(project: SongProject): boolean {
    if (project.tracks.length === 0) return true;
    const cached = this.projectBufferCache.get(project.id);
    if (!cached) return false;
    return project.tracks.every((t) => cached.has(t.id));
  }

  public storeProjectBuffersInRamCache(
    projectId: string,
    buffers: Map<string, AudioBuffer>
  ) {
    let incomingBytes = 0;
    buffers.forEach((buf) => {
      incomingBytes += buf.length * buf.numberOfChannels * 4;
    });

    this.evictBeforeDecode(incomingBytes, [this.project?.id || '', projectId]);

    let songMap = this.projectBufferCache.get(projectId);
    if (!songMap) {
      songMap = new Map<string, AudioBuffer>();
      this.projectBufferCache.set(projectId, songMap);
    }
    buffers.forEach((buf, trkId) => {
      songMap!.set(trkId, buf);
    });
    this.skippedByRamBudgetIds.delete(projectId);
    this.touchCacheOrder(projectId);
    this.logCacheRamMetrics(`storeProjectBuffersInRamCache(${projectId})`);
    this.emitCacheUpdate();
  }

  public clearStagedNextProject() {
    if (this.stagedNextTracks.size > 0) {
      this.stagedNextTracks.forEach((st) => st.dispose());
      this.stagedNextTracks.clear();
    }
    this.stagedNextProject = null;
    this.pendingStageNextProject = null;
    this.isStagingNextProject = false;
    this.emitCacheUpdate();
  }

  public getTotalUnderruns(): number {
    let count = 0;
    this.streamingTracks.forEach((st) => {
      count += st.getStats().underrunCount;
    });
    return count;
  }

  public evictSongFromRamCache(projectId: string) {
    if (this.stagedNextProject?.id === projectId) {
      this.clearStagedNextProject();
    }
    const map = this.projectBufferCache.get(projectId);
    if (map) {
      map.clear();
    }
    this.projectBufferCache.delete(projectId);
    this.cacheOrder = this.cacheOrder.filter((id) => id !== projectId);
    this.skippedByRamBudgetIds.delete(projectId);
    if (this.pinnedNextProjectId === projectId) {
      this.pinnedNextProjectId = null;
    }
    this.logCacheRamMetrics(`evictSongFromRamCache(${projectId})`);
    this.emitCacheUpdate();
  }

  public getSongRamCacheInfo(project: SongProject): SongRamCacheInfo {
    const totalCount = project.tracks.length;
    const effectiveMode = this.getEffectiveEngineModeForProject(project);

    // =========================================================================
    // STREAMING MODE RAM INFO
    // =========================================================================
    if (effectiveMode === 'stream') {
      // 1. If it's the currently active project
      if (this.project?.id === project.id && this.streamingTracks.size > 0) {
        const cachedBytes = Array.from(this.streamingTracks.values()).reduce(
          (sum, st) => sum + st.getStats().bufferedBytes,
          0
        );
        return {
          cachedCount: this.streamingTracks.size,
          totalCount,
          isReady: true,
          isPreloading: this.isMountingSong,
          skippedByRamBudget: false,
          cachedBytes,
          estimatedBytes: this.getProjectPcmEstimatedMB(project) * 1024 * 1024,
        };
      }

      // 2. If it's the staged next project
      if (this.stagedNextProject?.id === project.id && this.stagedNextTracks.size > 0) {
        const readyTracks = Array.from(this.stagedNextTracks.values()).filter((st) =>
          st.isStagedReady(NEXT_SONG_STAGE_SEC)
        ).length;
        const cachedBytes = Array.from(this.stagedNextTracks.values()).reduce(
          (sum, st) => sum + st.getStats().bufferedBytes,
          0
        );
        const isReady = totalCount > 0 && readyTracks >= totalCount;
        const isPreloading =
          this.isStagingNextProject || this.pendingStageNextProject?.id === project.id;

        return {
          cachedCount: readyTracks,
          totalCount,
          isReady,
          isPreloading,
          skippedByRamBudget: false,
          cachedBytes,
          estimatedBytes: this.getProjectPcmEstimatedMB(project) * 1024 * 1024,
        };
      }

      // 3. If it's queued or currently being staged
      if (this.pendingStageNextProject?.id === project.id || this.isStagingNextProject) {
        return {
          cachedCount: 0,
          totalCount,
          isReady: false,
          isPreloading: true,
          skippedByRamBudget: false,
          cachedBytes: 0,
          estimatedBytes: this.getProjectPcmEstimatedMB(project) * 1024 * 1024,
        };
      }

      return {
        cachedCount: 0,
        totalCount,
        isReady: false,
        isPreloading: false,
        skippedByRamBudget: false,
        cachedBytes: 0,
        estimatedBytes: this.getProjectPcmEstimatedMB(project) * 1024 * 1024,
      };
    }

    // =========================================================================
    // BUFFER MODE RAM INFO
    // =========================================================================
    const songMap = this.projectBufferCache.get(project.id);
    let cachedCount = 0;
    if (songMap) {
      for (const t of project.tracks) {
        if (songMap.has(t.id)) cachedCount++;
      }
    }
    const isReady = totalCount > 0 && cachedCount >= totalCount;
    const isPreloading = this.preloadingProjectIds.has(project.id);
    const skippedByRamBudget = !isReady && this.skippedByRamBudgetIds.has(project.id);
    const cachedBytes = this.getCachedProjectBytes(project.id);
    const estimatedBytes = this.estimateProjectBytes(project);

    return {
      cachedCount,
      totalCount,
      isReady,
      isPreloading,
      skippedByRamBudget,
      cachedBytes,
      estimatedBytes,
    };
  }

  /**
   * Downmixes dual-mono stereo AudioBuffers to a 1-channel AudioBuffer (halves RAM).
   * Real stereo (or already mono) buffers are returned untouched.
   */
  private compactDualMono(buf: AudioBuffer, trackId?: string): AudioBuffer {
    let out = buf;
    if (buf.numberOfChannels === 2) {
      const l = buf.getChannelData(0);
      if (isEffectivelyMono(l, buf.getChannelData(1))) {
        // Keep the average of L and R so nothing audible is lost
        const r = buf.getChannelData(1);
        const mono = this.ensureContext().createBuffer(1, buf.length, buf.sampleRate);
        const m = new Float32Array(buf.length);
        for (let i = 0; i < m.length; i++) m[i] = (l[i] + r[i]) * 0.5;
        mono.copyToChannel(m, 0);
        out = mono;
      }
    }
    if (trackId) this.trackChannelHints.set(trackId, out.numberOfChannels);
    return out;
  }

  public async decodeStemBuffer(
    rawBuffer: ArrayBuffer,
    label = 'stem',
    cloneBuffer = false
  ): Promise<{ audioBuffer: AudioBuffer; peaks: number[]; durationSec: number }> {
    const ctx = this.ensureContext();
    const t0 = performance.now();
    const targetBuf = cloneBuffer ? rawBuffer.slice(0) : rawBuffer;
    const audioBuffer = this.compactDualMono(await ctx.decodeAudioData(targetBuf));
    const elapsedMs = performance.now() - t0;
    console.info(
      `[AudioEngine][Decode] Pista "${label}" decodificada en ${elapsedMs.toFixed(1)} ms (${audioBuffer.duration.toFixed(1)}s, ${audioBuffer.numberOfChannels}ch)`
    );
    const peaks = extractWaveformPeaks(audioBuffer, 320);
    return {
      audioBuffer,
      peaks,
      durationSec: audioBuffer.duration,
    };
  }

  /**
   * Internal helper that decodes a project's missing tracks from IndexedDB.
   * When `isActiveLoad` is true (called from loadProject), the song is ALWAYS loaded regardless of budget.
   * When `isActiveLoad` is false (called from preloadProject for the next song), it checks if
   * `activeBytes + estimatedNextBytes <= maxCacheBytes` BEFORE decoding, and aborts if it doesn't fit!
   */
  private async decodeProjectIntoCache(
    project: SongProject,
    isActiveLoad: boolean,
    onProgress?: (cachedCount: number, totalCount: number) => void
  ): Promise<Map<string, AudioBuffer>> {
    const ctx = this.ensureContext();
    const totalTracks = project.tracks.length;

    const existingMap = this.projectBufferCache.get(project.id);
    if (existingMap && project.tracks.every((t) => existingMap.has(t.id))) {
      this.skippedByRamBudgetIds.delete(project.id);
      this.touchCacheOrder(project.id);
      onProgress?.(totalTracks, totalTracks);
      return existingMap;
    }

    const estimatedBytes = this.estimateProjectBytes(project);
    const activeId = this.project?.id;
    const activeBytes =
      activeId && activeId !== project.id
        ? this.getCachedProjectBytes(activeId) || (this.project ? this.estimateProjectBytes(this.project) : 0)
        : 0;

    // Evict any leftover songs BEFORE checking/decoding
    if (isActiveLoad) {
      this.evictBeforeDecode(estimatedBytes, [project.id]);
    } else {
      this.pinnedNextProjectId = project.id;
      this.evictBeforeDecode(0, [activeId || '', project.id]);

      // Check if active song + estimated next song fits within MAX_CACHE_BYTES
      if (activeBytes + estimatedBytes > this.maxCacheBytes) {
        const existingPartial = this.projectBufferCache.get(project.id);
        if (existingPartial) {
          existingPartial.clear();
          this.projectBufferCache.delete(project.id);
        }
        this.cacheOrder = this.cacheOrder.filter((id) => id !== project.id);
        this.skippedByRamBudgetIds.add(project.id);

        const activeMb = (activeBytes / (1024 * 1024)).toFixed(1);
        const estNextMb = (estimatedBytes / (1024 * 1024)).toFixed(1);
        const budgetMb = (this.maxCacheBytes / (1024 * 1024)).toFixed(0);
        console.info(
          `[AudioEngine][RAM] Siguiente canción "${project.title}" (${project.id}) NO precargada (RAM): activa (${activeMb} MB) + estimada siguiente (${estNextMb} MB) > presupuesto (${budgetMb} MB)`
        );
        this.logCacheRamMetrics(`preloadProject omitida por presupuesto ("${project.title}")`);
        this.emitCacheUpdate();
        return new Map<string, AudioBuffer>();
      }

      // Fits in budget: evict any other non-active song before decoding
      this.evictBeforeDecode(estimatedBytes, [activeId || '', project.id]);
    }

    const existingPromise = this.inFlightPreloads.get(project.id);
    if (existingPromise) {
      return existingPromise;
    }

    const preloadTask = (async () => {
      this.skippedByRamBudgetIds.delete(project.id);
      this.preloadingProjectIds.add(project.id);
      this.emitCacheUpdate();

      let songMap = this.projectBufferCache.get(project.id);
      if (!songMap) {
        songMap = new Map<string, AudioBuffer>();
        this.projectBufferCache.set(project.id, songMap);
      }

      try {
        const storedStems = await loadProjectStemsFromDb(project.id);
        const storedByTrackId = new Map(storedStems.map((s) => [s.trackId, s]));

        const missingTracks = project.tracks.filter((t) => !songMap!.has(t.id));
        let completed = totalTracks - missingTracks.length;
        onProgress?.(completed, totalTracks);

        // Parallel decoding with Promise.all (without breaking other tracks if one fails)
        await Promise.all(
          missingTracks.map(async (track) => {
            const stemRecord = storedByTrackId.get(track.id);
            if (!stemRecord) {
              completed++;
              onProgress?.(completed, totalTracks);
              return;
            }
            const t0 = performance.now();
            try {
              const rawBuf = await extractStemArrayBuffer(stemRecord);
              if (!rawBuf) return;
              const decoded = this.compactDualMono(await ctx.decodeAudioData(rawBuf), track.id);
              const elapsedMs = performance.now() - t0;
              console.info(
                `[AudioEngine][Decode] Pista "${track.name}" (${track.id}) decodificada en ${elapsedMs.toFixed(1)} ms`
              );
              songMap!.set(track.id, decoded);
            } catch (err) {
              console.error(
                `[AudioEngine][Decode Error] Falló decodificación de pista "${track.name}" (${track.id}):`,
                err
              );
            } finally {
              completed++;
              onProgress?.(completed, totalTracks);
              this.emitCacheUpdate();
            }
          })
        );

        this.touchCacheOrder(project.id);

        // Post-decode check: if this was a background preload and real size exceeded budget, evict it
        if (!isActiveLoad && this.project?.id && this.project.id !== project.id) {
          const realActiveBytes = this.getCachedProjectBytes(this.project.id);
          const realNextBytes = this.getCachedProjectBytes(project.id);
          if (realActiveBytes + realNextBytes > this.maxCacheBytes) {
            songMap.clear();
            this.projectBufferCache.delete(project.id);
            this.cacheOrder = this.cacheOrder.filter((id) => id !== project.id);
            this.skippedByRamBudgetIds.add(project.id);
            console.info(
              `[AudioEngine][RAM] Siguiente canción "${project.title}" expulsada tras decodificar: tamaño real (${(realNextBytes / (1024 * 1024)).toFixed(1)} MB) + activa (${(realActiveBytes / (1024 * 1024)).toFixed(1)} MB) > presupuesto (${this.getRamBudgetMB()} MB)`
            );
            this.logCacheRamMetrics(`Post-decode budget check ("${project.title}")`);
            return new Map<string, AudioBuffer>();
          }
        }

        this.logCacheRamMetrics(
          isActiveLoad
            ? `loadProject decoded ("${project.title}")`
            : `preloadProject("${project.title}")`
        );
        return songMap;
      } finally {
        this.preloadingProjectIds.delete(project.id);
        this.inFlightPreloads.delete(project.id);
        this.emitCacheUpdate();
      }
    })();

    this.inFlightPreloads.set(project.id, preloadTask);
    return preloadTask;
  }

  /**
  /**
   * Stages the next song in streaming mode (OPFS PCM):
   * Opens handles with 'next' priority and pre-buffers only the first NEXT_SONG_STAGE_SEC (6s = 3 chunks per track).
   * Total RAM: ~12 MB for 10 stereo stems. Enables fast swap (< 2 ms) upon activation.
   */
  private async stageNextSongStreaming(
    project: SongProject,
    onProgress?: (cachedCount: number, totalCount: number) => void
  ): Promise<void> {
    const ctx = this.ensureContext();
    if (this.stagedNextProject && this.stagedNextProject.id !== project.id) {
      this.clearStagedNextProject();
    }

    this.isStagingNextProject = true;
    this.stagedNextProject = project;
    this.emitCacheUpdate();

    try {
      const trackIds = project.tracks.map((t) => t.id);
      await pcmReaderClient.openProject(project.id, trackIds, 'next');

      // Create a dummy silent gain node before connection to mixer
      const dummyGain = ctx.createGain();
      dummyGain.gain.value = 0;

      let stagedCount = 0;
      const totalTracks = project.tracks.length;
      onProgress?.(0, totalTracks);

      for (const track of project.tracks) {
        let st = this.stagedNextTracks.get(track.id);
        if (!st) {
          st = new StreamingTrack({
            projectId: project.id,
            trackId: track.id,
            sampleRate: track.pcm?.sampleRate || ctx.sampleRate,
            totalFrames:
              track.pcm?.frames ||
              Math.round((track.durationSec || project.durationSec || 60) * 48000),
            channels: track.pcm?.channels,
            destinationNode: dummyGain,
            ctx,
            pitchSemitones: project.pitchSemitones || 0,
          });
          this.stagedNextTracks.set(track.id, st);
        }
      }

      await Promise.all(
        Array.from(this.stagedNextTracks.values()).map(async (st) => {
          await st.prefetchStagedChunks(NEXT_SONG_STAGE_SEC);
          stagedCount++;
          onProgress?.(stagedCount, totalTracks);
          this.emitCacheUpdate();
        })
      );

      console.info(
        `[AudioEngine][Staging] Siguiente canción "${project.title}" puesta en escena en RAM (${NEXT_SONG_STAGE_SEC}s = 3 chunks/pista, ~12 MB) lista para cambio instantáneo (< 2 ms)`
      );
    } catch (err) {
      console.error(`[AudioEngine][Staging Error] Falló puesta en escena de "${project.title}":`, err);
    } finally {
      this.isStagingNextProject = false;
      this.emitCacheUpdate();
    }
  }

  /**
   * Preloads the next song in the setlist:
   * - In streaming mode: stages initial 6s with 'next' priority (~12 MB RAM) if playback is stable (>= 8s) or stopped.
   * - In buffer mode: decodes full AudioBuffers into RAM respecting MAX_CACHE_BYTES.
   */
  public async preloadProject(
    project: SongProject,
    onProgress?: (cachedCount: number, totalCount: number) => void
  ): Promise<Map<string, AudioBuffer>> {
    if (this.project?.id === project.id) {
      return new Map();
    }

    const effectiveMode = this.getEffectiveEngineModeForProject(project);

    if (effectiveMode === 'stream') {
      // If already staged and ready, report completion
      if (
        this.stagedNextProject?.id === project.id &&
        this.stagedNextTracks.size >= project.tracks.length &&
        Array.from(this.stagedNextTracks.values()).every((st) => st.isStagedReady(NEXT_SONG_STAGE_SEC))
      ) {
        onProgress?.(project.tracks.length, project.tracks.length);
        return new Map();
      }

      // If playing and haven't had 8s of stable playback yet, defer staging to avoid CPU/disk contention
      if (this.isPlaying && this.activePlaybackStableSec < 8) {
        this.pendingStageNextProject = project;
        console.info(
          `[AudioEngine][Staging] Puesta en escena diferida de "${project.title}" hasta 8s de reproducción estable (tiempo estable actual: ${this.activePlaybackStableSec.toFixed(1)}s)`
        );
        this.emitCacheUpdate();
        return new Map();
      }

      // Otherwise start staging immediately
      await this.stageNextSongStreaming(project, onProgress);
      return new Map();
    }

    return this.decodeProjectIntoCache(project, false, onProgress);
  }

  public async preloadSongIntoRam(
    project: SongProject,
    onProgress?: (cachedCount: number, totalCount: number) => void
  ): Promise<Map<string, AudioBuffer>> {
    return this.preloadProject(project, onProgress);
  }

  public getTotalDurationSec(): number {
    if (!this.project) return 0;
    if (this.isStreamingMode()) {
      let maxStreamSec = 0;
      this.streamingTracks.forEach((st) => {
        if (st.totalDurationSec > maxStreamSec) maxStreamSec = st.totalDurationSec;
      });
      if (maxStreamSec > 1) return maxStreamSec;
    }
    let maxBufSec = 0;
    this.trackBuffers.forEach((buf) => {
      if (buf.duration > maxBufSec) maxBufSec = buf.duration;
    });
    if (maxBufSec > 1) return maxBufSec;
    if (this.project.durationSec && this.project.durationSec > 1) {
      return this.project.durationSec;
    }
    const secPerBar = (60 / (this.project.bpm || 120)) * (this.project.beatsPerBar || 4);
    return Math.max(8, (this.project.totalBars || 24) * secPerBar);
  }

  /**
   * Mounts a project into the active audio graph.
   * If in streaming mode ('stream'), opens OPFS PCM handles and pre-buffers the initial 10s (or uses staged tracks in < 2 ms).
   * If in buffer mode ('buffer'), decodes full AudioBuffers into RAM respecting MAX_CACHE_BYTES.
   */
  public async loadProject(
    project: SongProject,
    predecodedBuffers?: Map<string, AudioBuffer>
  ): Promise<{ peaksMap: Map<string, number[]>; wasCancelled: boolean }> {
    const myGenId = ++this.loadGenerationId;
    this.stop();

    const ctx = this.ensureContext();
    this.project = project;
    this.skippedByRamBudgetIds.delete(project.id);

    if (predecodedBuffers && predecodedBuffers.size > 0) {
      this.storeProjectBuffersInRamCache(project.id, predecodedBuffers);
    }

    // Disconnect previous track audio nodes
    this.trackNodes.forEach((node) => {
      try {
        node.source?.stop();
        node.source?.disconnect();
        node.sourceFadeGain?.disconnect();
        node.gainNode.disconnect();
        node.panNode.disconnect();
        node.analyser.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    });
    this.trackNodes.clear();

    const effectiveMode = this.getEffectiveEngineModeForProject(project);

    // =========================================================================
    // STREAMING MODE (OPFS PCM — REAPER STYLE)
    // Audio lives in disk, RAM holds only ~10s moving window (< 100 MB total RAM)
    // =========================================================================
    if (effectiveMode === 'stream') {
      // FAST SWAP: If this exact song was staged as next song with all tracks ready
      const isFastSwap =
        this.stagedNextProject?.id === project.id &&
        this.stagedNextTracks.size === project.tracks.length &&
        project.tracks.every((t) => this.stagedNextTracks.has(t.id));

      if (isFastSwap) {
        console.info(
          `[AudioEngine][Streaming] ⚡ FAST SWAP: "${project.title}" activada instantáneamente desde puesta en escena (< 2 ms)`
        );
        this.streamingTracks.forEach((st) => st.dispose());
        this.streamingTracks.clear();
        this.trackBuffers.clear();

        const updatedPeaks = new Map<string, number[]>();
        for (const track of project.tracks) {
          const gainNode = ctx.createGain();
          const panNode = ctx.createStereoPanner();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;

          gainNode.connect(panNode);
          panNode.connect(analyser);

          this.trackNodes.set(track.id, {
            source: null,
            sourceFadeGain: null,
            gainNode,
            panNode,
            analyser,
            timeDomainData: new Float32Array(analyser.fftSize),
          });

          const st = this.stagedNextTracks.get(track.id)!;
          st.setDestinationNode(gainNode);
          st.setPitchSemitones(project.pitchSemitones || 0);
          this.streamingTracks.set(track.id, st);

          if (track.peaks && track.peaks.length >= 64) {
            updatedPeaks.set(track.id, track.peaks);
          }
        }

        this.stagedNextTracks.clear();
        this.stagedNextProject = null;
        this.pendingStageNextProject = null;
        this.isMountingSong = false;
        this.mountingProgressText = null;

        this.applyMixerRouting();
        this.pausedSongSec = 0;
        const firstSec = project.sections[0] || null;
        this.activeSectionId = firstSec ? firstSec.id : null;
        this.isVamping = Boolean(firstSec?.vampByDefault);
        this.lastCueMessage = firstSec ? `LISTO: ${firstSec.name.toUpperCase()}` : null;
        this.emitTransport(true);
        this.emitCacheUpdate();
        this.logStreamMetrics(`loadProject FAST SWAP ("${project.title}")`);

        return { peaksMap: updatedPeaks, wasCancelled: false };
      }

      // Not fast swap: clear any staged tracks for different project
      if (this.stagedNextProject && this.stagedNextProject.id !== project.id) {
        this.clearStagedNextProject();
      }

      this.streamingTracks.forEach((st) => st.dispose());
      this.streamingTracks.clear();
      this.trackBuffers.clear();

      this.isMountingSong = true;
      this.mountingProgressText = `Preparando streaming OPFS (modo REAPER)...`;
      this.emitTransport(true);

      const trackIds = project.tracks.map((t) => t.id);
      const { openedTracks } = await pcmReaderClient.openProject(project.id, trackIds, 'active');

      if (myGenId !== this.loadGenerationId) {
        return { peaksMap: new Map(), wasCancelled: true };
      }

      // ROBUSTNESS CHECK: If any OPFS PCM file is missing or corrupt, fall back to 'buffer' mode automatically
      const openedSet = new Set(openedTracks);
      const allTracksOpened = project.tracks.every((t) => openedSet.has(t.id));

      if (!allTracksOpened) {
        console.warn(
          `[AudioEngine][Stream] Archivos PCM incompletos en OPFS para "${project.title}" (${openedTracks.length}/${project.tracks.length} pistas encontradas). Activando fallback automático a motor 'buffer' desde IndexedDB.`
        );
        this.fallbackBufferProjectIds.add(project.id);
      } else {
        const updatedPeaks = new Map<string, number[]>();
        for (const track of project.tracks) {
          const gainNode = ctx.createGain();
          const panNode = ctx.createStereoPanner();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;

          gainNode.connect(panNode);
          panNode.connect(analyser);

          this.trackNodes.set(track.id, {
            source: null,
            sourceFadeGain: null,
            gainNode,
            panNode,
            analyser,
            timeDomainData: new Float32Array(analyser.fftSize),
          });

          const st = new StreamingTrack({
            projectId: project.id,
            trackId: track.id,
            sampleRate: track.pcm?.sampleRate || ctx.sampleRate,
            totalFrames:
              track.pcm?.frames ||
              Math.round((track.durationSec || project.durationSec || 60) * 48000),
            channels: track.pcm?.channels,
            destinationNode: gainNode,
            ctx,
            pitchSemitones: project.pitchSemitones || 0,
          });
          this.streamingTracks.set(track.id, st);

          if (track.peaks && track.peaks.length >= 64) {
            updatedPeaks.set(track.id, track.peaks);
          }
        }

        this.mountingProgressText = `Precargando ventana de audio inicial (10s)...`;
        this.emitTransport(true);

        await Promise.all(
          Array.from(this.streamingTracks.values()).map((st) =>
            st.prefetchInitialChunks(0, 'active')
          )
        );

        if (myGenId !== this.loadGenerationId) {
          return { peaksMap: new Map(), wasCancelled: true };
        }

        // Verify at least 1 chunk per track was read without fatal corruption
        const allHaveInitialBuffer = Array.from(this.streamingTracks.values()).every(
          (st) => st.getStats().bufferedChunks > 0 || st.totalFrames === 0
        );

        if (!allHaveInitialBuffer) {
          console.warn(
            `[AudioEngine][Stream] Falló lectura inicial de chunks PCM para "${project.title}". Activando fallback automático a motor 'buffer'.`
          );
          this.fallbackBufferProjectIds.add(project.id);
          this.streamingTracks.forEach((st) => st.dispose());
          this.streamingTracks.clear();
          this.trackNodes.forEach((node) => {
            try {
              node.gainNode.disconnect();
              node.panNode.disconnect();
              node.analyser.disconnect();
            } catch {
              // ignore
            }
          });
          this.trackNodes.clear();
        } else {
          this.isMountingSong = false;
          this.mountingProgressText = null;
          this.applyMixerRouting();
          this.pausedSongSec = 0;
          const firstSec = project.sections[0] || null;
          this.activeSectionId = firstSec ? firstSec.id : null;
          this.isVamping = Boolean(firstSec?.vampByDefault);
          this.lastCueMessage = firstSec ? `LISTO: ${firstSec.name.toUpperCase()}` : null;
          this.emitTransport(true);
          this.emitCacheUpdate();

          this.logStreamMetrics(`loadProject("${project.title}")`);
          return { peaksMap: updatedPeaks, wasCancelled: false };
        }
      }
    }

    // =========================================================================
    // BUFFER MODE (AudioBuffer completo en RAM con presupuesto MAX_CACHE_BYTES)
    // =========================================================================
    this.streamingTracks.forEach((st) => st.dispose());
    this.streamingTracks.clear();

    const cacheInfo = this.getSongRamCacheInfo(project);
    if (!cacheInfo.isReady && project.tracks.length > 0) {
      this.isMountingSong = true;
      this.mountingProgressText = `Cargando pistas en RAM (${cacheInfo.cachedCount}/${cacheInfo.totalCount})...`;
      this.emitTransport(true);
    }

    let songBuffers = this.projectBufferCache.get(project.id);
    const allCached =
      songBuffers && project.tracks.every((t) => songBuffers!.has(t.id));

    if (!allCached) {
      songBuffers = await this.decodeProjectIntoCache(project, true, (loaded, total) => {
        if (myGenId === this.loadGenerationId && loaded < total) {
          this.isMountingSong = true;
          this.mountingProgressText = `Cargando pistas en RAM (${loaded}/${total})...`;
          this.emitTransport(true);
        }
      });
    } else {
      this.touchCacheOrder(project.id);
      // Ensure total cached bytes respect budget now that this song is active
      this.evictBeforeDecode(0, [project.id, this.pinnedNextProjectId || '']);
      this.logCacheRamMetrics(`loadProject CACHE HIT ("${project.title}")`);
    }

    if (myGenId !== this.loadGenerationId) {
      return { peaksMap: new Map(), wasCancelled: true };
    }

    // Point trackBuffers to a fresh Map referencing the cached AudioBuffers (never clearing cached maps)
    const nextTrackBuffers = new Map<string, AudioBuffer>();
    const updatedPeaks = new Map<string, number[]>();

    for (const track of project.tracks) {
      const audioBuffer = songBuffers?.get(track.id);
      if (!audioBuffer) continue;

      nextTrackBuffers.set(track.id, audioBuffer);

      const peaks =
        track.peaks && track.peaks.length >= 64
          ? track.peaks
          : extractWaveformPeaks(audioBuffer, 320);
      updatedPeaks.set(track.id, peaks);

      const gainNode = ctx.createGain();
      const panNode = ctx.createStereoPanner();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;

      gainNode.connect(panNode);
      panNode.connect(analyser);

      this.trackNodes.set(track.id, {
        source: null,
        sourceFadeGain: null,
        gainNode,
        panNode,
        analyser,
        timeDomainData: new Float32Array(analyser.fftSize),
      });
    }

    this.trackBuffers = nextTrackBuffers;
    this.isMountingSong = false;
    this.mountingProgressText = null;
    this.applyMixerRouting();
    this.pausedSongSec = 0;
    const firstSec = project.sections[0] || null;
    this.activeSectionId = firstSec ? firstSec.id : null;
    this.isVamping = Boolean(firstSec?.vampByDefault);
    this.lastCueMessage = firstSec ? `LISTO: ${firstSec.name.toUpperCase()}` : null;
    this.emitTransport(true);

    return { peaksMap: updatedPeaks, wasCancelled: false };
  }

  /**
   * Playback rate factor produced by source.detune: rate = 2^(semitones / 12)
   */
  private getPlaybackRate(semitones = this.project?.pitchSemitones ?? 0): number {
    return Math.pow(2, (semitones || 0) / 12);
  }

  private getSongSecAtCtxTime(ctxTime: number): number {
    if (!this.isPlaying) {
      return this.pausedSongSec;
    }
    const rate = this.getPlaybackRate();
    return this.playStartSongSec + Math.max(0, ctxTime - this.playStartCtxTime) * rate;
  }

  private getCtxTimeForSongSec(targetSongSec: number): number {
    if (!this.ctx) return 0;
    const rate = this.getPlaybackRate();
    return this.playStartCtxTime + (targetSongSec - this.playStartSongSec) / rate;
  }

  private getCurrentSongSec(): number {
    if (!this.isPlaying || !this.ctx) {
      return this.pausedSongSec;
    }
    return this.getSongSecAtCtxTime(this.ctx.currentTime);
  }

  public updateProjectConfig(project: SongProject) {
    const prevPitch = this.project?.pitchSemitones ?? 0;
    const nextPitch = project.pitchSemitones ?? 0;

    // Re-anchor playStartSongSec and playStartCtxTime BEFORE applying the new detune so there is no jump
    if (prevPitch !== nextPitch && this.isPlaying && this.ctx) {
      const nowCtx = this.ctx.currentTime;
      const currentSongSec = this.getSongSecAtCtxTime(nowCtx);
      this.playStartSongSec = currentSongSec;
      this.playStartCtxTime = nowCtx;
      this.project = project;

      if (this.isStreamingMode()) {
        this.streamingTracks.forEach((st) => st.setPitchSemitones(nextPitch));
      } else {
        this.trackNodes.forEach((node) => {
          if (node.source) {
            node.source.detune.setValueAtTime(nextPitch * 100, nowCtx);
          }
        });
      }
    } else {
      this.project = project;
      if (this.isStreamingMode()) {
        this.streamingTracks.forEach((st) => st.setPitchSemitones(nextPitch));
      }
    }

    this.applyMixerRouting();
    this.emitTransport(true);
  }

  /**
   * Mounts a newly imported project shell and its mixer nodes in < 1 ms
   * so the UI and mixer are 100% responsive immediately while stems decode in parallel.
   */
  public prepareProjectShell(project: SongProject): void {
    ++this.loadGenerationId;
    this.stop();

    const ctx = this.ensureContext();
    this.project = project;
    this.skippedByRamBudgetIds.delete(project.id);

    this.trackNodes.forEach((node) => {
      try {
        node.source?.stop();
        node.source?.disconnect();
        node.sourceFadeGain?.disconnect();
        node.gainNode.disconnect();
        node.panNode.disconnect();
        node.analyser.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    });
    this.trackNodes.clear();

    this.streamingTracks.forEach((st) => st.dispose());
    this.streamingTracks.clear();
    this.trackBuffers.clear();

    let songMap = this.projectBufferCache.get(project.id);
    if (!songMap) {
      songMap = new Map<string, AudioBuffer>();
      this.projectBufferCache.set(project.id, songMap);
    }
    this.touchCacheOrder(project.id);

    for (const track of project.tracks) {
      const gainNode = ctx.createGain();
      const panNode = ctx.createStereoPanner();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;

      gainNode.connect(panNode);
      panNode.connect(analyser);

      this.trackNodes.set(track.id, {
        source: null,
        sourceFadeGain: null,
        gainNode,
        panNode,
        analyser,
        timeDomainData: new Float32Array(analyser.fftSize),
      });
    }

    this.isMountingSong = false;
    this.mountingProgressText = null;
    this.applyMixerRouting();
    this.pausedSongSec = 0;
    const firstSec = project.sections[0] || null;
    this.activeSectionId = firstSec ? firstSec.id : null;
    this.isVamping = Boolean(firstSec?.vampByDefault);
    this.lastCueMessage = firstSec ? `LISTO: ${firstSec.name.toUpperCase()}` : null;
    this.emitTransport(true);
    this.emitCacheUpdate();
  }

  public mountDecodedTrack(
    track: TrackChannel,
    decoded: AudioBuffer
  ): { peaks: number[]; durationSec: number } {
    const ctx = this.ensureContext();
    this.trackChannelHints.set(track.id, decoded.numberOfChannels);
    this.trackBuffers.set(track.id, decoded);

    if (this.project) {
      const incomingBytes = decoded.length * decoded.numberOfChannels * 4;
      this.evictBeforeDecode(incomingBytes, [this.project.id]);
      let songMap = this.projectBufferCache.get(this.project.id);
      if (!songMap) {
        songMap = new Map();
        this.projectBufferCache.set(this.project.id, songMap);
      }
      songMap.set(track.id, decoded);
      this.touchCacheOrder(this.project.id);
      this.logCacheRamMetrics(`mountDecodedTrack("${track.name}")`);
      this.emitCacheUpdate();
    }

    const peaks =
      track.peaks && track.peaks.length >= 64
        ? track.peaks
        : extractWaveformPeaks(decoded, 320);

    let existingNode = this.trackNodes.get(track.id);
    if (!existingNode) {
      const gainNode = ctx.createGain();
      const panNode = ctx.createStereoPanner();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;

      gainNode.connect(panNode);
      panNode.connect(analyser);

      existingNode = {
        source: null,
        sourceFadeGain: null,
        gainNode,
        panNode,
        analyser,
        timeDomainData: new Float32Array(analyser.fftSize),
      };
      this.trackNodes.set(track.id, existingNode);
    }

    const gainNode = existingNode.gainNode;

    if (this.project) {
      const enrichedTrack: TrackChannel = {
        ...track,
        peaks,
        durationSec: decoded.duration,
      };
      const exists = this.project.tracks.some((t) => t.id === track.id);
      const nextTracks = exists
        ? this.project.tracks.map((t) => (t.id === track.id ? enrichedTrack : t))
        : [...this.project.tracks, enrichedTrack];

      const nextDurationSec = Math.max(this.project.durationSec || 0, decoded.duration);
      const secPerBar = (60 / (this.project.bpm || 120)) * (this.project.beatsPerBar || 4);
      const nextTotalBars = Math.max(
        this.project.totalBars || 24,
        nextDurationSec > 2 ? Math.max(4, Math.ceil(nextDurationSec / secPerBar)) : 24
      );

      this.project = {
        ...this.project,
        durationSec: nextDurationSec,
        totalBars: nextTotalBars,
        tracks: nextTracks,
      };

      this.applyMixerRouting();
      this.emitTransport(true);

      if (this.isStreamingMode() && track.pcm && track.pcm.frames > 0) {
        try {
          pcmReaderClient.openProject(this.project.id, [track.id], 'active').catch(() => {});
          const st = new StreamingTrack({
            projectId: this.project.id,
            trackId: track.id,
            sampleRate: track.pcm.sampleRate || ctx.sampleRate,
            totalFrames: track.pcm.frames,
            channels: track.pcm.channels,
            destinationNode: gainNode,
            ctx,
            pitchSemitones: this.project.pitchSemitones || 0,
          });
          this.streamingTracks.set(track.id, st);
          if (this.isPlaying) {
            const currentSec = this.getCurrentSongSec();
            st.seekTo(currentSec).catch(() => {});
          }
        } catch (stErr) {
          console.warn('[AudioEngine] Error mounting streaming track, falling back to buffer:', stErr);
          if (this.isPlaying) {
            const currentSec = this.getCurrentSongSec();
            this.startSourceForTrack(track.id, currentSec, ctx.currentTime);
          }
        }
      } else if (this.isPlaying) {
        const currentSec = this.getCurrentSongSec();
        this.startSourceForTrack(track.id, currentSec, ctx.currentTime);
      }
    }

    return { peaks, durationSec: decoded.duration };
  }

  public removeTrack(trackId: string) {
    const nodes = this.trackNodes.get(trackId);
    if (nodes) {
      try {
        nodes.source?.stop();
        nodes.source?.disconnect();
        nodes.sourceFadeGain?.disconnect();
        nodes.gainNode.disconnect();
        nodes.panNode.disconnect();
        nodes.analyser.disconnect();
      } catch {
        // ignore
      }
      this.trackNodes.delete(trackId);
    }
    this.trackBuffers.delete(trackId);
    const st = this.streamingTracks.get(trackId);
    if (st) {
      st.dispose();
      this.streamingTracks.delete(trackId);
    }
    if (this.project) {
      this.projectBufferCache.get(this.project.id)?.delete(trackId);
      this.emitCacheUpdate();
    }
  }

  private applyMixerRouting() {
    if (
      !this.project ||
      !this.ctx ||
      !this.masterGainNode ||
      !this.mainBusGain ||
      !this.cueBusGain ||
      !this.mainBusPan ||
      !this.cueBusPan
    ) {
      return;
    }

    this.masterGainNode.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.015);
    this.mainBusGain.gain.setTargetAtTime(this.project.masterGain, this.ctx.currentTime, 0.015);
    this.cueBusGain.gain.setTargetAtTime(
      this.project.cueMasterGain ?? 0.708,
      this.ctx.currentTime,
      0.015
    );

    if (this.project.splitRoutingMode === 'split-mono') {
      this.cueBusPan.pan.setValueAtTime(-1.0, this.ctx.currentTime);
      this.mainBusPan.pan.setValueAtTime(1.0, this.ctx.currentTime);
    } else {
      this.cueBusPan.pan.setValueAtTime(0.0, this.ctx.currentTime);
      this.mainBusPan.pan.setValueAtTime(0.0, this.ctx.currentTime);
    }

    const anySolo = this.project.tracks.some((t) => t.soloed);

    for (const track of this.project.tracks) {
      const node = this.trackNodes.get(track.id);
      if (!node || !this.mainBusGain || !this.cueBusGain) continue;

      const isAudible = anySolo ? track.soloed && !track.muted : !track.muted;
      const effectiveGain = isAudible ? track.gain : 0;

      node.gainNode.gain.setTargetAtTime(effectiveGain, this.ctx.currentTime, 0.015);
      node.panNode.pan.setTargetAtTime(
        this.project.splitRoutingMode === 'split-mono' ? 0 : track.pan,
        this.ctx.currentTime,
        0.015
      );

      try {
        node.analyser.disconnect();
      } catch {
        // ignore
      }

      if (track.bus === 'main') {
        node.analyser.connect(this.mainBusGain);
      } else if (track.bus === 'cue-click') {
        node.analyser.connect(this.cueBusGain);
      } else {
        node.analyser.connect(this.mainBusGain);
        node.analyser.connect(this.cueBusGain);
      }
    }
  }

  /**
   * Smoothly fades out and stops an existing track source over FADE_DURATION_SEC (8 ms)
   * at `fadeOutStartCtxTime`, preventing clicks/pops on pause, stop, seek, vamp, or section jumps.
   */
  private fadeOutAndStopNodeSource(
    node: ActiveTrackNodes,
    fadeOutStartCtxTime: number
  ) {
    if (!this.ctx || !node.source) return;
    const oldSource = node.source;
    const oldFadeGain = node.sourceFadeGain;
    node.source = null;
    node.sourceFadeGain = null;

    const now = this.ctx.currentTime;
    const startRampAt = Math.max(now, fadeOutStartCtxTime);
    const stopAt = startRampAt + FADE_DURATION_SEC;

    try {
      if (oldFadeGain) {
        oldFadeGain.gain.cancelScheduledValues(startRampAt);
        oldFadeGain.gain.setValueAtTime(1.0, startRampAt);
        oldFadeGain.gain.linearRampToValueAtTime(0.0001, stopAt);
      }
      oldSource.stop(stopAt);
      window.setTimeout(() => {
        try {
          oldSource.disconnect();
          oldFadeGain?.disconnect();
        } catch {
          // ignore
        }
      }, Math.max(30, (stopAt - now) * 1000 + 30));
    } catch {
      try {
        oldSource.stop();
        oldSource.disconnect();
        oldFadeGain?.disconnect();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Starts or schedules a track's AudioBufferSourceNode at an exact AudioContext time (`whenCtxTime`)
   * and song offset (`offsetSec`), applying an 8 ms fade-in (and 8 ms crossfade if replacing an active source).
   */
  private startSourceForTrack(
    trackId: string,
    offsetSec: number,
    whenCtxTime = 0,
    stopPreviousAtCtxTime?: number
  ) {
    if (!this.ctx || !this.project) return;
    if (this.isStreamingMode() && this.streamingTracks.has(trackId)) return;
    const buffer = this.trackBuffers.get(trackId);
    const node = this.trackNodes.get(trackId);
    if (!buffer || !node) return;

    const now = this.ctx.currentTime;
    if (node.source) {
      const fadeOutStart =
        stopPreviousAtCtxTime !== undefined && stopPreviousAtCtxTime > now
          ? stopPreviousAtCtxTime
          : now;
      this.fadeOutAndStopNodeSource(node, fadeOutStart);
    }

    if (offsetSec >= buffer.duration) return;

    const source = this.ctx.createBufferSource();
    const sourceFadeGain = this.ctx.createGain();
    source.buffer = buffer;
    source.detune.value = (this.project.pitchSemitones || 0) * 100;

    const startWhen = whenCtxTime > now ? whenCtxTime : now;
    // 8 ms micro-fade-in to eliminate clicks
    sourceFadeGain.gain.setValueAtTime(0.0001, startWhen);
    sourceFadeGain.gain.linearRampToValueAtTime(1.0, startWhen + FADE_DURATION_SEC);

    source.connect(sourceFadeGain);
    sourceFadeGain.connect(node.gainNode);
    source.start(startWhen, Math.max(0, offsetSec));

    node.source = source;
    node.sourceFadeGain = sourceFadeGain;
  }

  private startAllTrackSources(
    offsetSec: number,
    whenCtxTime = 0,
    stopPreviousAtCtxTime?: number
  ) {
    if (!this.project) return;
    for (const track of this.project.tracks) {
      this.startSourceForTrack(
        track.id,
        offsetSec,
        whenCtxTime,
        stopPreviousAtCtxTime
      );
    }
  }

  private stopAllTrackSourcesWithFade() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.trackNodes.forEach((node) => {
      if (node.source) {
        this.fadeOutAndStopNodeSource(node, now);
      }
    });
  }

  public play() {
    if (!this.project) return;
    if (this.isMountingSong) {
      this.notify(this.mountingProgressText || 'La canción todavía se está cargando…');
      return;
    }
    if (this.project.tracks.length > 0 && !this.hasPlayableAudio()) {
      this.notify(
        `"${this.project.title}" aún no tiene audio listo: se está preparando en segundo plano, o no se pudo leer el original (Biblioteca → Reubicar archivos).`
      );
      return;
    }

    const ctx = this.ensureContext();
    if (this.isPlaying) return;

    const startCtx = ctx.currentTime;
    this.isPlaying = true;
    this.playStartCtxTime = startCtx;
    this.playStartSongSec = this.pausedSongSec;
    this.pendingTransitionCtxTime = null;
    this.activePlaybackStableSec = 0;

    // Initialize lastScheduledSubStep just before current position so beat 1 at playStartSongSec is scheduled
    const secPerBeat = 60 / (this.project.bpm || 120);
    const subdiv = this.project.clickSubdivision || 1;
    this.lastScheduledSubStep = Math.floor((this.playStartSongSec / secPerBeat) * subdiv) - 1;
    this.lastAnnouncedSectionId = null;

    if (this.isStreamingMode()) {
      const rate = this.getPlaybackRate();
      this.streamingTracks.forEach((st) => {
        st.setPitchSemitones(this.project!.pitchSemitones || 0);
        st.updateScheduler({
          isPlaying: true,
          currentSongSec: this.playStartSongSec,
          playStartSongSec: this.playStartSongSec,
          playStartCtxTime: startCtx,
          rate,
          lookaheadSec: SCHEDULER_LOOKAHEAD_SEC,
        });
      });
    } else {
      this.startAllTrackSources(this.playStartSongSec, startCtx);
    }

    // Run an immediate lookahead pass and start the 25ms Web Worker scheduler + UI rAF loop
    this.runLookaheadSchedulerTick();
    this.schedulerWorker?.postMessage('start');
    this.startUiLoop();
    this.emitTransport(true);
  }

  public pause() {
    if (!this.isPlaying) return;
    this.pausedSongSec = this.getCurrentSongSec();
    this.isPlaying = false;
    this.pendingTransitionCtxTime = null;
    this.activePlaybackStableSec = 0;
    this.schedulerWorker?.postMessage('stop');
    if (this.isStreamingMode()) {
      this.streamingTracks.forEach((st) => st.stopSourcesWithFade());
    } else {
      this.stopAllTrackSourcesWithFade();
    }
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.emitTransport(true);
  }

  private noticeListener: ((message: string) => void) | null = null;

  /** Lets the UI show a message when an action can't proceed (instead of failing silently). */
  public setOnNotice(cb: ((message: string) => void) | null) {
    this.noticeListener = cb;
  }

  private notify(message: string) {
    console.warn(`[AudioEngine][Aviso] ${message}`);
    this.noticeListener?.(message);
  }

  /** True when the active song has audio ready to play (stream tracks or RAM buffers). */
  public hasPlayableAudio(): boolean {
    if (!this.project) return false;
    if (this.project.tracks.length === 0) return true;
    return this.isStreamingMode() ? this.streamingTracks.size > 0 : this.trackBuffers.size > 0;
  }

  public togglePlayPause() {
    if (this.isMountingSong) {
      this.notify(this.mountingProgressText || 'La canción todavía se está cargando…');
      return;
    }
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  public stop() {
    this.isPlaying = false;
    this.pausedSongSec = 0;
    this.queuedSectionId = null;
    this.queuedTargetSec = null;
    this.pendingTransitionCtxTime = null;
    this.lastScheduledSubStep = -1;
    this.lastAnnouncedSectionId = null;
    this.activePlaybackStableSec = 0;
    this.schedulerWorker?.postMessage('stop');
    if (this.isStreamingMode()) {
      this.streamingTracks.forEach((st) => {
        st.unpinSectionChunks();
        st.stopSourcesWithFade();
      });
    } else {
      this.stopAllTrackSourcesWithFade();
    }

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.project && this.project.sections.length > 0) {
      const first = this.project.sections[0];
      this.activeSectionId = first.id;
      this.isVamping = Boolean(first.vampByDefault);
      this.lastCueMessage = `LISTO: ${first.name.toUpperCase()}`;
    } else {
      this.activeSectionId = null;
      this.isVamping = false;
      this.lastCueMessage = null;
    }

    this.emitTransport(true);
  }

  public seekToSeconds(seconds: number) {
    if (!this.project || this.isMountingSong) return;
    const totalSec = this.getTotalDurationSec();
    const clampedSec = Math.max(0, Math.min(totalSec - 0.01, seconds));

    const matchingSec = this.findSectionAtTime(clampedSec);
    if (matchingSec) {
      this.activeSectionId = matchingSec.id;
      this.isVamping = Boolean(matchingSec.vampByDefault);
      this.lastCueMessage = `SECCIÓN: ${matchingSec.name.toUpperCase()}`;
    }

    this.queuedSectionId = null;
    this.queuedTargetSec = null;
    this.pendingTransitionCtxTime = null;
    this.activePlaybackStableSec = 0;

    if (this.isStreamingMode()) {
      pcmReaderClient.bumpGeneration();
      this.streamingTracks.forEach((st) => {
        st.unpinSectionChunks();
        st.seekTo(clampedSec).catch(() => {});
      });
    }

    if (this.isPlaying && this.ctx) {
      const nowCtx = this.ctx.currentTime;
      this.playStartCtxTime = nowCtx;
      this.playStartSongSec = clampedSec;
      const secPerBeat = 60 / (this.project.bpm || 120);
      const subdiv = this.project.clickSubdivision || 1;
      this.lastScheduledSubStep = Math.floor((clampedSec / secPerBeat) * subdiv) - 1;
      if (this.isStreamingMode()) {
        const rate = this.getPlaybackRate();
        this.streamingTracks.forEach((st) =>
          st.updateScheduler({
            isPlaying: true,
            currentSongSec: clampedSec,
            playStartSongSec: clampedSec,
            playStartCtxTime: nowCtx,
            rate,
            lookaheadSec: SCHEDULER_LOOKAHEAD_SEC,
          })
        );
      } else {
        this.startAllTrackSources(clampedSec, nowCtx, nowCtx);
      }
      this.runLookaheadSchedulerTick();
    } else {
      this.pausedSongSec = clampedSec;
    }
    this.emitTransport(true);
  }

  public queueSectionJump(sectionId: string) {
    if (!this.project || this.isMountingSong) return;
    const targetSection = this.project.sections.find((s) => s.id === sectionId);
    if (!targetSection) return;

    const targetStartSec = targetSection.startTimeSec ?? 0;

    if (!this.isPlaying) {
      this.seekToSeconds(targetStartSec);
      return;
    }

    if (this.queuedSectionId === sectionId) {
      this.queuedSectionId = null;
      this.queuedTargetSec = null;
      this.lastCueMessage = 'SALTO CANCELADO';
      this.emitTransport(true);
      return;
    }

    const nowSec = this.getCurrentSongSec();
    const mode: QuantizeMode = this.project.quantizeMode;

    if (mode === 'immediate') {
      this.seekToSeconds(targetStartSec);
      this.TriggerGuideCue(targetSection.cueName || targetSection.name, true);
      return;
    }

    const secPerBeat = 60 / (this.project.bpm || 120);
    const secPerBar = secPerBeat * (this.project.beatsPerBar || 4);

    let transitionSec = nowSec + secPerBar;
    if (mode === '1-bar') {
      const nextBarIndex = Math.floor(nowSec / secPerBar) + 1;
      transitionSec = nextBarIndex * secPerBar;
      if (transitionSec - nowSec < 0.25) transitionSec += secPerBar;
    } else if (mode === '2-bars') {
      const nextBarIndex = Math.floor(nowSec / secPerBar) + 2;
      transitionSec = nextBarIndex * secPerBar;
    } else if (mode === 'section-end') {
      const currentSecObj = this.findSectionAtTime(nowSec);
      if (currentSecObj && currentSecObj.endTimeSec > nowSec) {
        transitionSec = currentSecObj.endTimeSec;
      }
    }

    this.queuedSectionId = targetSection.id;
    this.queuedTargetSec = transitionSec;
    this.isVamping = false;
    this.lastCueMessage = `EN COLA → ${targetSection.name.toUpperCase()}`;

    // In streaming mode: pre-fetch target section chunks (4s) with 'seek' priority
    if (this.isStreamingMode()) {
      this.streamingTracks.forEach((st) => {
        st.prefetchJumpTarget(targetStartSec, 4).catch(() => {});
      });
    }

    this.emitTransport(true);
  }

  public cancelQueuedJump() {
    this.queuedSectionId = null;
    this.queuedTargetSec = null;
    this.lastCueMessage = 'SALTO CANCELADO';
    this.emitTransport(true);
  }

  public toggleVamp() {
    this.isVamping = !this.isVamping;
    if (this.isVamping) {
      this.queuedSectionId = null;
      this.queuedTargetSec = null;
      this.lastCueMessage = 'VAMP ACTIVO (LOOP SECCIÓN)';
      this.TriggerGuideCue('Vamp On', false);
      if (this.isStreamingMode()) {
        const activeSec = this.findSectionAtTime(this.getCurrentSongSec());
        if (activeSec && activeSec.endTimeSec - activeSec.startTimeSec <= 4.0) {
          this.streamingTracks.forEach((st) =>
            st.pinSectionChunks(activeSec.startTimeSec, activeSec.endTimeSec)
          );
          console.info(
            `[AudioEngine][Vamp] Sección corta "${activeSec.name}" (<= 4s) pineada en RAM para loop continuo sin lecturas de disco`
          );
        }
      }
    } else {
      this.lastCueMessage = 'VAMP LIBERADO';
      this.TriggerGuideCue('Vamp Off', false);
      if (this.isStreamingMode()) {
        this.streamingTracks.forEach((st) => st.unpinSectionChunks());
      }
    }
    this.emitTransport(true);
  }

  private findSectionAtTime(timeSec: number): SongSection | undefined {
    if (!this.project || this.project.sections.length === 0) return undefined;
    return this.project.sections.find(
      (s) => timeSec >= s.startTimeSec && timeSec < s.endTimeSec
    );
  }

  private getMusicalPosition(songSec: number) {
    if (!this.project) {
      return { currentBar: 1, currentBeat: 1, beatProgress: 0, totalBeatsElapsed: 0 };
    }
    const secPerBeat = 60 / this.project.bpm;
    const totalBeatsElapsed = Math.max(0, songSec / secPerBeat);
    const wholeBeatIndex = Math.floor(totalBeatsElapsed);
    const beatProgress = totalBeatsElapsed - wholeBeatIndex;
    const currentBar = Math.floor(wholeBeatIndex / this.project.beatsPerBar) + 1;
    const currentBeat = (wholeBeatIndex % this.project.beatsPerBar) + 1;

    return {
      currentBar,
      currentBeat,
      beatProgress,
      totalBeatsElapsed,
    };
  }

  /**
   * Lookahead scheduler running every 25ms from the Web Worker.
   * Schedules clicks, quantized section jumps, vamp loops, and end-of-song within the next 120ms.
   */
  private runLookaheadSchedulerTick() {
    if (!this.isPlaying || !this.project || !this.ctx) return;

    const nowCtx = this.ctx.currentTime;
    const horizonCtx = nowCtx + SCHEDULER_LOOKAHEAD_SEC;
    const songSecNow = this.getSongSecAtCtxTime(nowCtx);
    const songSecHorizon = this.getSongSecAtCtxTime(horizonCtx);
    const totalSongSec = this.getTotalDurationSec();

    // 1. End of song detection
    if (totalSongSec > 0 && songSecNow >= totalSongSec) {
      this.stop();
      if (this.onSongEndedCallback) {
        this.onSongEndedCallback();
      }
      return;
    }

    // Update streaming ring buffers and continuous chunk scheduling
    if (this.isStreamingMode()) {
      const currentSongSec = this.getCurrentSongSec();
      const rate = this.getPlaybackRate();
      this.streamingTracks.forEach((st) => {
        st.updateScheduler({
          isPlaying: this.isPlaying,
          currentSongSec,
          playStartSongSec: this.playStartSongSec,
          playStartCtxTime: this.playStartCtxTime,
          rate,
          lookaheadSec: SCHEDULER_LOOKAHEAD_SEC,
        });
      });

      // Track underruns to prevent staging during unstable playback
      const totalUnderruns = this.getTotalUnderruns();
      if (totalUnderruns > this.lastRecordedUnderruns) {
        this.lastRecordedUnderruns = totalUnderruns;
        this.activePlaybackStableSec = 0;
      } else {
        this.activePlaybackStableSec += SCHEDULER_TICK_MS / 1000;
      }

      // If active playback has been stable for >= 8s and there is a deferred staging project, trigger staging
      if (
        this.pendingStageNextProject &&
        !this.isStagingNextProject &&
        this.activePlaybackStableSec >= 8
      ) {
        const nextProj = this.pendingStageNextProject;
        this.pendingStageNextProject = null;
        this.stageNextSongStreaming(nextProj).catch((err) => {
          console.warn('[AudioEngine][Staging] Error durante puesta en escena diferida:', err);
        });
      }

      // Periodic [AudioEngine][Stream] telemetry log every 10 seconds during active streaming playback
      const nowPerf = performance.now();
      if (nowPerf - this.lastStreamLogTimeMs >= 10000) {
        this.lastStreamLogTimeMs = nowPerf;
        this.logStreamMetrics('Tick 10s');
      }
    }

    // 2. Lookahead scheduling for Quantized Section Jumps
    if (
      this.queuedSectionId &&
      this.queuedTargetSec !== null &&
      songSecHorizon >= this.queuedTargetSec &&
      this.pendingTransitionCtxTime === null
    ) {
      const targetSecObj = this.project.sections.find(
        (s) => s.id === this.queuedSectionId
      );
      const boundarySongSec = this.queuedTargetSec;
      this.queuedSectionId = null;
      this.queuedTargetSec = null;

      if (targetSecObj) {
        const exactJumpCtxTime = Math.max(
          nowCtx,
          this.getCtxTimeForSongSec(boundarySongSec)
        );
        const targetStartSec = targetSecObj.startTimeSec;

        // Schedule sample-accurate 8ms crossfade of current sources and start of new sources at exactJumpCtxTime
        if (this.isStreamingMode()) {
          this.streamingTracks.forEach((st) => {
            st.unpinSectionChunks();
            st.stopSourcesWithFade(exactJumpCtxTime);
            st.seekTo(targetStartSec).catch(() => {});
            if (
              targetSecObj.vampByDefault &&
              targetSecObj.endTimeSec - targetSecObj.startTimeSec <= 4.0
            ) {
              st.pinSectionChunks(targetSecObj.startTimeSec, targetSecObj.endTimeSec);
            }
          });
        } else {
          this.startAllTrackSources(
            targetStartSec,
            exactJumpCtxTime,
            exactJumpCtxTime
          );
        }

        // Schedule clicks up to the boundary before re-anchoring
        this.scheduleClicksInSongWindow(songSecNow, boundarySongSec, nowCtx);

        // Re-anchor clock at exactJumpCtxTime
        this.playStartCtxTime = exactJumpCtxTime;
        this.playStartSongSec = targetStartSec;
        const secPerBeat = 60 / (this.project.bpm || 120);
        const subdiv = this.project.clickSubdivision || 1;
        this.lastScheduledSubStep =
          Math.floor((targetStartSec / secPerBeat) * subdiv) - 1;

        this.activeSectionId = targetSecObj.id;
        this.isVamping = Boolean(targetSecObj.vampByDefault);
        this.lastCueMessage = `EN VIVO: ${targetSecObj.name.toUpperCase()}`;

        const newSongSecHorizon = this.getSongSecAtCtxTime(horizonCtx);
        this.scheduleClicksInSongWindow(
          targetStartSec,
          newSongSecHorizon,
          nowCtx
        );
        this.emitTransport(true);
        return;
      }
    }

    // 3. Lookahead scheduling for Vamp Section Loop
    const currentActiveSec = this.project.sections.find(
      (s) => s.id === this.activeSectionId
    );
    if (
      this.isVamping &&
      currentActiveSec &&
      !this.queuedSectionId &&
      songSecHorizon >= currentActiveSec.endTimeSec &&
      this.pendingTransitionCtxTime === null
    ) {
      const boundarySongSec = currentActiveSec.endTimeSec;
      const exactLoopCtxTime = Math.max(
        nowCtx,
        this.getCtxTimeForSongSec(boundarySongSec)
      );
      const loopStartSec = currentActiveSec.startTimeSec;

      // Schedule sample-accurate 8ms crossfade loop transition at exactLoopCtxTime
      if (this.isStreamingMode()) {
        this.streamingTracks.forEach((st) => {
          st.stopSourcesWithFade(exactLoopCtxTime);
          st.seekTo(loopStartSec).catch(() => {});
        });
      } else {
        this.startAllTrackSources(
          loopStartSec,
          exactLoopCtxTime,
          exactLoopCtxTime
        );
      }

      this.scheduleClicksInSongWindow(songSecNow, boundarySongSec, nowCtx);

      this.playStartCtxTime = exactLoopCtxTime;
      this.playStartSongSec = loopStartSec;
      const secPerBeat = 60 / (this.project.bpm || 120);
      const subdiv = this.project.clickSubdivision || 1;
      this.lastScheduledSubStep =
        Math.floor((loopStartSec / secPerBeat) * subdiv) - 1;

      this.lastCueMessage = `VAMP LOOP: ${currentActiveSec.name.toUpperCase()}`;

      const newSongSecHorizon = this.getSongSecAtCtxTime(horizonCtx);
      this.scheduleClicksInSongWindow(loopStartSec, newSongSecHorizon, nowCtx);
      this.emitTransport(true);
      return;
    }

    // 4. Natural section crossing detection
    const naturalSec = this.findSectionAtTime(songSecNow);
    if (naturalSec && naturalSec.id !== this.activeSectionId) {
      if (this.isStreamingMode()) {
        this.streamingTracks.forEach((st) => st.unpinSectionChunks());
      }
      this.activeSectionId = naturalSec.id;
      if (!this.queuedSectionId && naturalSec.vampByDefault) {
        this.isVamping = true;
        this.lastCueMessage = `AUTO-VAMP: ${naturalSec.name.toUpperCase()}`;
        if (this.isStreamingMode() && naturalSec.endTimeSec - naturalSec.startTimeSec <= 4.0) {
          this.streamingTracks.forEach((st) =>
            st.pinSectionChunks(naturalSec.startTimeSec, naturalSec.endTimeSec)
          );
        }
      } else {
        this.lastCueMessage = `SECCIÓN: ${naturalSec.name.toUpperCase()}`;
      }
      this.emitTransport(true);
    }

    // 5. Schedule all metronome clicks and guide cues falling in [songSecNow, songSecHorizon]
    this.scheduleClicksInSongWindow(songSecNow, songSecHorizon, nowCtx);
  }

  private scheduleClicksInSongWindow(
    windowStartSongSec: number,
    windowEndSongSec: number,
    nowCtx: number
  ) {
    if (!this.project || !this.ctx) return;

    const secPerBeat = 60 / (this.project.bpm || 120);
    const subdiv = this.project.clickSubdivision || 1;
    const secPerSubStep = secPerBeat / subdiv;

    const firstSubStep = Math.max(
      this.lastScheduledSubStep + 1,
      Math.floor(windowStartSongSec / secPerSubStep)
    );
    const lastSubStep = Math.floor(windowEndSongSec / secPerSubStep);

    for (let step = firstSubStep; step <= lastSubStep; step++) {
      const stepSongSec = step * secPerSubStep;
      const exactCtxTime = Math.max(
        nowCtx,
        this.getCtxTimeForSongSec(stepSongSec)
      );

      this.lastScheduledSubStep = step;
      const isMainBeat = step % subdiv === 0;
      const beatInBar =
        (Math.floor(step / subdiv) % (this.project.beatsPerBar || 4)) + 1;

      if (this.project.clickEnabled) {
        this.scheduleMetronomeClickAt(
          exactCtxTime,
          beatInBar === 1 && isMainBeat,
          isMainBeat
        );
      }

      if (isMainBeat && this.project.guideCuesEnabled) {
        if (
          this.queuedSectionId &&
          this.queuedTargetSec !== null &&
          this.queuedTargetSec - stepSongSec <= 2.2 &&
          this.lastAnnouncedSectionId !== this.queuedSectionId
        ) {
          const qSec = this.project.sections.find(
            (s) => s.id === this.queuedSectionId
          );
          if (qSec) {
            this.lastAnnouncedSectionId = qSec.id;
            this.TriggerGuideCue(
              `${qSec.cueName || qSec.name}`,
              true,
              exactCtxTime
            );
          }
        } else if (!this.isVamping && !this.queuedSectionId) {
          const upcomingSec = this.project.sections.find(
            (s) =>
              s.startTimeSec > stepSongSec &&
              s.startTimeSec - stepSongSec <= 2.0
          );
          if (
            upcomingSec &&
            this.lastAnnouncedSectionId !== upcomingSec.id
          ) {
            this.lastAnnouncedSectionId = upcomingSec.id;
            this.TriggerGuideCue(
              `${upcomingSec.cueName || upcomingSec.name}`,
              true,
              exactCtxTime
            );
          }
        }
      }
    }
  }

  /**
   * rAF loop is strictly for UI playhead & transport updates (throttled to ~20 fps in emitTransport).
   */
  private startUiLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }

    const uiTick = () => {
      if (!this.isPlaying) return;
      this.emitTransport(false);
      this.rafId = requestAnimationFrame(uiTick);
    };

    this.rafId = requestAnimationFrame(uiTick);
  }

  private scheduleMetronomeClickAt(
    exactCtxTime: number,
    isDownbeat: boolean,
    isQuarterBeat: boolean
  ) {
    if (!this.ctx || !this.cueBusGain || !this.project) return;

    const osc = this.ctx.createOscillator();
    const clickEnv = this.ctx.createGain();

    osc.type = isDownbeat ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(
      isDownbeat ? 1680 : isQuarterBeat ? 1120 : 840,
      exactCtxTime
    );
    osc.frequency.exponentialRampToValueAtTime(
      isDownbeat ? 820 : 540,
      exactCtxTime + 0.035
    );

    const level =
      this.project.clickGain *
      (isDownbeat ? 0.55 : isQuarterBeat ? 0.36 : 0.18);
    clickEnv.gain.setValueAtTime(0.0001, exactCtxTime);
    clickEnv.gain.linearRampToValueAtTime(level, exactCtxTime + 0.002);
    clickEnv.gain.exponentialRampToValueAtTime(0.0001, exactCtxTime + 0.042);

    osc.connect(clickEnv);
    clickEnv.connect(this.cueBusGain);

    osc.start(exactCtxTime);
    osc.stop(exactCtxTime + 0.045);
  }

  private TriggerGuideCue(
    cueText: string,
    playChime: boolean,
    whenCtxTime?: number
  ) {
    if (!this.project || !this.project.guideCuesEnabled) return;

    if (playChime && this.ctx && this.cueBusGain) {
      const startAt =
        whenCtxTime !== undefined
          ? Math.max(this.ctx.currentTime, whenCtxTime)
          : this.ctx.currentTime;
      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const env = this.ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'triangle';
      osc1.frequency.setValueAtTime(587.33, startAt);
      osc1.frequency.setValueAtTime(880.0, startAt + 0.07);
      osc2.frequency.setValueAtTime(293.66, startAt);

      const level = this.project.guideGain * 0.25;
      env.gain.setValueAtTime(0.0001, startAt);
      env.gain.linearRampToValueAtTime(level, startAt + 0.01);
      env.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.19);

      osc1.connect(env);
      osc2.connect(env);
      env.connect(this.cueBusGain);

      osc1.start(startAt);
      osc2.start(startAt);
      osc1.stop(startAt + 0.2);
      osc2.stop(startAt + 0.2);
    }

    if (
      this.project.guideVoiceReadout &&
      typeof window !== 'undefined' &&
      'speechSynthesis' in window
    ) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(cueText);
        utter.rate = 1.25;
        utter.pitch = 1.0;
        utter.volume = Math.min(1, this.project.guideGain);
        window.speechSynthesis.speak(utter);
      } catch {
        // Ignore speech synthesis restrictions
      }
    }
  }

  public getTransportState(): TransportState {
    const songSec = this.getCurrentSongSec();
    const totalDurationSec = this.getTotalDurationSec();
    const { currentBar, currentBeat, beatProgress } =
      this.getMusicalPosition(songSec);

    let countdownBeats = 0;
    let queuedTargetBar: number | null = null;
    if (this.queuedTargetSec !== null && this.project) {
      const secPerBeat = 60 / (this.project.bpm || 120);
      const secRemaining = Math.max(0, this.queuedTargetSec - songSec);
      countdownBeats = Math.max(1, Math.ceil(secRemaining / secPerBeat));
      queuedTargetBar =
        Math.floor(
          this.queuedTargetSec /
            (secPerBeat * (this.project.beatsPerBar || 4))
        ) + 1;
    }

    return {
      isPlaying: this.isPlaying,
      isMountingSong: this.isMountingSong,
      mountingProgressText: this.mountingProgressText,
      currentTimeSec: songSec,
      totalDurationSec,
      currentBar,
      currentBeat,
      beatProgress,
      activeSectionId: this.activeSectionId,
      queuedSectionId: this.queuedSectionId,
      queuedTargetBar,
      countdownBeats,
      isVamping: this.isVamping,
      lastCueMessage: this.lastCueMessage,
    };
  }

  public getTrackMeters(): MetersSnapshot {
    const tracks: Record<string, TrackMeterReading> = {};

    this.trackNodes.forEach((node, trackId) => {
      if (!this.isPlaying) {
        tracks[trackId] = { rms: 0, peak: 0, clipping: false };
        return;
      }
      node.analyser.getFloatTimeDomainData(node.timeDomainData);
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < node.timeDomainData.length; i++) {
        const v = Math.abs(node.timeDomainData[i]);
        sumSq += v * v;
        if (v > peak) peak = v;
      }
      const rms = Math.sqrt(sumSq / node.timeDomainData.length);
      tracks[trackId] = {
        rms: Math.min(1, rms * 1.8),
        peak: Math.min(1, peak),
        clipping: peak >= 0.98,
      };
    });

    let masterReading: TrackMeterReading = { rms: 0, peak: 0, clipping: false };
    if (this.isPlaying && this.masterAnalyser) {
      this.masterAnalyser.getFloatTimeDomainData(this.masterTimeData);
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < this.masterTimeData.length; i++) {
        const v = Math.abs(this.masterTimeData[i]);
        sumSq += v * v;
        if (v > peak) peak = v;
      }
      const rms = Math.sqrt(sumSq / this.masterTimeData.length);
      masterReading = {
        rms: Math.min(1, rms * 1.8),
        peak: Math.min(1, peak),
        clipping: peak >= 0.99,
      };
    }

    return { tracks, master: masterReading };
  }
}

export const audioEngine = new LibreTracksAudioEngine();

if (typeof window !== 'undefined') {
  const win = window as unknown as {
    __streamStats: () => ReturnType<LibreTracksAudioEngine['getGlobalStreamStats']>;
    __audioEngine: LibreTracksAudioEngine;
  };
  win.__streamStats = () => {
    const stats = audioEngine.getGlobalStreamStats();
    audioEngine.logStreamMetrics('window.__streamStats()');
    return stats;
  };
  win.__audioEngine = audioEngine;
}
