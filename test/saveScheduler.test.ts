// El guardado diferido debe funcionar con los temporizadores por defecto aunque `setTimeout` exija `window` como
// `this` (en el navegador, llamarlo como método de otro objeto lanza «Illegal invocation»: dejaba caer el control remoto).
import { SaveScheduler } from '../src/storage/saveScheduler';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const realSet = globalThis.setTimeout;
const realClear = globalThis.clearTimeout;
// Imita al navegador: solo acepta ser llamado sin objeto propio.
(globalThis as any).setTimeout = function (this: unknown, ...args: Parameters<typeof setTimeout>) {
  if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
  return realSet(...args);
};
(globalThis as any).clearTimeout = function (this: unknown, id?: Parameters<typeof clearTimeout>[0]) {
  if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
  return realClear(id);
};

const saved: number[] = [];
const scheduler = new SaveScheduler<{ id: string; n: number }>(
  async (item) => { saved.push(item.n); },
  (error) => { console.error(error); process.exit(1); },
  20,
);
scheduler.schedule({ id: 'a', n: 1 });
scheduler.schedule({ id: 'a', n: 2 });
assert(scheduler.hasPending(), 'queda un guardado pendiente');
await new Promise((resolve) => realSet(resolve, 80));
assert(saved.length === 1 && saved[0] === 2, 'se guarda solo el último cambio de la canción');
assert(!scheduler.hasPending(), 'no queda nada pendiente');
console.log('saveScheduler: OK');

// ---- Borrado y cierre (plan 4.3) ----
const sleep = (ms: number) => new Promise((resolve) => realSet(resolve, ms));
type Item = { id: string; n: number };
const log: string[] = [];
let clock = 1_000;
const slow = new SaveScheduler<Item>(
  async (item) => {
    log.push(`inicio ${item.id}${item.n}`);
    await sleep(item.n === 1 ? 40 : 1);
    log.push(`fin ${item.id}${item.n}`);
  },
  (error) => { console.error(error); process.exit(1); },
  20,
  undefined,
  undefined,
  () => clock,
  10_000,
);

// Dos guardados seguidos de la misma canción van en fila: el segundo no empieza hasta que acaba el primero
// (antes podían aplicarse al revés y quedaba el cambio viejo).
const p1 = slow.saveNow({ id: 'a', n: 1 });
const p2 = slow.saveNow({ id: 'a', n: 2 });
await Promise.all([p1, p2]);
assert(log.join(',') === 'inicio a1,fin a1,inicio a2,fin a2', `los guardados de una canción van en fila: ${log.join(',')}`);

// Canciones distintas no se esperan entre sí.
log.length = 0;
const pa = slow.saveNow({ id: 'a', n: 1 });
const pb = slow.saveNow({ id: 'b', n: 2 });
await Promise.all([pa, pb]);
assert(log.indexOf('fin b2') < log.indexOf('fin a1'), `otra canción no espera a la lenta: ${log.join(',')}`);

// Cancelar (borrar la canción) descarta lo pendiente y nada se guarda después.
log.length = 0;
slow.schedule({ id: 'c', n: 2 });
await slow.cancel('c');
await sleep(80);
assert(log.length === 0, `lo pendiente de una canción borrada no se guarda: ${log.join(',')}`);
assert(!slow.hasPending(), 'no queda nada pendiente');

// Cancelar espera a que termine el guardado que ya estaba en curso (si no, podía terminar después del borrado).
log.length = 0;
const enCurso = slow.saveNow({ id: 'd', n: 1 });
await slow.cancel('d');
assert(log.join(',') === 'inicio d1,fin d1', `cancel espera el guardado en curso: ${log.join(',')}`);
await enCurso;

// Un cambio que llegue mientras se borra (un fader que aún se mueve) no recrea la canción…
log.length = 0;
slow.schedule({ id: 'd', n: 2 });
await slow.saveNow({ id: 'd', n: 2 });
await sleep(80);
assert(log.length === 0, `tras cancelar se ignoran los guardados de esa canción: ${log.join(',')}`);
// …y pasada la ventana, la misma id se vuelve a poder guardar (p. ej. una reimportación).
clock += 10_001;
await slow.saveNow({ id: 'd', n: 2 });
assert(log.join(',') === 'inicio d2,fin d2', `pasada la ventana se guarda de nuevo: ${log.join(',')}`);

// flush(id): guarda ya lo pendiente de esa canción y deja el resto pendiente.
log.length = 0;
slow.schedule({ id: 'e', n: 2 });
slow.schedule({ id: 'f', n: 2 });
await slow.flush('e');
assert(log.join(',') === 'inicio e2,fin e2', `flush guarda esa canción y la espera: ${log.join(',')}`);
assert(slow.hasPending(), 'las demás siguen pendientes');
// flushAll guarda lo que queda y espera también lo que ya estaba en curso.
const larga = slow.saveNow({ id: 'g', n: 1 });
await slow.flushAll();
assert(log.includes('fin g1') && log.includes('fin f2'), `flushAll espera todo: ${log.join(',')}`);
await larga;
assert(!slow.hasPending(), 'sin pendientes al final');
console.log('saveScheduler (borrado y cierre): OK');
