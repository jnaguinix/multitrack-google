// Una generación de caché parcial no es una caché lista (H02).
import assert from 'node:assert/strict';
import { importIncompleteReason } from '../src/audio/nativeCacheManager';

const ids = ['a', 'b', 'c'];

assert.equal(importIncompleteReason({ tracks: [{ trackId: 'a' }, { trackId: 'b' }, { trackId: 'c' }], errors: [] }, ids), null, 'todas las pistas y sin errores: completa');
assert.equal(importIncompleteReason({ tracks: [{ trackId: 'c' }, { trackId: 'a' }, { trackId: 'b' }] }, ids), null, 'el orden no importa y `errors` puede faltar');

const falta = importIncompleteReason({ tracks: [{ trackId: 'a' }, { trackId: 'b' }], errors: [] }, ids);
assert.ok(falta && falta.includes('la pista c'), `una pista que falta se nombra: ${falta}`);

const varias = importIncompleteReason({ tracks: [{ trackId: 'a' }] }, ids);
assert.ok(varias && varias.includes('las pistas b, c'), `varias faltan: ${varias}`);

const conError = importIncompleteReason({ tracks: [{ trackId: 'a' }, { trackId: 'b' }, { trackId: 'c' }], errors: ['b.wav: formato no soportado'] }, ids);
assert.ok(conError && conError.includes('formato no soportado'), `un error del motor impide darla por lista: ${conError}`);

assert.ok(importIncompleteReason(null, ids), 'sin respuesta no es completa');
assert.equal(importIncompleteReason({ tracks: [] }, []), null, 'un proyecto sin pistas no tiene nada que faltar');
console.log('cacheComplete.test.ts OK');
