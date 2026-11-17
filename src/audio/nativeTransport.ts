// Del estado que informa el motor nativo (`audio_get_playback_state`) al estado de transporte de la interfaz.
import type { TransportState } from '../types/project';

/** Lo que hace falta del estado del motor para calcular el transporte. */
export interface TransportSnapshotFields {
  isPlaying: boolean;
  positionSec: number;
  durationSec: number;
  activeSectionId?: string | null;
  queuedSectionId?: string | null;
  isVamping?: boolean;
}

export const INITIAL_NATIVE_TRANSPORT: TransportState = {
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

/** Compás, pulso y avance del pulso a partir de la posición y el tempo de la canción (120 BPM y 4/4 si faltan). */
export function snapshotToTransport(
  pb: TransportSnapshotFields,
  bpm: number | undefined,
  beatsPerBar: number | undefined
): TransportState {
  const curSec = pb.positionSec;
  const secPerBeat = 60 / (bpm || 120);
  const bpb = beatsPerBar || 4;
  const totalBeats = curSec / secPerBeat;
  return {
    isPlaying: pb.isPlaying,
    currentTimeSec: curSec,
    totalDurationSec: pb.durationSec,
    currentBar: Math.floor(totalBeats / bpb) + 1,
    currentBeat: (Math.floor(totalBeats) % bpb) + 1,
    beatProgress: totalBeats - Math.floor(totalBeats),
    activeSectionId: pb.activeSectionId || null,
    queuedSectionId: pb.queuedSectionId || null,
    queuedTargetBar: null,
    countdownBeats: 0,
    isVamping: Boolean(pb.isVamping),
    lastCueMessage: null,
  };
}
