/**
 * Sonoridad de las canciones (EBU R128) tal como llega del motor y cómo se presenta. El motor mide la mezcla de
 * referencia (pistas de Main a ganancia 1, sin volumen master); el master de la canción es un factor lineal posterior
 * a la suma, así que desplaza la sonoridad y el pico exactamente en 20·log10(master) dB y se aplica aquí, sin volver a
 * analizar cuando se mueve.
 */
import type { SongLoudness, SongProject } from '../types/project';

/** A partir de esta diferencia con el resto del setlist se avisa (LU: 1 LU = 1 dB de sonoridad). */
export const LOUDNESS_WARN_LU = 2;

/** Nivel de pico (dBFS) en el que empieza a actuar el limitador suave del motor (knee 0,9 lineal). */
export const LIMITER_ENGAGE_DBFS = 20 * Math.log10(0.9);

/** Decibelios de un factor lineal. Un factor no válido (0, negativo, NaN) se trata como 1 (sin cambio). */
export function masterGainDb(gain: number | undefined): number {
  return typeof gain === 'number' && Number.isFinite(gain) && gain > 0 ? 20 * Math.log10(gain) : 0;
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Sonoridad integrada con la que suena la canción (referencia + volumen master), o `null` si no se midió. */
export function playedLufs(song: Pick<SongProject, 'loudness' | 'masterGain'>): number | null {
  const l = song.loudness?.integratedLufs;
  return finite(l) ? l + masterGainDb(song.masterGain) : null;
}

/** Pico real con el que suena la canción antes del limitador, o `null` si no se midió. */
export function playedTruePeak(song: Pick<SongProject, 'loudness' | 'masterGain'>): number | null {
  const p = song.loudness?.truePeakDbtp;
  return finite(p) ? p + masterGainDb(song.masterGain) : null;
}

/**
 * Sonoridad de referencia del setlist: la mediana de lo que suena cada canción (una canción muy fuerte o muy baja no
 * la desplaza). Hace falta medir al menos dos canciones; con una no hay con qué comparar.
 */
export function setlistReferenceLufs(songs: ReadonlyArray<Pick<SongProject, 'loudness' | 'masterGain'>>): number | null {
  const values = songs.map(playedLufs).filter(finite).sort((a, b) => a - b);
  if (values.length < 2) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/** Número con coma decimal y el signo menos tipográfico («−13,4»); `signed` añade «+» a los positivos. */
export function formatLu(value: number, signed = false): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Math.abs(rounded).toFixed(1).replace('.', ',');
  if (rounded < 0) return `−${text}`;
  if (rounded === 0) return text;
  return signed ? `+${text}` : text;
}

export interface LoudnessLabel {
  /** «−13,4 LUFS». */
  text: string;
  /** Diferencia con el setlist («+2,1») o `null` si no hay con qué comparar o es 0. */
  delta: string | null;
  /** `warn` si se aleja ≥ 2 LU del resto del setlist. */
  tone: 'ok' | 'warn';
  /** Detalle para el tooltip. */
  title: string;
}

/** Cómo se muestra la sonoridad de una canción respecto al setlist, o `null` si no hay medida. */
export function describeLoudness(song: Pick<SongProject, 'loudness' | 'masterGain'>, reference: number | null): LoudnessLabel | null {
  const lufs = playedLufs(song);
  if (lufs === null) return null;
  const l = song.loudness as SongLoudness;
  const delta = reference === null ? null : lufs - reference;
  const showDelta = delta !== null && Math.round(delta * 10) !== 0;
  const peak = playedTruePeak(song);
  const master = masterGainDb(song.masterGain);

  const lines = [`Sonoridad integrada: ${formatLu(lufs)} LUFS${Math.abs(master) >= 0.05 ? ` (con tu volumen master, ${formatLu(master, true)} dB)` : ''}`];
  if (delta !== null) lines.push(`Frente al resto del setlist: ${formatLu(delta, true)} LU`);
  if (finite(l.loudnessRangeLu)) lines.push(`Rango de sonoridad: ${formatLu(l.loudnessRangeLu)} LU`);
  if (peak !== null) {
    lines.push(`Pico real: ${formatLu(peak)} dBTP${peak > LIMITER_ENGAGE_DBFS ? ' · el limitador actuará en los picos' : ''}`);
  }
  lines.push('Mezcla de las pistas de música a ganancia 1, sin click ni guía.');

  return {
    text: `${formatLu(lufs)} LUFS`,
    delta: showDelta ? formatLu(delta as number, true) : null,
    // Se decide con el valor que se ve (un decimal): un «+2,0» no puede quedar sin avisar por ser 1,985.
    tone: delta !== null && Math.abs(Math.round(delta * 10) / 10) >= LOUDNESS_WARN_LU ? 'warn' : 'ok',
    title: lines.join('\n'),
  };
}

/** Pone la sonoridad medida por el motor en la canción; el mismo objeto si no cambia nada (no se renderiza de más). */
export function withLoudness<T extends Pick<SongProject, 'id' | 'loudness'>>(song: T, projectId: string, loudness: SongLoudness): T {
  if (song.id !== projectId || song.loudness?.signature === loudness.signature && song.loudness?.analyzedAt === loudness.analyzedAt) {
    return song;
  }
  return { ...song, loudness };
}
