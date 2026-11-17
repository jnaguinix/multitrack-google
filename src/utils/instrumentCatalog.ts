/**
 * Catálogo de instrumentos de OmniTracks.
 *
 * Los archivos de un multitrack traen nombres imposibles de normalizar de forma fiable («Diosesamorf#-bajo-Bb-
 * multitrack»). En lugar de adivinarlos, el asistente de importación hace que el usuario elija a mano de esta
 * lista cerrada. El nombre del catálogo es el que se guarda en la canción y el que se muestra en la app; el
 * nombre del archivo solo se conserva por dentro (`fileName` / `filePath`) para reproducir y reimportar.
 */
import type { OutputBus, TrackChannel } from '../types/project';

export type InstrumentRole = TrackChannel['role'];

export interface InstrumentDef {
  id: string;
  label: string;
  role: InstrumentRole;
  color: string;
  /** Click y Guía: salen por el bus Cue (auriculares) y van fijos a la derecha de la mezcla. */
  fixed?: boolean;
}

/** Instrumentos normales, en orden alfabético (el que se ve en el selector). */
export const INSTRUMENTS: readonly InstrumentDef[] = [
  { id: 'bajo', label: 'Bajo', role: 'bass', color: '#DC2626' },
  { id: 'bateria', label: 'Batería', role: 'drums', color: '#D97706' },
  { id: 'cuerdas', label: 'Cuerdas', role: 'custom', color: '#7C3AED' },
  { id: 'guitarra-acustica', label: 'Guitarra acústica', role: 'guitar', color: '#65A30D' },
  { id: 'guitarra-electrica', label: 'Guitarra eléctrica', role: 'guitar', color: '#059669' },
  { id: 'loop', label: 'Loop', role: 'fx', color: '#64748B' },
  { id: 'metales', label: 'Metales', role: 'custom', color: '#CA8A04' },
  { id: 'organo', label: 'Órgano', role: 'keys', color: '#0E7490' },
  { id: 'percusion', label: 'Percusión', role: 'perc', color: '#EA580C' },
  { id: 'piano', label: 'Piano', role: 'keys', color: '#0891B2' },
  { id: 'sintetizador-pad', label: 'Sintetizador / Pad', role: 'synth', color: '#A855F7' },
  { id: 'teclado', label: 'Teclado', role: 'keys', color: '#2563EB' },
  { id: 'voz-alto', label: 'Voz Alto', role: 'vox', color: '#BE185D' },
  { id: 'voz-principal', label: 'Voz principal', role: 'vox', color: '#DB2777' },
  { id: 'voz-soprano', label: 'Voz Soprano', role: 'vox', color: '#E11D48' },
  { id: 'voz-tenor', label: 'Voz Tenor', role: 'vox', color: '#9D174D' },
];

export const CLICK_INSTRUMENT: InstrumentDef = { id: 'click', label: 'Click', role: 'click', color: '#0891B2', fixed: true };
export const GUIDE_INSTRUMENT: InstrumentDef = { id: 'guia', label: 'Guía', role: 'guide', color: '#0284C7', fixed: true };

/** Click y Guía, fijos. */
export const FIXED_INSTRUMENTS: readonly InstrumentDef[] = [CLICK_INSTRUMENT, GUIDE_INSTRUMENT];
export const ALL_INSTRUMENTS: readonly InstrumentDef[] = [...INSTRUMENTS, ...FIXED_INSTRUMENTS];

const BY_ID = new Map(ALL_INSTRUMENTS.map((i) => [i.id, i] as const));

export function getInstrument(id: string | null | undefined): InstrumentDef | null {
  return id ? BY_ID.get(id) ?? null : null;
}

// ---------------------------------------------------------------------------------------------
// Nombres y numeración
// ---------------------------------------------------------------------------------------------

/**
 * Nombre final de cada pista. Si un instrumento se repite se numera por orden de aparición
 * («Guitarra eléctrica 1», «Guitarra eléctrica 2»); si aparece una sola vez, va sin número.
 * `null` (pista ignorada) devuelve `null` y no cuenta.
 */
export function numberedNames(instrumentIds: ReadonlyArray<string | null>): Array<string | null> {
  const totals = new Map<string, number>();
  for (const id of instrumentIds) {
    if (id) totals.set(id, (totals.get(id) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return instrumentIds.map((id) => {
    const def = getInstrument(id);
    if (!id || !def) return null;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return (totals.get(id) ?? 1) > 1 ? `${def.label} ${n}` : def.label;
  });
}

/**
 * Instrumento del catálogo que corresponde a un nombre ya guardado («Guitarra eléctrica 2» → `guitarra-electrica`).
 * Coincidencia exacta con la etiqueta (sin número final): sirve para volver a numerar al añadir pistas a una
 * canción o al reimportarla. Los nombres antiguos que no están en el catálogo devuelven `null`.
 */
export function instrumentIdFromName(name: string): string | null {
  const base = (name || '').replace(/\s+\d+$/, '').trim();
  const found = ALL_INSTRUMENTS.find((i) => i.label === base);
  return found ? found.id : null;
}

// ---------------------------------------------------------------------------------------------
// Orden y clasificación
// ---------------------------------------------------------------------------------------------

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Orden alfabético en español con números naturales: «Guitarra 2» va antes que «Guitarra 10». */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

type TrackLike = Pick<TrackChannel, 'name' | 'role'>;

const norm = (s: string) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/** Canciones importadas antes del catálogo: el rol puede ser `custom` aunque el nombre sea «Click Track». */
export function isClickTrack(t: TrackLike): boolean {
  if (t.role === 'click') return true;
  const n = norm(t.name);
  return n.includes('click') || n.includes('metro');
}

export function isGuideTrack(t: TrackLike): boolean {
  if (t.role === 'guide') return true;
  const n = norm(t.name);
  return n === 'cues' || n === 'cue' || n === 'guide' || n === 'guia' || n.startsWith('guia ') || n.startsWith('guide ');
}

/** Pistas «normales»: las que van en la lista alfabética (Click y Guía van aparte, fijos). */
export function isInstrumentTrack(t: TrackLike): boolean {
  return !isClickTrack(t) && !isGuideTrack(t);
}

export function sortInstrumentTracks<T extends TrackLike>(tracks: readonly T[]): T[] {
  return tracks.filter(isInstrumentTrack).sort((a, b) => compareNames(a.name, b.name));
}

/** Orden de Arreglo: instrumentos en orden alfabético y, al final, Click y Guía. */
export function orderTracksForDisplay<T extends TrackLike>(tracks: readonly T[]): T[] {
  return [
    ...sortInstrumentTracks(tracks),
    ...tracks.filter((t) => isClickTrack(t)),
    ...tracks.filter((t) => !isClickTrack(t) && isGuideTrack(t)),
  ];
}

/**
 * Bus real de una pista. Los instrumentos van siempre a Main y solo Click y Guía a Cue (auriculares): la
 * interfaz ya no deja elegir el ruteo por pista, y lo guardado en canciones anteriores se normaliza aquí.
 */
export function effectiveBus(t: TrackLike): OutputBus {
  return isClickTrack(t) || isGuideTrack(t) ? 'cue-click' : 'main';
}
