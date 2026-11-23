// Plan 6.8 (AG2 H11b): un dispositivo guardado que no está conectado no se sustituye por el predeterminado.
import { chooseSelectedDevice, resolveActiveDevice } from '../desktop/frontend/deviceSelection';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
const devices = [
  { name: 'Altavoces', isDefault: true },
  { name: 'Interfaz USB', isDefault: false },
];

assert(chooseSelectedDevice('Interfaz USB', devices).name === 'Interfaz USB', 'el guardado y presente se conserva');
assert(!chooseSelectedDevice('Interfaz USB', devices).missing, 'presente no es «desconectado»');
const ausente = chooseSelectedDevice('Interfaz USB', [devices[0]]);
assert(ausente.name === 'Interfaz USB' && ausente.missing, 'el guardado ausente se conserva y se marca desconectado');
assert(chooseSelectedDevice(null, devices).name === 'Altavoces', 'sin guardado se propone el predeterminado');
assert(chooseSelectedDevice(undefined, []).name === '', 'sin dispositivos no hay selección');

assert(resolveActiveDevice('Interfaz USB', devices)?.name === 'Interfaz USB', 'activo = el elegido');
assert(resolveActiveDevice('Interfaz USB', [devices[0]]) === undefined, 'elegido ausente: no hay dispositivo activo (no se cae al predeterminado)');
assert(resolveActiveDevice('', devices)?.name === 'Altavoces', 'sin elección se usa el predeterminado');
console.log('deviceSelection: OK');
