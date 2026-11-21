/**
 * Modo diagnóstico: un interruptor (Ajustes de audio → Diagnóstico) que, encendido, anota con detalle lo que
 * hace la interfaz con el motor (comandos, transporte, carga de canciones, control remoto, errores) y avisa de
 * incoherencias («alarmas»). Apagado no cuesta nada: `trace` solo mira un booleano y el texto del evento se
 * construye con una función que ni siquiera se llama.
 *
 * Nunca se usa desde el hilo de audio de Rust: todo esto ocurre en la interfaz.
 * Las alarmas y los errores quedan siempre en la caja negra (`flightRecorder`), con el modo encendido o no.
 */
import { FlightRecorder, flightRecorder } from './flightRecorder';

export type DebugCategory = 'comando' | 'transporte' | 'controles' | 'carga' | 'remoto' | 'error' | 'alarma';

export interface DebugEvent {
  /** Milisegundos desde que arrancó el registro. */
  t: number;
  category: DebugCategory;
  detail: string;
}

const STORAGE_KEY = 'omnitracks_debug_mode';
const CAPACITY = 2000;
/** Un comando que tarda más que esto se anota como alarma (el motor o la interfaz de comandos van lentos). */
export const SLOW_COMMAND_MS = 250;
/** Máximo de caracteres de los argumentos y resultados que se copian al registro. */
const MAX_DETAIL_CHARS = 240;

export class DebugMode {
  private on = false;
  private events: DebugEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly start: number;
  private alarmCount = 0;
  private version = 0;
  private notifyScheduled = false;

  constructor(
    private readonly now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
    private readonly recorder: FlightRecorder | null = null
  ) {
    this.start = this.now();
    try {
      this.on = this.storage?.getItem(STORAGE_KEY) === '1';
    } catch (err) {
      console.warn('[Diagnóstico] No se pudo leer si el modo diagnóstico estaba encendido:', err);
    }
  }

  get enabled(): boolean {
    return this.on;
  }

  setEnabled(value: boolean): void {
    if (value === this.on) return;
    this.on = value;
    try {
      this.storage?.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch (err) {
      console.warn('[Diagnóstico] No se pudo guardar el estado del modo diagnóstico:', err);
    }
    this.push('transporte', value ? 'modo diagnóstico ENCENDIDO' : 'modo diagnóstico APAGADO', true);
  }

  /**
   * Anota un evento solo si el modo está encendido. `detail` puede ser una función para no construir el texto
   * (p. ej. serializar argumentos) cuando está apagado.
   */
  trace(category: DebugCategory, detail: string | (() => string)): void {
    if (!this.on) return;
    this.push(category, typeof detail === 'function' ? detail() : detail, false);
  }

  /**
   * Una incoherencia detectada. Queda siempre en la caja negra (aunque el modo esté apagado) y, si está
   * encendido, también en el registro detallado.
   */
  alarm(code: string, detail: string): void {
    this.alarmCount++;
    this.recorder?.record(`alarma:${code}`, detail);
    this.push('alarma', `${code}: ${detail}`, true);
  }

  /** Un error inesperado (excepción no capturada, promesa rechazada…). */
  error(context: string, error: unknown): void {
    const text = describeError(error);
    this.recorder?.record(`error:${context}`, text);
    this.push('error', `${context}: ${text}`, true);
  }

  /** Eventos en orden. Con `onlyIf`, solo las categorías indicadas. */
  all(categories?: ReadonlySet<DebugCategory>): readonly DebugEvent[] {
    return categories ? this.events.filter((e) => categories.has(e.category)) : this.events;
  }

  alarms(): number {
    return this.alarmCount;
  }

  clear(): void {
    this.events = [];
    this.alarmCount = 0;
    this.bump();
  }

  /** Para `useSyncExternalStore`: cambia con cada evento nuevo (agrupados, como mucho uno por cuadro). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Texto listo para pegar o guardar: cabecera, contexto y los eventos con su categoría. */
  report(context: Record<string, string | number | boolean | null | undefined> = {}): string {
    const head = [
      `OmniTracks · registro del modo diagnóstico · ${new Date().toISOString()}`,
      `modo diagnóstico: ${this.on ? 'encendido' : 'apagado'}`,
      `alarmas desde que se encendió: ${this.alarmCount}`,
      ...Object.entries(context).map(([k, v]) => `${k}: ${v ?? '—'}`),
    ];
    const lines = this.events.map((e) => `[+${(e.t / 1000).toFixed(3)} s] ${e.category}: ${e.detail}`);
    return [...head, `--- ${lines.length} eventos ---`, ...lines].join('\n');
  }

  private push(category: DebugCategory, detail: string, force: boolean): void {
    // Las alarmas y los errores se guardan aunque el modo esté apagado: son pocos y valen oro después.
    if (!this.on && !force) return;
    this.events.push({ t: Math.round(this.now() - this.start), category, detail: clip(detail) });
    if (this.events.length > CAPACITY) this.events.splice(0, this.events.length - CAPACITY);
    this.bump();
  }

  private bump(): void {
    this.version++;
    if (this.notifyScheduled || this.listeners.size === 0) return;
    this.notifyScheduled = true;
    // Un aviso por cuadro como mucho: un fader genera decenas de eventos por segundo y no debe renderizar cada uno.
    const run = () => {
      this.notifyScheduled = false;
      for (const l of this.listeners) l();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }
}

function clip(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}… (+${text.length - MAX_DETAIL_CHARS})` : text;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    // catch-ok: dar formato a un error no puede registrar otro error (el registro lo usa); queda String(error)
    return String(error);
  }
}

/** Resumen corto y seguro de los argumentos de un comando (sin volcar listas enormes). */
export function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  try {
    return clip(
      JSON.stringify(args, (_k, v) => (Array.isArray(v) && v.length > 8 ? `[${v.length} elementos]` : v))
    );
  } catch {
    // catch-ok: argumentos que no se pueden serializar se anotan con un texto fijo en el registro
    return '(args no serializables)';
  }
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (err) {
    console.warn('[Diagnóstico] Sin almacenamiento local; el modo diagnóstico no se recordará:', err);
    return null;
  }
}

/** Registro compartido de la aplicación. */
export const debugMode = new DebugMode(undefined, undefined, flightRecorder);
