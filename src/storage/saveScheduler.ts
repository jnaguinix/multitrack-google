/**
 * Guardado con retraso de las canciones. Mover un fader genera decenas de cambios por segundo y cada guardado
 * reescribe `library.json` y el sidecar: aquí los cambios continuos de una misma canción se agrupan y solo se
 * guarda el último. Cualquier otro cambio guarda al momento (y descarta lo pendiente de esa canción, que ya va
 * incluido), y `flushAll` guarda todo lo pendiente (al ocultar o cerrar la ventana).
 *
 * Los guardados de una misma canción van en fila: uno no empieza hasta que termina el anterior (los comandos de
 * Tauri se ejecutan como tareas independientes y dos seguidos podían aplicarse al revés, dejando el cambio viejo).
 * `cancel(id)` es para borrar la canción: descarta lo pendiente, espera lo que ya se estaba guardando e ignora los
 * guardados que lleguen después (si no, un guardado diferido la volvería a crear en la biblioteca).
 */
export class SaveScheduler<T extends { id: string }> {
  private pending = new Map<string, { item: T; timer: ReturnType<typeof setTimeout> }>();
  private inflight = new Map<string, Promise<void>>();
  /** Canciones canceladas (borradas) y hasta cuándo se ignoran sus guardados. */
  private cancelled = new Map<string, number>();

  constructor(
    private readonly save: (item: T) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly delayMs = 400,
    // Envueltos en funciones: `setTimeout` suelto guardado en una propiedad y llamado como `this.setTimer(...)` hace que
    // el navegador lance «Illegal invocation» (exige `window` como `this`).
    private readonly setTimer: typeof setTimeout = ((handler: () => void, ms?: number) => setTimeout(handler, ms)) as typeof setTimeout,
    private readonly clearTimer: typeof clearTimeout = ((id?: ReturnType<typeof setTimeout>) => clearTimeout(id)) as typeof clearTimeout,
    private readonly now: () => number = () => Date.now(),
    /** Cuánto tiempo se ignoran los guardados de una canción cancelada. */
    private readonly cancelWindowMs = 10_000
  ) {}

  /** Guarda dentro de `delayMs`; si llega otro cambio de la misma canción antes, solo se guarda el último. */
  schedule(item: T): void {
    if (this.isCancelled(item.id)) return;
    const existing = this.pending.get(item.id);
    if (existing) this.clearTimer(existing.timer);
    const timer = this.setTimer(() => {
      this.pending.delete(item.id);
      void this.run(item);
    }, this.delayMs);
    this.pending.set(item.id, { item, timer });
  }

  /** Guarda ya y descarta el guardado pendiente de esa canción (lo que traía ya está en `item`). */
  saveNow(item: T): Promise<void> {
    if (this.isCancelled(item.id)) return Promise.resolve();
    const existing = this.pending.get(item.id);
    if (existing) {
      this.clearTimer(existing.timer);
      this.pending.delete(item.id);
    }
    return this.run(item);
  }

  /** Guarda ya lo pendiente de esa canción (si lo hay) y espera a que termine lo suyo. */
  async flush(id: string): Promise<void> {
    const existing = this.pending.get(id);
    if (existing) {
      this.clearTimer(existing.timer);
      this.pending.delete(id);
      await this.run(existing.item);
      return;
    }
    await (this.inflight.get(id) ?? Promise.resolve());
  }

  /**
   * Para borrar una canción: descarta lo pendiente, espera a que termine lo que ya se estaba guardando e ignora los
   * guardados de esa canción durante `cancelWindowMs` (un cambio que llegue mientras se borra no debe recrearla).
   */
  async cancel(id: string): Promise<void> {
    this.cancelled.set(id, this.now() + this.cancelWindowMs);
    const existing = this.pending.get(id);
    if (existing) {
      this.clearTimer(existing.timer);
      this.pending.delete(id);
    }
    await (this.inflight.get(id) ?? Promise.resolve());
  }

  /** Guarda todo lo pendiente y espera a que termine también lo que ya se estaba guardando. */
  async flushAll(): Promise<void> {
    const items = [...this.pending.values()].map((p) => p.item);
    for (const p of this.pending.values()) this.clearTimer(p.timer);
    this.pending.clear();
    await Promise.all(items.map((item) => this.run(item)));
    await Promise.all([...this.inflight.values()]);
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  private isCancelled(id: string): boolean {
    const until = this.cancelled.get(id);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.cancelled.delete(id);
    return false;
  }

  /** Encola el guardado detrás del que ya hubiera en curso para esa canción. */
  private run(item: T): Promise<void> {
    const id = item.id;
    const previous = this.inflight.get(id) ?? Promise.resolve();
    const current = previous.then(async () => {
      try {
        await this.save(item);
      } catch (error) {
        this.onError(error);
      }
    });
    this.inflight.set(id, current);
    void current.then(() => {
      if (this.inflight.get(id) === current) this.inflight.delete(id);
    });
    return current;
  }
}
