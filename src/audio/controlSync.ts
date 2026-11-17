/**
 * Sincronización de los controles de la mezcla con el motor nativo.
 *
 * - **Solo diferencias:** al mover un fader solo se envía esa pista, no las 17 (antes cada cambio mandaba la orden
 *   de todas las pistas, con cientos de llamadas por segundo al arrastrar).
 * - **En orden:** todo pasa por una [`ControlQueue`] serie: una orden no sale hasta que el motor confirmó la anterior.
 * - **Autocorrección:** el motor informa en cada sondeo cómo tiene cada pista de verdad. Si no coincide con lo que
 *   muestra la interfaz durante dos sondeos seguidos y la cola está en reposo, se reenvía lo correcto y queda
 *   anotado en la caja negra. Cualquier orden perdida o aplicada al revés se cura sola.
 */
import type { SongProject, TrackChannel } from '../types/project';
import { panToEngine } from '../utils/panScale';
import { engineBus } from '../utils/instrumentCatalog';
import { flightRecorder, type FlightRecorder } from '../utils/flightRecorder';
import { ControlQueue, type ControlOp, type InvokeFn } from './controlQueue';

export type { ControlOp } from './controlQueue';

/** Lo que el motor informa de cada pista (`audio_get_playback_state`). */
export interface EngineTrackControl {
  trackId: string;
  gain: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  bus: string;
  /** «Aur.»: la pista también va a los auriculares. */
  monitor?: boolean;
}

export interface EngineGlobals {
  masterGain?: number;
  cueMasterGain?: number;
  monitorGain?: number;
  pitchSemitones?: number;
}

export interface TrackDesired {
  id: string;
  gain: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  monitor: boolean;
  bus: 'main' | 'click' | 'guide';
}

const GAIN_TOLERANCE = 1e-4;
const DEFAULT_MASTER = 1.0;
const DEFAULT_CUE_MASTER = 0.708;
const DEFAULT_MONITOR = 1.0;

export function desiredTrack(t: TrackChannel): TrackDesired {
  return {
    id: t.id,
    gain: Number.isFinite(t.gain) ? t.gain : 1,
    pan: panToEngine(t.pan),
    muted: Boolean(t.muted),
    soloed: Boolean(t.soloed),
    monitor: Boolean(t.monitor),
    bus: engineBus(t),
  };
}

type TrackField = 'gain' | 'pan' | 'muted' | 'soloed' | 'monitor' | 'bus';
const TRACK_FIELDS: readonly TrackField[] = ['gain', 'pan', 'muted', 'soloed', 'monitor', 'bus'];

const sameGain = (a: number, b: number) => Math.abs(a - b) <= GAIN_TOLERANCE;

function sectionsPayload(project: SongProject) {
  return (project.sections || []).map((s) => ({
    id: s.id,
    name: s.name,
    code: (s as { code?: string }).code || null,
    startSec: s.startTimeSec,
    endSec: s.endTimeSec,
  }));
}

function metronomeConfig(project: SongProject) {
  return {
    enabled: project.clickEnabled ?? true,
    bpm: project.bpm || 120,
    beatsPerBar: project.beatsPerBar || 4,
    subdivision: project.clickSubdivision ?? 1,
    gain: project.clickGain ?? 0.8,
  };
}

/**
 * Órdenes necesarias para pasar de `prev` a `next`. Con `prev = null` devuelve todo (carga completa).
 * Cada orden de pista lleva solo los campos que cambiaron.
 */
export function diffProjectControls(prev: SongProject | null, next: SongProject): ControlOp[] {
  const ops: ControlOp[] = [];

  // Cabecera de la canción (tempo, compás, cuantización, secciones)
  const songKey = (p: SongProject) => JSON.stringify([p.bpm || 120, p.beatsPerBar || 4, p.quantizeMode || 'section-end', sectionsPayload(p)]);
  if (!prev || songKey(prev) !== songKey(next)) {
    ops.push({
      key: 'song',
      cmd: 'audio_configure_song',
      args: {
        bpm: next.bpm || 120,
        beatsPerBar: next.beatsPerBar || 4,
        sections: sectionsPayload(next),
        quantizeMode: next.quantizeMode || 'section-end',
      },
    });
  }

  // Metrónomo
  if (!prev || JSON.stringify(metronomeConfig(prev)) !== JSON.stringify(metronomeConfig(next))) {
    ops.push({ key: 'metronome', cmd: 'audio_set_metronome', args: { config: metronomeConfig(next) } });
  }

  // Ganancias maestras
  const master = next.masterGain ?? DEFAULT_MASTER;
  const cue = next.cueMasterGain ?? DEFAULT_CUE_MASTER;
  const masterArgs: Record<string, unknown> = {};
  if (!prev || !sameGain(prev.masterGain ?? DEFAULT_MASTER, master)) masterArgs.masterGain = master;
  if (!prev || !sameGain(prev.cueMasterGain ?? DEFAULT_CUE_MASTER, cue)) masterArgs.cueMasterGain = cue;
  const monitor = next.monitorGain ?? DEFAULT_MONITOR;
  if (!prev || !sameGain(prev.monitorGain ?? DEFAULT_MONITOR, monitor)) masterArgs.monitorGain = monitor;
  if (Object.keys(masterArgs).length > 0) ops.push({ key: 'master', cmd: 'audio_set_master_gains', args: masterArgs });

  // Tono
  if (!prev || (prev.pitchSemitones || 0) !== (next.pitchSemitones || 0)) {
    ops.push({ key: 'pitch', cmd: 'audio_set_pitch', args: { semitones: next.pitchSemitones || 0 } });
  }

  // Pistas: solo los campos que cambiaron (todos si la pista es nueva)
  const before = new Map<string, TrackDesired>();
  for (const t of prev?.tracks ?? []) before.set(t.id, desiredTrack(t));
  for (const t of next.tracks) {
    const now = desiredTrack(t);
    const old = before.get(t.id);
    const args: Record<string, unknown> = { trackId: t.id };
    for (const f of TRACK_FIELDS) {
      const changed = !old || (f === 'gain' ? !sameGain(old.gain, now.gain) : old[f] !== now[f]);
      if (changed) args[f] = now[f];
    }
    if (Object.keys(args).length > 1) ops.push({ key: `track:${t.id}`, cmd: 'audio_set_track_controls', args });
  }
  return ops;
}

