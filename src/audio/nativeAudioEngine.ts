// =============================================================================
// NATIVE AUDIO ENGINE ADAPTER (Fase 6: Integración del Motor Nativo en Escritorio)
// =============================================================================
// En entorno de escritorio (Tauri v2 / Windows x64), este adaptador asume el
// transporte, mezclador, secciones, setlist y control remoto LAN llamando al motor
// nativo en Rust vía IPC. El motor web (audioEngine.ts) se mantiene 100% intacto.
// =============================================================================

import { logAsyncError } from '../utils/asyncErrors';
import { ControlSync, type ControlOp, type EngineTrackControl } from './controlSync';
import { flightRecorder } from '../utils/flightRecorder';
import { AudioEngineMode, SongProject, TrackChannel, TransportState, MetersSnapshot } from '../types/project';
import { MeterBallistics, NativeMetersSnapshot } from './meterBallistics';
import { StatePoller } from './statePoller';
import { sameTransport } from '../utils/transportEqual';
import { NativeCacheManager, type CacheStatus, type NativeImportProgress } from './nativeCacheManager';
import { INITIAL_NATIVE_TRANSPORT, snapshotToTransport } from './nativeTransport';

export type { NativeImportProgress } from './nativeCacheManager';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const getInvoke = (): Invoke | null => {
  if (typeof window === 'undefined') return null;
  return (window as any).__TAURI__?.core?.invoke || null;
};

export interface NativePlaybackSnapshot {
  isPlaying: boolean;
  isBuffering?: boolean;
  prefillDurationMs?: number;
  deviceDisconnected?: boolean;
  positionSec: number;
  durationSec: number;
  currentFrame: number;
  totalFrames: number;
  underruns: number;
  callbacks: number;
  maxCallbackDurationUs: number;
  maxFeederBlockDurationUs?: number;
  minRingBufferLevelMs?: number | null;
  activeSectionId?: string | null;
  queuedSectionId?: string | null;
  isVamping?: boolean;
  pitchSemitones?: number;
  clickEnabled?: boolean;
  clickGain?: number;
  clickSubdivision?: number;
  quantizeMode?: string;
  masterGain?: number;
  cueMasterGain?: number;
  monitorGain?: number;
  /** Lo que el motor tiene realmente en cada pista: la interfaz lo compara con lo que muestra y corrige diferencias. */
  trackControls?: EngineTrackControl[];
  /** Picos reales medidos por el motor desde la consulta anterior. */
  meters?: NativeMetersSnapshot;
}

/** Reloj para la caída de los medidores (performance.now si existe). */
const meterNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

export class NativeAudioEngine {
  private currentProject: SongProject | null = null;
  /** Envío ordenado, por diferencias y autocorregido de los controles de la mezcla (ver `controlSync.ts`). */
  private readonly controlSync = new ControlSync({
    getInvoke: () => getInvoke() ?? undefined,
    onError: (op, err) => logAsyncError(op.cmd)(err),
  });
  private loadedProjectId: string | null = null;
  private loadingPromises = new Map<string, Promise<{ peaksMap: Map<string, number[]>; wasCancelled: boolean }>>();
  private transportListeners = new Set<(transport: TransportState) => void>();
  private poller: StatePoller<NativePlaybackSnapshot> | null = null;
  private lastPollErrorLogMs = 0;
  private suppressedPollErrors = 0;
  private onSongEndedCallback: (() => void) | null = null;
  private onNoticeCallback: ((msg: string) => void) | null = null;
  private onDeviceDisconnectedCallback: ((disconnected: boolean) => void) | null = null;

  private lastPositionSec: number = 0;
  private lastDurationSec: number = 0;
  private lastPlaybackState: NativePlaybackSnapshot | null = null;
  private meterBallistics = new MeterBallistics();
  private wasPlayingBeforeEnd: boolean = false;
  private deviceDisconnectedAlerted: boolean = false;

  private currentTransport: TransportState = { ...INITIAL_NATIVE_TRANSPORT };

  /** Caché PCM nativa: avance de la decodificación, estado «lista» y generación (ver `nativeCacheManager.ts`). */
  private readonly cache = new NativeCacheManager({
    getInvoke,
    notice: (msg) => this.onNoticeCallback?.(msg),
  });
  private playPendingProjectId: string | null = null;

