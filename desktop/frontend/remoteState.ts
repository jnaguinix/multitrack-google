
import type { SongProject, SongSection, TransportState } from '../../src/types/project';

export type Command =
  | { type: 'setTrackGain'; revision: number; trackIndex: number; gain: number }
  | { type: 'setTrackMute'; revision: number; trackIndex: number; muted: boolean }
  | { type: 'setTrackPan'; revision: number; trackIndex: number; pan: number }
  | { type: 'setTrackSolo'; revision: number; trackIndex: number; soloed: boolean };

export interface Dispatch {
  id: number;
  projectId: string;
  trackId: string;
  command: Command;
}

export interface Receipt {
  id: number;
  outcome: 'applied' | 'stale' | 'superseded' | 'unconfirmed';
}

export type Source = {
  project: SongProject | null;
  setlist: SongProject[];
  activating: boolean;
};

export type Clock = {
  positionSec: number;
  durationSec: number;
  sampledAtMs: number;
  rate: number;
  playing: boolean;
};

export function trackIdentity(project: SongProject | null): string {
  return JSON.stringify(project ? [project.id, project.tracks.map((track) => track.id)] : null);
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff ? value : fallback;
}

function song(project: SongProject | undefined | null) {
  return project ? {
    id: project.id,
    title: project.title,
    key: project.keySignature || '—',
    bpm: Number.isFinite(project.bpm) && project.bpm > 0 ? project.bpm : 120,
    beatsPerBar: positiveInteger(project.beatsPerBar, 4),
    beatUnit: positiveInteger(project.beatUnit, 4),
  } : null;
}

function section(section: SongSection | undefined) {
  return section ? { name: section.name, startSec: section.startTimeSec } : null;
}

/** Mapa de secciones para los teléfonos: nombre, tramo y color, ordenadas por inicio. */
function sectionMap(project: SongProject | null | undefined) {
  return [...(project?.sections ?? [])]
    .sort((a, b) => a.startTimeSec - b.startTimeSec)
    .map((entry) => ({
      name: entry.name,
      startSec: entry.startTimeSec,
      endSec: entry.endTimeSec,
      color: entry.color || '',
    }));
}

export function snapshot(
  source: Source,
  transport: TransportState,
  revision: number,
  previousClock: Clock | undefined,
  nowMs: number,
) {
  const { project, setlist, activating } = source;
  const currentIndex = project ? setlist.findIndex((entry) => entry.id === project.id) : -1;
  const active = project?.sections.find((entry) => entry.id === transport.activeSectionId);
  const upcoming = project?.sections.reduce<SongSection | undefined>((next, candidate) => {
    const after = active?.startTimeSec ?? transport.currentTimeSec;
    return candidate.startTimeSec > after && (!next || candidate.startTimeSec < next.startTimeSec)
      ? candidate : next;
  }, undefined);
  const queued = section(project?.sections.find((entry) => entry.id === transport.queuedSectionId));
  const playing = Boolean(project && transport.isPlaying && !activating && !transport.isMountingSong);
  // El tono ya no altera la velocidad: la canción avanza un segundo por segundo (antes subía 2^(tono/12)).
  const rate = playing ? 1 : 0;
  const positionSec = project ? transport.currentTimeSec : 0;
  const durationSec = project ? transport.totalDurationSec : 0;
  const elapsedMs = previousClock ? nowMs - previousClock.sampledAtMs : 0;
  const predicted = previousClock ? previousClock.positionSec + elapsedMs / 1000 * previousClock.rate : 0;
  const canReuse = previousClock && previousClock.playing === playing && previousClock.rate === rate
    && previousClock.durationSec === durationSec
    && (playing ? elapsedMs >= 0 && elapsedMs < 1000 && Math.abs(predicted - positionSec) < 0.12
      : previousClock.positionSec === positionSec);

  return {
    revision,
    acceptingCommands: Boolean(project && !activating && !transport.isMountingSong),
    currentSong: song(project),
    nextSong: song(setlist[currentIndex + 1]),
    setlist: setlist.map(song),
    currentSection: section(active),
    nextSection: section(upcoming),
    queuedJump: queued && { section: queued, targetBar: transport.queuedTargetBar },
    sections: sectionMap(project),
    vamping: transport.isVamping,
    clock: canReuse ? previousClock : { positionSec, durationSec, sampledAtMs: nowMs, rate, playing },
    tracks: project?.tracks.map(({ id, name, color, gain, muted, pan, soloed }) => ({
      id, name, color: color || '', gain, muted, pan: Number.isFinite(pan) ? pan : 0, soloed: Boolean(soloed),
    })) ?? [],
  };
}

export function targets(command: Dispatch, project: SongProject | null, revision: number): boolean {
  return project?.id === command.projectId
    && command.command.revision === revision
    && project?.tracks[command.command.trackIndex]?.id === command.trackId;
}

/**
 * Qué acuse corresponde a un comando remoto pendiente (`null` = todavía no se puede decir, se espera).
 * `applied` exige las dos cosas: que el estado de la interfaz ya refleje el cambio Y que el motor haya confirmado
 * todas las órdenes enviadas sin rechazar ninguna desde el envío del comando (plan 3.3, H19). Antes bastaba lo
 * primero, y el teléfono veía «aplicado» con la orden aún en la cola o rechazada por el motor.
 */
export function receiptFor(
  _command: Dispatch,
  ctx: {
    targets: boolean;
    matches: boolean;
    engine: { idle: boolean; errors: number };
    errorsAtDispatch: number;
    pastDeadline: boolean;
  },
): Receipt['outcome'] | null {
  if (!ctx.targets) return 'stale';
  if (ctx.engine.errors > ctx.errorsAtDispatch) return 'unconfirmed';
  if (ctx.matches && ctx.engine.idle) return 'applied';
  return ctx.pastDeadline ? 'unconfirmed' : null;
}

export function matches(command: Dispatch, project: SongProject): boolean {
  const track = project.tracks[command.command.trackIndex];
  const [field, value] = mixChange(command.command);
  return track[field] === value;
}

function mixChange(command: Command) {
  switch (command.type) {
    case 'setTrackGain': return ['gain', command.gain] as const;
    case 'setTrackMute': return ['muted', command.muted] as const;
    case 'setTrackPan': return ['pan', command.pan] as const;
    case 'setTrackSolo': return ['soloed', command.soloed] as const;
  }
}

export function applyMix(project: SongProject, commands: Dispatch[]): SongProject {
  const tracks = [...project.tracks];
  for (const { command } of commands) {
    const [field, value] = mixChange(command);
    tracks[command.trackIndex] = { ...tracks[command.trackIndex], [field]: value };
  }
  return { ...project, tracks };
}
