import { effectiveBus } from './instrumentCatalog';
import type { MetersSnapshot, SongProject, TransportState } from '../types/project';

const PEAK_FLOOR_DBFS = -60;

export function gainToDbLocal(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0) return -Infinity;
  return Math.round(200 * Math.log10(gain)) / 10;
}

/** Respuesta de las barras estimadas de salida: independiente del recorrido del fader. */
export function activityFromGain(gain: number): number {
  return Math.max(0, Math.min(1, (gainToDbLocal(gain) + 60) / 66));
}

/** Posición 0..1 de un nivel dBFS en la escala de los medidores. */
export function peakPosition(dbfs: number): number {
  return Math.max(0, Math.min(1, (dbfs - PEAK_FLOOR_DBFS) / -PEAK_FLOOR_DBFS));
}

export interface StripLevels {
  l: number;
  r: number;
}

export interface MixerLevels {
  click: StripLevels;
  main: StripLevels;
  cue: StripLevels;
  /** Con niveles nativos la escala es dBFS (zonas de color de los medidores de pista). */
  nativeScale: boolean;
}

/** Pico de una pista (0 si está atenuada o no se reproduce). */
export function trackPeak(
  project: SongProject,
  transport: TransportState,
  meters: MetersSnapshot,
  trackId: string
): number {
  const anySolo = project.tracks.some((t) => t.soloed);
  const trk = project.tracks.find((t) => t.id === trackId);
  if (!trk) return 0;
  const isDimmed = trk.muted || (anySolo && !trk.soloed);
  return !isDimmed && transport.isPlaying ? meters.tracks[trackId]?.peak ?? 0 : 0;
}

/** Posición 0..1 en la escala dBFS de un pico lineal (1.0 = 0 dBFS). */
function linearToPosition(x: number): number {
  return peakPosition(x > 0 ? 20 * Math.log10(x) : -Infinity);
}

/**
 * Medidor de una pista: izquierda y derecha en la escala dBFS (0 si está atenuada o no se reproduce). Si el motor
 * no informa los canales por separado, los dos muestran el pico.
 */
export function trackLevels(
  project: SongProject,
  transport: TransportState,
  meters: MetersSnapshot,
  trackId: string
): StripLevels {
  const peak = trackPeak(project, transport, meters, trackId);
  if (peak <= 0) return { l: 0, r: 0 };
  const reading = meters.tracks[trackId];
  const l = reading?.l ?? peak;
  const r = reading?.r ?? peak;
  return { l: linearToPosition(l), r: linearToPosition(r) };
}

/** Niveles de los cuatro buses: medidos en escritorio, estimados en la web. */
export function computeMixerLevels(
  project: SongProject,
  transport: TransportState,
  meters: MetersSnapshot
): MixerLevels {
  const anySolo = project.tracks.some((t) => t.soloed);
  let maxMainBusLevel = 0;
  let maxCueBusLevel = 0;

  for (const trk of project.tracks) {
    const isAudible = anySolo ? trk.soloed && !trk.muted : !trk.muted;
    const rawRms = isAudible && transport.isPlaying ? meters.tracks[trk.id]?.rms || 0 : 0;
    if (rawRms > 0) {
      const bus = effectiveBus(trk);
      if (bus === 'main') maxMainBusLevel = Math.max(maxMainBusLevel, rawRms);
      if (bus === 'cue-click') maxCueBusLevel = Math.max(maxCueBusLevel, rawRms);
    }
  }

  const beatDecay = transport.isPlaying ? Math.max(0, 1 - transport.beatProgress * 2.6) : 0;
  const clickStripLevel =
    transport.isPlaying && project.clickEnabled && !anySolo
      ? activityFromGain(project.clickGain) * (transport.currentBeat === 1 ? 0.86 : 0.65) * beatDecay
      : 0;
  maxCueBusLevel = Math.max(maxCueBusLevel, clickStripLevel);

  const cueMasterGain = project.cueMasterGain ?? 0.708; // -3.0 dB por defecto
  const mainBusOutLevel = transport.isPlaying
    ? Math.min(1, Math.max(maxMainBusLevel, meters.master.rms) * activityFromGain(project.masterGain) * 1.05)
    : 0;
  const cueBusOutLevel = transport.isPlaying
    ? Math.min(1, maxCueBusLevel * activityFromGain(cueMasterGain) * 1.05)
    : 0;

  const nb = transport.isPlaying ? meters.nativeBuses ?? null : null;
  const busPos = linearToPosition;
  const strip = (native: { l: number; r: number } | undefined, est: number, rFactor: number): StripLevels =>
    nb && native ? { l: busPos(native.l), r: busPos(native.r) } : { l: est, r: est * rFactor };

  return {
    click: strip(nb?.click, clickStripLevel, 0.96),
    main: strip(nb?.main, mainBusOutLevel, 0.95),
    cue: strip(nb?.cue, cueBusOutLevel, 0.95),
    nativeScale: Boolean(meters.nativeBuses),
  };
}