  constructor() {
    if (typeof window !== 'undefined' && (window as any).__TAURI__) {
      this.startPolling();
      this.setupEventListeners();
    }
  }

  private setupEventListeners(): void {
    const listen = (window as any).__TAURI__?.event?.listen;
    if (!listen) return;

    listen('audio://import-progress', (event: any) => {
      this.cache.handleProgressEvent(event?.payload);
    }).catch((err: any) => {
      console.warn('[NativeAudioEngine] Error suscribiendo a audio://import-progress:', err);
    });
  }

  public getImportProgress(projectId: string): NativeImportProgress | null {
    return this.cache.getImportProgress(projectId);
  }

  public isProjectImporting(projectId: string): boolean {
    return this.cache.isProjectImporting(projectId);
  }

  public markImportStarted(projectId: string, text = 'Iniciando decodificación...', totalTracks = 0): void {
    this.cache.markImportStarted(projectId, text, totalTracks);
  }

  public markImportCompleted(projectId: string): void {
    this.cache.markImportCompleted(projectId);
  }

  /** `null` si aún no se consultó; `true`/`false` según el último resultado del backend (síncrono). */
  public isNativeCacheReady(projectId: string): boolean | null {
    return this.cache.isNativeCacheReady(projectId);
  }

  /** Consulta varias canciones a la vez (p. ej. el setlist al abrir la app o al cambiar). */
  public refreshCacheStatuses(projects: SongProject[]): Promise<void> {
    return this.cache.refreshCacheStatuses(projects);
  }

  /** Texto "Pista N de M · P%" a partir del avance real emitido por el backend. */
  public formatImportProgress(projectId: string): string | null {
    return this.cache.formatImportProgress(projectId);
  }

  public consumePlayPending(projectId: string): boolean {
    if (this.playPendingProjectId === projectId) {
      this.playPendingProjectId = null;
      return true;
    }
    return false;
  }

  public isDesktop(): boolean {
    return typeof window !== 'undefined' && Boolean((window as any).__TAURI__);
  }

  public setOnNotice(cb: ((msg: string) => void) | null): void {
    this.onNoticeCallback = cb;
  }

  public setOnSongEnded(cb: (() => void) | null): void {
    this.onSongEndedCallback = cb;
  }

  public setOnDeviceDisconnected(cb: ((disconnected: boolean) => void) | null): void {
    this.onDeviceDisconnectedCallback = cb;
  }

  public getTransportState(): TransportState {
    return { ...this.currentTransport };
  }

  public getTotalDurationSec(): number {
    return this.lastDurationSec || this.currentProject?.durationSec || 0;
  }

  public hasPlayableAudio(): boolean {
    return Boolean(
      this.currentProject &&
        this.loadedProjectId === this.currentProject.id &&
        this.currentProject.tracks.length > 0
    );
  }

  // ===========================================================================
  // SUSCRIPCIÓN DE TRANSPORTE
  // ===========================================================================
  public subscribe(listener: (transport: TransportState) => void): () => void {
    this.transportListeners.add(listener);
    listener({ ...this.currentTransport });
    return () => {
      this.transportListeners.delete(listener);
    };
  }

  public subscribeCache(listener: () => void): () => void {
    return this.cache.subscribe(listener);
  }

  private notifyTransport(): void {
    const copy = { ...this.currentTransport };
    for (const listener of this.transportListeners) {
      try {
        listener(copy);
      } catch (err) {
        console.warn('[NativeAudioEngine] Error en listener de transporte:', err);
      }
    }
  }

  private notifyCache(): void {
    this.cache.notify();
  }

  // ===========================================================================
  // SONDEO DE ESTADO (una sola petición pendiente; ver statePoller.ts)
  // ===========================================================================
  private startPolling(): void {
    if (this.poller) return;
    this.poller = new StatePoller<NativePlaybackSnapshot>({
      request: async () => {
        const invoke = getInvoke();
        if (!invoke) return null;
        return invoke<NativePlaybackSnapshot>('audio_get_playback_state');
      },
      onSnapshot: (pb) => this.applySnapshot(pb),
      onError: (err) => this.reportPollError(err),
      // Reproduciendo, ~30 fps; en pausa basta una consulta cada 200 ms.
      delayMs: (last) => (last?.isPlaying ? 33 : 200),
    });
    this.poller.start();
  }

