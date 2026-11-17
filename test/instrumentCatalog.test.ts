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
  canonicalInstrumentId,
  migrateTrackNames,
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
  numberedNames(['guitarra', 'bajo', 'guitarra']),
  ['Guitarra 1', 'Bajo', 'Guitarra 2'],
  'repetidos se numeran por orden'
);
eq(numberedNames(['piano', null, 'piano']), ['Piano 1', null, 'Piano 2'], 'las ignoradas no cuentan ni se numeran');
eq(numberedNames(['piano', null]), ['Piano', null], 'una sola vez, aunque haya ignoradas');
eq(numberedNames(['guitarra', 'guitarra', 'guitarra']), ['Guitarra 1', 'Guitarra 2', 'Guitarra 3'], 'tres guitarras');
eq(numberedNames(['x-no-existe']), [null], 'id desconocido da null');

// --- Nombre guardado → instrumento
eq(instrumentIdFromName('Guitarra 2'), 'guitarra', 'quita el número final');
eq(instrumentIdFromName('Bajo'), 'bajo', 'sin número');
eq(instrumentIdFromName('Click Track'), null, 'nombre antiguo fuera del catálogo');
eq(instrumentIdFromName('Voz 1'), 'voz', 'etiqueta con espacio y número');

// --- Catálogo simplificado: nombres e ids anteriores se reconocen y se migran
assert(!labels.includes('Teclado') && !labels.includes('Cuerdas') && !labels.includes('Sintetizador / Pad'), 'ya no están Teclado, Cuerdas ni Sintetizador / Pad');
assert(labels.includes('Guitarra') && labels.includes('Piano') && labels.includes('Pad') && labels.includes('Strings'), 'Guitarra, Piano, Pad y Strings');
assert(!labels.some((l) => l.startsWith('Guitarra ')), 'una sola Guitarra, sin acústica ni eléctrica');
eq(canonicalInstrumentId('guitarra-electrica'), 'guitarra', 'id viejo: guitarra eléctrica');
eq(canonicalInstrumentId('guitarra-acustica'), 'guitarra', 'id viejo: guitarra acústica');
eq(canonicalInstrumentId('teclado'), 'piano', 'id viejo: teclado');
eq(canonicalInstrumentId('sintetizador-pad'), 'pad', 'id viejo: sintetizador / pad');
eq(canonicalInstrumentId('cuerdas'), 'strings', 'id viejo: cuerdas');
eq(getInstrument('teclado')?.label, 'Piano', 'getInstrument resuelve los ids viejos');
eq(instrumentIdFromName('Guitarra eléctrica 2'), 'guitarra', 'nombre viejo: guitarra eléctrica');
eq(instrumentIdFromName('Guitarra acústica'), 'guitarra', 'nombre viejo: guitarra acústica');
eq(instrumentIdFromName('Teclado'), 'piano', 'nombre viejo: teclado');
eq(instrumentIdFromName('Sintetizador / Pad'), 'pad', 'nombre viejo: sintetizador / pad');
eq(instrumentIdFromName('Cuerdas'), 'strings', 'nombre viejo: cuerdas');
eq(
  migrateTrackNames([
    { name: 'Guitarra acústica' },
    { name: 'Guitarra eléctrica 1' },
    { name: 'Guitarra eléctrica 2' },
    { name: 'Teclado' },
    { name: 'Sintetizador / Pad' },
    { name: 'Cuerdas' },
    { name: 'Bajo' },
    { name: 'Click Track' },
    { name: 'Voz' },
  ]).map((x) => x.name),
  ['Guitarra 1', 'Guitarra 2', 'Guitarra 3', 'Piano', 'Pad', 'Strings', 'Bajo', 'Click Track', 'Voz'],
  'las canciones guardadas pasan a los nombres nuevos y se renumeran; lo que no es del catálogo no se toca'
);
const ya = migrateTrackNames([{ name: 'Guitarra 1' }, { name: 'Guitarra 2' }, { name: 'Piano' }]);
eq(migrateTrackNames(ya).map((x) => x.name), ['Guitarra 1', 'Guitarra 2', 'Piano'], 'migrar dos veces no cambia nada');
const mismo = [{ name: 'Bajo' }];
assert(migrateTrackNames(mismo)[0] === mismo[0], 'una pista que no cambia es el mismo objeto');

