/**
 * Anota los comandos que la interfaz envía al motor (`invoke` de Tauri) cuando el modo diagnóstico está encendido.
 *
 * Se instala una sola vez, al arrancar, envolviendo `window.__TAURI__.core.invoke`: así se ven TODOS los comandos
 * (controles, transporte, biblioteca, diálogos, control remoto) sin tocar cada punto de llamada. Apagado, el
 * envoltorio solo mide la duración (un comando lento queda siempre como alarma) y devuelve el mismo resultado.
 *
 * Los comandos de sondeo (estado, medidores) no se anotan salvo que tarden: son decenas por segundo.
 */
import { debugMode, describeError, summarizeArgs, SLOW_COMMAND_MS, type DebugCategory, type DebugMode } from './debugMode';

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const NOISY = new Set(['audio_get_playback_state', 'audio_get_meters', 'audio_get_stream_stats', 'audio_get_stats', 'audio_get_track_meters']);

const CATEGORY_BY_COMMAND: Array<[RegExp, DebugCategory]> = [
  [/^audio_(play|pause|stop|seek|queue_jump|cancel_jump|toggle_vamp|reopen_stream)$/, 'transporte'],
  [/^audio_(set_track_controls|set_config|set_|update_project_config|apply_project_change)/, 'controles'],
  [/^audio_(load_project|preload_project|switch_to_preloaded|import|generate|unload|delete)/, 'carga'],
  [/^(remote_|lan_)/, 'remoto'],
];

function categoryOf(cmd: string): DebugCategory {
  for (const [re, cat] of CATEGORY_BY_COMMAND) if (re.test(cmd)) return cat;
  return 'comando';
}

/** Envuelve una función `invoke` para anotar sus llamadas en `debug`. Se exporta para poder probarla. */
export function wrapInvoke(
  original: Invoke,
  debug: DebugMode = debugMode,
  now: () => number = () => performance.now()
): Invoke {
  return (command, args) => {
    const started = now();
    const noisy = NOISY.has(command);
    return Promise.resolve(original(command, args)).then(
      (value) => {
        const ms = now() - started;
        if (ms > SLOW_COMMAND_MS) debug.alarm('comando-lento', `${command} tardó ${Math.round(ms)} ms`);
        if (!noisy) debug.trace(categoryOf(command), () => `${command} ${summarizeArgs(args)} → ok (${Math.round(ms)} ms)`);
        return value;
      },
      (error: unknown) => {
        const ms = now() - started;
        debug.trace(categoryOf(command), () => `${command} ${summarizeArgs(args)} → ERROR (${Math.round(ms)} ms): ${describeError(error)}`);
        // Sin el modo encendido, el error lo gestiona quien llamó; aquí solo se relanza tal cual.
        throw error;
      }
    );
  };
}

/** Instala el envoltorio en `window.__TAURI__.core.invoke` (si existe) y los avisos de errores globales. */
export function installInvokeTrace(): void {
  if (typeof window === 'undefined') return;
  installGlobalErrorHooks();
  const core = (window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core;
  if (!core?.invoke) return;
  try {
    core.invoke = wrapInvoke(core.invoke.bind(core));
  } catch (err) {
    // Si el objeto está congelado no se pueden anotar los comandos; el resto del modo diagnóstico sigue funcionando.
    console.warn('[Diagnóstico] No se pudo envolver invoke; los comandos no se anotarán:', err);
  }
}

let hooksInstalled = false;
function installGlobalErrorHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  window.addEventListener('error', (e) => debugMode.error('excepción', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => debugMode.error('promesa rechazada', e.reason));
}
