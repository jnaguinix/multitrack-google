import {
  MetersSnapshot,
  QuantizeMode,
  SongProject,
  SongRamCacheInfo,
  SongSection,
  TrackChannel,
  TrackMeterReading,
  TransportState,
} from '../types/project';
import { extractStemArrayBuffer, loadProjectStemsFromDb } from '../storage/projectDb';
import { extractWaveformPeaks } from './demoSynthesizer';

interface ActiveTrackNodes {
  source: AudioBufferSourceNode | null;
  gainNode: GainNode;
  panNode: StereoPannerNode;
  analyser: AnalyserNode;
  timeDomainData: Float32Array<ArrayBuffer>;
}

type TransportListener = (state: TransportState) => void;
type CacheListener = () => void;

/**
 * Maximum 2 songs in RAM cache: the active song and the next song in the setlist.
 */
const MAX_CACHED_PROJECTS = 2;

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

  /**
   * Decoded AudioBuffers cache per project: Map<projectId, Map<trackId, AudioBuffer>>
   * Keeps at most 2 songs (active + next in setlist).
   */
  private projectBufferCache: Map<string, Map<string, AudioBuffer>> = new Map();
  private cacheOrder: string[] = [];
  private pinnedNextProjectId: string | null = null;
  private preloadingProjectIds: Set<string> = new Set();
  private inFlightPreloads: Map<string, Promise<Map<string, AudioBuffer>>> = new Map();

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
   * Calculates and logs estimated RAM of all AudioBuffers currently in projectBufferCache:
   * sum(length * numberOfChannels * 4) in MB.
   */
  public logCacheRamMetrics(reason: string) {
    let totalBytes = 0;
    const perSongSummary: string[] = [];

    this.projectBufferCache.forEach((trackMap, projId) => {
      let songBytes = 0;
      trackMap.forEach((buf) => {
        songBytes += buf.length * buf.numberOfChannels * 4;
      });
      totalBytes += songBytes;
      perSongSummary.push(`${projId}: ${(songBytes / (1024 * 1024)).toFixed(2)} MB (${trackMap.size} pistas)`);
    });

    const totalMb = totalBytes / (1024 * 1024);
    console.info(
      `[AudioEngine][RAM] ${reason} | Canciones en caché: ${this.projectBufferCache.size}/${MAX_CACHED_PROJECTS} | Total estimado: ${totalMb.toFixed(2)} MB [${perSongSummary.join(' | ')}]`
    );
  }

  /**
   * Enforces maximum of 2 cached songs (active song + next song in setlist).
   * Explicitly clears evicted maps so GC can reclaim AudioBuffer memory immediately.
   */
  private enforceCacheLimit(protectedIds: string[] = []) {
    const keepSet = new Set<string>();
    if (this.project?.id) keepSet.add(this.project.id);
    if (this.pinnedNextProjectId) keepSet.add(this.pinnedNextProjectId);
    for (const id of protectedIds) {
      if (id) keepSet.add(id);
    }

    while (this.projectBufferCache.size > MAX_CACHED_PROJECTS) {
      // Find oldest cached project not in keepSet, or oldest non-active project
      let victimId = this.cacheOrder.find((id) => !keepSet.has(id));
      if (!victimId) {
        victimId = this.cacheOrder.find((id) => id !== this.project?.id);
      }
      if (!victimId) break;

      const victimMap = this.projectBufferCache.get(victimId);
      if (victimMap) {
        victimMap.clear();
      }
      this.projectBufferCache.delete(victimId);
      this.cacheOrder = this.cacheOrder.filter((id) => id !== victimId);
      console.info(`[AudioEngine][Cache] Canción expulsada del caché para liberar RAM: ${victimId}`);
    }
  }

  private touchCacheProject(projectId: string, protectedIds: string[] = []) {
    this.cacheOrder = this.cacheOrder.filter((id) => id !== projectId);
    this.cacheOrder.push(projectId);
    this.enforceCacheLimit(protectedIds);
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
    let songMap = this.projectBufferCache.get(projectId);
    if (!songMap) {
      songMap = new Map<string, AudioBuffer>();
      this.projectBufferCache.set(projectId, songMap);
    }
    buffers.forEach((buf, trkId) => {
      songMap!.set(trkId, buf);
    });
    this.touchCacheProject(projectId, [projectId]);
    this.logCacheRamMetrics(`storeProjectBuffersInRamCache(${projectId})`);
    this.emitCacheUpdate();
  }

  public evictSongFromRamCache(projectId: string) {
    const map = this.projectBufferCache.get(projectId);
    if (map) {
      map.clear();
    }
    this.projectBufferCache.delete(projectId);
    this.cacheOrder = this.cacheOrder.filter((id) => id !== projectId);
    if (this.pinnedNextProjectId === projectId) {
      this.pinnedNextProjectId = null;
    }
    this.logCacheRamMetrics(`evictSongFromRamCache(${projectId})`);
    this.emitCacheUpdate();
  }

  public getSongRamCacheInfo(project: SongProject): SongRamCacheInfo {
    const totalCount = project.tracks.length;
    const songMap = this.projectBufferCache.get(project.id);
    let cachedCount = 0;
    if (songMap) {
      for (const t of project.tracks) {
        if (songMap.has(t.id)) cachedCount++;
      }
    }
    const isReady = totalCount > 0 && cachedCount >= totalCount;
    const isPreloading = this.preloadingProjectIds.has(project.id);
    return {
      cachedCount,
      totalCount,
      isReady,
      isPreloading,
    };
  }

  public async decodeStemBuffer(
    rawBuffer: ArrayBuffer,
    label = 'stem'
  ): Promise<{ audioBuffer: AudioBuffer; peaks: number[]; durationSec: number }> {
    const ctx = this.ensureContext();
    const t0 = performance.now();
    const copy = rawBuffer.slice(0);
    const audioBuffer = await ctx.decodeAudioData(copy);
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
   * 2. CACHÉ Y PRECARGA DE LA SIGUIENTE CANCIÓN:
   * Reads stems from IndexedDB and decodes them in parallel with Promise.all
   * WITHOUT touching current playback or the active audio graph.
   * Keeps at most 2 songs in cache (current + next in setlist).
   */
  public async preloadProject(
    project: SongProject,
    onProgress?: (cachedCount: number, totalCount: number) => void
  ): Promise<Map<string, AudioBuffer>> {
    this.pinnedNextProjectId = project.id !== this.project?.id ? project.id : this.pinnedNextProjectId;

    const existingMap = this.projectBufferCache.get(project.id);
    const totalTracks = project.tracks.length;

    if (existingMap && project.tracks.every((t) => existingMap.has(t.id))) {
      this.touchCacheProject(project.id, [this.project?.id || '', project.id]);
      onProgress?.(totalTracks, totalTracks);
      return existingMap;
    }

    const existingPromise = this.inFlightPreloads.get(project.id);
    if (existingPromise) {
      return existingPromise;
    }

    const preloadTask = (async () => {
      const ctx = this.ensureContext();
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

        // 1. DECODIFICACIÓN PARALELA con Promise.all (sin romper las demás si una pista falla)
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
              const copy = rawBuf.slice(0);
              const decoded = await ctx.decodeAudioData(copy);
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

        this.touchCacheProject(project.id, [this.project?.id || '', project.id]);
        this.logCacheRamMetrics(`preloadProject("${project.title}")`);
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
   * Alias maintained for compatibility with UI components
   */
  public async preloadSongIntoRam(
    project: SongProject,
    onProgress?: (cachedCount: number, totalCount: number) => void
  ): Promise<Map<string, AudioBuffer>> {
    return this.preloadProject(project, onProgress);
  }

  public getTotalDurationSec(): number {
    if (!this.project) return 0;
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
   * 1 & 2. Mounts a project into the active audio graph using parallel Promise.all decoding
   * and the 2-song AudioBuffer cache without clearing buffers that remain in the cache.
   */
  public async loadProject(
    project: SongProject,
    predecodedBuffers?: Map<string, AudioBuffer>
  ): Promise<{ peaksMap: Map<string, number[]>; wasCancelled: boolean }> {
    const myGenId = ++this.loadGenerationId;
    this.stop();

    const ctx = this.ensureContext();
    this.project = project;

    if (predecodedBuffers && predecodedBuffers.size > 0) {
      this.storeProjectBuffersInRamCache(project.id, predecodedBuffers);
    }

    // Disconnect previous track audio nodes
    this.trackNodes.forEach((node) => {
      try {
        node.source?.stop();
        node.source?.disconnect();
        node.gainNode.disconnect();
        node.panNode.disconnect();
        node.analyser.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    });
    this.trackNodes.clear();

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
      songBuffers = await this.preloadProject(project, (loaded, total) => {
        if (myGenId === this.loadGenerationId && loaded < total) {
          this.isMountingSong = true;
          this.mountingProgressText = `Cargando pistas en RAM (${loaded}/${total})...`;
          this.emitTransport(true);
        }
      });
    } else {
      this.touchCacheProject(project.id, [project.id, this.pinnedNextProjectId || '']);
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
   * 3. ARREGLAR EL BUG DEL PITCH:
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

    // 3. Re-anchor playStartSongSec and playStartCtxTime BEFORE applying the new detune so there is no jump
    if (prevPitch !== nextPitch && this.isPlaying && this.ctx) {
      const nowCtx = this.ctx.currentTime;
      const currentSongSec = this.getSongSecAtCtxTime(nowCtx);
      this.playStartSongSec = currentSongSec;
      this.playStartCtxTime = nowCtx;
      this.project = project;

      this.trackNodes.forEach((node) => {
        if (node.source) {
          node.source.detune.setValueAtTime(nextPitch * 100, nowCtx);
        }
      });
    } else {
      this.project = project;
    }

    this.applyMixerRouting();
    this.emitTransport(true);
  }

  public mountDecodedTrack(
    track: TrackChannel,
    decoded: AudioBuffer
  ): { peaks: number[]; durationSec: number } {
    const ctx = this.ensureContext();
    this.trackBuffers.set(track.id, decoded);

    if (this.project) {
      let songMap = this.projectBufferCache.get(this.project.id);
      if (!songMap) {
        songMap = new Map();
        this.projectBufferCache.set(this.project.id, songMap);
      }
      songMap.set(track.id, decoded);
      this.touchCacheProject(this.project.id, [this.project.id]);
      this.logCacheRamMetrics(`mountDecodedTrack("${track.name}")`);
      this.emitCacheUpdate();
    }

    const peaks =
      track.peaks && track.peaks.length >= 64
        ? track.peaks
        : extractWaveformPeaks(decoded, 320);

    const gainNode = ctx.createGain();
    const panNode = ctx.createStereoPanner();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    gainNode.connect(panNode);
    panNode.connect(analyser);

    this.trackNodes.set(track.id, {
      source: null,
      gainNode,
      panNode,
      analyser,
      timeDomainData: new Float32Array(analyser.fftSize),
    });

    if (this.project) {
      this.applyMixerRouting();
      if (this.isPlaying) {
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
        nodes.gainNode.disconnect();
        nodes.panNode.disconnect();
        nodes.analyser.disconnect();
      } catch {
        // ignore
      }
      this.trackNodes.delete(trackId);
    }
    this.trackBuffers.delete(trackId);
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
   * Starts or schedules a track's AudioBufferSourceNode at an exact AudioContext time (`whenCtxTime`)
   * and song offset (`offsetSec`).
   */
  private startSourceForTrack(
    trackId: string,
    offsetSec: number,
    whenCtxTime = 0,
    stopPreviousAtCtxTime?: number
  ) {
    if (!this.ctx || !this.project) return;
    const buffer = this.trackBuffers.get(trackId);
    const node = this.trackNodes.get(trackId);
    if (!buffer || !node) return;

    if (node.source) {
      try {
        if (
          stopPreviousAtCtxTime !== undefined &&
          stopPreviousAtCtxTime > this.ctx.currentTime
        ) {
          const oldSource = node.source;
          oldSource.stop(stopPreviousAtCtxTime);
          window.setTimeout(() => {
            try {
              oldSource.disconnect();
            } catch {
              // ignore
            }
          }, Math.max(50, (stopPreviousAtCtxTime - this.ctx.currentTime) * 1000 + 50));
        } else {
          node.source.stop();
          node.source.disconnect();
        }
      } catch {
        // ignore
      }
      node.source = null;
    }

    if (offsetSec >= buffer.duration) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.detune.value = (this.project.pitchSemitones || 0) * 100;
    source.connect(node.gainNode);
    const startWhen = whenCtxTime > 0 ? whenCtxTime : 0;
    source.start(startWhen, Math.max(0, offsetSec));
    node.source = source;
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

  private stopAllTrackSources() {
    this.trackNodes.forEach((node) => {
      if (node.source) {
        try {
          node.source.stop();
          node.source.disconnect();
        } catch {
          // ignore
        }
        node.source = null;
      }
    });
  }

  public play() {
    if (!this.project || this.isMountingSong) return;
    if (this.project.tracks.length > 0 && this.trackBuffers.size === 0) return;

    const ctx = this.ensureContext();
    if (this.isPlaying) return;

    const startCtx = ctx.currentTime;
    this.isPlaying = true;
    this.playStartCtxTime = startCtx;
    this.playStartSongSec = this.pausedSongSec;
    this.pendingTransitionCtxTime = null;

    // Initialize lastScheduledSubStep just before current position so beat 1 at playStartSongSec is scheduled
    const secPerBeat = 60 / (this.project.bpm || 120);
    const subdiv = this.project.clickSubdivision || 1;
    this.lastScheduledSubStep = Math.floor((this.playStartSongSec / secPerBeat) * subdiv) - 1;
    this.lastAnnouncedSectionId = null;

    this.startAllTrackSources(this.playStartSongSec, startCtx);

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
    this.schedulerWorker?.postMessage('stop');
    this.stopAllTrackSources();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.emitTransport(true);
  }

  public togglePlayPause() {
    if (this.isMountingSong) return;
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
    this.schedulerWorker?.postMessage('stop');
    this.stopAllTrackSources();

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

    if (this.isPlaying && this.ctx) {
      const nowCtx = this.ctx.currentTime;
      this.playStartCtxTime = nowCtx;
      this.playStartSongSec = clampedSec;
      const secPerBeat = 60 / (this.project.bpm || 120);
      const subdiv = this.project.clickSubdivision || 1;
      this.lastScheduledSubStep = Math.floor((clampedSec / secPerBeat) * subdiv) - 1;
      this.startAllTrackSources(clampedSec, nowCtx);
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
    } else {
      this.lastCueMessage = 'VAMP LIBERADO';
      this.TriggerGuideCue('Vamp Off', false);
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
   * 4. CLICK CON SCHEDULER DE LOOKAHEAD (no rAF):
   * Runs every 25ms from the Web Worker.
   * Schedules clicks, quantized section jumps, vamp loops, and end-of-song within the next 120ms
   * using exact AudioContext timestamps (`osc.start(exactCtxTime)` and `source.start(exactCtxTime, offset)`).
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

        // Schedule sample-accurate stop of current sources and start of new sources at exactJumpCtxTime
        this.startAllTrackSources(
          targetStartSec,
          exactJumpCtxTime,
          exactJumpCtxTime
        );

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

        // Schedule any clicks in the remainder of the 120ms lookahead window after the jump
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

      // Schedule sample-accurate loop transition at exactLoopCtxTime
      this.startAllTrackSources(
        loopStartSec,
        exactLoopCtxTime,
        exactLoopCtxTime
      );

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
      this.activeSectionId = naturalSec.id;
      if (!this.queuedSectionId && naturalSec.vampByDefault) {
        this.isVamping = true;
        this.lastCueMessage = `AUTO-VAMP: ${naturalSec.name.toUpperCase()}`;
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
