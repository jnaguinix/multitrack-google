// Pruebas de sameTransport: el sondeo no debe provocar renderizados cuando nada cambió.
import { sameTransport } from '../src/utils/transportEqual';
import type { TransportState } from '../src/types/project';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const base: TransportState = {
  isPlaying: false,
  currentTimeSec: 12.5,
  totalDurationSec: 260,
  currentBar: 7,
  currentBeat: 2,
  beatProgress: 0.25,
  activeSectionId: 'v1',
  queuedSectionId: null,
  queuedTargetBar: null,
  countdownBeats: 0,
  isVamping: false,
  lastCueMessage: null,
};

assert(sameTransport(base, { ...base }), 'dos estados idénticos deben ser iguales');
assert(!sameTransport(base, { ...base, currentTimeSec: 12.6 }), 'la posición cambió');
assert(!sameTransport(base, { ...base, isPlaying: true }), 'empezó a sonar');
assert(!sameTransport(base, { ...base, activeSectionId: 'co' }), 'cambió la sección activa');
assert(!sameTransport(base, { ...base, queuedSectionId: 'co' }), 'hay un salto en cola');
assert(!sameTransport(base, { ...base, isVamping: true }), 'se activó el vamp');
assert(!sameTransport(base, { ...base, currentBeat: 3 }), 'cambió el pulso');
assert(!sameTransport(base, { ...base, isMountingSong: true }), 'campo opcional nuevo');
assert(sameTransport({ ...base, isMountingSong: undefined }, { ...base }), 'campo opcional undefined equivale a ausente');
console.log('transportEqual: OK');
