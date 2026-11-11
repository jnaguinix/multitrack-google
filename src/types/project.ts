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
  guideCuesEnabled: boolean;
  guideVoiceReadout: boolean;
  guideGain: number;
  guidePan?: number;
  masterGain: number;
  cueMasterGain?: number; // Master output gain for the Click / Cue bus ("Auriculares banda")
  pitchSemitones: number; // -6 to +6 semitones detune for stems
  isTitleCustom?: boolean;
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
}

export interface MetersSnapshot {
  tracks: Record<string, TrackMeterReading>;
  master: TrackMeterReading;
}

export type RemoteSyncMessage =
  | {
      type: 'STATE_SYNC';
      project?: Omit<SongProject, 'tracks'> & {
        tracks: Omit<TrackChannel, 'peaks'>[];
      };
      transport: TransportState;
    }
  | {
      type: 'TRANSPORT_SYNC';
      transport: TransportState;
    }
  | { type: 'CMD_PLAY_PAUSE' }
  | { type: 'CMD_STOP' }
  | { type: 'CMD_JUMP_SECTION'; sectionId: string }
  | { type: 'CMD_TOGGLE_VAMP' }
  | { type: 'CMD_TOGGLE_CLICK' }
  | { type: 'CMD_TOGGLE_GUIDE' }
  | { type: 'CMD_SET_QUANTIZE'; mode: QuantizeMode }
  | { type: 'CMD_SET_TRACK_MUTE'; trackId: string; muted: boolean }
  | { type: 'CMD_SET_TRACK_SOLO'; trackId: string; soloed: boolean }
  | { type: 'CMD_SET_TRACK_GAIN'; trackId: string; gain: number }
  | { type: 'CMD_SET_MASTER_GAIN'; gain: number }
  | { type: 'CMD_SET_CLICK_GAIN'; gain: number }
  | { type: 'CMD_SET_GUIDE_GAIN'; gain: number }
  | { type: 'CMD_NEXT_SONG' }
  | { type: 'CMD_PREV_SONG' }
  | { type: 'CMD_REQUEST_SYNC' };
