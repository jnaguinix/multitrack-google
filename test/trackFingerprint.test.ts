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

console.log('=== TODAS LAS PRUEBAS DE HUELLA DE PISTAS PASARON EXITOSAMENTE ===');
