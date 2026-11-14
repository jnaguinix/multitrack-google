import type { MetersSnapshot } from '../types/project';

export const EMPTY_METERS: MetersSnapshot = {
  tracks: {},
  master: { rms: 0, peak: 0, clipping: false },
};

/**
 * Ciclo único de actualización de medidores (UI03).
 *
 * Todos los medidores visibles comparten una sola lectura del motor y un solo temporizador, que solo
 * existe mientras haya algún suscriptor. La lectura (`current`) es un objeto estable entre ticks, apto para
 * `useSyncExternalStore`: solo se vuelven a renderizar los medidores suscritos, no las consolas que los contienen.
 */
export function createMeterFeed(read: () => MetersSnapshot, intervalMs = 50) {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let current: MetersSnapshot = EMPTY_METERS;

  const tick = () => {
    current = read();
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (timer == null) {
        tick();
        timer = setInterval(tick, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer != null) {
          clearInterval(timer);
          timer = null;
          current = EMPTY_METERS;
        }
      };
    },
    getSnapshot(): MetersSnapshot {
      return current;
    },
    /** Para pruebas. */
    get subscribers(): number {
      return listeners.size;
    },
    get running(): boolean {
      return timer != null;
    },
  };
}
