/**
 * Caja negra: registro circular de los últimos eventos de control (qué se pidió al motor, qué tenía el motor,
 * qué discrepancias se corrigieron). Los fallos «rápidos y temporales» no se pueden reproducir después; con
 * este registro sí se puede ver qué pasó. «Copiar diagnóstico» (Ajustes de audio) lo pone en el portapapeles.
 *
 * Solo guarda texto corto en memoria: no toca el disco salvo la última discrepancia (para verla tras reiniciar).
 */

export interface RecorderEvent {
  /** Milisegundos desde que arrancó el registro. */
  t: number;
  kind: string;
  detail: string;
}

const LAST_MISMATCH_KEY = 'omnitracks_last_mismatch';
const DEFAULT_CAPACITY = 500;

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class FlightRecorder {
  private events: RecorderEvent[] = [];
  private readonly start: number;

  constructor(
    private readonly capacity = DEFAULT_CAPACITY,
    private readonly now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()
  ) {
    this.start = this.now();
  }

  record(kind: string, detail: string): void {
    this.events.push({ t: Math.round(this.now() - this.start), kind, detail });
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
  }

  all(): readonly RecorderEvent[] {
    return this.events;
  }

  /** Guarda una discrepancia detectada para poder verla en el diagnóstico aunque la app se reinicie. */
  rememberMismatch(summary: string): void {
    this.record('discrepancia', summary);
    try {
      this.storage?.setItem(LAST_MISMATCH_KEY, JSON.stringify({ at: new Date().toISOString(), summary }));
    } catch {
      // Sin almacenamiento disponible: el registro en memoria basta.
    }
  }

  lastMismatch(): { at: string; summary: string } | null {
    try {
      const raw = this.storage?.getItem(LAST_MISMATCH_KEY);
      return raw ? (JSON.parse(raw) as { at: string; summary: string }) : null;
    } catch {
      return null;
    }
  }

  /** Texto listo para pegar en un mensaje: cabecera, última discrepancia y los eventos en orden. */
  report(context: Record<string, string | number | boolean | null | undefined> = {}): string {
    const head = [
      `OmniTracks · diagnóstico · ${new Date().toISOString()}`,
      ...Object.entries(context).map(([k, v]) => `${k}: ${v ?? '—'}`),
    ];
    const last = this.lastMismatch();
    if (last) head.push(`Última discrepancia guardada (${last.at}): ${last.summary}`);
    const lines = this.events.map((e) => `[+${(e.t / 1000).toFixed(3)} s] ${e.kind}: ${e.detail}`);
    return [...head, `--- últimos ${lines.length} eventos ---`, ...lines].join('\n');
  }
}

/** Registro compartido de la aplicación. */
export const flightRecorder = new FlightRecorder();
