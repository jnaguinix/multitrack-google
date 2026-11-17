// Pruebas del catálogo de instrumentos, la numeración, el orden y la memoria de mapeos.
import {
  ALL_INSTRUMENTS,
  INSTRUMENTS,
  compareNames,
  effectiveBus,
  engineBus,
  getInstrument,
  instrumentIdFromName,
  isClickTrack,
  isGuideTrack,
  numberedNames,
  orderTracksForDisplay,
  sortInstrumentTracks,
} from '../src/utils/instrumentCatalog';
import { loadTrackMapMemory, memoryKey, rememberTrackMapping } from '../src/utils/trackMapMemory';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
const eq = (a: unknown, b: unknown, msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// --- Catálogo
assert(new Set(ALL_INSTRUMENTS.map((i) => i.id)).size === ALL_INSTRUMENTS.length, 'ids únicos');
assert(new Set(ALL_INSTRUMENTS.map((i) => i.label)).size === ALL_INSTRUMENTS.length, 'nombres únicos');
const labels = INSTRUMENTS.map((i) => i.label);
eq([...labels].sort(compareNames), labels, 'los instrumentos del catálogo están en orden alfabético');
assert(getInstrument('click')?.role === 'click' && getInstrument('guia')?.role === 'guide', 'click y guía son fijos');
assert(getInstrument('nada') === null && getInstrument(null) === null, 'id desconocido');

// --- Numeración
eq(numberedNames(['bajo', 'bateria']), ['Bajo', 'Batería'], 'sin repetidos no hay número');
eq(
  numberedNames(['guitarra-electrica', 'bajo', 'guitarra-electrica']),
  ['Guitarra eléctrica 1', 'Bajo', 'Guitarra eléctrica 2'],
  'repetidos se numeran por orden'
);
eq(numberedNames(['teclado', null, 'teclado']), ['Teclado 1', null, 'Teclado 2'], 'las ignoradas no cuentan ni se numeran');
eq(numberedNames(['teclado', null]), ['Teclado', null], 'una sola vez, aunque haya ignoradas');
eq(numberedNames(['x-no-existe']), [null], 'id desconocido da null');

// --- Nombre guardado → instrumento
eq(instrumentIdFromName('Guitarra eléctrica 2'), 'guitarra-electrica', 'quita el número final');
eq(instrumentIdFromName('Bajo'), 'bajo', 'sin número');
eq(instrumentIdFromName('Click Track'), null, 'nombre antiguo fuera del catálogo');
eq(instrumentIdFromName('Voz Alto 1'), 'voz-alto', 'etiqueta con espacio y número');

// --- Orden: alfabético en español, números naturales, sin Click ni Guía
assert(compareNames('Batería', 'Bajo') > 0 && compareNames('Bajo', 'Batería') < 0, 'orden español');
assert(compareNames('Órgano', 'Percusión') < 0 && compareNames('Órgano', 'Bajo') > 0, 'la tilde no cambia el orden');
assert(compareNames('Guitarra 2', 'Guitarra 10') < 0, 'números naturales');
const tracks = [
  { name: 'Teclado', role: 'keys' as const },
  { name: 'Click', role: 'click' as const },
  { name: 'Bajo', role: 'bass' as const },
  { name: 'Guía', role: 'guide' as const },
  { name: 'Guitarra eléctrica 2', role: 'guitar' as const },
  { name: 'Guitarra eléctrica 1', role: 'guitar' as const },
];
eq(sortInstrumentTracks(tracks).map((t) => t.name), ['Bajo', 'Guitarra eléctrica 1', 'Guitarra eléctrica 2', 'Teclado'], 'orden y exclusión de fijos');
eq(
  orderTracksForDisplay(tracks).map((t) => t.name),
  ['Bajo', 'Guitarra eléctrica 1', 'Guitarra eléctrica 2', 'Teclado', 'Click', 'Guía'],
  'Arreglo: instrumentos alfabéticos y al final Click y Guía'
);
assert(tracks[0].name === 'Teclado', 'sortInstrumentTracks no modifica la lista original');

// --- Canciones anteriores al catálogo
assert(isClickTrack({ name: 'Click Track', role: 'custom' }), 'Click Track antiguo con rol custom');
assert(isGuideTrack({ name: 'Cues', role: 'custom' }) && isGuideTrack({ name: 'Guía', role: 'custom' }), 'Cues y Guía antiguos');
assert(!isClickTrack({ name: 'Bajo', role: 'bass' }) && !isGuideTrack({ name: 'Guitarra', role: 'guitar' }), 'un instrumento normal no es fijo');

// --- Bus real
eq(effectiveBus({ name: 'Bajo', role: 'bass' }), 'main', 'instrumento → main');
eq(effectiveBus({ name: 'Click Track', role: 'custom' }), 'cue-click', 'click → cue');
eq(effectiveBus({ name: 'Guía', role: 'guide' }), 'cue-click', 'guía → cue');

// --- Bus enviado al motor: Click y Guía se distinguen para poder separarlos en la salida
eq(engineBus({ name: 'Bajo', role: 'bass' }), 'main', 'instrumento → main');
eq(engineBus({ name: 'Click Track', role: 'custom' }), 'click', 'click antiguo → click');
eq(engineBus({ name: 'Guía', role: 'guide' }), 'guide', 'guía → guide');
eq(engineBus({ name: 'Cues', role: 'custom' }), 'guide', 'Cues antiguo → guide');

// --- Memoria (coincidencia exacta)
function fakeStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}
const st = fakeStorage();
eq(loadTrackMapMemory(st), {}, 'memoria vacía');
rememberTrackMapping(
  [
    { fileName: 'Bass.wav', instrumentId: 'bajo' },
    { fileName: 'Diosesamorf#-bajo-Bb-multitrack.wav', instrumentId: 'bajo' },
    { fileName: 'Ignorada.wav', instrumentId: null },
    { fileName: 'Rara.wav', instrumentId: 'no-existe' },
  ],
  st
);
const mem = loadTrackMapMemory(st);
eq(mem[memoryKey('BASS.WAV')], 'bajo', 'coincide sin distinguir mayúsculas');
assert(!('ignorada.wav' in mem) && !('rara.wav' in mem), 'no recuerda ignoradas ni ids desconocidos');
assert(mem[memoryKey('Bass 2.wav')] === undefined, 'nunca adivina: un nombre parecido no coincide');
const bad = fakeStorage();
bad.setItem('omnitracks_track_map_v1', '{no es json');
eq(loadTrackMapMemory(bad), {}, 'JSON corrupto no rompe');

console.log('instrumentCatalog: OK');
