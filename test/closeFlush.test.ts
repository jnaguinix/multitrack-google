// Cerrar la ventana: se guarda lo pendiente y solo después se confirma el cierre a Rust.
import { CLOSE_REQUESTED_EVENT, installCloseFlush } from '../src/utils/closeFlush';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function harness(opts: { flush?: () => Promise<void>; invoke?: () => Promise<unknown> } = {}) {
  const log: string[] = [];
  const errors: string[] = [];
  let handler: ((e: unknown) => void) | null = null;
  const deps = {
    listen: async (event: string, h: (e: unknown) => void) => {
      assert(event === CLOSE_REQUESTED_EVENT, `escucha el evento de cierre, no «${event}»`);
      handler = h;
      return () => {
        handler = null;
      };
    },
    invoke: async (command: string) => {
      log.push(`invoke ${command}`);
      return opts.invoke ? opts.invoke() : undefined;
    },
    flush: async () => {
      log.push('flush inicio');
      if (opts.flush) await opts.flush();
      log.push('flush fin');
    },
    onError: (context: string) => (error: unknown) => {
      errors.push(`${context}: ${String(error)}`);
    },
  };
  return { deps, log, errors, fire: () => handler?.({}), isListening: () => handler !== null };
}

// 1. Primero se guarda (y se espera), después se confirma el cierre.
{
  const h = harness({ flush: () => sleep(30) });
  await installCloseFlush(h.deps);
  h.fire();
  await sleep(10);
  assert(h.log.join(',') === 'flush inicio', `mientras guarda no se confirma: ${h.log.join(',')}`);
  await sleep(60);
  assert(h.log.join(',') === 'flush inicio,flush fin,invoke app_confirm_close', `guarda y luego confirma: ${h.log.join(',')}`);
}

// 2. Si guardar falla, el error se registra y el cierre se confirma igualmente (la ventana no puede quedar atascada).
{
  const h = harness({
    flush: async () => {
      throw new Error('disco lleno');
    },
  });
  await installCloseFlush(h.deps);
  h.fire();
  await sleep(20);
  assert(h.log.includes('invoke app_confirm_close'), 'confirma aunque el guardado falle');
  assert(h.errors.length === 1 && h.errors[0].includes('guardar antes de cerrar'), `registra el fallo: ${h.errors.join('|')}`);
}

// 3. Dos avisos seguidos confirman una sola vez.
{
  const h = harness({ flush: () => sleep(20) });
  await installCloseFlush(h.deps);
  h.fire();
  h.fire();
  await sleep(60);
  assert(h.log.filter((l) => l.startsWith('invoke')).length === 1, `una sola confirmación: ${h.log.join(',')}`);
}

// 4. Si la confirmación falla, se registra y se permite reintentar con el siguiente aviso.
{
  let fallos = 1;
  const h = harness({
    invoke: async () => {
      if (fallos-- > 0) throw new Error('sin permiso');
    },
  });
  await installCloseFlush(h.deps);
  h.fire();
  await sleep(20);
  assert(h.errors.some((e) => e.includes('confirmar el cierre')), 'registra el fallo de la confirmación');
  h.fire();
  await sleep(20);
  assert(h.log.filter((l) => l.startsWith('invoke')).length === 2, 'reintenta con el siguiente aviso');
}

// 5. Cancelar la suscripción deja de escuchar.
{
  const h = harness();
  const cancelar = await installCloseFlush(h.deps);
  cancelar();
  assert(!h.isListening(), 'sin suscripción tras cancelar');
}

console.log('closeFlush: OK');
