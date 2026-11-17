/**
 * Motor simulado para la vista previa en el navegador (solo desarrollo, sin Tauri).
 *
 * Imita los comandos de Tauri que usa la interfaz: biblioteca de ejemplo, carga de canciones, transporte con
 * un reloj que avanza, saltos de sección, vamp y medidores animados. No emite sonido. Existe para ver y
 * medir la interfaz sin compilar el .exe. En producción esta rama se descarta (`import.meta.env.DEV`).
 */
import type { SongProject } from '../types/project';
import { createSampleLibrary, PREVIEW_SAMPLE_RATE } from './fixtures';
import { previewInvoke as remotePreviewInvoke } from '../../desktop/frontend/previewInvoke';
import { proposeRouting, validateRouting, type RoutingConfig, type RoutingInfo } from '../../desktop/frontend/routing';

type Args = Record<string, any> | undefined;

interface SectionDto {
  id: string;
  name: string;
  startSec: number;
  endSec: number;
}

interface TrackControl {
  gain: number;
  /** Entero de -100 a 100, como en el motor real. */
  pan: number;
  muted: boolean;
  soloed: boolean;
  monitor: boolean;
  splitSequence: boolean;
  cueGain: number;
  cueMuted: boolean;
  bus: string;
}

const SCAN_NAMES = [
  'Diosesamorf#-bajo-Bb-multitrack',
  'Diosesamorf#-bateria-Bb-multitrack',
  'Diosesamorf#-guitarra electrica 1-Bb-multitrack',
  'Diosesamorf#-guitarra electrica 2-Bb-multitrack',
  'Diosesamorf#-teclado-Bb-multitrack',
  'Click Track',
  'Guide',
  'Bass',
  'Drums (Live)',
  'Soprano',
];

function scannedFolder() {
  return {
    folderPath: 'C:\\Vista previa\\Friend of God',
    folderName: 'Friend of God',
    title: 'Friend of God',
    artist: 'Artista Desconocido',
    bpm: null,
    key: null,
    sections: [],
    files: SCAN_NAMES.map((name, i) => ({
      filePath: `C:\\Vista previa\\Friend of God\\${name}.wav`,
      fileName: `${name}.wav`,
      trackName: name,
      trackId: `stem-${String(i + 1).padStart(2, '0')}`,
      estDurationSec: 381.7,
      fileSize: 67_337_620,
    })),
  };
}

const savedRouting = new Map<string, RoutingConfig>();
const deviceChannels = (name: string | null) => (name && name.includes('4 salidas') ? 4 : 2);

function routingInfo(name: string | null): RoutingInfo {
  const channels = deviceChannels(name);
  const saved = savedRouting.get(name ?? '');
  const stale = Boolean(saved && saved.channels !== channels);
  const config = saved && !stale ? saved : proposeRouting(channels);
  const issues = validateRouting(config, channels);
  return {
    deviceName: name,
    host: 'WASAPI',
    deviceFound: true,
    channels,
    config,
    proposed: proposeRouting(channels),
    saved: Boolean(saved && !stale),
    stale,
    valid: issues.length === 0,
    issues,
    notes:
      channels <= 2
        ? ['Windows (WASAPI compartido) solo expone los canales que declara el controlador. Para usar más canales hace falta ASIO o un formato multicanal configurado en Windows.', 'Comprueba cada canal con el tono de prueba antes de un servicio.']
        : [`Windows expone ${channels} canales de salida en este dispositivo. Una salida de audífonos que solo replica a otra no se distingue por software.`, 'Comprueba cada canal con el tono de prueba antes de un servicio.'],
    summary: '',
  };
}

