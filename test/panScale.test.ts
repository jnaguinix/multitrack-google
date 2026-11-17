// Pruebas de panToEngine: el motor nativo espera enteros de -100 a 100, la interfaz usa -1..+1.
import { panToEngine } from '../src/utils/panScale';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

assert(panToEngine(0) === 0, 'centro');
assert(panToEngine(-1) === -100, 'izquierda total');
assert(panToEngine(1) === 100, 'derecha total');
assert(panToEngine(0.35) === 35, 'decimal');
assert(panToEngine(0.01) === 1, 'el 0,01 que ya hay guardado en un proyecto');
assert(panToEngine(-0.5) === -50, 'negativo');
assert(Number.isInteger(panToEngine(0.333333)), 'siempre entero');
assert(panToEngine(2) === 100 && panToEngine(-3) === -100, 'se limita a -100..100');
assert(panToEngine(NaN) === 0 && panToEngine(undefined) === 0 && panToEngine(null) === 0, 'valores no válidos dan 0');

console.log('panScale: OK');