  /** Registra los fallos del sondeo sin inundar la consola: como mucho un aviso cada 5 s, con el recuento. */
  private reportPollError(err: unknown): void {
    const now = Date.now();
    if (now - this.lastPollErrorLogMs < 5000) {
      this.suppressedPollErrors++;
      return;
    }
    const extra = this.suppressedPollErrors > 0 ? ` (${this.suppressedPollErrors} fallos más desde el último aviso)` : '';
    console.warn(`[NativeAudioEngine] Error consultando el estado de reproducción${extra}:`, err);
    this.lastPollErrorLogMs = now;
    this.suppressedPollErrors = 0;
  }

  /** Pide una actualización de estado inmediata (tras play, pausa, seek, salto, carga…). */
  private refreshStateNow(): void {
    this.poller?.pollNow();
  }

  private applySnapshot(pb: NativePlaybackSnapshot): void {
    this.lastPlaybackState = pb;
    this.meterBallistics.update(pb.meters, meterNow());
    // Red de seguridad: si el motor tiene algo distinto de lo que muestra la interfaz (una orden perdida o
    // aplicada al revés), se corrige y queda anotado en la caja negra.
    if (this.currentProject && this.loadedProjectId === this.currentProject.id) {
      this.controlSync.reconcile(pb, this.currentProject);
    }
    this.lastPositionSec = pb.positionSec;
    this.lastDurationSec = pb.durationSec;

    // Detección de desconexión de hardware en caliente
    if (pb.deviceDisconnected) {
      if (!this.deviceDisconnectedAlerted) {
        this.deviceDisconnectedAlerted = true;
        this.onDeviceDisconnectedCallback?.(true);
        this.onNoticeCallback?.('Dispositivo de audio desconectado. Reproducción pausada y posición conservada.');
      }
    } else if (this.deviceDisconnectedAlerted) {
      this.deviceDisconnectedAlerted = false;
      this.onDeviceDisconnectedCallback?.(false);
    }

    // Detección de fin de canción para setlist automático
    if (this.wasPlayingBeforeEnd && !pb.isPlaying && pb.totalFrames > 0 && pb.currentFrame >= pb.totalFrames) {
      this.wasPlayingBeforeEnd = false;
      console.info('[NativeAudioEngine] Canción finalizada.');
      this.onSongEndedCallback?.();
    } else {
      this.wasPlayingBeforeEnd = pb.isPlaying;
    }

    const nextTransport = snapshotToTransport(pb, this.currentProject?.bpm, this.currentProject?.beatsPerBar);

    // Si nada cambió (p. ej. en pausa) no se avisa: evita renderizar la interfaz entera con cada consulta.
    if (sameTransport(this.currentTransport, nextTransport)) return;
    this.currentTransport = nextTransport;
    this.notifyTransport();
  }

  // ===========================================================================
  // CONTROL DE TRANSPORTE
  // ===========================================================================
  public async play(): Promise<void> {
    const invoke = getInvoke();
    if (!invoke) return;

    if (!this.currentProject) {
      this.onNoticeCallback?.('No hay ninguna canción seleccionada.');
      return;
    }

    const projId = this.currentProject.id;
    const progress = this.cache.getImportProgress(projId);
    if (progress && !progress.completed) {
      this.playPendingProjectId = projId;
      this.onNoticeCallback?.(
        `Decodificando pistas (${progress.percent}%) de "${this.currentProject.title}"... Comenzará a sonar al finalizar.`
      );
      return;
    }

    if (this.loadedProjectId !== projId) {
      const status = await this.checkProjectCacheStatus(this.currentProject);
      if (status.isReady) {
        await this.loadProject(this.currentProject);
      } else {
        this.onNoticeCallback?.(
          `La canción "${this.currentProject.title}" no dispone de caché PCM nativa. Pulsa «Generar caché nativa».`
        );
        return;
      }
    }

    try {
      await invoke('audio_play');
      this.refreshStateNow();
    } catch (err: any) {
      console.warn('[NativeAudioEngine] Error al reproducir:', err);
      this.onNoticeCallback?.(`Error al reproducir: ${err}`);
    }
  }

