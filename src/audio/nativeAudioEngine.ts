// =============================================================================
// NATIVE AUDIO ENGINE ADAPTER (Fase 6: Integración del Motor Nativo en Escritorio)
// =============================================================================
// En entorno de escritorio (Tauri v2 / Windows x64), este adaptador asume el
// transporte, mezclador, secciones, setlist y control remoto LAN llamando al motor
// nativo en Rust vía IPC. El motor web (audioEngine.ts) se mantiene 100% intacto.
// =============================================================================

import { SongProject, TrackChannel, TransportState, MetersSnapshot } from '../types/project';
import { MeterBallistics, NativeMetersSnapshot } from './meterBallistics';
import { loadProjectStemsFromDb, extractStemArrayBuffer } from '../storage/projectDb';
import {
  pickNativeFolder,
  scanNativeFolder,
  checkFilesExist,
  importTrackBytesRaw,
} from '../utils/nativeDialog';

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
  splitMono?: boolean;
  masterGain?: number;
  cueMasterGain?: number;
  /** Picos reales medidos por el motor desde la consulta anterior. */
  meters?: NativeMetersSnapshot;
}

/** Reloj para la caída de los medidores (performance.now si existe). */
const meterNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

export interface NativeImportProgress {
  percent: number;
  text: string;
  completed: boolean;
  /** Pista que se está decodificando (1-based). 0 si aún no se conoce. */
  trackNumber: number;
  totalTracks: number;
}

export class NativeAudioEngine {
  private currentProject: SongProject | null = null;
  private loadedProjectId: string | null = null;
  private loadingPromises = new Map<string, Promise<{ peaksMap: Map<string, number[]>; wasCancelled: boolean }>>();
  private transportListeners = new Set<(transport: TransportState) => void>();
  private cacheListeners = new Set<() => void>();
  private pollInterval: number | null = null;
  private onSongEndedCallback: (() => void) | null = null;
  private onNoticeCallback: ((msg: string) => void) | null = null;
  private onDeviceDisconnectedCallback: ((disconnected: boolean) => void) | null = null;

  private lastPositionSec: number = 0;
  private lastDurationSec: number = 0;
  private lastPlaybackState: NativePlaybackSnapshot | null = null;
  private meterBallistics = new MeterBallistics();
  private wasPlayingBeforeEnd: boolean = false;
  private deviceDisconnectedAlerted: boolean = false;

  private currentTransport: TransportState = {
    isPlaying: false,
    currentTimeSec: 0,
    totalDurationSec: 0,
    currentBar: 1,
    currentBeat: 1,
    beatProgress: 0,
    activeSectionId: null,
    queuedSectionId: null,
    queuedTargetBar: null,
    countdownBeats: 0,
    isVamping: false,
    lastCueMessage: null,
  };

  private importProgressByProject = new Map<string, NativeImportProgress>();
  private generatingCachePromises = new Map<string, Promise<boolean>>();
  /** Último estado conocido de la caché PCM nativa por proyecto (para pintar la interfaz de forma síncrona). */
  private nativeReadyByProject = new Map<string, boolean>();
  /** Pistas de cada proyecto, para poder re-consultar el estado al terminar una importación. */
  private trackIdsByProject = new Map<string, string[]>();
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

