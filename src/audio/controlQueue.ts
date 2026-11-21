/**
 * Cola serie de órdenes de control al motor (volumen, paneo, mute, solo, bus, ganancias maestras, tono, metrónomo).
 *
 * Por qué existe: cada comando de Tauri se ejecuta como una tarea independiente, así que dos órdenes enviadas en
 * un orden (solo ON y después solo OFF) pueden aplicarse al revés. Medido: en 5 de 3000 intentos el motor
 * terminó con el solo puesto aunque la interfaz mostraba lo contrario. Aquí las órdenes salen **de una en una y
 * en el orden en que se pidieron**: no se envía la siguiente hasta que el motor confirmó la anterior.
 *
 * Además fusiona las órdenes pendientes de una misma clave (p. ej. arrastrar un fader genera decenas de valores:
 * solo importa el último), con lo que el tráfico por la interfaz de comandos baja mucho.
 */

export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface ControlOp {
  /** Identifica el control (`track:<id>`, `master`, `pitch`…). Dos órdenes pendientes con la misma clave se fusionan. */
  key: string;
  cmd: string;
  args: Record<string, unknown>;
}

export class ControlQueue {
  private pending = new Map<string, { cmd: string; args: Record<string, unknown> }>();
  private order: string[] = [];
  private running = false;
  private idleWaiters: Array<() => void> = [];
  /** Marca de tiempo (ms) del último envío al motor. */
  lastSendAt = 0;
  /** Órdenes que el motor rechazó desde que existe la cola (solo crece). */
  errorCount = 0;

  constructor(
    private readonly getInvoke: () => InvokeFn | undefined,
    private readonly onError: (op: ControlOp, error: unknown) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly onSend: (op: ControlOp) => void = () => {}
  ) {}

  enqueue(op: ControlOp): void {
    const existing = this.pending.get(op.key);
    if (existing) {
      // Los argumentos son parciales (solo lo que cambió): se acumulan y lo último gana.
      existing.args = { ...existing.args, ...op.args };
    } else {
      this.pending.set(op.key, { cmd: op.cmd, args: { ...op.args } });
      this.order.push(op.key);
    }
    void this.drain();
  }

  /** `true` si no hay nada pendiente ni en vuelo. */
  isIdle(): boolean {
    return !this.running && this.pending.size === 0;
  }

  /** Se resuelve cuando la cola queda vacía y el motor confirmó la última orden. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.order.length > 0) {
        const key = this.order.shift() as string;
        const entry = this.pending.get(key);
        this.pending.delete(key);
        if (!entry) continue;
        const op: ControlOp = { key, cmd: entry.cmd, args: entry.args };
        const invoke = this.getInvoke();
        if (!invoke) continue; // sin motor (navegador): nada que enviar
        this.lastSendAt = this.now();
        this.onSend(op);
        try {
          await invoke(op.cmd, op.args);
        } catch (error) {
          this.errorCount += 1;
          this.onError(op, error);
        }
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }
}
