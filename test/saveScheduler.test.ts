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
