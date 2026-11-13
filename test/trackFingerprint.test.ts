import { findSongFingerprintMatches } from '../src/audio/fingerprint';
import { SongProject } from '../src/types/project';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

console.log('=== PRUEBAS UNITARIAS: Huella de Pistas (Fingerprint) ===');

const baseSong: SongProject = {
  id: 'song-original',
  title: 'Eres Bendito',
  artist: 'Jaime Murrel',
  bpm: 108,
  beatsPerBar: 4,
  beatUnit: 4,
  keySignature: 'G Major',
  totalBars: 120,
  durationSec: 250,
  quantizeMode: '1-bar',
  splitRoutingMode: 'stereo',
  clickEnabled: false,
  clickGain: 1,
  clickSubdivision: 1,
  guideCuesEnabled: true,
  guideVoiceReadout: true,
  guideGain: 1,
  masterGain: 1,
  pitchSemitones: 0,
  sections: [],
  updatedAt: Date.now(),
  tracks: [
    { id: 't1', name: 'Drums', role: 'drums', color: '#ff0', gain: 1, pan: 0, muted: false, soloed: false, bus: 'main', peaks: [], fileSize: 10000000, durationSec: 250.2 },
    { id: 't2', name: 'Bass', role: 'bass', color: '#0f0', gain: 1, pan: 0, muted: false, soloed: false, bus: 'main', peaks: [], fileSize: 8000000, durationSec: 250.2 },
    { id: 't3', name: 'Acoustic', role: 'guitar', color: '#00f', gain: 1, pan: 0, muted: false, soloed: false, bus: 'main', peaks: [], fileSize: 9000000, durationSec: 250.1 },
    { id: 't4', name: 'Electric', role: 'guitar', color: '#00f', gain: 1, pan: 0, muted: false, soloed: false, bus: 'main', peaks: [], fileSize: 9500000, durationSec: 250.2 },
    { id: 't5', name: 'Keys', role: 'keys', color: '#f0f', gain: 1, pan: 0, muted: false, soloed: false, bus: 'main', peaks: [], fileSize: 11000000, durationSec: 250.3 },
    { id: 't6', name: 'Pad', role: 'synth', color: '#f0f', gain: 1, pan: 0, muted: false, soloed: false, bus: 'main', peaks: [], fileSize: 10500000, durationSec: 250.2 },
    { id: 't7', name: 'Lead Vox', role: 'vox', color: '#f00', gain: 1, pan: 0, muted: false, soloed: false, bus: 'main', peaks: [], fileSize: 12000000, durationSec: 248.5 },
  ],
};

// Test 1: Renamed files (same 7 tracks, all sizes and durations match 100%)
const renamedFiles = [
  { name: '01_Bateria.mp3', fileSize: 10000000, durationSec: 250.2 },
  { name: '02_Bajo.mp3', fileSize: 8000000, durationSec: 250.2 },
  { name: '03_Acustica.mp3', fileSize: 9000000, durationSec: 250.1 },
  { name: '04_Electrica.mp3', fileSize: 9500000, durationSec: 250.2 },
  { name: '05_Piano.mp3', fileSize: 11000000, durationSec: 250.3 },
  { name: '06_Sintetizador.mp3', fileSize: 10500000, durationSec: 250.2 },
  { name: '07_Voz.mp3', fileSize: 12000000, durationSec: 248.5 },
];
const res1 = findSongFingerprintMatches(renamedFiles, [baseSong]);
console.log('Test 1 (100% coincidencia con archivos renombrados):', res1.length, res1[0]?.matchRatio);
assert(res1.length === 1, 'Debe encontrar 1 candidata');
assert(res1[0].matchRatio === 1.0, 'Coincidencia debe ser 100%');
console.log('✔ Test 1 PASADO');

// Test 2: ±1 track difference (6 of 7 tracks match = 85.7% >= 80%)
const minusOneTrack = renamedFiles.slice(0, 6);
const res2 = findSongFingerprintMatches(minusOneTrack, [baseSong]);
console.log('Test 2 (6 de 7 pistas coinciden, ±1 pista):', res2.length, res2[0]?.matchRatio);
assert(res2.length === 1, 'Debe encontrar 1 candidata');
assert(res2[0].matchRatio >= 0.80, 'Coincidencia debe ser >= 80%');
console.log('✔ Test 2 PASADO');