export function createPreviewBackend() {
  const library = createSampleLibrary();
  // Solo desarrollo: permite provocar a mano una diferencia entre la interfaz y el "motor" para ver la autocorrección.
  (globalThis as unknown as { __previewControls?: Map<string, TrackControl> }).__previewControls = undefined;
  const songsById = new Map<string, SongProject>(library.songs.map((s) => [s.id, s]));
  const controls = new Map<string, TrackControl>();
  (globalThis as unknown as { __previewControls?: Map<string, TrackControl> }).__previewControls = controls;

  let loadedId: string | null = null;
  let trackIds: string[] = [];
  let sections: SectionDto[] = [];
  let duration = 0;
  let playing = false;
  let position = 0;
  let lastTick = performance.now();
  let quantize: string = 'section-end';
  let queued: { sectionId: string; atSec: number; targetSec: number } | null = null;
  let vamping = false;
  let loopRange: [number, number] | null = null;
  let bpm = 120;
  let pitch = 0;
  let splitMono = false;
  let masterGain = 1;
  let cueMasterGain = 0.708;
  let monitorGain = 1;
  let callbacks = 0;
  let settings = { host: 'WASAPI', deviceName: null as string | null, sampleRate: 48000, bufferSize: null as number | null, testChannel: null as number | null };

  const sectionAt = (t: number) => sections.find((s) => t >= s.startSec && t < s.endSec) ?? null;

  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.25, (now - lastTick) / 1000);
    lastTick = now;
    callbacks += Math.round(dt * 100);
    if (!playing) return;
    const before = position;
    position += dt * Math.pow(2, pitch / 12);
    if (queued && before < queued.atSec && position >= queued.atSec) {
      position = queued.targetSec + (position - queued.atSec);
      queued = null;
    }
    if (vamping && loopRange && position >= loopRange[1]) {
      position = loopRange[0] + (position - loopRange[1]);
    }
    if (position >= duration) {
      position = duration;
      playing = false;
    }
  };

  const anySolo = () => [...controls.values()].some((c) => c.soloed);

  const meters = () => {
    const t = performance.now() / 1000;
    const solo = anySolo();
    const tracks = trackIds.map((id, i) => {
      const c = controls.get(id);
      const audible = playing && c && !(solo ? !c.soloed : c.muted);
      const level = audible ? Math.min(0.98, (0.25 + 0.35 * Math.abs(Math.sin(t * (1.3 + i * 0.37) + i))) * Math.min(2, c!.gain)) : 0;
      return { trackId: id, l: level, r: level * 0.94 };
    });
    const sum = Math.min(0.98, tracks.reduce((m, x) => Math.max(m, x.l), 0) * masterGain);
    const pair = (v: number) => ({ l: v, r: v * 0.95 });
    return { tracks, main: pair(sum), cue: pair(0), out: pair(sum), click: pair(0), clipped: false };
  };

  const snapshot = () => {
    tick();
    const sec = sectionAt(position);
    return {
      isPlaying: playing,
      isBuffering: false,
      prefillDurationMs: 0,
      deviceDisconnected: false,
      positionSec: position,
      durationSec: duration,
      currentFrame: Math.round(position * PREVIEW_SAMPLE_RATE),
      totalFrames: Math.round(duration * PREVIEW_SAMPLE_RATE),
      underruns: 0,
      callbacks,
      maxCallbackDurationUs: 0,
      minRingBufferLevelMs: null,
      activeSectionId: sec?.id ?? null,
      queuedSectionId: queued?.sectionId ?? null,
      isVamping: vamping,
      pitchSemitones: pitch,
      clickEnabled: false,
      clickGain: 1,
      quantizeMode: quantize,
      splitMono,
      masterGain,
      cueMasterGain,
      monitorGain,
      meters: meters(),
      trackControls: trackIds.map((id) => ({ trackId: id, ...(controls.get(id) as TrackControl) })),
    };
  };

  const jumpTo = (sectionId: string, mode: string) => {
    tick();
    const target = sections.find((s) => s.id === sectionId);
    if (!target) return null;
    const cur = sectionAt(position);
    if (mode === 'immediate' || !cur) {
      position = target.startSec;
      queued = null;
    } else {
      const atSec = mode === '1-bar' ? Math.ceil(position / ((60 / bpm) * 4)) * ((60 / bpm) * 4) : cur.endSec;
      queued = { sectionId, atSec, targetSec: target.startSec };
    }
    return { targetSectionId: target.id, targetSec: target.startSec };
  };

  const handlers: Record<string, (args: Args) => unknown> = {
    // ---- Biblioteca
    library_load: () => ({ ...library, updatedAt: Date.now(), songs: [...songsById.values()] }),
    library_save: (a) => {
      for (const s of a?.library?.songs ?? []) songsById.set(s.id, s);
      return null;
    },
    library_save_song: (a) => {
      if (a?.song) songsById.set(a.song.id, a.song);
      return null;
    },
    library_delete_song: (a) => {
      songsById.delete(a?.songId);
      return null;
    },
    library_update_song_folder: () => null,
    library_read_sidecar: () => null,

    // ---- Motor: carga
    audio_get_project_cache_status: (a) => ({
      isReady: true,
      cachedTracksCount: a?.trackIds?.length ?? 0,
      totalTracksCount: a?.trackIds?.length ?? 0,
    }),
    audio_load_project: (a) => {
      const song = songsById.get(a?.projectId);
      loadedId = a?.projectId ?? null;
      trackIds = song?.tracks.map((t) => t.id) ?? [];
      sections = (a?.sections ?? song?.sections.map((s) => ({ id: s.id, name: s.name, startSec: s.startTimeSec, endSec: s.endTimeSec })) ?? []).map(
        (s: any) => ({ id: s.id, name: s.name, startSec: s.startSec ?? s.start_sec, endSec: s.endSec ?? s.end_sec })
      );
      duration = song?.durationSec ?? Math.max(0, ...sections.map((s) => s.endSec));
      bpm = a?.bpm ?? song?.bpm ?? 120;
      quantize = a?.quantizeMode ?? song?.quantizeMode ?? 'section-end';
      position = 0;
      playing = false;
      queued = null;
      vamping = false;
      loopRange = null;
      for (const t of song?.tracks ?? []) controls.set(t.id, { gain: t.gain, pan: Math.round(t.pan * 100), muted: t.muted, soloed: t.soloed, monitor: false, splitSequence: false, cueGain: 1, cueMuted: false, bus: 'main' });
      const trackPeaks: Record<string, number[]> = {};
      for (const t of song?.tracks ?? []) trackPeaks[t.id] = t.peaks;
      return {
        projectId: loadedId,
        sampleRate: PREVIEW_SAMPLE_RATE,
        trackCount: trackIds.length,
        durationSec: duration,
        totalFrames: Math.round(duration * PREVIEW_SAMPLE_RATE),
        trackPeaks,
      };
    },
    audio_preload_project: () => null,
    audio_switch_to_preloaded: () => null,
    audio_configure_song: (a) => {
      if (a?.bpm) bpm = a.bpm;
      if (a?.quantizeMode) quantize = a.quantizeMode;
      return null;
    },

    // ---- Motor: transporte
    audio_play: () => {
      tick();
      if (position >= duration) position = 0;
      playing = true;
      return null;
    },
    audio_pause: () => {
      tick();
      playing = false;
      return null;
    },
    audio_stop: () => {
      playing = false;
      position = 0;
      queued = null;
      return null;
    },
    audio_seek: (a) => {
      tick();
      position = Math.max(0, Math.min(duration, a?.positionSec ?? 0));
      queued = null;
      return null;
    },
    audio_queue_jump: (a) => jumpTo(a?.sectionId, a?.mode ?? quantize),
    audio_cancel_jump: () => {
      queued = null;
      return null;
    },
    audio_toggle_vamp: (a) => {
      tick();
      vamping = a?.enable ?? !vamping;
      const cur = sectionAt(position);
      loopRange = vamping && cur ? [cur.startSec, cur.endSec] : null;
      return vamping;
    },
    audio_get_playback_state: () => snapshot(),

    // ---- Motor: mezcla
    audio_set_track_controls: (a) => {
      const c = controls.get(a?.trackId) ?? { gain: 1, pan: 0, muted: false, soloed: false, monitor: false, splitSequence: false, cueGain: 1, cueMuted: false, bus: 'main' };
      if (a?.gain != null) c.gain = a.gain;
      if (a?.monitor != null) c.monitor = Boolean(a.monitor);
      if (a?.splitSequence != null) c.splitSequence = Boolean(a.splitSequence);
      if (a?.cueGain != null) c.cueGain = a.cueGain;
      if (a?.cueMuted != null) c.cueMuted = Boolean(a.cueMuted);
      if (a?.bus != null) c.bus = a.bus;
      if (a?.pan != null) c.pan = a.pan;
      if (a?.muted != null) c.muted = a.muted;
      if (a?.soloed != null) c.soloed = a.soloed;
      controls.set(a?.trackId, c);
      return null;
    },
    audio_set_master_gains: (a) => {
      if (a?.masterGain != null) masterGain = a.masterGain;
      if (a?.cueMasterGain != null) cueMasterGain = a.cueMasterGain;
      if (a?.monitorGain != null) monitorGain = a.monitorGain;
      return null;
    },
    audio_set_pitch: (a) => {
      pitch = a?.semitones ?? 0;
      return null;
    },
    audio_set_split_mono: (a) => {
      splitMono = Boolean(a?.enabled);
      return null;
    },
    audio_set_metronome: () => null,

    // ---- Dispositivo y ajustes de audio
    audio_get_config: () => settings,
    audio_set_config: (a) => {
      settings = { ...settings, ...(a?.settings ?? a ?? {}) };
      return settings;
    },
    audio_list_hosts: () => ['WASAPI'],
    audio_list_devices: () => [
      {
        id: 'Altavoces (vista previa)', name: 'Altavoces (vista previa)', host: 'WASAPI', isDefault: true, channels: 2,
        defaultSampleRate: 48000, supportedSampleRates: [44100, 48000, 96000], minBufferSize: 64, maxBufferSize: 4096, sampleFormat: 'f32',
      },
      {
        id: 'Interfaz 4 salidas (vista previa)', name: 'Interfaz 4 salidas (vista previa)', host: 'WASAPI', isDefault: false, channels: 4,
        defaultSampleRate: 48000, supportedSampleRates: [44100, 48000, 96000], minBufferSize: 64, maxBufferSize: 4096, sampleFormat: 'f32',
      },
    ],
    audio_get_routing: (a) => routingInfo(a?.deviceName ?? null),
    audio_set_routing: (a) => {
      const name = a?.deviceName ?? null;
      const ch = deviceChannels(name);
      const cfg = { ...(a?.config as RoutingConfig), custom: true };
      if (validateRouting(cfg, ch).length === 0) savedRouting.set(name ?? '', cfg);
      const info = routingInfo(name);
      return validateRouting(cfg, ch).length === 0 ? info : { ...info, config: cfg, valid: false, issues: validateRouting(cfg, ch) };
    },
    audio_reset_routing: (a) => {
      savedRouting.delete(a?.deviceName ?? '');
      return routingInfo(a?.deviceName ?? null);
    },
    audio_reopen_stream: () => null,
    audio_test_tone: () => null,
    audio_get_stats: () => ({
      callbacks, underruns: 0, maxCallbackDurationUs: 0, lastCallbackDurationUs: 0, minRingBufferLevelMs: null,
      avgCallbackDurationUs: 0, xruns: 0, latencyMs: 10,
    }),
    audio_reset_stats: () => null,
    audio_get_cache_stats: () => ({ totalBytes: 0, projects: 0, tracks: 0 }),
    audio_clean_orphan_caches: () => 0,
    audio_delete_project_cache: () => null,
    audio_check_files_exist: (a) => Object.fromEntries((a?.paths ?? []).map((p: string) => [p, true])),
    desktop_update_check: () => null,

    // ---- Importación: selector de carpeta y escaneo simulados (nombres largos como los de un multitrack real)
    'plugin:dialog|open': () => 'C:\\Vista previa\\Friend of God',
    audio_scan_folder: () => scannedFolder(),
    audio_scan_files: () => scannedFolder(),
  };

  const invoke = async <T,>(command: string, args?: Args): Promise<T> => {
    const handler = handlers[command];
    if (handler) return handler(args) as T;
    if (command.startsWith('remote_')) return remotePreviewInvoke<T>(command, args as any);
    // Comando que la vista previa no simula (importar, diálogos de archivos…): no hace nada.
    console.debug(`[Vista previa] comando no simulado: ${command}`, args);
    return null as T;
  };

  return {
    invoke,
    listen: async (_event: string, _handler: (e: unknown) => void) => () => {},
  };
}
