/**
 * Datos de ejemplo de la vista previa en el navegador (solo desarrollo). No se incluyen en producción.
 */
import type { SongProject, SongSection, TrackChannel } from '../types/project';

const SAMPLE_RATE = 48000;

/** Generador pseudoaleatorio determinista (mulberry32): las ondas son iguales en cada recarga. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Envolvente normalizada 0..1 de `n` puntos, con "intensidad" distinta por sección. */
function makePeaks(seed: number, n: number, sections: SongSection[], duration: number, base: number): number[] {
  const r = rng(seed);
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * duration;
    const sec = sections.findIndex((s) => t >= s.startTimeSec && t < s.endTimeSec);
    const energy = sec < 0 ? 0.3 : 0.45 + 0.4 * ((sec * 37) % 7) / 6;
    const v = base * energy * (0.55 + 0.45 * r());
    peaks.push(Math.max(0.02, Math.min(1, v)));
  }
  return peaks;
}

const SECTION_COLORS = ['#06B6D4', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#EF4444'];

function makeSections(duration: number, names: [string, string][]): SongSection[] {
  const len = duration / names.length;
  return names.map(([name, code], i) => ({
    id: `sec-${code.toLowerCase()}-${i}`,
    name,
    code,
    color: SECTION_COLORS[i % SECTION_COLORS.length],
    startTimeSec: Math.round(i * len * 10) / 10,
    endTimeSec: Math.round((i + 1) * len * 10) / 10,
  }));
}

const TRACK_DEFS: { name: string; role: TrackChannel['role']; color: string; base: number }[] = [
  { name: 'Batería', role: 'drums', color: '#F59E0B', base: 0.95 },
  { name: 'Bajo', role: 'bass', color: '#3B82F6', base: 0.7 },
  { name: 'Teclado', role: 'keys', color: '#8B5CF6', base: 0.6 },
  { name: 'Guitarra 1', role: 'guitar', color: '#10B981', base: 0.65 },
  { name: 'Guitarra 2', role: 'guitar', color: '#06B6D4', base: 0.55 },
  { name: 'Synth', role: 'synth', color: '#EC4899', base: 0.5 },
  { name: 'Coros', role: 'vox', color: '#EF4444', base: 0.6 },
  { name: 'Voz', role: 'vox', color: '#F472B6', base: 0.8 },
];

function makeSong(opts: {
  id: string;
  title: string;
  artist: string;
  key: string;
  bpm: number;
  duration: number;
  order: number;
  tracks: number;
  sections: [string, string][];
}): SongProject {
  const sections = makeSections(opts.duration, opts.sections);
  const secPerBar = (60 / opts.bpm) * 4;
  const tracks: TrackChannel[] = TRACK_DEFS.slice(0, opts.tracks).map((d, i) => ({
    id: `${opts.id}-t${i + 1}`,
    name: d.name,
    role: d.role,
    color: d.color,
    gain: 1,
    pan: 0,
    muted: false,
    soloed: false,
    bus: 'main',
    peaks: makePeaks(opts.order * 100 + i, 320, sections, opts.duration, d.base),
    fileName: `${d.name}.wav`,
    durationSec: opts.duration,
  }));
  return {
    id: opts.id,
    title: opts.title,
    artist: opts.artist,
    folderPath: `C:\\Vista previa\\${opts.title}`,
    folder: 'imported',
    inSetlist: true,
    setlistOrder: opts.order,
    bpm: opts.bpm,
    beatsPerBar: 4,
    beatUnit: 4,
    keySignature: opts.key,
    totalBars: Math.ceil(opts.duration / secPerBar),
    durationSec: opts.duration,
    quantizeMode: 'section-end',
    splitRoutingMode: 'stereo',
    clickEnabled: false,
    clickGain: 1,
    clickSubdivision: 1,
    masterGain: 1,
    cueMasterGain: 0.708,
    pitchSemitones: 0,
    sections,
    tracks,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000 + opts.order,
  };
}

export function createSampleLibrary(): { version: number; updatedAt: number; activeSetlist: string[]; songs: SongProject[] } {
  const songs = [
    makeSong({
      id: 'demo-1', title: 'Sublime Gracia', artist: 'Vista previa', key: 'G', bpm: 72, duration: 260, order: 0, tracks: 8,
      sections: [['Intro', 'IN'], ['Verso 1', 'V1'], ['Coro', 'CO'], ['Verso 2', 'V2'], ['Coro', 'CO'], ['Puente', 'PU'], ['Coro', 'CO'], ['Final', 'FI']],
    }),
    makeSong({
      id: 'demo-2', title: 'Cuán Grande Es Él', artist: 'Vista previa', key: 'C', bpm: 66, duration: 300, order: 1, tracks: 6,
      sections: [['Intro', 'IN'], ['Estrofa', 'V1'], ['Coro', 'CO'], ['Estrofa', 'V2'], ['Coro', 'CO'], ['Final', 'FI']],
    }),
    makeSong({
      id: 'demo-3', title: 'Aleluya', artist: 'Vista previa', key: 'D', bpm: 120, duration: 210, order: 2, tracks: 3,
      sections: [['Intro', 'IN'], ['Verso', 'V1'], ['Coro', 'CO'], ['Final', 'FI']],
    }),
  ];
  // Sonoridad de ejemplo (en escritorio la mide el motor): una canción normal, otra más baja y otra más fuerte.
  const demoLoudness = (lufs: number, peak: number) => ({
    integratedLufs: lufs, loudnessRangeLu: 6.2, truePeakDbtp: peak, samplePeakDbfs: peak - 0.2,
    durationSec: 260, tracksMeasured: 6, signature: 'demo', referenceVersion: 1, analyzedAt: 1,
  });
  songs[0].loudness = demoLoudness(-14.1, -2.6);
  songs[1].loudness = demoLoudness(-19.4, -6.0);
  songs[2].loudness = demoLoudness(-11.2, 0.4);
  songs[2].masterGain = 0.9;
  return { version: 1, updatedAt: Date.now(), activeSetlist: songs.map((s) => s.id), songs };
}

export const PREVIEW_SAMPLE_RATE = SAMPLE_RATE;