/** Cambios de valor continuo (arrastrar un fader o un pan): se pueden guardar con retraso sin riesgo. */
export function isContinuousOnly(ops: readonly ControlOp[]): boolean {
  return (
    ops.length > 0 &&
    ops.every((op) => {
      if (op.key === 'master') return true;
      if (!op.key.startsWith('track:')) return false;
      return Object.keys(op.args).every((k) => k === 'trackId' || k === 'gain' || k === 'pan');
    })
  );
}

export interface TrackMismatch {
  trackId: string;
  fields: TrackField[];
  desired: TrackDesired;
  actual: EngineTrackControl;
}

/** Pistas cuyo estado en el motor no coincide con el deseado. Se ignoran los IDs repetidos (no son direccionables). */
export function findTrackMismatches(desired: readonly TrackDesired[], actual: readonly EngineTrackControl[]): TrackMismatch[] {
  const counts = new Map<string, number>();
  for (const d of desired) counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
  const engineById = new Map<string, EngineTrackControl>();
  for (const a of actual) if (!engineById.has(a.trackId)) engineById.set(a.trackId, a);

  const out: TrackMismatch[] = [];
  for (const d of desired) {
    if ((counts.get(d.id) ?? 0) > 1) continue;
    const a = engineById.get(d.id);
    if (!a) continue;
    const fields: TrackField[] = [];
    if (!sameGain(a.gain, d.gain)) fields.push('gain');
    if (a.pan !== d.pan) fields.push('pan');
    if (a.muted !== d.muted) fields.push('muted');
    if (a.soloed !== d.soloed) fields.push('soloed');
    if (Boolean(a.monitor) !== d.monitor) fields.push('monitor');
    if (a.bus !== d.bus) fields.push('bus');
    if (fields.length > 0) out.push({ trackId: d.id, fields, desired: d, actual: a });
  }
  return out;
}

/** Tiempo tras el último envío antes de fiarse de lo que informa el motor. */
export const SETTLE_MS = 150;
/** Sondeos seguidos con la misma diferencia antes de corregirla. */
export const CONFIRM_POLLS = 2;
/** Como mucho, 3 correcciones por control cada 5 s: si no se arregla, se anota y se deja de insistir. */
export const MAX_RESYNC_PER_WINDOW = 3;
export const RESYNC_WINDOW_MS = 5000;

export interface ControlSyncDeps {
  getInvoke: () => InvokeFn | undefined;
  onError: (op: ControlOp, error: unknown) => void;
  recorder?: FlightRecorder;
  now?: () => number;
}

export class ControlSync {
  readonly queue: ControlQueue;
  private readonly recorder: FlightRecorder;
  private readonly now: () => number;
  private streaks = new Map<string, { signature: string; count: number }>();
  private attempts = new Map<string, number[]>();

  constructor(deps: ControlSyncDeps) {
    this.recorder = deps.recorder ?? flightRecorder;
    this.now = deps.now ?? (() => Date.now());
    this.queue = new ControlQueue(
      deps.getInvoke,
      (op, error) => {
        this.recorder.record('error', `${op.cmd} ${JSON.stringify(op.args)} → ${String(error)}`);
        deps.onError(op, error);
      },
      this.now,
      (op) => this.recorder.record('envío', `${op.cmd} ${JSON.stringify(op.args)}`)
    );
  }

