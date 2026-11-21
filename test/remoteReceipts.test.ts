// Acuses del puente remoto (plan 3.3, H19): «applied» solo cuando el motor confirmó la orden, no cuando cambió el estado de React.
import { ControlQueue } from '../src/audio/controlQueue';
import { receiptFor, type Dispatch } from '../desktop/frontend/remoteState';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const command: Dispatch = {
  id: 7,
  projectId: 'p',
  trackId: 't1',
  command: { type: 'setTrackMute', revision: 1, trackIndex: 0, muted: true },
};
const base = { targets: true, matches: true, engine: { idle: true, errors: 0 }, errorsAtDispatch: 0, pastDeadline: false };

// --- receiptFor ------------------------------------------------------------------------------------------------
assert(receiptFor(command, base) === 'applied', 'estado actualizado y motor en reposo sin errores: applied');
assert(receiptFor(command, { ...base, engine: { idle: false, errors: 0 } }) === null,
  'estado actualizado pero el motor aún no confirmó: se espera (antes ya decía applied)');
assert(receiptFor(command, { ...base, engine: { idle: false, errors: 0 }, pastDeadline: true }) === 'unconfirmed',
  'el motor no confirma a tiempo: unconfirmed');
assert(receiptFor(command, { ...base, engine: { idle: true, errors: 1 }, errorsAtDispatch: 0 }) === 'unconfirmed',
  'el motor rechazó una orden desde el envío: unconfirmed, nunca applied');
assert(receiptFor(command, { ...base, engine: { idle: false, errors: 1 }, errorsAtDispatch: 0 }) === 'unconfirmed',
  'el error se informa sin esperar a que la cola se vacíe');
assert(receiptFor(command, { ...base, engine: { idle: true, errors: 3 }, errorsAtDispatch: 3 }) === 'applied',
  'errores anteriores al envío no cuentan');
assert(receiptFor(command, { ...base, targets: false }) === 'stale', 'ya no apunta a esta canción o revisión: stale');
assert(receiptFor(command, { ...base, matches: false }) === null, 'el estado aún no cambió: se espera');
assert(receiptFor(command, { ...base, matches: false, pastDeadline: true }) === 'unconfirmed', 'el estado no cambió a tiempo: unconfirmed');

// --- ControlQueue cuenta los errores del motor --------------------------------------------------------------------
async function main() {
  let fail = false;
  const queue = new ControlQueue(
    () => async () => { if (fail) throw new Error('rechazado'); },
    () => {},
  );
  assert(queue.errorCount === 0, 'sin errores al empezar');
  queue.enqueue({ key: 'a', cmd: 'audio_set_track_controls', args: { trackId: 'a' } });
  await queue.idle();
  assert(queue.errorCount === 0, 'una orden buena no cuenta error');
  fail = true;
  queue.enqueue({ key: 'a', cmd: 'audio_set_track_controls', args: { trackId: 'a' } });
  await queue.idle();
  assert(queue.errorCount === 1, 'una orden rechazada suma un error');

  console.log('remoteReceipts: OK');
}
void main();