// --- Otros: para lo que no encaja en ningún instrumento
assert(labels.includes('Otros'), 'el catálogo tiene «Otros»');
eq(getInstrument('otros')?.role, 'custom', 'Otros usa el rol genérico');
eq(numberedNames(['otros', 'otros']), ['Otros 1', 'Otros 2'], 'varios «Otros» se numeran');
eq(instrumentIdFromName('Otros 2'), 'otros', 'se reconoce con número');
assert(effectiveBus({ name: 'Otros', role: 'custom' }) === 'main', 'Otros va a Main, no a auriculares');
assert(sortInstrumentTracks([{ name: 'Otros', role: 'custom' as const }]).length === 1, 'Otros va en la lista alfabética, no entre los fijos');

// --- Una sola Voz (antes Alto, principal, Soprano y Tenor)
assert(labels.includes('Voz') && !labels.some((l) => l.startsWith('Voz ')), 'una sola Voz en el catálogo');
for (const viejo of ['voz-alto', 'voz-principal', 'voz-soprano', 'voz-tenor']) eq(canonicalInstrumentId(viejo), 'voz', `id viejo ${viejo}`);
for (const viejo of ['Voz Alto', 'Voz principal', 'Voz Soprano', 'Voz Tenor']) eq(instrumentIdFromName(viejo), 'voz', `nombre viejo ${viejo}`);
eq(numberedNames(['voz', 'voz', 'voz']), ['Voz 1', 'Voz 2', 'Voz 3'], 'varias voces se numeran');
eq(
  migrateTrackNames([{ name: 'Voz Alto' }, { name: 'Voz principal' }, { name: 'Voz Tenor 2' }, { name: 'Bajo' }]).map((x) => x.name),
  ['Voz 1', 'Voz 2', 'Voz 3', 'Bajo'],
  'las voces guardadas pasan a Voz 1, 2, 3'
);
eq(migrateTrackNames([{ name: 'Voz Soprano' }]).map((x) => x.name), ['Voz'], 'una sola voz queda sin número');

// --- Orden: alfabético en español, números naturales, sin Click ni Guía
assert(compareNames('Batería', 'Bajo') > 0 && compareNames('Bajo', 'Batería') < 0, 'orden español');
assert(compareNames('Órgano', 'Percusión') < 0 && compareNames('Órgano', 'Bajo') > 0, 'la tilde no cambia el orden');
assert(compareNames('Guitarra 2', 'Guitarra 10') < 0, 'números naturales');
const tracks = [
  { name: 'Teclado', role: 'keys' as const },
  { name: 'Click', role: 'click' as const },
  { name: 'Bajo', role: 'bass' as const },
  { name: 'Guía', role: 'guide' as const },
  { name: 'Guitarra 2', role: 'guitar' as const },
  { name: 'Guitarra 1', role: 'guitar' as const },
];
eq(sortInstrumentTracks(tracks).map((t) => t.name), ['Bajo', 'Guitarra 1', 'Guitarra 2', 'Teclado'], 'orden y exclusión de fijos');
eq(
  orderTracksForDisplay(tracks).map((t) => t.name),
  ['Bajo', 'Guitarra 1', 'Guitarra 2', 'Teclado', 'Click', 'Guía'],
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
    { fileName: 'Keys.wav', instrumentId: 'teclado' }, // id anterior: se guarda como «piano»
    { fileName: 'Diosesamorf#-bajo-Bb-multitrack.wav', instrumentId: 'bajo' },
    { fileName: 'Ignorada.wav', instrumentId: null },
    { fileName: 'Rara.wav', instrumentId: 'no-existe' },
  ],
  st
);
const mem = loadTrackMapMemory(st);
eq(mem[memoryKey('BASS.WAV')], 'bajo', 'coincide sin distinguir mayúsculas');
eq(mem[memoryKey('keys.wav')], 'piano', 'un id anterior se guarda ya migrado');
const viejo = fakeStorage();
viejo.setItem('omnitracks_track_map_v1', JSON.stringify({ 'pad.wav': 'sintetizador-pad', 'gtr.wav': 'guitarra-electrica' }));
eq(loadTrackMapMemory(viejo), { 'pad.wav': 'pad', 'gtr.wav': 'guitarra' }, 'la memoria guardada con ids anteriores se carga migrada');
assert(!('ignorada.wav' in mem) && !('rara.wav' in mem), 'no recuerda ignoradas ni ids desconocidos');
assert(mem[memoryKey('Bass 2.wav')] === undefined, 'nunca adivina: un nombre parecido no coincide');
const bad = fakeStorage();
bad.setItem('omnitracks_track_map_v1', '{no es json');
eq(loadTrackMapMemory(bad), {}, 'JSON corrupto no rompe');

console.log('instrumentCatalog: OK');
