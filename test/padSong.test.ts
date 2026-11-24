import assert from 'node:assert/strict';
import {
  createPadOnlySong,
  DEFAULT_PAD_GAIN,
  effectivePadNoteIndex,
  filterLibrarySongs,
  isPadOnlySong,
  normalizePadHarmony,
  normalizePadStyle,
  noteIndexToLabel,
  padConfigFromProject,
  padHarmonyLabel,
  padHarmonyToEngine,
  padStyleLabel,
  padStyleToEngine,
  parseKeyToNoteIndex,
  subdivisionBadge,
} from '../src/utils/padSong';
import type { SongProject } from '../src/types/project';

// 1. Parseo de notas (naturales, sostenidos, bemoles, mayores y menores)
assert.equal(parseKeyToNoteIndex('C'), 0);
assert.equal(parseKeyToNoteIndex('C# Major'), 1);
assert.equal(parseKeyToNoteIndex('Db'), 1);
assert.equal(parseKeyToNoteIndex('Eb'), 3);
assert.equal(parseKeyToNoteIndex('F#m'), 6);
assert.equal(parseKeyToNoteIndex('G Major'), 7);
assert.equal(parseKeyToNoteIndex('Am'), 9);
assert.equal(parseKeyToNoteIndex('Bb'), 10);
assert.equal(parseKeyToNoteIndex('B'), 11);
assert.equal(parseKeyToNoteIndex(''), 0);

// 2. Transposición de la nota real
assert.equal(effectivePadNoteIndex('G', 2), 9); // G + 2 = A
assert.equal(effectivePadNoteIndex('C', -1), 11); // C - 1 = B
assert.equal(noteIndexToLabel(effectivePadNoteIndex('Bb', 2)), 'C');

// 3. Creación de canción sin secuencia
const padSong = createPadOnlySong({
  id: 'pad-1',
  title: 'Espíritu Santo',
  keySignature: 'G Major',
  bpm: 72,
  beatsPerBar: 4,
  clickSubdivision: 2,
  setlistOrder: 3,
  now: 123456,
});

assert.equal(isPadOnlySong(padSong), true);
assert.equal(padSong.tracks.length, 0);
assert.equal(padSong.sections.length, 0);
assert.equal(padSong.durationSec, 0);
assert.equal(padSong.keySignature, 'G');
assert.equal(padSong.bpm, 72);
assert.equal(padSong.clickSubdivision, 2);
assert.equal(padSong.inSetlist, true);
assert.equal(padSong.setlistOrder, 3);
assert.equal(padSong.padEnabled, true);
assert.equal(padSong.padGain, DEFAULT_PAD_GAIN);
assert.equal(padSong.padHarmony, 'open');
assert.equal(padSong.padStyle, 'warm');
assert.equal(subdivisionBadge(padSong.clickSubdivision), '×2');
assert.equal(subdivisionBadge(4), '×4');
assert.equal(subdivisionBadge(1), '×1');

// 3b. Armonía y timbre del pad
assert.equal(normalizePadHarmony(undefined), 'open');
assert.equal(normalizePadHarmony('minor'), 'minor');
assert.equal(normalizePadStyle('shimmer'), 'shimmer');
assert.equal(padHarmonyToEngine('major'), 1);
assert.equal(padHarmonyToEngine('minor'), 2);
assert.equal(padStyleToEngine('strings'), 2);
assert.equal(padHarmonyLabel('minor'), 'Menor');
assert.equal(padStyleLabel('shimmer'), 'Ambiente');

// 4. Configuración para el motor
const cfg = padConfigFromProject(padSong);
assert.deepEqual(cfg, {
  activeMode: true,
  enabled: true,
  note: 7,
  gain: DEFAULT_PAD_GAIN,
  monitor: false,
  harmony: 0,
  style: 0,
});

const shimmerMajorSong = createPadOnlySong({
  id: 'pad-2',
  title: 'Digno',
  keySignature: 'Bb',
  bpm: 68,
  padHarmony: 'major',
  padStyle: 'shimmer',
  now: 123457,
});
assert.deepEqual(padConfigFromProject(shimmerMajorSong), {
  activeMode: true,
  enabled: true,
  note: 10,
  gain: DEFAULT_PAD_GAIN,
  monitor: false,
  harmony: 1,
  style: 1,
});

const normalSong: SongProject = {
  ...padSong,
  id: 'normal-1',
  title: 'Canción Normal',
  padOnly: undefined,
};
assert.equal(isPadOnlySong(normalSong), false);
assert.deepEqual(padConfigFromProject(normalSong), {
  activeMode: false,
  enabled: false,
  note: 0,
  gain: 0,
  monitor: false,
  harmony: 0,
  style: 0,
});

assert.equal(padSong.padPackId, null, 'por defecto una canción sin secuencia arranca con sintetizador interno');
const packSong = createPadOnlySong({
  id: 'pad-pack-1',
  title: 'Gloria',
  keySignature: 'D',
  bpm: 70,
  padPackId: 'pack-warm-01',
  now: 123458,
});
assert.equal(packSong.padPackId, 'pack-warm-01', 'debe conservar el pack elegido al crear la canción');

// 5. Exclusión de la biblioteca: las canciones sin secuencia no salen en Biblioteca
const visible = filterLibrarySongs([padSong, normalSong]);
assert.deepEqual(
  visible.map((s) => s.id),
  ['normal-1'],
  'las canciones sin secuencia deben quedar fuera de la Biblioteca'
);

console.log('padSong.test.ts OK');
