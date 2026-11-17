// Pruebas del paso del estado del motor nativo al transporte de la interfaz (compás, pulso y secciones).
import { INITIAL_NATIVE_TRANSPORT, snapshotToTransport } from '../src/audio/nativeTransport';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const base = { isPlaying: true, positionSec: 0, durationSec: 200 };

{
  const t = snapshotToTransport(base, 120, 4);
  assert(t.currentBar === 1 && t.currentBeat === 1 && t.beatProgress === 0, 'al inicio: compás 1, pulso 1');
  assert(t.totalDurationSec === 200 && t.isPlaying, 'duración y reproducción');
}
{
  // 120 BPM = 0,5 s por pulso; 2,25 s = 4,5 pulsos = compás 2, pulso 1, a mitad de pulso.
  const t = snapshotToTransport({ ...base, positionSec: 2.25 }, 120, 4);
  assert(t.currentBar === 2 && t.currentBeat === 1 && Math.abs(t.beatProgress - 0.5) < 1e-9, `compás y pulso a 2,25 s: ${t.currentBar}.${t.currentBeat}`);
}
{
  // En 3/4 a 60 BPM, 4 s = pulso 5 = compás 2, pulso 2.
  const t = snapshotToTransport({ ...base, positionSec: 4 }, 60, 3);
  assert(t.currentBar === 2 && t.currentBeat === 2, 'compás de 3 pulsos');
}
{
  const t = snapshotToTransport({ ...base, positionSec: 1 }, undefined, undefined);
  assert(t.currentBar === 1 && t.currentBeat === 3, 'sin tempo: 120 BPM y 4/4');
}
{
  const t = snapshotToTransport({ ...base, activeSectionId: 'coro', queuedSectionId: '', isVamping: undefined }, 120, 4);
  assert(t.activeSectionId === 'coro' && t.queuedSectionId === null && t.isVamping === false, 'secciones vacías pasan a null y el vamp a false');
}
assert(INITIAL_NATIVE_TRANSPORT.currentBar === 1 && !INITIAL_NATIVE_TRANSPORT.isPlaying, 'transporte inicial');

console.log('nativeTransport: OK');
