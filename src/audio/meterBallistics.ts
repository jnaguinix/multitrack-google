// Balística de los medidores de escritorio: convierte los picos que entrega el motor nativo
// (pico desde la consulta anterior, lineal, 1.0 = 0 dBFS) en valores visibles con caída suave.
// Es pura (sin Tauri ni DOM) para poder probarla en Node.

import type { MetersSnapshot, TrackMeterReading } from '../types/project';

export interface NativeLevelPair {
  l: number;
  r: number;
}

export interface NativeMetersSnapshot {
  tracks: { trackId: string; l: number; r: number }[];
  main: NativeLevelPair;
  cue: NativeLevelPair;
  out: NativeLevelPair;
  click?: NativeLevelPair;
  guide?: NativeLevelPair;
  clipped: boolean;
}

/** Caída de ~20 dB por segundo, la balística típica de un medidor de pico. */
export const METER_FALL_DB_PER_SEC = 20;
/** Tiempo que se mantiene encendido el aviso de recorte. */
export const CLIP_HOLD_MS = 1000;

type Channel = { value: number; at: number };

const ZERO: TrackMeterReading = { rms: 0, peak: 0, clipping: false };

function decayed(ch: Channel | undefined, now: number): number {
  if (!ch) return 0;
  const dtSec = Math.max(0, now - ch.at) / 1000;
  return ch.value * Math.pow(10, (-METER_FALL_DB_PER_SEC * dtSec) / 20);
}

function finite(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
}

export class MeterBallistics {
  private channels = new Map<string, Channel>();
  private trackIdsSeen = new Set<string>();
  private lastClipAt = -Infinity;

  /** Mezcla una lectura nueva: el valor mostrado es el mayor entre el pico nuevo y el anterior ya caído. */
  public update(raw: NativeMetersSnapshot | null | undefined, now: number): void {
    if (!raw) return;
    const push = (key: string, v: number) => {
      const shown = Math.max(finite(v), decayed(this.channels.get(key), now));
      this.channels.set(key, { value: shown, at: now });
    };
    for (const t of raw.tracks ?? []) {
      this.trackIdsSeen.add(t.trackId);
      push(`t:${t.trackId}:l`, t.l);
      push(`t:${t.trackId}:r`, t.r);
    }
    for (const bus of ['main', 'cue', 'out', 'click', 'guide'] as const) {
      const pair = raw[bus];
      push(`b:${bus}:l`, pair?.l ?? 0);
      push(`b:${bus}:r`, pair?.r ?? 0);
    }
    if (raw.clipped) this.lastClipAt = now;
  }

  public reset(): void {
    this.channels.clear();
    this.trackIdsSeen.clear();
    this.lastClipAt = -Infinity;
  }

  /** Nivel visible de un canal ya con la caída aplicada hasta `now`. */
  public level(key: string, now: number): number {
    return decayed(this.channels.get(key), now);
  }

  public pair(bus: string, now: number): NativeLevelPair {
    return { l: this.level(`b:${bus}:l`, now), r: this.level(`b:${bus}:r`, now) };
  }

  /**
   * Instantánea en el formato que usan las vistas. `rms` y `peak` contienen el MISMO valor: el pico
   * con caída (el motor nativo mide pico, no RMS). Una pista sin dato da 0, nunca un valor inventado.
   */
  public snapshot(trackIds: string[], now: number, isPlaying: boolean): MetersSnapshot {
    const tracks: Record<string, TrackMeterReading> = {};
    if (!isPlaying) {
      for (const id of trackIds) tracks[id] = { ...ZERO };
      return { tracks, master: { ...ZERO }, nativeBuses: null };
    }
    // Pistas conocidas por la vista + las que el motor está midiendo de verdad.
    const ids = new Set<string>([...trackIds, ...this.trackIdsSeen]);
    for (const id of ids) {
      const v = Math.max(this.level(`t:${id}:l`, now), this.level(`t:${id}:r`, now));
      tracks[id] = { rms: Math.min(1, v), peak: Math.min(1, v), clipping: v >= 1 };
    }
    const main = this.pair('main', now);
    const m = Math.max(main.l, main.r);
    const clipping = now - this.lastClipAt <= CLIP_HOLD_MS;
    return {
      tracks,
      master: { rms: Math.min(1, m), peak: Math.min(1, m), clipping },
      nativeBuses: {
        main,
        cue: this.pair('cue', now),
        out: this.pair('out', now),
        click: this.pair('click', now),
        guide: this.pair('guide', now),
        clipping,
      },
    };
  }
}
