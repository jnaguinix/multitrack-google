import type { PadHarmony, PadStyle, SongProject } from '../types/project';

export interface PadNoteOption {
  index: number;
  label: string;
  keySignature: string;
}

export const PAD_NOTES: readonly PadNoteOption[] = [
  { index: 0, label: 'C', keySignature: 'C' },
  { index: 1, label: 'C#', keySignature: 'C#' },
  { index: 2, label: 'D', keySignature: 'D' },
  { index: 3, label: 'Eb', keySignature: 'Eb' },
  { index: 4, label: 'E', keySignature: 'E' },
  { index: 5, label: 'F', keySignature: 'F' },
  { index: 6, label: 'F#', keySignature: 'F#' },
  { index: 7, label: 'G', keySignature: 'G' },
  { index: 8, label: 'Ab', keySignature: 'Ab' },
  { index: 9, label: 'A', keySignature: 'A' },
  { index: 10, label: 'Bb', keySignature: 'Bb' },
  { index: 11, label: 'B', keySignature: 'B' },
] as const;

export const CLICK_SUBDIVISION_OPTIONS: readonly {
  value: 1 | 2 | 4;
  badge: string;
  label: string;
  hint: string;
}[] = [
  { value: 1, badge: '×1', label: 'A tiempo', hint: 'Un pulso por tiempo (negras)' },
  { value: 2, badge: '×2', label: 'Doble', hint: 'Dos pulsos por tiempo (corcheas)' },
  { value: 4, badge: '×4', label: 'Cuádruple', hint: 'Cuatro pulsos por tiempo (semicorcheas)' },
] as const;

export const TIME_SIGNATURE_OPTIONS: readonly { beatsPerBar: number; beatUnit: number; label: string }[] = [
  { beatsPerBar: 2, beatUnit: 4, label: '2/4' },
  { beatsPerBar: 3, beatUnit: 4, label: '3/4' },
  { beatsPerBar: 4, beatUnit: 4, label: '4/4' },
  { beatsPerBar: 5, beatUnit: 4, label: '5/4' },
  { beatsPerBar: 6, beatUnit: 8, label: '6/8' },
] as const;

export const DEFAULT_PAD_GAIN = 0.85;

export const PAD_HARMONY_OPTIONS: readonly { value: PadHarmony; engine: number; label: string; hint: string }[] = [
  { value: 'open', engine: 0, label: 'Abierto', hint: 'Quinta y octava: funciona en mayor y menor' },
  { value: 'major', engine: 1, label: 'Mayor', hint: 'Añade novena y tercera mayor cálida' },
  { value: 'minor', engine: 2, label: 'Menor', hint: 'Añade tercera menor suave' },
] as const;

export const PAD_STYLE_OPTIONS: readonly { value: PadStyle; engine: number; label: string; hint: string }[] = [
  { value: 'warm', engine: 0, label: 'Cálido', hint: 'Redondo y profundo para toda la canción' },
  { value: 'shimmer', engine: 1, label: 'Ambiente', hint: 'Nube amplia con octava aérea y cola larga' },
  { value: 'strings', engine: 2, label: 'Cuerdas', hint: 'Más presencia en medios para llenar la banda' },
] as const;

export function normalizePadHarmony(value: string | undefined): PadHarmony {
  if (value === 'major' || value === 'minor') return value;
  return 'open';
}

export function normalizePadStyle(value: string | undefined): PadStyle {
  if (value === 'shimmer' || value === 'strings') return value;
  return 'warm';
}

export function padHarmonyToEngine(value: PadHarmony | undefined): number {
  return PAD_HARMONY_OPTIONS.find((o) => o.value === normalizePadHarmony(value))?.engine ?? 0;
}

export function padStyleToEngine(value: PadStyle | undefined): number {
  return PAD_STYLE_OPTIONS.find((o) => o.value === normalizePadStyle(value))?.engine ?? 0;
}

export function padHarmonyLabel(value: PadHarmony | undefined): string {
  return PAD_HARMONY_OPTIONS.find((o) => o.value === normalizePadHarmony(value))?.label ?? 'Abierto';
}

export function padStyleLabel(value: PadStyle | undefined): string {
  return PAD_STYLE_OPTIONS.find((o) => o.value === normalizePadStyle(value))?.label ?? 'Cálido';
}

export function isPadOnlySong(song: Pick<SongProject, 'padOnly'> | null | undefined): boolean {
  return Boolean(song?.padOnly);
}

