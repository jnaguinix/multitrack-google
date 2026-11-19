export type QuantizeMode = '1-bar' | '2-bars' | 'section-end' | 'immediate';

export type OutputBus = 'main' | 'cue-click' | 'both';

export type SplitRoutingMode = 'stereo' | 'split-mono';

export type SetlistTransitionMode = 'stop' | 'cue-next' | 'auto-play';

export type AudioEngineMode = 'buffer' | 'stream';

export interface TrackPcmMetadata {
  sampleRate: number;
  channels: number;
  frames: number;
  version: 1;
}

export interface SongSection {
  id: string;
  name: string;
  code: string; // e.g., 'IN', 'V1', 'CO', 'PU', 'FI'
  color: string; // semantic studio hex color
  startTimeSec: number; // Start time in seconds (mm:ss)
  endTimeSec: number; // End time in seconds (mm:ss)
  startBar?: number; // Legacy/optional bar reference
  lengthBars?: number; // Legacy/optional bar length
  vampByDefault?: boolean;
  cueName?: string; // Spoken or synthesized guide cue label
}

export interface TrackChannel {
  id: string;
  name: string;
  role: 'drums' | 'bass' | 'keys' | 'guitar' | 'synth' | 'vox' | 'perc' | 'fx' | 'click' | 'guide' | 'custom';
  color: string;
  gain: number; // Linear amplitude gain. 0 = silence, 1 = 0 dB, ~3.1623 = +10 dB.
  pan: number; // -1.0 (L) to +1.0 (R)
  muted: boolean;
  soloed: boolean;
  /** «Aur.»: la pista, además de su salida normal, se oye en los auriculares (junto al click y la guía). */
  monitor?: boolean;
  /**
   * Secuencia dividida: un solo archivo con el click y la guía en el canal izquierdo y los instrumentos en el derecho.
   * El izquierdo va a auriculares (volumen y mute en el fader Click) y el derecho a la música (fader de la pista).
   */
  splitSequence?: boolean;
  /** Volumen del canal izquierdo (click y guía) de una secuencia dividida. */
  cueGain?: number;
  /** Mute del canal izquierdo (click y guía) de una secuencia dividida. */
  cueMuted?: boolean;
  bus: OutputBus;
  peaks: number[]; // Normalized 0..1 envelope peaks for canvas waveform rendering
  isCustomAudio?: boolean;
  fileName?: string;
  filePath?: string;
  fileSize?: number;
  durationSec?: number;
  pcm?: TrackPcmMetadata;
}

export type RepertoireFolder = 'imported' | 'setlist' | 'demos';

/**
 * Sonoridad (EBU R128) de la mezcla de referencia de una canción, medida por el motor en segundo plano: las pistas de
 * música a ganancia 1, sin click ni guía y sin volumen master (ese se aplica al mostrarla, ver `utils/loudness.ts`).
 */
export interface SongLoudness {
  /** LUFS integrados; `null` si la mezcla es silencio o dura menos de 400 ms. */
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  /** Pico real (True Peak) antes del limitador, en dBTP. */
  truePeakDbtp: number | null;
  samplePeakDbfs: number | null;
  durationSec: number;
  tracksMeasured: number;
  /** Qué caché y reparto de pistas se midió. */
  signature: string;
  referenceVersion: number;
  analyzedAt: number;
}

export interface SongProject {
  id: string;
  title: string;
  artist: string;
  folderPath?: string;
  folder?: RepertoireFolder;
  inSetlist?: boolean;
  setlistOrder?: number;
  bpm: number;
  beatsPerBar: number;
  beatUnit: number;
  keySignature: string;
  totalBars: number;
  durationSec?: number;
  quantizeMode: QuantizeMode;
  splitRoutingMode: SplitRoutingMode;
  clickEnabled: boolean;
  clickGain: number;
  clickPan?: number;
  clickSubdivision: 1 | 2; // 1 = quarter notes, 2 = eighth notes
  masterGain: number;
  /** Sonoridad medida por el motor (solo escritorio, en segundo plano). */
  loudness?: SongLoudness;
  cueMasterGain?: number; // Master output gain for the Click / Cue bus ("Auriculares banda")
  /** Volumen general de las pistas marcadas «Aur.» en los auriculares (1 = sin cambio). */
  monitorGain?: number;
  pitchSemitones: number; // -6 to +6 semitones detune for stems
  isTitleCustom?: boolean;
  /** Notas de la canción para el servicio (por ejemplo «entrar con el coro»). */
  notes?: string;
  /** Qué hacer al terminar esta canción (la flecha hacia la siguiente). Sin valor: el ajuste general. */
  transitionToNext?: SetlistTransitionMode;
  createdAt?: number;
  lastUsedAt?: number;
  sections: SongSection[];
  tracks: TrackChannel[];
  updatedAt: number;
}

export interface SongRamCacheInfo {
  cachedCount: number;
  totalCount: number;
  isReady: boolean;
  isPreloading: boolean;
  skippedByRamBudget?: boolean;
  cachedBytes?: number;
  estimatedBytes?: number;
}

export interface TransportState {
  isPlaying: boolean;
  isMountingSong?: boolean;
  mountingProgressText?: string | null;
  currentTimeSec: number;
  totalDurationSec: number;
  currentBar: number; // 1-indexed
  currentBeat: number; // 1-indexed (1..beatsPerBar)
  beatProgress: number; // 0..1 fractional progress within current beat
  activeSectionId: string | null;
  queuedSectionId: string | null;
  queuedTargetBar: number | null;
  countdownBeats: number;
  isVamping: boolean;
  lastCueMessage: string | null;
}

export interface TrackMeterReading {
  rms: number; // 0..1
  peak: number; // 0..1
  clipping: boolean;
  /** Pico de cada canal (0..1) cuando el motor los mide por separado; `peak` es el mayor de los dos. */
  l?: number;
  r?: number;
}

/** Niveles reales por bus del motor nativo (pico lineal con caída, 1.0 = 0 dBFS). */
export interface NativeBusLevels {
  main: { l: number; r: number };
  cue: { l: number; r: number };
  out: { l: number; r: number };
  click: { l: number; r: number };
  /** Envío a auriculares («Aur.»); ausente en motores antiguos. */
  monitor?: { l: number; r: number };
  clipping: boolean;
}

export interface MetersSnapshot {
  tracks: Record<string, TrackMeterReading>;
  master: TrackMeterReading;
  /** Solo en escritorio: niveles medidos por bus. Si falta, las vistas usan su estimación de siempre. */
  nativeBuses?: NativeBusLevels | null;
}
