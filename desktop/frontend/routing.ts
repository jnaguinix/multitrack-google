/**
 * Tipos y reglas del ruteo de salidas en la interfaz. El motor (`desktop/src-tauri/src/audio/routing.rs`) es la
 * autoridad: valida otra vez al guardar y al abrir el dispositivo. Esta copia sirve para avisar mientras se
 * edita y para la vista previa del navegador; si cambian las reglas hay que cambiarlas en los dos sitios.
 */

export type RouteSource = 'musicL' | 'musicR' | 'musicMono' | 'click' | 'guide' | 'monitor';

export interface RouteEntry {
  source: RouteSource;
  gain: number;
}

export interface OutputAssign {
  sources: RouteEntry[];
}

export interface RoutingConfig {
  channels: number;
  outputs: OutputAssign[];
  allowMixed: boolean;
  custom: boolean;
}

/** Respuesta de `audio_get_routing` / `audio_set_routing` / `audio_reset_routing`. */
export interface RoutingInfo {
  deviceName?: string | null;
  host: string;
  deviceFound: boolean;
  channels: number;
  config: RoutingConfig;
  proposed: RoutingConfig;
  saved: boolean;
  stale: boolean;
  valid: boolean;
  issues: string[];
  notes: string[];
  summary: string;
}

export const ROUTE_SOURCES: readonly RouteSource[] = ['musicL', 'musicR', 'musicMono', 'click', 'guide', 'monitor'];

export const SOURCE_LABEL: Record<RouteSource, string> = {
  musicL: 'Música izq.',
  musicR: 'Música der.',
  musicMono: 'Música mono',
  click: 'Click',
  guide: 'Guía',
  monitor: 'Monitor',
};

/** Con artículo, para los mensajes. */
const SOURCE_NAME: Record<RouteSource, string> = {
  musicL: 'la música izquierda',
  musicR: 'la música derecha',
  musicMono: 'la música (mono)',
  click: 'el click',
  guide: 'la guía',
  monitor: 'el monitor',
};

const isMusic = (s: RouteSource) => s === 'musicL' || s === 'musicR' || s === 'musicMono';
const isCue = (s: RouteSource) => s === 'click' || s === 'guide' || s === 'monitor';
const entries = (...sources: RouteSource[]): OutputAssign => ({ sources: sources.map((source) => ({ source, gain: 1 })) });

/** Propuesta automática según los canales independientes que expone el dispositivo. */
export function proposeRouting(channels: number): RoutingConfig {
  const outputs: OutputAssign[] = Array.from({ length: channels }, () => ({ sources: [] }));
  if (channels === 1) outputs[0] = entries('musicMono', 'click', 'guide', 'monitor');
  else if (channels === 2) {
    outputs[0] = entries('musicMono');
    outputs[1] = entries('click', 'guide', 'monitor');
  } else if (channels === 3) {
    outputs[0] = entries('musicL');
    outputs[1] = entries('musicR');
    outputs[2] = entries('click', 'guide', 'monitor');
  } else if (channels >= 4) {
    outputs[0] = entries('musicL');
    outputs[1] = entries('musicR');
    outputs[2] = entries('click');
    outputs[3] = entries('guide', 'monitor');
  }
  return { channels, outputs, allowMixed: false, custom: false };
}

/** Mensajes de lo que impide reproducir con este ruteo. Lista vacía = válido. */
export function validateRouting(config: RoutingConfig, deviceChannels: number): string[] {
  if (deviceChannels <= 0) return ['El dispositivo no expone ninguna salida.'];
  if (config.channels !== deviceChannels || config.outputs.length !== deviceChannels) {
    return [`Este ruteo se hizo para ${config.channels} salidas y el dispositivo tiene ${deviceChannels}.`];
  }
  const issues: string[] = [];
  const has = (pred: (s: RouteSource) => boolean) => config.outputs.some((o) => o.sources.some((e) => e.gain > 0 && pred(e.source)));
  if (!has(isMusic)) issues.push('La música no está asignada a ninguna salida: se perdería.');
  if (!has((s) => s === 'click')) issues.push('El click no está asignado a ninguna salida: se perdería.');
  if (!has((s) => s === 'guide')) issues.push('La guía no está asignada a ninguna salida: se perdería.');
  if (!has((s) => s === 'monitor')) issues.push('El monitor (Aur.) no está asignado a ninguna salida: las pistas marcadas se perderían.');
  if (!config.allowMixed) {
    config.outputs.forEach((o, i) => {
      const music = o.sources.find((e) => e.gain > 0 && isMusic(e.source));
      const cue = o.sources.find((e) => e.gain > 0 && isCue(e.source));
      if (music && cue) {
        issues.push(
          `La salida ${i + 1} mezcla ${SOURCE_NAME[music.source]} con ${SOURCE_NAME[cue.source]}: ${SOURCE_NAME[cue.source]} llegaría al público.`
        );
      }
    });
  }
  return issues;
}

/** Marca o desmarca una fuente en una salida (devuelve una copia). */
export function toggleSource(config: RoutingConfig, output: number, source: RouteSource): RoutingConfig {
  const outputs = config.outputs.map((o, i) => {
    if (i !== output) return o;
    const present = o.sources.some((e) => e.source === source);
    return { sources: present ? o.sources.filter((e) => e.source !== source) : [...o.sources, { source, gain: 1 }] };
  });
  return { ...config, outputs, custom: true };
}
