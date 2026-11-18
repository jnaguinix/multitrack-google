/**
 * Sonoridad de las canciones (EBU R128) tal como llega del motor y cómo se presenta. El motor mide la mezcla de
 * referencia (pistas de Main a ganancia 1, sin volumen master); el master de la canción es un factor lineal posterior
 * a la suma, así que desplaza la sonoridad y el pico exactamente en 20·log10(master) dB y se aplica aquí, sin volver a
 * analizar cuando se mueve.
 */
import type { SongLoudness, SongProject } from '../types/project';

/** A partir de esta diferencia (en dB) con el resto del setlist se avisa de que se notaría el salto de volumen. */
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
  /** Lo que se lee en la ficha: «Parecida al resto», «Más fuerte», «Más suave» o, sin con qué comparar, «Volumen −14,1». */
  text: string;
  /** Cuánto se aleja del resto del setlist («+2,0 dB»), o `null` si es parecida o no hay con qué comparar. */
  delta: string | null;
  /** `warn` si se aleja ≥ 2 dB del resto del setlist: se notaría el salto de volumen entre canciones. */
  tone: 'ok' | 'warn';
  /** Explicación para quien no es técnico (tooltip): frases normales, sin siglas. */
  title: string;
}

/** A partir de esta diferencia (en dB, como los faders) se considera que suena distinto al resto. */
export const LOUDNESS_SIMILAR_DB = 1;

/** Rango de sonoridad (en LU, que son dB) desde el que se avisa de que la canción sube y baja mucho. */
const WIDE_RANGE_LU = 12;

/**
 * Cómo se muestra la sonoridad de una canción respecto al setlist, o `null` si no hay medida. Todo el texto está
 * pensado para alguien que no sabe de audio: nada de siglas (LUFS, LU, dBTP) ni de términos del estándar.
 */
export function describeLoudness(song: Pick<SongProject, 'loudness' | 'masterGain'>, reference: number | null): LoudnessLabel | null {
  const lufs = playedLufs(song);
  if (lufs === null) return null;
  const l = song.loudness as SongLoudness;
  // Se decide con el valor que se ve (un decimal): un «+2,0» no puede quedar sin avisar por ser 1,985.
  const diff = reference === null ? null : Math.round((lufs - reference) * 10) / 10;
  const peak = playedTruePeak(song);
  const master = masterGainDb(song.masterGain);
  const warn = diff !== null && Math.abs(diff) >= LOUDNESS_WARN_LU;

  let text: string;
  let delta: string | null = null;
  let summary: string;
  if (diff === null) {
    text = `Volumen ${formatLu(lufs)}`;
    summary = 'Todavía no hay otra canción medida con la que compararla.';
  } else if (Math.abs(diff) < LOUDNESS_SIMILAR_DB) {
    text = 'Parecida al resto';
    summary = 'Suena parecido al resto del Setlist: no se notará un cambio de volumen.';
  } else {
    const louder = diff > 0;
    text = louder ? 'Más fuerte' : 'Más suave';
    delta = `${formatLu(diff, true)} dB`;
    summary = `Suena ${formatLu(Math.abs(diff))} dB ${louder ? 'más fuerte' : 'más suave'} que el resto del Setlist.`;
  }

  const lines = [summary];
  if (warn) lines.push('Se notará el cambio de volumen al pasar de una canción a otra.');
  lines.push(`Volumen medio: ${formatLu(lufs)} (cuanto más cerca de 0, más fuerte).`);
  if (Math.abs(master) >= 0.05) lines.push(`Incluye el volumen general que le pusiste (${formatLu(master, true)} dB).`);
  if (finite(l.loudnessRangeLu) && l.loudnessRangeLu >= WIDE_RANGE_LU) {
    lines.push('Tiene partes muy suaves y otras muy fuertes: el volumen sube y baja bastante.');
  }
  if (peak !== null && peak > LIMITER_ENGAGE_DBFS) {
    lines.push('Sus golpes más fuertes pasan el máximo y el limitador los recorta un poco. Si suena apretado, baja el volumen general de la canción.');
  }
  lines.push('Se mide con las pistas de música, sin click ni guía.');

  return { text, delta, tone: warn ? 'warn' : 'ok', title: lines.join('\n') };
}

/** Pone la sonoridad medida por el motor en la canción; el mismo objeto si no cambia nada (no se renderiza de más). */
export function withLoudness<T extends Pick<SongProject, 'id' | 'loudness'>>(song: T, projectId: string, loudness: SongLoudness): T {
  if (song.id !== projectId || song.loudness?.signature === loudness.signature && song.loudness?.analyzedAt === loudness.analyzedAt) {
    return song;
  }
  return { ...song, loudness };
}