  public async pause(): Promise<void> {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      await invoke('audio_pause');
      this.refreshStateNow();
    } catch (err: any) {
      console.warn('[NativeAudioEngine] Error al pausar:', err);
    }
  }

  public async togglePlayPause(): Promise<void> {
    if (this.currentTransport.isPlaying) {
      await this.pause();
    } else {
      await this.play();
    }
  }

  public async stop(): Promise<void> {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      this.poller?.invalidate();
      await invoke('audio_stop');
      this.refreshStateNow();
      this.currentTransport.isPlaying = false;
      this.currentTransport.currentTimeSec = 0;
      this.currentTransport.currentBar = 1;
      this.currentTransport.currentBeat = 1;
      this.notifyTransport();
    } catch (err: any) {
      console.warn('[NativeAudioEngine] Error al detener:', err);
    }
  }

  public async seekToSeconds(sec: number): Promise<void> {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      await invoke('audio_seek', { positionSec: Math.max(0, sec) });
      this.refreshStateNow();
    } catch (err: any) {
      console.warn('[NativeAudioEngine] Error al hacer seek:', err);
    }
  }

  public async queueSectionJump(sectionId: string, mode?: string): Promise<void> {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      const qMode = mode || this.currentProject?.quantizeMode || 'section-end';
      await invoke('audio_queue_jump', { sectionId, mode: qMode });
      this.refreshStateNow();
    } catch (err: any) {
      console.warn('[NativeAudioEngine] Error en salto de sección:', err);
      this.onNoticeCallback?.(`Error en salto: ${err}`);
    }
  }

  public async cancelQueuedJump(): Promise<void> {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      await invoke('audio_cancel_jump');
      this.refreshStateNow();
    } catch (err: any) {
      console.warn('[NativeAudioEngine] Error cancelando salto:', err);
    }
  }

  public async toggleVamp(enable?: boolean): Promise<boolean> {
    const invoke = getInvoke();
    if (!invoke) return false;
    try {
      const targetState = enable !== undefined ? enable : !this.currentTransport.isVamping;
      const res = await invoke<boolean>('audio_toggle_vamp', { enable: targetState });
      this.refreshStateNow();
      return res;
    } catch (err: any) {
      console.warn('[NativeAudioEngine] Error alternando vamp:', err);
      return false;
    }
  }

  public async reopenDevice(): Promise<void> {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      await invoke('audio_reopen_stream');
      this.deviceDisconnectedAlerted = false;
      this.onDeviceDisconnectedCallback?.(false);
      this.onNoticeCallback?.('Dispositivo de audio reabierto con éxito.');
    } catch (err: any) {
      console.warn('[NativeAudioEngine] Error al reabrir dispositivo:', err);
      this.onNoticeCallback?.(`Error reabriendo dispositivo: ${err}`);
    }
  }

  // ===========================================================================
  // CONTROL DE MEZCLADOR Y PISTAS
  // ===========================================================================
  // ===========================================================================
  // CARGA DE PROYECTO Y VERIFICACIÓN DE CACHÉ NATIVA
  // ===========================================================================
  public prepareProjectShell(project: SongProject): void {
    const prevId = this.currentProject?.id;
    this.currentProject = project;
    if (prevId && prevId !== project.id) {
      this.loadedProjectId = null;
      this.poller?.invalidate();
      void this.stop();
    }
  }

  /** Envía TODO el estado de la canción al motor (carga, importación, reapertura). */
  public updateProjectConfig(project: SongProject): void {
    this.currentProject = project;
    this.controlSync.syncAll(project);
  }

  /**
   * Envía solo lo que cambió entre dos versiones de la canción (un fader, un solo…). Las órdenes salen en orden y
   * una a una. Devuelve las órdenes generadas (la interfaz las usa para decidir cuándo guardar).
   */
  public applyProjectChange(prev: SongProject, next: SongProject): ControlOp[] {
    this.currentProject = next;
    return this.controlSync.applyChange(prev, next);
  }

  public checkProjectCacheStatus(project: SongProject): Promise<CacheStatus> {
    return this.cache.checkProjectCacheStatus(project);
  }

  /** Genera la caché PCM nativa; nunca dos decodificaciones a la vez del mismo proyecto. */
  public generateNativeCacheForProject(
    project: SongProject,
    onProgress?: (percent: number, text: string) => void
  ): Promise<boolean> {
    return this.cache.generateNativeCacheForProject(project, onProgress);
  }

  public async loadProject(
    project: SongProject,
    onProgressOrBuffers?: ((percent: number, text: string) => void) | unknown
  ): Promise<{ peaksMap: Map<string, number[]>; wasCancelled: boolean }> {
    const invoke = getInvoke();
    const peaksMap = new Map<string, number[]>();
    if (!invoke) return { peaksMap, wasCancelled: false };

    const onProgress =
      typeof onProgressOrBuffers === 'function'
        ? (onProgressOrBuffers as (percent: number, text: string) => void)
        : undefined;

    this.currentProject = project;

    // Si el proyecto se está importando actualmente en segundo plano, no iniciar una segunda importación:
    if (this.isProjectImporting(project.id)) {
      console.info(`[NativeAudioEngine] loadProject pospuesto: '${project.id}' se está decodificando actualmente.`);
      return { peaksMap, wasCancelled: false };
    }

    const existingPromise = this.loadingPromises.get(project.id);
    if (existingPromise) {
      return existingPromise;
    }

    const loadTask = (async () => {
      onProgress?.(10, `Verificando caché nativa para "${project.title}"...`);

      const cacheStatus = await this.checkProjectCacheStatus(project);
      if (!cacheStatus.isReady && project.tracks.length > 0) {
        if (this.isProjectImporting(project.id)) {
          return { peaksMap, wasCancelled: false };
        }
        onProgress?.(20, 'Generando caché PCM nativa...');
        const success = await this.generateNativeCacheForProject(project, onProgress);
        if (!success) {
          this.loadedProjectId = null;
          this.onNoticeCallback?.(`La canción "${project.title}" no dispone de caché PCM nativa.`);
          return { peaksMap, wasCancelled: false };
        }
      }

      onProgress?.(70, 'Cargando pistas en motor nativo...');
      const nativeSections = (project.sections || []).map((s) => ({
        id: s.id,
        name: s.name,
        code: (s as any).code || null,
        startSec: s.startTimeSec,
        endSec: s.endTimeSec,
      }));

      try {
        const loadRes: any = await invoke('audio_load_project', {
          projectId: project.id,
          bpm: project.bpm || 120,
          beatsPerBar: project.beatsPerBar || 4,
          sections: nativeSections,
          quantizeMode: project.quantizeMode || 'section-end',
        });

        this.loadedProjectId = project.id;
        this.poller?.invalidate();
        this.lastDurationSec = loadRes?.durationSec || project.durationSec || 0;

        const sr = loadRes?.sampleRate || 48000;
        const totFrames = loadRes?.totalFrames || Math.round(this.lastDurationSec * sr);
        const trackPeaksObj = loadRes?.trackPeaks || {};
        for (const trk of project.tracks) {
          const pks = trackPeaksObj[trk.id];
          if (Array.isArray(pks) && pks.length > 0) {
            peaksMap.set(trk.id, pks);
            trk.peaks = pks;
          } else if (trk.peaks && trk.peaks.length > 0) {
            peaksMap.set(trk.id, trk.peaks);
          }
          if (!trk.pcm && totFrames > 0) {
            trk.pcm = {
              sampleRate: sr,
              channels: 2,
              frames: totFrames,
              version: 1,
            };
          }
        }

        this.updateProjectConfig(project);
        this.notifyCache();

        onProgress?.(100, `Cargadas ${loadRes?.trackCount || project.tracks.length} pistas.`);

        if (this.consumePlayPending(project.id)) {
          await this.play();
        }
      } catch (err: any) {
        this.loadedProjectId = null;
        console.error('[NativeAudioEngine] Error al cargar proyecto en Rust:', err);
        this.onNoticeCallback?.(`Error al cargar pistas en motor nativo: ${err}`);
        throw err;
      }

      return { peaksMap, wasCancelled: false };
    })();

    this.loadingPromises.set(project.id, loadTask);
    try {
      return await loadTask;
    } finally {
      this.loadingPromises.delete(project.id);
    }
  }

  public async preloadProject(project: SongProject): Promise<void> {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      if (this.isProjectImporting(project.id)) return;
      const cacheStatus = await this.checkProjectCacheStatus(project);
      if (!cacheStatus.isReady) {
        console.info(`[NativeAudioEngine] Preload omitido para '${project.id}' (caché aún no lista)`);
        return;
      }
      await invoke('audio_preload_project', { projectId: project.id });
    } catch (err: any) {
      console.warn('[NativeAudioEngine] Error al precargar proyecto:', err);
    }
  }

  public async switchSong(project: SongProject): Promise<void> {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      await invoke('audio_switch_to_preloaded');
      this.currentProject = project;
      this.loadedProjectId = project.id;
      this.updateProjectConfig(project);
      this.notifyCache();
    } catch {
      await this.loadProject(project);
    }
  }

  // ===========================================================================
  // MÉTODOS DE COMPATIBILIDAD CON VISTAS (Mixer, Timeline, Setlist, Modales)
  // ===========================================================================
  /**
   * Niveles reales medidos por el motor nativo (pico post-fader con caída de ~20 dB/s).
   * Incluye las pistas de la canción mostrada; una pista que no está sonando da 0.
   */
  public getTrackMeters(): MetersSnapshot {
    const isPlaying = this.currentTransport.isPlaying;
    if (!isPlaying) this.meterBallistics.reset();
    const ids = this.currentProject ? this.currentProject.tracks.map((t) => t.id) : [];
    return this.meterBallistics.snapshot(ids, meterNow(), isPlaying);
  }

  public isProjectPcmReady(song: SongProject): boolean {
    if (!song.tracks || song.tracks.length === 0) return true;
    return song.tracks.every((t) => Boolean(t.pcm && t.pcm.frames > 0));
  }

  public getSongRamCacheInfo(song: SongProject): {
    isReady: boolean;
    isCached: boolean;
    isPreloading: boolean;
    cachedCount: number;
    totalCount: number;
    cachedBytes: number;
    skippedByRamBudget: boolean;
  } {
    const ready = this.isProjectPcmReady(song);
    const totalCount = song.tracks?.length || 0;
    return {
      isReady: ready,
      isCached: ready,
      isPreloading: this.isProjectImporting(song.id),
      cachedCount: ready ? totalCount : 0,
      totalCount,
      cachedBytes: 0,
      skippedByRamBudget: false,
    };
  }

  public getEffectiveEngineModeForProject(_song: SongProject): AudioEngineMode {
    return 'stream';
  }

  public getProjectPcmEstimatedMB(song: SongProject): number {
    const frames = song.tracks.reduce((sum, t) => sum + (t.pcm?.frames || 0), 0);
    return Math.round((frames * 2) / (1024 * 1024));
  }

  public setPriorityProjectIds(_ids: string[]): void {}

  public clearProjectFallback(_projectId: string): void {}

  public getTotalCachedMB(): number {
    return 0;
  }

  public removeTrack(_trackId: string): void {}

  public evictSongFromRamCache(_projectId: string): void {}

  public mountDecodedTrack(_track: TrackChannel, _buffer: AudioBuffer): void {}

  public async decodeStemBuffer(
    _rawBuf: ArrayBuffer,
    _name: string,
    _isMono?: boolean
  ): Promise<{ audioBuffer: AudioBuffer; peaks: number[]; durationSec: number }> {
    return {
      audioBuffer: {} as any,
      peaks: new Array(320).fill(0.2),
      durationSec: 180,
    };
  }

  public getCachedProjectBuffers(_projectId: string): Map<string, AudioBuffer> | null {
    return null;
  }

  public hasFullProjectInCache(_project: SongProject): boolean {
    return true;
  }

  public storeProjectBuffersInRamCache(_projectId: string, _map: Map<string, AudioBuffer>): void {}
}

export const nativeAudioEngine = new NativeAudioEngine();
