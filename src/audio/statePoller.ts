/**
 * Sondeo de estado con una sola petición pendiente.
 *
 * - La siguiente consulta se programa al terminar la anterior (nunca hay dos en vuelo).
 * - Cada respuesta lleva la generación con la que se pidió: tras `invalidate()` (cambio de proyecto,
 *   parada…) la respuesta antigua se descarta y no sobrescribe un estado más reciente.
 * - `pollNow()` pide una actualización inmediata tras una acción relevante (play, pausa, seek…); si ya hay
 *   una petición en vuelo, se encadena otra justo al terminar.
 * - La cadencia la decide `delayMs`, de modo que pausado se consulta menos que reproduciendo.
 * - Los errores nunca se silencian: llegan a `onError` (el llamador decide cómo avisar, con control de frecuencia).
 */
export interface StatePollerOptions<T> {
  /** Pide el estado. `null`/`undefined` significa «sin dato» (p. ej. el puente aún no existe). */
  request: () => Promise<T | null | undefined>;
  onSnapshot: (snapshot: T) => void;
  onError: (error: unknown) => void;
  /** Espera antes de la siguiente consulta, según el último estado recibido. */
  delayMs: (last: T | null) => number;
}

export class StatePoller<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private refreshQueued = false;
  private generation = 0;
  private last: T | null = null;

  constructor(private readonly options: StatePollerOptions<T>) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.refreshQueued = false;
    this.clearTimer();
  }

  /** Descarta la respuesta en vuelo (si la hay) y pide el estado de nuevo cuanto antes. */
  invalidate(): void {
    this.generation++;
    this.last = null;
    this.pollNow();
  }

  /** Pide una actualización inmediata (tras play, pausa, seek, salto…). */
  pollNow(): void {
    if (!this.running) return;
    if (this.inFlight) {
      this.refreshQueued = true;
      return;
    }
    this.clearTimer();
    void this.run();
  }

  /** Para pruebas: ¿hay una petición en vuelo? */
  get pending(): boolean {
    return this.inFlight;
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    const generation = this.generation;
    try {
      const snapshot = await this.options.request();
      if (generation === this.generation && snapshot != null) {
        this.last = snapshot;
        this.options.onSnapshot(snapshot);
      }
    } catch (error) {
      if (generation === this.generation) this.options.onError(error);
    } finally {
      this.inFlight = false;
      if (this.running) {
        if (this.refreshQueued) {
          this.refreshQueued = false;
          void this.run();
        } else {
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.run();
          }, Math.max(0, this.options.delayMs(this.last)));
        }
      }
    }
  }
}