// Test 3: Less than 80% match (4 of 7 tracks match = 57.1% < 80%)
const belowThreshold = renamedFiles.slice(0, 4);
const res3 = findSongFingerprintMatches(belowThreshold, [baseSong]);
console.log('Test 3 (4 de 7 pistas coinciden, diferencia > 1 pista):', res3.length);
assert(res3.length === 0, 'No debe coincidir si track count excede ±1 o ratio < 80%');
console.log('✔ Test 3 PASADO');

// Test 4: Different song with 7 tracks but different lengths
const differentSongTracks = [
  { name: 'trk1.mp3', fileSize: 4000000, durationSec: 180 },
  { name: 'trk2.mp3', fileSize: 4200000, durationSec: 180 },
  { name: 'trk3.mp3', fileSize: 4100000, durationSec: 180 },
  { name: 'trk4.mp3', fileSize: 4300000, durationSec: 180 },
  { name: 'trk5.mp3', fileSize: 4000000, durationSec: 180 },
  { name: 'trk6.mp3', fileSize: 4500000, durationSec: 180 },
  { name: 'trk7.mp3', fileSize: 4600000, durationSec: 180 },
];
const res4 = findSongFingerprintMatches(differentSongTracks, [baseSong]);
console.log('Test 4 (Canción diferente con 7 pistas):', res4.length);
assert(res4.length === 0, 'No debe coincidir con canción distinta');
console.log('✔ Test 4 PASADO');

// Test 5 (a): Escaneo sin duración (MP3/FLAC/WAV extendido), misma carpeta -> 1 candidata
const scanNoDuration = baseSong.tracks.map((t) => ({
  name: t.name,
  fileSize: t.fileSize,
  durationSec: undefined, // El escaneo rápido no pudo extraer duración
}));
const res5 = findSongFingerprintMatches(scanNoDuration, [baseSong]);
console.log('Test 5 (a - Escaneo sin duración, misma carpeta):', res5.length, res5[0]?.matchRatio);
assert(res5.length === 1, 'Debe encontrar exactamente 1 candidata aunque falte la duración en el escaneo');
assert(res5[0].matchRatio === 1.0, 'Coincidencia por tamaño debe ser 100%');
console.log('✔ Test 5 (a) PASADO');

// Test 6 (b): Dos candidatas a la vez en biblioteca -> debe preguntar (no auto-fusionar)
const duplicateSong: SongProject = {
  ...baseSong,
  id: 'song-copy-2',
  title: 'Eres Bendito (Copia)',
};
const res6 = findSongFingerprintMatches(renamedFiles, [baseSong, duplicateSong]);
console.log('Test 6 (b - Dos candidatas a la vez):', res6.length);
assert(res6.length === 2, 'Debe encontrar 2 candidatas');
// En App.tsx, auto-fusión requiere `candidates.length === 1 && top.matchRatio === 1.0`
const autoMergeTest6 = res6.length === 1 && res6[0].matchRatio === 1.0;
assert(!autoMergeTest6, 'Con dos candidatas a la vez DEBE preguntar al usuario, nunca auto-fusionar');
console.log('✔ Test 6 (b) PASADO');

// Test 7 (c): 7 contra 9 pistas (diferencia > ±1) -> 0 candidatos
const nineTracks = [
  ...renamedFiles,
  { name: '08_Violin.mp3', fileSize: 5000000, durationSec: 250.2 },
  { name: '09_Cello.mp3', fileSize: 5200000, durationSec: 250.2 },
];
const res7 = findSongFingerprintMatches(nineTracks, [baseSong]);
console.log('Test 7 (c - 7 contra 9 pistas):', res7.length);
assert(res7.length === 0, '7 contra 9 pistas excede la tolerancia ±1 y debe devolver 0 candidatos');
console.log('✔ Test 7 (c) PASADO');

// Test 8 (d): 80–99% de coincidencia -> debe preguntar, NO auto-fusionar
// 6 de 7 pistas coinciden = 85.71%
const res8 = findSongFingerprintMatches(minusOneTrack, [baseSong]);
console.log('Test 8 (d - 80–99% de coincidencia):', res8.length, res8[0]?.matchRatio);
assert(res8.length === 1, 'Debe encontrar 1 candidata');
assert(res8[0].matchRatio >= 0.80 && res8[0].matchRatio < 1.0, 'La coincidencia debe estar entre 80% y 99%');
const autoMergeTest8 = res8.length === 1 && res8[0].matchRatio === 1.0;
assert(!autoMergeTest8, 'Coincidencia parcial (80–99%) DEBE preguntar al usuario, nunca auto-fusionar');
console.log('✔ Test 8 (d) PASADO');

console.log('=== TODAS LAS PRUEBAS DE HUELLA DE PISTAS PASARON EXITOSAMENTE ===');
