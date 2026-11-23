// Cliente remoto (desktop/web/remote.js): qué hace al cerrarse el socket (plan 3.2, H20). 1008 (comandos rechazados
// seguidos) no es una revocación: la sesión sigue vigente y se reconecta. 4403 solo termina si el portátil ya no
// reconoce la cookie. Se prueba la función pura `closeAction` que remote.js marca con <closeAction>.
import fs from 'node:fs';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

type Action = { action: 'retry' | 'ended' | 'superseded'; message: string };
type CloseAction = (input: { code: number; sessionStatus: number | null; livedMs: number }) => Action;

const source = fs.readFileSync(new URL('../desktop/web/remote.js', import.meta.url), 'utf-8');
const block = source.match(/\/\/ <closeAction>([\s\S]*?)\/\/ <\/closeAction>/);
assert(block !== null, 'remote.js marca la función con <closeAction>…</closeAction>');
const closeAction = new Function(`${block![1]}\nreturn closeAction;`)() as CloseAction;

const casos: Array<[string, Parameters<CloseAction>[0], Action['action']]> = [
  ['1008 con la sesión vigente: se reconecta', { code: 1008, sessionStatus: null, livedMs: 60_000 }, 'retry'],
  ['1008 aunque el socket durara poco: se reconecta', { code: 1008, sessionStatus: 204, livedMs: 100 }, 'retry'],
  ['4403 y el portátil ya no reconoce la cookie: fin', { code: 4403, sessionStatus: 401, livedMs: 60_000 }, 'ended'],
  ['4403 con 403: fin', { code: 4403, sessionStatus: 403, livedMs: 60_000 }, 'ended'],
  ['4403, cookie vigente y socket recién abierto: otro dispositivo tomó el relevo', { code: 4403, sessionStatus: 204, livedMs: 500 }, 'superseded'],
  ['4403, cookie vigente y llevaba rato abierto: se reconecta', { code: 4403, sessionStatus: 204, livedMs: 60_000 }, 'retry'],
  ['4403 sin respuesta del portátil: se reintenta, no se da por terminado', { code: 4403, sessionStatus: null, livedMs: 60_000 }, 'retry'],
  ['1006 (red caída): se reconecta', { code: 1006, sessionStatus: null, livedMs: 60_000 }, 'retry'],
  ['1001 (suspensión): se reconecta', { code: 1001, sessionStatus: null, livedMs: 60_000 }, 'retry'],
];
for (const [nombre, entrada, esperado] of casos) {
  const resultado = closeAction(entrada);
  assert(resultado.action === esperado, `${nombre} (dio «${resultado.action}»)`);
  assert(resultado.message.length > 0, `${nombre}: hay un mensaje para el usuario`);
}
assert(closeAction({ code: 1008, sessionStatus: null, livedMs: 0 }).message.includes('Reconectando'), '1008 avisa de que reconecta');
assert(!/Sesión cerrada por el portátil/.test(closeAction({ code: 1008, sessionStatus: 204, livedMs: 0 }).message), '1008 ya no dice que el portátil cerró la sesión');

// El cierre del socket usa closeAction y ya no trata 1008 como fin de sesión.
assert(/closeAction\(\{ code: event\.code/.test(source), 'onclose decide con closeAction');
assert(!/event\.code === 4403 \|\| event\.code === 1008/.test(source), 'ya no se juntan 4403 y 1008 como fin de sesión');

console.log('remoteClose: OK');

// Plan 6.9 (AG2 H15): al volver a la pantalla o a la red el cliente reconecta sin esperar al reintento.
{
  type Resume = (input: { event: string; socketState: number; silentMs: number; stopped: boolean }) => 'reconnect' | 'none';
  const resume = source.match(/\/\/ <resumeAction>([\s\S]*?)\/\/ <\/resumeAction>/);
  assert(resume !== null, 'remote.js marca la función con <resumeAction>…</resumeAction>');
  const resumeAction = new Function(`${resume![1]}\nreturn resumeAction;`)() as Resume;
  assert(resumeAction({ event: 'visible', socketState: 3, silentMs: 0, stopped: false }) === 'reconnect', 'socket cerrado: reconecta');
  assert(resumeAction({ event: 'visible', socketState: 1, silentMs: 10_000, stopped: false }) === 'reconnect', 'abierto pero mudo: reconecta');
  assert(resumeAction({ event: 'visible', socketState: 1, silentMs: 500, stopped: false }) === 'none', 'abierto y con tráfico: no toca');
  assert(resumeAction({ event: 'online', socketState: 1, silentMs: 100, stopped: false }) === 'reconnect', 'volvió la red: reconecta');
  assert(resumeAction({ event: 'visible', socketState: 3, silentMs: 0, stopped: true }) === 'none', 'sesión terminada: no reconecta');
  assert(/addEventListener\('visibilitychange'/.test(source) && /addEventListener\('online'/.test(source), 'remote.js escucha visibilitychange y online');
}