/** Convierte un tono («G Major», «Bb», «F#m», «Am») al índice cromático 0..11 (`C = 0`). */
export function parseKeyToNoteIndex(keySignature: string | undefined): number {
  const trimmed = (keySignature ?? '').trim();
  if (!trimmed) return 0;
  const first = trimmed[0].toUpperCase();
  const baseMap: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const base = baseMap[first];
  if (base === undefined) return 0;
  const second = trimmed[1];
  const offset = second === '#' || second === '♯' ? 1 : second === 'b' || second === '♭' ? -1 : 0;
  return (((base + offset) % 12) + 12) % 12;
}

/** Nota real del pad tras sumar la transposición en semitonos. */
export function effectivePadNoteIndex(keySignature: string | undefined, pitchSemitones = 0): number {
  const base = parseKeyToNoteIndex(keySignature);
  const shift = Number.isFinite(pitchSemitones) ? Math.round(pitchSemitones) : 0;
  return (((base + shift) % 12) + 12) % 12;
}

export function noteIndexToLabel(noteIndex: number): string {
  const safe = (((Math.round(noteIndex) % 12) + 12) % 12);
  return PAD_NOTES[safe].label;
}

export function subdivisionBadge(subdivision: number | undefined): string {
  if (subdivision === 2) return '×2';
  if (subdivision === 4) return '×4';
  return '×1';
}

export function normalizeClickSubdivision(value: number | undefined): 1 | 2 | 4 {
  if (value === 2 || value === 4) return value;
  return 1;
}

/** Las canciones sin secuencia viven solo en el Setlist, no en la Biblioteca. */
export function filterLibrarySongs(songs: readonly SongProject[]): SongProject[] {
  return songs.filter((song) => !song.padOnly);
}

export interface PadEngineConfig {
  activeMode: boolean;
  enabled: boolean;
  note: number;
  gain: number;
  monitor: boolean;
  harmony: number;
  style: number;
}

export function padConfigFromProject(project: SongProject | null | undefined): PadEngineConfig {
  if (!project?.padOnly) {
    return { activeMode: false, enabled: false, note: 0, gain: 0, monitor: false, harmony: 0, style: 0 };
  }
  const gain = Number.isFinite(project.padGain) ? (project.padGain as number) : DEFAULT_PAD_GAIN;
  return {
    activeMode: true,
    enabled: project.padEnabled !== false,
    note: parseKeyToNoteIndex(project.keySignature),
    gain,
    monitor: Boolean(project.padMonitor),
    harmony: padHarmonyToEngine(project.padHarmony),
    style: padStyleToEngine(project.padStyle),
  };
}

export interface CreatePadSongParams {
  title: string;
  artist?: string;
  keySignature: string;
  bpm: number;
  beatsPerBar?: number;
  beatUnit?: number;
  clickSubdivision?: 1 | 2 | 4;
  padHarmony?: PadHarmony;
  padStyle?: PadStyle;
  setlistOrder?: number;
  id?: string;
  now?: number;
}

export function createPadOnlySong(params: CreatePadSongParams): SongProject {
  const now = params.now ?? Date.now();
  const safeBpm = Number.isFinite(params.bpm) ? Math.max(40, Math.min(240, Math.round(params.bpm))) : 120;
  const beatsPerBar = params.beatsPerBar && params.beatsPerBar >= 2 && params.beatsPerBar <= 12 ? Math.round(params.beatsPerBar) : 4;
  const beatUnit = params.beatUnit === 8 ? 8 : 4;
  const noteIdx = parseKeyToNoteIndex(params.keySignature);
  const cleanKey = noteIndexToLabel(noteIdx);

  return {
    id: params.id ?? `pad-${now}-${Math.random().toString(36).slice(2, 6)}`,
    title: params.title.trim() || `Pad en ${cleanKey}`,
    artist: params.artist?.trim() || 'Sin secuencia',
    inSetlist: true,
    setlistOrder: params.setlistOrder,
    bpm: safeBpm,
    beatsPerBar,
    beatUnit,
    keySignature: cleanKey,
    totalBars: 0,
    durationSec: 0,
    quantizeMode: 'immediate',
    splitRoutingMode: 'stereo',
    clickEnabled: true,
    clickGain: 0.9,
    clickSubdivision: normalizeClickSubdivision(params.clickSubdivision),
    masterGain: 1.0,
    cueMasterGain: 0.708,
    monitorGain: 1.0,
    pitchSemitones: 0,
    isTitleCustom: true,
    sections: [],
    tracks: [],
    padOnly: true,
    padEnabled: true,
    padGain: DEFAULT_PAD_GAIN,
    padMonitor: false,
    padHarmony: normalizePadHarmony(params.padHarmony),
    padStyle: normalizePadStyle(params.padStyle),
    createdAt: now,
    lastUsedAt: now,
    updatedAt: now,
  };
}
