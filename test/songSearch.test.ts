import assert from 'node:assert/strict';
import { filterSongs, normalizeText } from '../src/utils/songSearch';

const songs = [
  { title: 'Dios el más grande', artist: 'Juan Carlos Alvarado', keySignature: 'C Major', bpm: 120 },
  { title: 'Eres Bendito', artist: 'Jaime Murrel', keySignature: 'G Major', bpm: 108 },
  { title: 'Friend of God', keySignature: 'C Major', bpm: 120 },
];

// 1. Sin acentos ni mayúsculas
assert.equal(normalizeText('ÁrtÍsta'), 'artista');
assert.deepEqual(filterSongs(songs, 'MAS').map((s) => s.title), ['Dios el más grande']);

// 2. Varias palabras: todas deben aparecer, en cualquier campo y orden
assert.deepEqual(filterSongs(songs, 'dios grande').map((s) => s.title), ['Dios el más grande']);
assert.deepEqual(filterSongs(songs, 'g 108').map((s) => s.title), ['Eres Bendito']);

// 3. Artista y BPM
assert.deepEqual(filterSongs(songs, 'murrel').map((s) => s.title), ['Eres Bendito']);
assert.equal(filterSongs(songs, '120').length, 2);

// 4. Búsqueda vacía devuelve todo (copia) y sin coincidencias devuelve vacío
const all = filterSongs(songs, '   ');
assert.equal(all.length, 3);
assert.notEqual(all, songs);
assert.equal(filterSongs(songs, 'zzz').length, 0);

console.log('songSearch: OK');
