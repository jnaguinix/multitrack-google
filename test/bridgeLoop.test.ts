// El puente con el servidor LAN no apaga el servidor ante un error pasajero (plan 3.1, H13): reintenta con espera
// creciente, avisa del estado degradado, se recupera solo y se detiene únicamente ante un error terminal o a petición.
import fs from 'node:fs';
import {
  ALARM_AFTER_FAILURES,
  RETRY_DELAYS_MS,
  TERMINAL_CODE,
  createBridgeLoop,
  describeError,
  isTerminalError,
  retryDelay,
} from '../desktop/frontend/bridgeLoop';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

/** Reloj falso: guarda el temporizador pendiente y deja avanzarlo a mano. */
function fakeClock() {
  let pending: { callback: () => void; ms: number } | null = null;
  const delays: number[] = [];
  return {
    delays,
    setTimer: (callback: () => void, ms: number) => {
      pending = { callback, ms };
      delays.push(ms);
      return pending;
    },
    clearTimer: (handle: unknown) => { if (pending === handle) pending = null; },
    hasPending: () => pending !== null,
    /** Dispara el temporizador pendiente y espera a que el intercambio termine. */
    async tick() {
      const next = pending;
      assert(next !== null, 'había un temporizador pendiente');
      pending = null;
      next!.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function harness(script: Array<'ok' | 'fallo' | 'terminal'>) {
  const clock = fakeClock();
  const events: string[] = [];
  let steps = 0;
  let activo = true;
  const loop = createBridgeLoop({
    intervalMs: 100,
    active: () => activo,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    step: async () => {
      const next = script[steps++] ?? 'ok';
      if (next === 'fallo') throw new Error('el WebView no respondió');
      if (next === 'terminal') throw new Error(`${TERMINAL_CODE}: El servidor LAN está apagado o la sesión terminó.`);
    },
    onDegraded: (n) => events.push(`degradado:${n}`),
    onRecovered: (n) => events.push(`recuperado:${n}`),
    onTerminal: () => events.push('terminal'),
  });
  return { clock, events, loop, steps: () => steps, desactivar: () => { activo = false; } };
}

// 1. Esperas: la primera es corta, crecen y la última se repite sin parar nunca.
assert(retryDelay(0, 100) === 100, 'sin fallos se usa el intervalo normal');
assert(retryDelay(1, 100) === RETRY_DELAYS_MS[0], 'el primer fallo espera poco');
for (let n = 2; n <= RETRY_DELAYS_MS.length; n++) {
  assert(retryDelay(n, 100) > retryDelay(n - 1, 100), `la espera crece en el fallo ${n}`);
}
assert(retryDelay(500, 100) === RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1], 'la espera tiene tope y nunca deja de reintentar');
assert(ALARM_AFTER_FAILURES >= 2, 'una sola caída pasajera no dispara la alarma del diagnóstico');

// 2. Un solo error NO es terminal: se reintenta y el puente se recupera (esto es lo que antes apagaba el servidor).
{
  const h = harness(['ok', 'fallo', 'ok']);
  h.loop.start();
  await h.clock.tick(); // ok
  await h.clock.tick(); // fallo
  assert(h.events.join() === 'degradado:1', 'un error pasajero solo marca el estado degradado');
  assert(h.clock.hasPending(), 'tras un error pasajero se sigue intentando');
  assert(h.clock.delays[h.clock.delays.length - 1] === RETRY_DELAYS_MS[0], 'el reintento usa la espera corta');
  await h.clock.tick(); // ok
  assert(h.events.join() === 'degradado:1,recuperado:1', 'al volver a responder se recupera solo, una vez');
  assert(h.clock.delays[h.clock.delays.length - 1] === 100, 'recuperado: vuelve al ritmo normal');
  assert(!h.events.includes('terminal'), 'nunca se declaró terminal');
}

// 3. Fallos seguidos: espera creciente, el contador sube y no se cierra jamás.
{
  const h = harness(Array(12).fill('fallo'));
  h.loop.start();
  for (let i = 0; i < 12; i++) await h.clock.tick();
  assert(h.loop.failures() === 12, 'cuenta los fallos seguidos');
  const esperas = h.clock.delays.slice(1);
  assert(esperas[0] === 250 && esperas[4] === 5000 && esperas[11] === 5000, `esperas crecientes con tope: ${esperas.join(',')}`);
  assert(!h.events.includes('terminal') && h.clock.hasPending(), 'doce fallos seguidos no apagan nada: sigue intentando');
}

// 4. Un error terminal (el servidor ya no existe) detiene el bucle y avisa una sola vez.
{
  const h = harness(['ok', 'terminal', 'ok']);
  h.loop.start();
  await h.clock.tick();
  await h.clock.tick();
  assert(h.events.join() === 'terminal', 'el error terminal avisa una vez');
  assert(!h.clock.hasPending(), 'tras un error terminal no se reprograma nada');
  assert(h.steps() === 2, 'tras un error terminal no se vuelve a llamar al servidor');
}

// 5. A petición: stop() cancela el temporizador y un intercambio en vuelo no reprograma ni avisa.
{
  const h = harness(['ok', 'ok']);
  h.loop.start();
  await h.clock.tick();
  h.loop.stop();
  assert(!h.clock.hasPending(), 'stop() cancela el temporizador pendiente');
}
{
  const h = harness(['fallo']);
  h.loop.start();
  h.desactivar(); // la conexión dejó de ser la vigente antes de que fallara el intercambio
  await h.clock.tick();
  assert(h.events.length === 0 && !h.clock.hasPending(), 'una conexión que ya no es la vigente no avisa ni reintenta');
}

// 6. El error terminal se reconoce por el código y se muestra sin él.
assert(isTerminalError(new Error(`${TERMINAL_CODE}: apagado`)), 'se reconoce el error terminal');
assert(isTerminalError(`${TERMINAL_CODE}: apagado`), 'también como texto (así llegan los errores de Tauri)');
assert(!isTerminalError(new Error('Timeout')), 'un error cualquiera no es terminal');
assert(describeError(`${TERMINAL_CODE}: El servidor LAN está apagado.`) === 'El servidor LAN está apagado.', 'el código no se muestra');

// 7. Contrato con Rust: el servidor debe anteponer ese código al error de «apagado o sesión terminada».
const mainRs = fs.readFileSync(new URL('../desktop/src-tauri/src/main.rs', import.meta.url), 'utf-8');
assert(mainRs.includes(`${TERMINAL_CODE}:`), 'main.rs antepone el código del error terminal en active_server');

console.log('bridgeLoop: OK');
