/**
 * Guardado con retraso de las canciones. Mover un fader genera decenas de cambios por segundo y cada guardado
 * reescribe `library.json` y el sidecar: aquí los cambios continuos de una misma canción se agrupan y solo se
 * guarda el último. Cualquier otro cambio guarda al momento (y descarta lo pendiente de esa canción, que ya va
 * incluido), y `flushAll` guarda todo lo pendiente (al ocultar o cerrar la ventana).
 */
export class SaveScheduler<T extends { id: string }> {
  private pending = new Map<string, { item: T; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly save: (item: T) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly delayMs = 400,
    private readonly setTimer: typeof setTimeout = setTimeout,
    private readonly clearTimer: typeof clearTimeout = clearTimeout
  ) {}

  /** Guarda dentro de `delayMs`; si llega otro cambio de la misma canción antes, solo se guarda el último. */
  schedule(item: T): void {
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
    const existing = this.pending.get(item.id);
    if (existing) {
      this.clearTimer(existing.timer);
      this.pending.delete(item.id);
    }
    return this.run(item);
  }

  /** Guarda inmediatamente todo lo pendiente. */
  async flushAll(): Promise<void> {
    const items = [...this.pending.values()].map((p) => p.item);
    for (const p of this.pending.values()) this.clearTimer(p.timer);
    this.pending.clear();
    await Promise.all(items.map((item) => this.run(item)));
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  private async run(item: T): Promise<void> {
    try {
      await this.save(item);
    } catch (error) {
      this.onError(error);
    }
  }
}
