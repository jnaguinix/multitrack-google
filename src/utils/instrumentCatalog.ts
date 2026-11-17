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
  /** Secuencia completa con el click y la guía en el canal izquierdo y los instrumentos en el derecho. */
  splitSequence?: boolean;
  /** Aclaración que se muestra al elegirlo. */
  hint?: string;
}

/** Instrumentos normales, en orden alfabético (el que se ve en el selector). */
export const INSTRUMENTS: readonly InstrumentDef[] = [
  { id: 'bajo', label: 'Bajo', role: 'bass', color: '#DC2626' },
  { id: 'bateria', label: 'Batería', role: 'drums', color: '#D97706' },
  { id: 'guitarra', label: 'Guitarra', role: 'guitar', color: '#059669' },
  { id: 'loop', label: 'Loop', role: 'fx', color: '#64748B' },
  { id: 'metales', label: 'Metales', role: 'custom', color: '#CA8A04' },
  { id: 'organo', label: 'Órgano', role: 'keys', color: '#0E7490' },
  { id: 'otros', label: 'Otros', role: 'custom', color: '#737373' },
  { id: 'pad', label: 'Pad', role: 'synth', color: '#A855F7' },
  { id: 'percusion', label: 'Percusión', role: 'perc', color: '#EA580C' },
  { id: 'piano', label: 'Piano', role: 'keys', color: '#0891B2' },
  {
    id: 'secuencia',
    label: 'Secuencia',
    role: 'custom',
    color: '#14B8A6',
    splitSequence: true,
    hint: 'L: click y guía · R: música',
  },
  { id: 'strings', label: 'Strings', role: 'custom', color: '#7C3AED' },
  { id: 'voz', label: 'Voz', role: 'vox', color: '#DB2777' },
];

/**
 * Catálogo anterior (simplificado el 2026-11-17): Guitarra acústica y eléctrica son «Guitarra», Teclado es «Piano»,
 * «Sintetizador / Pad» es «Pad», «Cuerdas» es «Strings» y Voz Alto, Voz principal, Voz Soprano y Voz Tenor son «Voz».
 * Los ids y nombres viejos siguen reconociéndose: las
 * canciones y la memoria de mapeo ya guardadas se migran al cargarse.
 */
const LEGACY_ID: Readonly<Record<string, string>> = {
  'guitarra-acustica': 'guitarra',
  'guitarra-electrica': 'guitarra',
  teclado: 'piano',
  'sintetizador-pad': 'pad',
  cuerdas: 'strings',
  'voz-alto': 'voz',
  'voz-principal': 'voz',
  'voz-soprano': 'voz',
  'voz-tenor': 'voz',
};
const LEGACY_LABEL: Readonly<Record<string, string>> = {
  'Guitarra acústica': 'guitarra',
  'Guitarra eléctrica': 'guitarra',
  Teclado: 'piano',
  'Sintetizador / Pad': 'pad',
  Cuerdas: 'strings',
  'Voz Alto': 'voz',
  'Voz principal': 'voz',
  'Voz Soprano': 'voz',
  'Voz Tenor': 'voz',
};

/** Id actual del catálogo para un id guardado (resuelve los ids anteriores). */
export function canonicalInstrumentId(id: string | null | undefined): string | null {
  if (!id) return null;
  return LEGACY_ID[id] ?? id;
}

export const CLICK_INSTRUMENT: InstrumentDef = { id: 'click', label: 'Click', role: 'click', color: '#0891B2', fixed: true };
export const GUIDE_INSTRUMENT: InstrumentDef = { id: 'guia', label: 'Guía', role: 'guide', color: '#0284C7', fixed: true };

/** Click y Guía, fijos. */
export const FIXED_INSTRUMENTS: readonly InstrumentDef[] = [CLICK_INSTRUMENT, GUIDE_INSTRUMENT];
export const ALL_INSTRUMENTS: readonly InstrumentDef[] = [...INSTRUMENTS, ...FIXED_INSTRUMENTS];

const BY_ID = new Map(ALL_INSTRUMENTS.map((i) => [i.id, i] as const));

export function getInstrument(id: string | null | undefined): InstrumentDef | null {
  const canonical = canonicalInstrumentId(id);
  return canonical ? BY_ID.get(canonical) ?? null : null;
}

// ---------------------------------------------------------------------------------------------
// Nombres y numeración
// ---------------------------------------------------------------------------------------------

/**
 * Nombre final de cada pista. Si un instrumento se repite se numera por orden de aparición
 * («Guitarra 1», «Guitarra 2»); si aparece una sola vez, va sin número.
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
 * Instrumento del catálogo que corresponde a un nombre ya guardado («Guitarra 2» → `guitarra`).
 * Coincidencia exacta con la etiqueta (sin número final): sirve para volver a numerar al añadir pistas a una
 * canción o al reimportarla. Los nombres antiguos que no están en el catálogo devuelven `null`.
 */
export function instrumentIdFromName(name: string): string | null {
  const base = (name || '').replace(/\s+\d+$/, '').trim();
  const found = ALL_INSTRUMENTS.find((i) => i.label === base);
  return found ? found.id : LEGACY_LABEL[base] ?? null;
}

/**
 * Pasa los nombres de pista anteriores al catálogo actual y recalcula la numeración de cada instrumento
 * («Guitarra acústica», «Guitarra eléctrica 1» y «2» pasan a «Guitarra 1», «2» y «3»; «Teclado» pasa a «Piano»).
 * No toca los nombres que no son del catálogo («Click Track», «Voz»…) y es idempotente.
 */
export function migrateTrackNames<T extends { name: string }>(tracks: readonly T[]): T[] {
  const ids = tracks.map((t) => instrumentIdFromName(t.name));
  const names = numberedNames(ids);
  return tracks.map((t, i) => (ids[i] && names[i] && names[i] !== t.name ? { ...t, name: names[i] as string } : t));
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

/**
 * Bus que se envía al motor nativo. El motor distingue Click y Guía para poder sacarlos por salidas distintas
 * cuando el dispositivo tiene suficientes canales (`audio/routing.rs`).
 */
export function engineBus(t: TrackLike): 'main' | 'click' | 'guide' {
  if (isClickTrack(t)) return 'click';
  if (isGuideTrack(t)) return 'guide';
  return 'main';
}
