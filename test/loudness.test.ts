// Pruebas de cómo se presenta la sonoridad: master aplicado como dB, referencia del setlist y avisos.
import {
  describeLoudness,
  formatLu,
  LIMITER_ENGAGE_DBFS,
  masterGainDb,
  playedLufs,
  playedTruePeak,
  setlistReferenceLufs,
  withLoudness,
} from '../src/utils/loudness';
import type { SongLoudness } from '../src/types/project';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

const loud = (lufs: number | null, peak: number | null = -3, extra: Partial<SongLoudness> = {}): SongLoudness => ({
  integratedLufs: lufs,
  loudnessRangeLu: 6,
  truePeakDbtp: peak,
  samplePeakDbfs: peak,
  durationSec: 200,
  tracksMeasured: 8,
  signature: 'v1:48000:abc',
  referenceVersion: 1,
  analyzedAt: 1,
  ...extra,
});
const song = (lufs: number | null, masterGain = 1, peak: number | null = -3) => ({ loudness: loud(lufs, peak), masterGain });

// ---- Master como decibelios (un factor lineal: 2 = +6,02 dB)
assert(masterGainDb(1) === 0, 'master 1 = 0 dB');
assert(near(masterGainDb(2), 6.0206, 1e-3) && near(masterGainDb(0.5), -6.0206, 1e-3), '×2 = +6 dB, ×0,5 = −6 dB');
assert(masterGainDb(0) === 0 && masterGainDb(-1) === 0 && masterGainDb(NaN) === 0 && masterGainDb(undefined) === 0, 'factor no válido: sin cambio');
assert(near(masterGainDb(1.6218), 4.2, 0.01), 'el 1,62 de «Friend of God» son +4,2 dB');

// ---- Lo que suena = referencia + master (sonoridad y pico)
assert(near(playedLufs(song(-18, 1.6218))!, -18 + 4.2, 0.01), 'sonoridad con el master');
assert(near(playedTruePeak(song(-18, 2, -6))!, -6 + 6.0206, 1e-3), 'el pico sube igual que la sonoridad');
assert(playedLufs({ loudness: undefined, masterGain: 1 }) === null, 'sin medida: null');
assert(playedLufs(song(null)) === null, 'silencio o demasiado corta: null');
assert(playedTruePeak(song(-18, 1, null)) === null, 'sin pico: null');

// ---- Referencia del setlist: mediana, y solo con dos o más medidas
assert(setlistReferenceLufs([song(-14)]) === null, 'con una canción no hay con qué comparar');
assert(setlistReferenceLufs([song(-14), { loudness: undefined, masterGain: 1 }]) === null, 'las sin medir no cuentan');
assert(setlistReferenceLufs([song(-14), song(-16)]) === -15, 'dos canciones: el punto medio');
assert(setlistReferenceLufs([song(-14), song(-16), song(-9)]) === -14, 'tres: la mediana, no la media (una fuerte no la arrastra)');
assert(near(setlistReferenceLufs([song(-14, 2), song(-20)])!, (-14 + 6.0206 + -20) / 2, 1e-3), 'cuenta lo que suena, con el master');

// ---- Formato
assert(formatLu(-13.44) === '−13,4' && formatLu(-13.46) === '−13,5', 'menos tipográfico, coma y un decimal');
assert(formatLu(2.14, true) === '+2,1' && formatLu(2.14) === '2,1', '«+» solo si se pide');
assert(formatLu(0, true) === '0,0' && formatLu(-0.04, true) === '0,0', 'cero sin signo (ni «−0,0»)');

// ---- Etiqueta de la ficha
{
  const l = describeLoudness(song(-14), -16)!;
  assert(l.text === '−14,0 LUFS' && l.delta === '+2,0' && l.tone === 'warn', `2 LU por encima avisa: ${JSON.stringify(l)}`);
  assert(l.title.includes('+2,0 LU') && l.title.includes('Pico real: −3,0 dBTP'), 'el detalle trae la diferencia y el pico');
}
{
  const l = describeLoudness(song(-14.015), -16)!; // 1,985 LU: se muestra «+2,0» y debe avisar igual
  assert(l.delta === '+2,0' && l.tone === 'warn', `lo que se ve manda: ${JSON.stringify(l)}`);
  assert(describeLoudness(song(-14.06), -16)!.tone === 'ok', '1,94 se muestra «+1,9»: no avisa');
}
{
  const l = describeLoudness(song(-15.5), -16)!;
  assert(l.delta === '+0,5' && l.tone === 'ok', 'por debajo de 2 LU no avisa');
}
{
  const l = describeLoudness(song(-16), -16)!;
  assert(l.delta === null && l.tone === 'ok', 'igual que la referencia: sin diferencia que mostrar');
  assert(describeLoudness(song(-16), null)!.delta === null, 'sin referencia no hay diferencia');
}
{
  const l = describeLoudness(song(-20), -16)!;
  assert(l.delta === '−4,0' && l.tone === 'warn', 'más baja también avisa');
}
assert(describeLoudness({ loudness: undefined, masterGain: 1 }, -16) === null, 'sin medida no hay etiqueta');
assert(describeLoudness(song(null), -16) === null, 'sin sonoridad (silencio) no hay etiqueta');
{
  const hot = describeLoudness(song(-14, 1, LIMITER_ENGAGE_DBFS + 0.5), -14)!;
  assert(hot.title.includes('el limitador actuará'), 'pico por encima del umbral del limitador: se avisa');
  const calm = describeLoudness(song(-14, 1, -3), -14)!;
  assert(!calm.title.includes('limitador'), 'con margen no se menciona');
  const boosted = describeLoudness(song(-14, 2, -3), -14)!;
  assert(boosted.title.includes('con tu volumen master, +6,0 dB'), 'se explica que incluye el master');
}

// ---- Aplicar el resultado del motor
{
  const a = { id: 'a', loudness: undefined as SongLoudness | undefined };
  const result = loud(-14);
  const updated = withLoudness(a, 'a', result);
  assert(updated !== a && updated.loudness === result, 'la canción recibe su medida');
  assert(withLoudness(a, 'otra', result) === a, 'la medida de otra canción no la toca');
  assert(withLoudness(updated, 'a', { ...result }) === updated, 'la misma medida no renderiza de más');
  assert(withLoudness(updated, 'a', loud(-14, -3, { analyzedAt: 2 })) !== updated, 'una medida más nueva sí la sustituye');
}

console.log('loudness: OK');