  /** Envía todo el estado de la canción (carga, importación, reapertura). */
  syncAll(project: SongProject): void {
    this.recorder.record('sync-total', `${project.id} (${project.tracks.length} pistas)`);
    this.streaks.clear();
    for (const op of diffProjectControls(null, project)) this.queue.enqueue(op);
  }

  /** Envía solo lo que cambió entre dos versiones de la canción y devuelve las órdenes generadas. */
  applyChange(prev: SongProject, next: SongProject): ControlOp[] {
    const ops = diffProjectControls(prev, next);
    for (const op of ops) this.queue.enqueue(op);
    return ops;
  }

  enqueue(op: ControlOp): void {
    this.queue.enqueue(op);
  }

  /**
   * Compara el estado informado por el motor con el deseado y corrige las diferencias confirmadas.
   * Devuelve las claves corregidas en esta llamada.
   */
  reconcile(engine: { trackControls?: readonly EngineTrackControl[] } & EngineGlobals, project: SongProject): string[] {
    const settled = this.queue.isIdle() && this.now() - this.queue.lastSendAt >= SETTLE_MS;
    if (!settled || !engine.trackControls || engine.trackControls.length === 0) {
      this.streaks.clear();
      return [];
    }

    // Diferencias actuales, por clave de control
    const found = new Map<string, { signature: string; summary: string; op: ControlOp }>();
    for (const m of findTrackMismatches(project.tracks.map(desiredTrack), engine.trackControls)) {
      const args: Record<string, unknown> = { trackId: m.trackId };
      for (const f of m.fields) args[f] = m.desired[f];
      found.set(`track:${m.trackId}`, {
        signature: m.fields.map((f) => `${f}=${String(m.actual[f])}`).join(','),
        summary: `${m.trackId}: ${m.fields.map((f) => `${f} motor=${String(m.actual[f])} interfaz=${String(m.desired[f])}`).join(', ')}`,
        op: { key: `track:${m.trackId}`, cmd: 'audio_set_track_controls', args },
      });
    }
    const wantMaster = project.masterGain ?? DEFAULT_MASTER;
    const wantCue = project.cueMasterGain ?? DEFAULT_CUE_MASTER;
    const wantMonitor = project.monitorGain ?? DEFAULT_MONITOR;
    const masterArgs: Record<string, unknown> = {};
    if (engine.masterGain !== undefined && !sameGain(engine.masterGain, wantMaster)) masterArgs.masterGain = wantMaster;
    if (engine.cueMasterGain !== undefined && !sameGain(engine.cueMasterGain, wantCue)) masterArgs.cueMasterGain = wantCue;
    if (engine.monitorGain !== undefined && !sameGain(engine.monitorGain, wantMonitor)) masterArgs.monitorGain = wantMonitor;
    if (Object.keys(masterArgs).length > 0) {
      found.set('master', {
        signature: `master=${engine.masterGain},cue=${engine.cueMasterGain},monitor=${engine.monitorGain}`,
        summary: `ganancias maestras: motor=${engine.masterGain}/${engine.cueMasterGain}/${engine.monitorGain} interfaz=${wantMaster}/${wantCue}/${wantMonitor}`,
        op: { key: 'master', cmd: 'audio_set_master_gains', args: masterArgs },
      });
    }
    const wantPitch = project.pitchSemitones || 0;
    if (engine.pitchSemitones !== undefined && engine.pitchSemitones !== wantPitch) {
      found.set('pitch', {
        signature: `pitch=${engine.pitchSemitones}`,
        summary: `tono: motor=${engine.pitchSemitones} interfaz=${wantPitch}`,
        op: { key: 'pitch', cmd: 'audio_set_pitch', args: { semitones: wantPitch } },
      });
    }

    // Una diferencia solo se corrige si se repite en sondeos consecutivos (una orden en vuelo no cuenta)
    for (const key of [...this.streaks.keys()]) if (!found.has(key)) this.streaks.delete(key);
    const corrected: string[] = [];
    for (const [key, f] of found) {
      const streak = this.streaks.get(key);
      const count = streak && streak.signature === f.signature ? streak.count + 1 : 1;
      this.streaks.set(key, { signature: f.signature, count });
      if (count < CONFIRM_POLLS) continue;

      const t = this.now();
      const recent = (this.attempts.get(key) ?? []).filter((x) => t - x < RESYNC_WINDOW_MS);
      if (recent.length >= MAX_RESYNC_PER_WINDOW) {
        if (recent.length === MAX_RESYNC_PER_WINDOW) {
          this.recorder.rememberMismatch(`NO se pudo corregir ${f.summary} tras ${MAX_RESYNC_PER_WINDOW} intentos`);
          recent.push(t); // un solo aviso por ventana
          this.attempts.set(key, recent);
        }
        continue;
      }
      recent.push(t);
      this.attempts.set(key, recent);
      this.recorder.rememberMismatch(`corregido ${f.summary}`);
      this.queue.enqueue(f.op);
      this.streaks.delete(key);
      corrected.push(key);
    }
    return corrected;
  }
}