    listen('audio://import-progress', async (event: any) => {
      const payload = event.payload;
      if (!payload) return;
      const projId = payload.project_id || payload.projectId;
      let percent = Math.round(payload.percent || 0);
      const text = payload.track_name || '';
      const completed = Boolean(payload.completed);
      const totalTracks = Number(payload.total_tracks ?? payload.totalTracks ?? 0);
      // El backend envía cuántas pistas llevan terminadas; la que se está procesando es la siguiente.
      const rawIndex = Number(payload.track_index ?? payload.trackIndex ?? 0);
      let trackNumber = completed ? totalTracks : Math.min(rawIndex + 1, totalTracks || rawIndex + 1);

      // Los eventos salen de varios hilos y pueden llegar cruzados: mientras la importación sigue en
      // curso, ni el porcentaje ni el número de pista pueden retroceder.
      const prev = this.importProgressByProject.get(projId);
      if (prev && !prev.completed && !completed) {
        percent = Math.max(prev.percent, percent);
        trackNumber = Math.max(prev.trackNumber, trackNumber);
      }

      this.importProgressByProject.set(projId, {
        percent,
        text,
        completed,
        trackNumber,
        totalTracks,
      });

      this.notifyCache();

      if (completed) {
        console.info(`[NativeAudioEngine] Importación de caché completada para proyecto '${projId}'`);
        this.recheckKnownProject(projId);
      }
    }).catch((err: any) => {
      console.warn('[NativeAudioEngine] Error suscribiendo a audio://import-progress:', err);
    });
  }

  public getImportProgress(projectId: string): NativeImportProgress | null {
    return this.importProgressByProject.get(projectId) || null;
  }

  public isProjectImporting(projectId: string): boolean {
    const prog = this.importProgressByProject.get(projectId);
    return Boolean(prog && !prog.completed);
  }

  public markImportStarted(projectId: string, text = 'Iniciando decodificación...', totalTracks = 0): void {
    this.importProgressByProject.set(projectId, {
      percent: 0,
      text,
      completed: false,
      trackNumber: 0,
      totalTracks,
    });
    this.notifyCache();
  }

  public markImportCompleted(projectId: string): void {
    const prev = this.importProgressByProject.get(projectId);
    this.importProgressByProject.set(projectId, {
      percent: 100,
      text: 'Completado',
      completed: true,
      trackNumber: prev?.totalTracks ?? 0,
      totalTracks: prev?.totalTracks ?? 0,
    });
    this.notifyCache();
    this.recheckKnownProject(projectId);
  }

  /**
   * Estado conocido de la caché PCM nativa: `null` si aún no se consultó, `true`/`false` según el último
   * resultado del backend. Es síncrono para poder usarlo al renderizar tarjetas.
   */
  public isNativeCacheReady(projectId: string): boolean | null {
    const v = this.nativeReadyByProject.get(projectId);
    return v === undefined ? null : v;
  }

  /** Guarda el estado y avisa a los suscriptores solo si cambió (evita redibujados en bucle). */
  private setNativeReady(projectId: string, ready: boolean): void {
    const prev = this.nativeReadyByProject.get(projectId);
    this.nativeReadyByProject.set(projectId, ready);
    if (prev !== ready) this.notifyCache();
  }

  /** Re-consulta el estado de un proyecto cuyas pistas ya conocemos (p. ej. al terminar una importación). */
  private recheckKnownProject(projectId: string): void {
    const trackIds = this.trackIdsByProject.get(projectId);
    if (!trackIds) return;
    this.queryCacheStatus(projectId, trackIds).catch((err) => {
      console.error(`[NativeAudioEngine] Error re-consultando la caché de '${projectId}':`, err);
    });
  }

  /** Consulta varias canciones a la vez (p. ej. el setlist al abrir la app o al cambiar). */
  public async refreshCacheStatuses(projects: SongProject[]): Promise<void> {
    await Promise.all(projects.map((p) => this.checkProjectCacheStatus(p)));
  }

  /** Texto "Pista N de M · P%" a partir del avance real emitido por el backend. */
  public formatImportProgress(projectId: string): string | null {
    const prog = this.importProgressByProject.get(projectId);
    if (!prog || prog.completed) return null;
    const pista = prog.totalTracks > 0 && prog.trackNumber > 0
      ? `Pista ${prog.trackNumber} de ${prog.totalTracks} · `
      : '';
    return `${pista}${prog.percent}%`;
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
    this.cacheListeners.add(listener);
    return () => {
      this.cacheListeners.delete(listener);
    };
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
    for (const listener of this.cacheListeners) {
      try {
        listener();
      } catch (err) {
        console.warn('[NativeAudioEngine] Error en listener de caché:', err);
      }
    }
  }

  // ===========================================================================
  // BUCLE DE POLLING DE ESTADO (~30 ms para suavidad de 30 fps)
  // ===========================================================================
  private startPolling(): void {
    if (this.pollInterval != null) return;
    this.pollInterval = window.setInterval(async () => {
      const invoke = getInvoke();
      if (!invoke) return;

      try {
        const pb = await invoke<NativePlaybackSnapshot>('audio_get_playback_state');
        if (!pb) return;

        this.lastPlaybackState = pb;
        this.meterBallistics.update(pb.meters, meterNow());
        const curSec = pb.positionSec;
        const totSec = pb.durationSec;
        this.lastPositionSec = curSec;
        this.lastDurationSec = totSec;

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

        // Cálculo de compás y tempo
        const bpm = (this.currentProject?.bpm) || 120;
        const bpb = (this.currentProject?.beatsPerBar) || 4;
        const secPerBeat = 60 / bpm;
        const totalBeats = curSec / secPerBeat;
        const currentBar = Math.floor(totalBeats / bpb) + 1;
        const currentBeat = (Math.floor(totalBeats) % bpb) + 1;
        const beatProgress = totalBeats - Math.floor(totalBeats);

        // Detección de fin de canción para setlist automático
        if (this.wasPlayingBeforeEnd && !pb.isPlaying && pb.totalFrames > 0 && pb.currentFrame >= pb.totalFrames) {
          this.wasPlayingBeforeEnd = false;
          console.info('[NativeAudioEngine] Canción finalizada.');
          this.onSongEndedCallback?.();
        } else {
          this.wasPlayingBeforeEnd = pb.isPlaying;
        }

        this.currentTransport = {
          isPlaying: pb.isPlaying,
          currentTimeSec: curSec,
          totalDurationSec: totSec,
          currentBar,
          currentBeat,
          beatProgress,
          activeSectionId: pb.activeSectionId || null,
          queuedSectionId: pb.queuedSectionId || null,
          queuedTargetBar: null,
          countdownBeats: 0,
          isVamping: Boolean(pb.isVamping),
          lastCueMessage: null,
        };

        this.notifyTransport();
      } catch {
        // Silenciar errores transitorios en polling
      }
    }, 33);
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
    const progress = this.importProgressByProject.get(projId);
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
      await invoke('audio_stop');
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
    } catch (err: any) {
      console.warn('[NativeAudioEngine] Error al hacer seek:', err);
    }
  }

  public async queueSectionJump(sectionId: string, mode?: string): Promise<void> {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      const qMode = mode || this.currentProject?.quantizeMode || '1-bar';
      await invoke('audio_queue_jump', { sectionId, mode: qMode });
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
  public setTrackGain(trackId: string, gain: number): void {
    const invoke = getInvoke();
    if (!invoke) return;
    invoke('audio_set_track_controls', { trackId, gain }).catch(() => {});
  }

  public setTrackPan(trackId: string, pan: number): void {
    const invoke = getInvoke();
    if (!invoke) return;
    invoke('audio_set_track_controls', { trackId, pan }).catch(() => {});
  }

  public setTrackMuted(trackId: string, muted: boolean): void {
    const invoke = getInvoke();
    if (!invoke) return;
    invoke('audio_set_track_controls', { trackId, muted }).catch(() => {});
  }

  public setTrackSoloed(trackId: string, soloed: boolean): void {
    const invoke = getInvoke();
    if (!invoke) return;
    invoke('audio_set_track_controls', { trackId, soloed }).catch(() => {});
  }

  public setTrackBus(trackId: string, bus: string): void {
    const invoke = getInvoke();
    if (!invoke) return;
    invoke('audio_set_track_controls', { trackId, bus }).catch(() => {});
  }

  public setMasterGain(masterGain: number): void {
    const invoke = getInvoke();
    if (!invoke) return;
    invoke('audio_set_master_gains', { masterGain, cueMasterGain: null }).catch(() => {});
  }

  public setCueMasterGain(cueMasterGain: number): void {
    const invoke = getInvoke();
    if (!invoke) return;
    invoke('audio_set_master_gains', { masterGain: null, cueMasterGain }).catch(() => {});
  }

  public setClickEnabled(enabled: boolean): void {
    if (!this.currentProject) return;
    this.updateMetronome({ clickEnabled: enabled });
  }

  public setClickGain(gain: number): void {
    if (!this.currentProject) return;
    this.updateMetronome({ clickGain: gain });
  }

  public setClickSubdivision(subdivision: number): void {
    if (!this.currentProject) return;
    this.updateMetronome({ clickSubdivision: subdivision as 1 | 2 });
  }

  public setPitchSemitones(semitones: number): void {
    const invoke = getInvoke();
    if (!invoke) return;
    invoke('audio_set_pitch', { semitones }).catch(() => {});
  }

  public setSplitRoutingMode(mode: 'stereo' | 'split-mono'): void {
    const invoke = getInvoke();
    if (!invoke) return;
    invoke('audio_set_split_mono', { enabled: mode === 'split-mono' }).catch(() => {});
  }

  private updateMetronome(changes: Partial<SongProject>): void {
    const invoke = getInvoke();
    if (!invoke || !this.currentProject) return;
    const cfg = {
      enabled: changes.clickEnabled ?? this.currentProject.clickEnabled ?? true,
      bpm: this.currentProject.bpm || 120,
      beatsPerBar: this.currentProject.beatsPerBar || 4,
      subdivision: changes.clickSubdivision ?? this.currentProject.clickSubdivision ?? 1,
      gain: changes.clickGain ?? this.currentProject.clickGain ?? 0.8,
      splitMono: this.currentProject.splitRoutingMode === 'split-mono',
    };
    invoke('audio_set_metronome', { config: cfg }).catch(() => {});
  }

  // ===========================================================================
  // CARGA DE PROYECTO Y VERIFICACIÓN DE CACHÉ NATIVA
  // ===========================================================================
  public prepareProjectShell(project: SongProject): void {
    const prevId = this.currentProject?.id;
    this.currentProject = project;
    if (prevId && prevId !== project.id) {
      this.loadedProjectId = null;
      void this.stop();
    }
  }

  public updateProjectConfig(project: SongProject): void {
    this.currentProject = project;
    const invoke = getInvoke();
    if (!invoke) return;

    // Sincronizar parámetros globales
    this.setSplitRoutingMode(project.splitRoutingMode || 'stereo');
    this.setMasterGain(project.masterGain ?? 1.0);
    this.setCueMasterGain(project.cueMasterGain ?? 0.708);
    this.setPitchSemitones(project.pitchSemitones || 0);

    const nativeSections = (project.sections || []).map((s) => ({
      id: s.id,
      name: s.name,
      code: (s as any).code || null,
      startSec: s.startTimeSec,
      endSec: s.endTimeSec,
    }));

    invoke('audio_configure_song', {
      bpm: project.bpm || 120,
      beatsPerBar: project.beatsPerBar || 4,
      sections: nativeSections,
      quantizeMode: project.quantizeMode || '1-bar',
    }).catch(() => {});

    // Sincronizar metrónomo
    this.updateMetronome(project);

    // Sincronizar controles individuales de cada pista
    for (const trk of project.tracks) {
      invoke('audio_set_track_controls', {
        trackId: trk.id,
        gain: trk.gain,
        pan: trk.pan,
        muted: trk.muted,
        soloed: trk.soloed,
        bus: trk.bus,
      }).catch(() => {});
    }
  }

  /** Consulta al backend y actualiza el estado síncrono. Lanza si el backend falla. */
  private async queryCacheStatus(
    projectId: string,
    trackIds: string[]
  ): Promise<{ isReady: boolean; cachedCount: number; totalCount: number }> {
    const invoke = getInvoke();
    if (!invoke) return { isReady: false, cachedCount: 0, totalCount: trackIds.length };

    const res: any = await invoke('audio_get_project_cache_status', {
      projectId,
      sampleRate: null,
      trackIds,
    });
    const isReady = Boolean(res?.isReady);
    this.setNativeReady(projectId, isReady);
    return {
      isReady,
      cachedCount: res?.cachedTracksCount || 0,
      totalCount: res?.totalTracksCount || trackIds.length,
    };
  }

  public async checkProjectCacheStatus(project: SongProject): Promise<{ isReady: boolean; cachedCount: number; totalCount: number }> {
    const trackIds = project.tracks.map((t) => t.id);
    this.trackIdsByProject.set(project.id, trackIds);
    try {
      return await this.queryCacheStatus(project.id, trackIds);
    } catch (err) {
      console.error(`[NativeAudioEngine] Error consultando el estado de la caché de '${project.id}':`, err);
      this.setNativeReady(project.id, false);
      return { isReady: false, cachedCount: 0, totalCount: trackIds.length };
    }
  }

  /**
   * Genera la caché PCM nativa de un proyecto. Nunca lanza dos decodificaciones a la vez
   * para el mismo proyecto: si ya hay una en curso (propia o iniciada por otro camino,
   * `isProjectImporting`), espera a esa y devuelve si la caché quedó lista.
   */
  public async generateNativeCacheForProject(
    project: SongProject,
    onProgress?: (percent: number, text: string) => void
  ): Promise<boolean> {
    const inFlight = this.generatingCachePromises.get(project.id);
    if (inFlight) {
      const unsubscribe = this.forwardRealProgress(project.id, onProgress);
      try {
        return await inFlight;
      } finally {
        unsubscribe();
      }
    }

    if (this.isProjectImporting(project.id)) {
      const unsubscribe = this.forwardRealProgress(project.id, onProgress);
      try {
        await this.waitForImportToFinish(project.id);
        return (await this.checkProjectCacheStatus(project)).isReady;
      } finally {
        unsubscribe();
      }
    }

    this.trackIdsByProject.set(project.id, project.tracks.map((t) => t.id));
    this.markImportStarted(project.id, 'Preparando decodificación...', project.tracks.length);
    const unsubscribe = this.forwardRealProgress(project.id, onProgress);
    const task = this.runGenerateNativeCache(project, onProgress).finally(() => {
      // Si el backend no llegó a emitir `completed` (error/cancelación), no dejar el proyecto
      // marcado como "importando" para siempre.
      if (this.isProjectImporting(project.id)) this.markImportCompleted(project.id);
      this.generatingCachePromises.delete(project.id);
      unsubscribe();
    });
    this.generatingCachePromises.set(project.id, task);
    return task;
  }

  /** Reenvía a `onProgress` el avance real (audio://import-progress) mientras dure la decodificación. */
  private forwardRealProgress(
    projectId: string,
    onProgress?: (percent: number, text: string) => void
  ): () => void {
    if (!onProgress) return () => {};
    return this.subscribeCache(() => {
      const prog = this.importProgressByProject.get(projectId);
      if (!prog || prog.completed || prog.trackNumber === 0) return;
      const label = this.formatImportProgress(projectId) ?? `${prog.percent}%`;
      onProgress(prog.percent, `${label}${prog.text ? ` · ${prog.text}` : ''}`);
    });
  }

  private waitForImportToFinish(projectId: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.isProjectImporting(projectId)) return resolve();
      const unsubscribe = this.subscribeCache(() => {
        if (!this.isProjectImporting(projectId)) {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  private async runGenerateNativeCache(
    project: SongProject,
    onProgress?: (percent: number, text: string) => void
  ): Promise<boolean> {
    const invoke = getInvoke();
    if (!invoke) return false;

    try {
      onProgress?.(5, 'Comprobando rutas de origen...');

      // 1. INTENTO 1: Rutas de archivos originales en disco (track.filePath)
      const tracksWithPaths = project.tracks.filter((t) => Boolean(t.filePath));
      if (tracksWithPaths.length === project.tracks.length && tracksWithPaths.length > 0) {
        const paths = tracksWithPaths.map((t) => t.filePath!);
        const existResults = await checkFilesExist(paths);
        const allExist = existResults.every(Boolean);

        if (allExist) {
          onProgress?.(15, `Decodificando ${paths.length} pistas desde rutas originales...`);
          const filesToImport = tracksWithPaths.map((t) => ({
            filePath: t.filePath!,
            trackId: t.id,
          }));

          const res: any = await invoke('audio_import_tracks', {
            projectId: project.id,
            files: filesToImport,
            targetSampleRate: null,
          });

          if (res?.tracks && res.tracks.length > 0) {
            onProgress?.(100, `¡Caché nativa generada para ${res.tracks.length} pistas!`);
            this.notifyCache();
            await this.checkProjectCacheStatus(project);
            return true;
          }
        }
      }

      // 2. INTENTO 2: Audios guardados en almacenamiento IndexedDB (versión web o drag & drop)
      onProgress?.(20, 'Buscando pistas en almacenamiento local (IndexedDB)...');
      const stems = await loadProjectStemsFromDb(project.id);
      if (stems && stems.length > 0) {
        const total = stems.length;
        let completed = 0;

        for (let i = 0; i < total; i++) {
          const stem = stems[i];
          const label = stem.fileName || stem.trackId;
          onProgress?.(
            Math.round(20 + ((i + 1) / total) * 75),
            `Decodificando "${label}" (${i + 1}/${total})...`
          );

          const arrayBuf = await extractStemArrayBuffer(stem);
          if (!arrayBuf || arrayBuf.byteLength === 0) continue;

          await importTrackBytesRaw(
            project.id,
            stem.trackId,
            stem.fileName || `${stem.trackId}.mp3`,
            new Uint8Array(arrayBuf)
          );
          completed++;
        }

        if (completed > 0) {
          onProgress?.(100, `¡Caché nativa generada para ${completed} pistas!`);
          this.notifyCache();
          await this.checkProjectCacheStatus(project);
          return true;
        }
      }

      // 3. INTENTO 3: Solicitar carpeta con selector nativo de Windows
      onProgress?.(30, `Solicitando carpeta original para "${project.title}"...`);
      const selectedFolder = await pickNativeFolder();
      if (!selectedFolder) {
        throw new Error('Operación cancelada: no se seleccionó ninguna carpeta.');
      }

      onProgress?.(45, `Escaneando carpeta "${selectedFolder}"...`);
      const scanned = await scanNativeFolder(selectedFolder);
      if (!scanned.files || scanned.files.length === 0) {
        throw new Error('No se encontraron archivos de audio compatibles en la carpeta seleccionada.');
      }

      const filesToImport = scanned.files.map((file, idx) => {
        const matchedTrack = project.tracks.find(
          (t) => t.name.toLowerCase() === file.trackName.toLowerCase() || t.fileName === file.fileName
        );
        const trackId = matchedTrack ? matchedTrack.id : project.tracks[idx]?.id || file.trackId;
        if (matchedTrack) matchedTrack.filePath = file.filePath;
        return {
          filePath: file.filePath,
          trackId,
        };
      });

      onProgress?.(60, `Decodificando ${filesToImport.length} pistas...`);
      const res: any = await invoke('audio_import_tracks', {
        projectId: project.id,
        files: filesToImport,
        targetSampleRate: null,
      });

      if (res?.tracks && res.tracks.length > 0) {
        onProgress?.(100, `¡Caché nativa generada para ${res.tracks.length} pistas!`);
        this.notifyCache();
        await this.checkProjectCacheStatus(project);
        return true;
      }

      throw new Error('No se generaron pistas en la caché.');
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error('[NativeAudioEngine] Error generando caché nativa:', err);
      onProgress?.(0, `Error: ${msg}`);
      this.onNoticeCallback?.(`Error al generar caché nativa: ${msg}`);
      return false;
    }
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
          quantizeMode: project.quantizeMode || '1-bar',
        });

        this.loadedProjectId = project.id;
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

  public getEffectiveEngineModeForProject(_song: SongProject): string {
    return 'stream';
  }

  public getProjectPcmEstimatedMB(song: SongProject): number {
    const frames = song.tracks.reduce((sum, t) => sum + (t.pcm?.frames || 0), 0);
    return Math.round((frames * 2) / (1024 * 1024));
  }

  public getEngineMode(): string {
    return 'stream';
  }

  public setEngineMode(_mode: string): void {}

  public getRamBudgetMB(): number {
    return 1024;
  }

  public setRamBudgetMB(_mb: number): void {}

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
