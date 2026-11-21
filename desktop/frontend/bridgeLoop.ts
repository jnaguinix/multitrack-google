/**
 * Bucle de intercambio entre la interfaz y el servidor LAN (plan de correcciones 3.1, H13).
 *
 * Antes, un solo intercambio fallido apagaba el servidor y desconectaba a los músicos en pleno servicio. Ahora un
 * error pasajero (el WebView tardó, el motor estaba ocupado, un comando falló una vez) solo pone el puente en
 * estado degradado y reintenta con espera creciente; el servidor sigue encendido. El bucle solo se detiene ante un
 * error terminal (el servidor ya no existe: nadie a quien reintentarle) o a petición (`stop`).
 *
 * Es una pieza pura (sin React ni Tauri): los temporizadores y las reacciones se inyectan, y así se prueba.
 */

/** Código que el servidor antepone al error de «ya no hay servidor» (`active_server` en `main.rs`). */
export const TERMINAL_CODE = 'LAN_APAGADO';

/** Esperas entre reintentos tras fallos seguidos. La última se repite: nunca se deja de intentar. */
export const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 5000] as const;

/** Tras N fallos seguidos se avisa en el diagnóstico (una vez por episodio). */
export const ALARM_AFTER_FAILURES = 3;

export function retryDelay(failures: number, intervalMs: number): number {
  if (failures <= 0) return intervalMs;
  return RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** El servidor dijo que ya no existe (apagado o sesión terminada): reintentar no sirve de nada. */
export function isTerminalError(error: unknown): boolean {
  return messageOf(error).includes(TERMINAL_CODE);
}

/** Texto para mostrar: sin el código interno. */
export function describeError(error: unknown): string {
  return messageOf(error).replace(new RegExp(`${TERMINAL_CODE}:\\s*`, 'g'), '');
}

export type BridgeLoopOptions = {
  /** Un intercambio completo. Lanza si falla; no debe tragarse los errores. */
  step: () => Promise<void>;
  /** Falso cuando la conexión que lo creó ya no es la vigente (se apagó, se reemplazó o se desmontó). */
  active: () => boolean;
  intervalMs: number;
  /** Cada fallo pasajero (`failures` cuenta los seguidos, desde 1). */
  onDegraded: (failures: number, error: unknown) => void;
  /** El primer intercambio bueno tras uno o más fallos. */
  onRecovered: (failures: number) => void;
  /** Error terminal: el bucle se detuvo y no vuelve a llamar a nada. */
  onTerminal: (error: unknown) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type BridgeLoop = { start: () => void; stop: () => void; failures: () => number };

export function createBridgeLoop(options: BridgeLoopOptions): BridgeLoop {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let failures = 0;
  let handle: unknown;
  let stopped = false;

  const live = () => !stopped && options.active();
  const schedule = (ms: number) => { handle = setTimer(() => { void run(); }, ms); };

  async function run() {
    if (!live()) return;
    try {
      await options.step();
    } catch (error) {
      // catch-ok: el error no se pierde, se entrega a onTerminal u onDegraded, que lo registran y lo muestran
      if (!live()) return;
      if (isTerminalError(error)) {
        stopped = true;
        options.onTerminal(error);
        return;
      }
      failures += 1;
      options.onDegraded(failures, error);
      schedule(retryDelay(failures, options.intervalMs));
      return;
    }
    if (!live()) return;
    if (failures > 0) {
      const seguidos = failures;
      failures = 0;
      options.onRecovered(seguidos);
    }
    schedule(options.intervalMs);
  }

  return {
    start: () => schedule(0),
    stop: () => {
      stopped = true;
      clearTimer(handle);
    },
    failures: () => failures,
  };
}
