import type { SongProject } from '../types/project';

export function getSongWaveformPeaks(project: SongProject | null, totalDurationSec?: number): number[] {
  if (!project || project.tracks.length === 0) return [];
  const numBuckets = 380;
  const anySolo = project.tracks.some((track) => track.soloed);
  const activeTracks = project.tracks.filter(
    (track) => track.role !== 'click' && track.role !== 'guide'
      && !track.muted && (!anySolo || track.soloed),
  );
  const tracks = activeTracks.length > 0 ? activeTracks : project.tracks;
  const divisor = Math.max(1, tracks.length * 0.65);
  return Array.from({ length: numBuckets }, (_, index) => {
    let sum = 0;
    for (const track of tracks) {
      if (!track.peaks?.length) continue;
      const relativeTime = totalDurationSec && track.durationSec
        ? (index / numBuckets) * (totalDurationSec / track.durationSec)
        : index / numBuckets;
      if (relativeTime >= 1) continue;
      const peakIndex = Math.floor(relativeTime * track.peaks.length);
      sum += (track.peaks[peakIndex] || 0) * track.gain;
    }
    return Math.min(1, sum / divisor);
  });
}

/** Lo mínimo que necesita el dibujo de una sección. */
export interface WaveSection {
  startTimeSec: number;
  endTimeSec: number;
  color?: string;
}

export interface WaveBarsOptions {
  /** Tamaño del dibujo en píxeles CSS (el contexto ya trae la escala de pantalla). */
  width: number;
  height: number;
  /** Picos de la mezcla (`getSongWaveformPeaks`), de 0 a 1. */
  peaks: ArrayLike<number>;
  sections: ReadonlyArray<WaveSection>;
  totalDurationSec: number;
  /** Franja vertical donde va la onda: arriba y abajo queda libre para los rótulos. */
  top: number;
  bottom: number;
  /** Color de las barras que no caen en ninguna sección. */
  fallbackColor?: string;
}

/**
 * Dibuja la onda del mapa de la canción: barras simétricas sobre el eje central, **cada una del color de su
 * sección**, normalizadas al pico más alto para ocupar toda la franja aunque la mezcla de varias pistas sea baja.
 * La usan el mapa del Setlist y el de En vivo, para que se vean igual.
 */
export function drawSectionWaveBars(ctx: CanvasRenderingContext2D, o: WaveBarsOptions): void {
  const { width, height, peaks, sections, totalDurationSec, top, bottom } = o;
  if (!width || !height || totalDurationSec <= 0 || peaks.length === 0) return;
  const barCount = Math.min(peaks.length, Math.max(1, Math.floor(width / 4)));
  const stepX = width / Math.max(1, barCount);
  const centerY = (top + bottom) / 2;
  const halfMax = Math.max(0, (bottom - top) / 2);
  let maxPeak = 0;
  for (let index = 0; index < peaks.length; index++) maxPeak = Math.max(maxPeak, peaks[index]);
  const norm = maxPeak > 0 ? 1 / maxPeak : 1;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.5, Math.min(3, stepX * 0.62));
  ctx.globalAlpha = 1;
  for (let i = 0; i < barCount; i++) {
    const first = Math.floor((i * peaks.length) / barCount);
    const last = Math.max(first + 1, Math.floor(((i + 1) * peaks.length) / barCount));
    let peak = 0;
    for (let index = first; index < last; index++) peak = Math.max(peak, peaks[index] ?? 0);
    const half = Math.max(1.5, Math.sqrt(peak * norm) * halfMax);
    const seconds = ((i + 0.5) / barCount) * totalDurationSec;
    const section = sections.find((item) => item.startTimeSec <= seconds && seconds < item.endTimeSec);
    const x = (i + 0.5) * stepX;
    ctx.strokeStyle = section?.color || o.fallbackColor || '#F5F5F3';
    ctx.beginPath();
    ctx.moveTo(x, centerY - half);
    ctx.lineTo(x, centerY + half);
    ctx.stroke();
  }
  ctx.restore();
}
