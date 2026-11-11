import React, { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Sliders,
  Volume2,
  Check,
  AlertTriangle,
  Info,
  RefreshCw,
  X,
  Activity,
  Play,
  Pause,
  Square,
  FolderOpen,
  ChevronDown,
  RotateCcw,
} from 'lucide-react';
import { loadAllProjectsFromDb, loadProjectStemsFromDb, extractStemArrayBuffer } from '../../src/storage/projectDb';
import { SongProject } from '../../src/types/project';
import './connection.css';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface AudioDeviceInfo {
  id: string;
  name: string;
  host: string;
  isDefault: boolean;
  channels: number;
  defaultSampleRate: number;
  supportedSampleRates: number[];
  minBufferSize: number | null;
  maxBufferSize: number | null;
  sampleFormat: string;
}

interface AudioSettings {
  host: string;
  deviceName: string | null;
  sampleRate: number | null;
  bufferSize: number | null;
  testChannel: number | null;
}

interface AudioStreamStatsSnapshot {
  underruns: number;
  callbacks: number;
  maxCallbackDurationUs: number;
  minRingBufferLevelMs?: number | null;
  maxFeederBlockDurationUs?: number;
}

interface PlaybackStateSnapshot {
  isPlaying: boolean;
  isBuffering?: boolean;
  prefillDurationMs?: number;
  positionSec: number;
  durationSec: number;
  currentFrame: number;
  totalFrames: number;
  underruns: number;
  callbacks: number;
  maxCallbackDurationUs: number;
  maxFeederBlockDurationUs?: number;
  minRingBufferLevelMs?: number | null;
  activeSectionId?: string | null;
  queuedSectionId?: string | null;
  isVamping?: boolean;
  pitchSemitones?: number;
  clickEnabled?: boolean;
  clickGain?: number;
  clickSubdivision?: number;
  quantizeMode?: string;
  splitMono?: boolean;
  masterGain?: number;
  cueMasterGain?: number;
}

interface TestToneResult {
  success: boolean;
  channel: number;
  channels: number;
  sampleRate: number;
  durationMs: number;
}

interface Props {
  triggerHost: HTMLElement | null;
}

const host = window as Window & { __TAURI__?: { core: { invoke: Invoke } } };
const invoke = host.__TAURI__?.core.invoke;

export default memo(function DesktopAudioSettings({ triggerHost }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [hosts, setHosts] = useState<string[]>(['WASAPI']);
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [selectedHost, setSelectedHost] = useState('WASAPI');
  const [selectedDeviceName, setSelectedDeviceName] = useState<string>('');
  const [selectedChannel, setSelectedChannel] = useState<number>(0);
  const [isPlayingTestTone, setIsPlayingTestTone] = useState(false);
  const [savingNotice, setSavingNotice] = useState('');
  const [statusNotice, setStatusNotice] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const [stats, setStats] = useState<AudioStreamStatsSnapshot>({
    underruns: 0,
    callbacks: 0,
    maxCallbackDurationUs: 0,
    minRingBufferLevelMs: null,
  });

  const pollStats = async () => {
    if (!invoke) return;
    try {
      const s = await invoke<AudioStreamStatsSnapshot>('audio_get_stats');
      if (s) setStats(s);
    } catch {
      // ignore
    }
  };

  const handleResetStats = async () => {
    if (!invoke) return;
    try {
      await invoke('audio_reset_stats');
      const s = await invoke<AudioStreamStatsSnapshot>('audio_get_stats');
      if (s) setStats(s);
    } catch {
      // ignore
    }
  };

  const [songProjects, setSongProjects] = useState<SongProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [playbackState, setPlaybackState] = useState<PlaybackStateSnapshot>({
    isPlaying: false,
    positionSec: 0,
    durationSec: 0,
    currentFrame: 0,
    totalFrames: 0,
    underruns: 0,
    callbacks: 0,
    maxCallbackDurationUs: 0,
  });
  const [isNativeLoaded, setIsNativeLoaded] = useState(false);
  const [nativeNotice, setNativeNotice] = useState('');
  const [isStressTesting, setIsStressTesting] = useState(false);
  const [stressNotice, setStressNotice] = useState('');
  const [seekInputSec, setSeekInputSec] = useState(0);
  const [isDraggingSeek, setIsDraggingSeek] = useState(false);
  const [preloadProjectId, setPreloadProjectId] = useState<string>('');
  const [isPreloading, setIsPreloading] = useState(false);
  const [switchDurationMs, setSwitchDurationMs] = useState<number | null>(null);

  const [loadErrorDetails, setLoadErrorDetails] = useState<string | null>(null);
  const [isGeneratingCache, setIsGeneratingCache] = useState(false);
  const [cacheProgressText, setCacheProgressText] = useState('');
  const [cacheProgressPercent, setCacheProgressPercent] = useState(0);

  const [splitMono, setSplitMono] = useState(() => localStorage.getItem('omnitracks_split_mono') === 'true');
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);

  const [selectedSectionId, setSelectedSectionId] = useState<string>('');
  const [quantizeMode, setQuantizeMode] = useState<string>('1-bar');
  const [clickEnabled, setClickEnabled] = useState(true);
  const [clickGain, setClickGain] = useState(0.8);
  const [clickSubdiv, setClickSubdiv] = useState<1 | 2>(1);
  const [pitchSemitones, setPitchSemitones] = useState(0);

  const currentProject = songProjects.find((p) => p.id === selectedProjectId);

  const activeDevice = devices.find((d) => d.name === selectedDeviceName) || devices.find((d) => d.isDefault) || devices[0];

  const loadAudioConfig = async () => {
    if (!invoke) return;
    setIsLoading(true);
    setStatusNotice('');
    try {
      const [availableHosts, availableDevices, savedConfig] = await Promise.all([
        invoke<string[]>('audio_list_hosts').catch(() => ['WASAPI']),
        invoke<AudioDeviceInfo[]>('audio_list_devices', { host: selectedHost }).catch(() => []),
        invoke<AudioSettings>('audio_get_config').catch(() => ({
          host: 'WASAPI',
          deviceName: null,
          sampleRate: null,
          bufferSize: null,
          testChannel: 0,
        })),
      ]);

      setHosts(availableHosts);
      setDevices(availableDevices);

      try {
        const projs = await loadAllProjectsFromDb();
        setSongProjects(projs);
        if (projs.length > 0 && !selectedProjectId) {
          setSelectedProjectId(projs[0].id);
        }
      } catch {
        // ignore
      }

      if (savedConfig.deviceName && availableDevices.some((d) => d.name === savedConfig.deviceName)) {
        setSelectedDeviceName(savedConfig.deviceName);
      } else {
        const defaultDev = availableDevices.find((d) => d.isDefault) || availableDevices[0];
        if (defaultDev) {
          setSelectedDeviceName(defaultDev.name);
        }
      }

      if (typeof savedConfig.testChannel === 'number') {
        setSelectedChannel(savedConfig.testChannel);
      }
    } catch (err) {
      setStatusNotice('Error al consultar dispositivos de audio.');
      console.warn('Audio settings load error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleHostChange = async (hostName: string) => {
    setSelectedHost(hostName);
    if (!invoke) return;
    try {
      const devList = await invoke<AudioDeviceInfo[]>('audio_list_devices', { host: hostName });
      setDevices(devList);
      const def = devList.find((d) => d.isDefault) || devList[0];
      if (def) setSelectedDeviceName(def.name);
    } catch {
      // ignore
    }
  };

  const handleDeviceChange = (deviceName: string) => {
    setSelectedDeviceName(deviceName);
    setSelectedChannel(0);
  };

  useEffect(() => {
    if (invoke) {
      void loadAudioConfig();
    }
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    if (invoke) {
      timer = window.setInterval(async () => {
        try {
          const pb = await invoke<PlaybackStateSnapshot>('audio_get_playback_state');
          if (pb) {
            setPlaybackState(pb);
            if (pb.isPlaying && !isDraggingSeek) {
              setSeekInputSec(Math.round(pb.positionSec * 10) / 10);
            } else if (!pb.isPlaying && pb.currentFrame === 0 && !isDraggingSeek) {
              setSeekInputSec(0);
            }
            if (typeof pb.pitchSemitones === 'number') {
              setPitchSemitones(pb.pitchSemitones);
            }
            if (typeof pb.clickEnabled === 'boolean') {
              setClickEnabled(pb.clickEnabled);
            }
            if (typeof pb.clickGain === 'number') {
              setClickGain(pb.clickGain);
            }
            if (typeof pb.clickSubdivision === 'number') {
              setClickSubdiv(pb.clickSubdivision as 1 | 2);
            }
          }
          const s = await invoke<AudioStreamStatsSnapshot>('audio_get_stats');
          if (s) setStats(s);
        } catch {
          // ignore
        }
      }, 250);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isDraggingSeek]);

  const handleNativeLoad = async () => {
    if (!invoke || !selectedProjectId) return;
    setNativeNotice('Cargando pistas...');
    setLoadErrorDetails(null);
    try {
      const currentProj = songProjects.find((p) => p.id === selectedProjectId);
      const nativeSections = (currentProj?.sections || []).map((s) => ({
        id: s.id,
        name: s.name,
        code: (s as any).code || null,
        startSec: s.startTimeSec,
        endSec: s.endTimeSec,
      }));

      const res: any = await invoke('audio_load_project', {
        projectId: selectedProjectId,
        bpm: currentProj?.bpm || 120,
        beatsPerBar: currentProj?.beatsPerBar || 4,
        sections: nativeSections,
        quantizeMode: currentProj?.quantizeMode || quantizeMode || '1-bar',
      });
      setIsNativeLoaded(true);
      setNativeNotice(`Cargadas ${res.trackCount} pistas (${res.durationSec.toFixed(1)}s)`);

      if (currentProj?.sections && currentProj.sections.length > 0) {
        setSelectedSectionId(currentProj.sections[0].id);
      }

      await invoke('audio_set_split_mono', { enabled: splitMono });
      pollStats();
    } catch (err: any) {
      const errMsg = String(err);
      setNativeNotice(`Error cargando: ${errMsg}`);
      setLoadErrorDetails(errMsg);
    }
  };

  const handleQueueJump = async (sectionId: string) => {
    if (!invoke || !sectionId) return;
    try {
      const res: any = await invoke('audio_queue_jump', { sectionId, mode: quantizeMode });
      setNativeNotice(`Salto en cola -> ${res?.targetSectionId || sectionId} (${quantizeMode})`);
      setLoadErrorDetails(null);
    } catch (err: any) {
      const errMsg = `Error en salto: ${err instanceof Error ? err.message : String(err)}`;
      setNativeNotice(errMsg);
      setLoadErrorDetails(errMsg);
    }
  };

  const handleCancelJump = async () => {
    if (!invoke) return;
    try {
      await invoke('audio_cancel_jump');
      setNativeNotice('Salto cancelado');
    } catch (err: any) {
      const errMsg = `Error cancelando salto: ${err instanceof Error ? err.message : String(err)}`;
      setNativeNotice(errMsg);
    }
  };

  const handleToggleVamp = async () => {
    if (!invoke) return;
    try {
      const newVamp: boolean = await invoke('audio_toggle_vamp', { enable: !playbackState.isVamping });
      setNativeNotice(newVamp ? 'Vamp activado en bucle' : 'Vamp desactivado');
    } catch (err: any) {
      const errMsg = `Error alternando vamp: ${err instanceof Error ? err.message : String(err)}`;
      setNativeNotice(errMsg);
    }
  };

  const handlePreloadSong = async () => {
    if (!invoke || !preloadProjectId) return;
    setIsPreloading(true);
    setNativeNotice('Precargando siguiente canción...');
    try {
      await invoke('audio_preload_project', { projectId: preloadProjectId });
      const pTitle = songProjects.find((p) => p.id === preloadProjectId)?.title || preloadProjectId;
      setNativeNotice(`Precargada: ${pTitle}`);
    } catch (err: any) {
      const errMsg = `Error precargando: ${String(err)}`;
      setNativeNotice(errMsg);
      setLoadErrorDetails(errMsg);
    } finally {
      setIsPreloading(false);
    }
  };

  const handleSwitchToPreloaded = async () => {
    if (!invoke) return;
    setNativeNotice('Cambiando a canción precargada...');
    const t0 = performance.now();
    try {
      const res: any = await invoke('audio_switch_to_preloaded');
      const dur = Math.round(performance.now() - t0);
      setSwitchDurationMs(dur);
      if (res?.projectId) {
        setSelectedProjectId(res.projectId);
      }
      setIsNativeLoaded(true);
      setNativeNotice(`Cambio instantáneo en ${dur} ms (${res?.trackCount || 0} pistas)`);
    } catch (err: any) {
      const errMsg = `Error cambiando a precargada: ${String(err)}`;
      setNativeNotice(errMsg);
      setLoadErrorDetails(errMsg);
    }
  };

  const handlePitchChange = async (st: number) => {
    setPitchSemitones(st);
    if (!invoke) return;
    try {
      await invoke('audio_set_pitch', { semitones: st });
    } catch (err) {
      console.warn('Error cambiando tono:', err);
    }
  };

  const handleMetronomeChange = async (enabled: boolean, gain: number, subdivision: number) => {
    setClickEnabled(enabled);
    setClickGain(gain);
    setClickSubdiv(subdivision as 1 | 2);
    if (!invoke) return;
    try {
      await invoke('audio_set_metronome', {
        config: {
          enabled,
          bpm: currentProject?.bpm || 120,
          beatsPerBar: currentProject?.beatsPerBar || 4,
          subdivision,
          gain,
          splitMono,
        },
      });
    } catch (err) {
      console.warn('Error configurando metrónomo:', err);
    }
  };

  const handleSplitMonoChange = async (enabled: boolean) => {
    setSplitMono(enabled);
    localStorage.setItem('omnitracks_split_mono', String(enabled));
    if (invoke) {
      try {
        await invoke('audio_set_split_mono', { enabled });
      } catch (err) {
        console.warn('Error cambiando split-mono:', err);
      }
    }
  };

  const handleGenerateNativeCache = async () => {
    if (!invoke || !selectedProjectId) return;
    setIsGeneratingCache(true);
    setCacheProgressPercent(0);
    setCacheProgressText('Leyendo stems de la biblioteca...');
    setLoadErrorDetails(null);
    try {
      const stems = await loadProjectStemsFromDb(selectedProjectId);
      if (!stems || stems.length === 0) {
        setLoadErrorDetails('No se encontraron stems en memoria para este proyecto. Usa el botón de carpeta para decodificar desde disco.');
        setIsGeneratingCache(false);
        return;
      }

      const total = stems.length;
      let completed = 0;
      const targetSr = activeDevice?.defaultSampleRate || 48000;

      for (let i = 0; i < total; i++) {
        const stem = stems[i];
        const label = stem.fileName || stem.trackId;
        setCacheProgressText(`Decodificando "${label}" (${i + 1}/${total})...`);
        setCacheProgressPercent(Math.round(((i) / total) * 100));

        const arrayBuf = await extractStemArrayBuffer(stem);
        if (!arrayBuf || arrayBuf.byteLength === 0) {
          continue;
        }

        const bytes = Array.from(new Uint8Array(arrayBuf));
        await invoke('audio_import_track_bytes', {
          projectId: selectedProjectId,
          trackId: stem.trackId,
          fileName: stem.fileName || `${stem.trackId}.mp3`,
          bytes,
          targetSampleRate: targetSr,
        });
        completed++;
      }

      if (completed === 0) {
        setLoadErrorDetails('Los stems almacenados no tenían buffer en memoria. Selecciona la carpeta original desde disco.');
        setIsGeneratingCache(false);
        return;
      }

      setCacheProgressPercent(100);
      setCacheProgressText(`¡Caché generada para ${completed} pistas!`);
      setTimeout(() => {
        setIsGeneratingCache(false);
        void handleNativeLoad();
      }, 500);
    } catch (err: any) {
      setLoadErrorDetails(`Error generando caché: ${err}`);
      setIsGeneratingCache(false);
    }
  };

  const handleImportFromFolder = async () => {
    if (!invoke || !selectedProjectId) return;
    try {
      const selected = await invoke<any>('plugin:dialog|open', {
        options: {
          directory: true,
          multiple: false,
          title: 'Seleccionar carpeta de la canción multitrack',
        },
      });

      const folderPath =
        typeof selected === 'string'
          ? selected
          : selected?.path || (Array.isArray(selected) ? selected[0] : null);

      if (!folderPath) return;

      setIsGeneratingCache(true);
      setCacheProgressText(`Decodificando archivos en "${folderPath}"...`);
      setCacheProgressPercent(25);
      setLoadErrorDetails(null);

      const targetSr = activeDevice?.defaultSampleRate || 48000;
      const res: any = await invoke('audio_import_folder', {
        projectId: selectedProjectId,
        folderPath,
        targetSampleRate: targetSr,
      });

      setCacheProgressPercent(100);
      setCacheProgressText(`¡${res.tracks?.length || 0} pistas procesadas!`);
      setTimeout(() => {
        setIsGeneratingCache(false);
        void handleNativeLoad();
      }, 500);
    } catch (err: any) {
      setLoadErrorDetails(`Error importando carpeta: ${err}`);
      setIsGeneratingCache(false);
    }
  };

  const handleNativePlay = async () => {
    if (!invoke) return;
    try {
      await invoke('audio_play');
      setNativeNotice('Reproduciendo');
    } catch (err: any) {
      setNativeNotice(`Error: ${err}`);
    }
  };

  const handleNativePause = async () => {
    if (!invoke) return;
    try {
      await invoke('audio_pause');
      setNativeNotice('En pausa');
    } catch (err: any) {
      setNativeNotice(`Error: ${err}`);
    }
  };

  const handleNativeStop = async () => {
    if (!invoke) return;
    try {
      await invoke('audio_stop');
      setSeekInputSec(0);
      setNativeNotice('Detenido');
    } catch (err: any) {
      setNativeNotice(`Error: ${err}`);
    }
  };

  const handleNativeSeek = async (sec: number) => {
    if (!invoke) return;
    try {
      await invoke('audio_seek', { positionSec: sec });
    } catch (err: any) {
      setNativeNotice(`Error seek: ${err}`);
    }
  };

  const handleStressTest = () => {
    setIsStressTesting(true);
    setStressNotice('Probando aislamiento de hilo UI (3s)...');
    setTimeout(() => {
      const t0 = performance.now();
      let operations = 0;
      while (performance.now() - t0 < 3000) {
        operations += Math.sqrt(Math.random());
      }
      pollStats().then(() => {
        setIsStressTesting(false);
        setStressNotice(`Carga completada (${Math.round(operations).toLocaleString()} ops). Comprueba si hubo cortes.`);
      });
    }, 60);
  };

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`;
  };

  const handleTestTone = async () => {
    if (!invoke || !activeDevice) return;
    setIsPlayingTestTone(true);
    setStatusNotice(`Tono 440 Hz en Salida ${selectedChannel + 1}...`);

    try {
      await invoke<TestToneResult>('audio_test_tone', {
        deviceName: activeDevice.name,
        channel: selectedChannel,
        frequency: 440.0,
        durationMs: 1200,
      });

      void pollStats();

      setTimeout(() => {
        setIsPlayingTestTone(false);
        setStatusNotice(`Tono completado en Salida ${selectedChannel + 1}.`);
        void pollStats();
      }, 1250);
    } catch (err) {
      setIsPlayingTestTone(false);
      setStatusNotice(`Fallo al reproducir tono: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSaveConfig = async () => {
    if (!invoke) return;
    setSavingNotice('Guardando...');
    try {
      const settingsToSave: AudioSettings = {
        host: selectedHost,
        deviceName: activeDevice ? activeDevice.name : null,
        sampleRate: activeDevice ? activeDevice.defaultSampleRate : null,
        bufferSize: activeDevice?.minBufferSize ?? null,
        testChannel: selectedChannel,
      };

      await invoke('audio_set_config', { settings: settingsToSave });
      setSavingNotice('Guardado');
      setTimeout(() => setSavingNotice(''), 2500);
    } catch (err) {
      setSavingNotice(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const isCaseA = Boolean(activeDevice && activeDevice.channels >= 4);

  const isCaseB = (() => {
    if (isCaseA || !activeDevice || devices.length < 2) return false;

    const pairRegex = /(?:(?:\b(?:out|ch|line|salida)\s*)?(?:[1-9]\s*[-/]\s*[1-9]))/i;

    const getBaseHardwareName = (name: string) => {
      return name
        .replace(/\((?:[^)]*?(?:1\/2|3\/4|5\/6|7\/8|1-2|3-4|5-6|7-8|out|ch|line)[^)]*?)\)/gi, '')
        .replace(/(?:out|line|salida|ch|canales)?\s*[1-9]\s*[-/]\s*[1-9]/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    };

    const activeBase = getBaseHardwareName(activeDevice.name);
    if (!activeBase || activeBase.length < 3) return false;

    const matchingSiblings = devices.filter((d) => {
      const dBase = getBaseHardwareName(d.name);
      return dBase === activeBase && (pairRegex.test(d.name) || pairRegex.test(activeDevice.name));
    });

    return matchingSiblings.length >= 2;
  })();

  const isCaseC = !isCaseA && !isCaseB && Boolean(activeDevice && activeDevice.channels === 2);

  return (
    <>
      {triggerHost &&
        createPortal(
          <button
            type="button"
            className="lt-control lt-icon-control"
            aria-label="Audio"
            title="Audio"
            onClick={() => {
              dialogRef.current?.showModal();
              void loadAudioConfig();
            }}
          >
            <Sliders size={17} aria-hidden="true" />
          </button>,
          triggerHost
        )}

      <dialog
        ref={dialogRef}
        id="desktop-audio-dialog"
        className="fixed inset-0 m-auto z-50 bg-studio-panel border border-neutral-800 rounded-2xl w-full max-w-xl p-5 space-y-3 shadow-2xl backdrop:bg-black/70 text-neutral-100 overflow-hidden"
        aria-labelledby="desktop-audio-title"
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* 1. Cabecera: título «Audio» y botón de cerrar */}
        <div className="flex items-center justify-between pb-2.5 border-b border-neutral-800">
          <div className="flex items-center gap-2">
            <Volume2 className="w-4 h-4 text-studio-ink" />
            <h2 id="desktop-audio-title" className="text-base font-bold text-neutral-100">
              Audio
            </h2>
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="text-neutral-400 hover:text-white p-1 cursor-pointer rounded-lg hover:bg-neutral-800 transition-colors"
            aria-label="Cerrar modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 2. Dispositivo, en una sola fila: driver (estrecho), dispositivo (ancho) y refrescar */}
        <div className="flex items-center gap-2">
          <div className="w-24 shrink-0">
            <select
              value={selectedHost}
              onChange={(e) => void handleHostChange(e.target.value)}
              className="w-full bg-studio-strip border border-studio-line rounded-lg px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-neutral-500 cursor-pointer"
            >
              {hosts.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-0">
            <select
              value={selectedDeviceName}
              onChange={(e) => handleDeviceChange(e.target.value)}
              className="w-full bg-studio-strip border border-studio-line rounded-lg px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-neutral-500 truncate cursor-pointer"
            >
              {devices.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name} {d.isDefault ? '(Predeterminado)' : ''}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => void loadAudioConfig()}
            title="Refrescar lista de dispositivos"
            className="p-2 rounded-lg bg-studio-strip hover:bg-neutral-800 border border-studio-line text-neutral-400 hover:text-white shrink-0 cursor-pointer transition-colors"
          >
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* 3. Resumen del dispositivo, en una sola línea de texto pequeño */}
        {activeDevice && (
          <div className="text-[11px] text-neutral-400 font-mono">
            {activeDevice.channels} salidas · {activeDevice.defaultSampleRate.toLocaleString('es-ES')} Hz · búfer {activeDevice.minBufferSize ?? 480} ({Math.round(((activeDevice.minBufferSize ?? 480) / (activeDevice.defaultSampleRate || 48000)) * 1000)} ms) · {activeDevice.sampleFormat || 'f32'}
          </div>
        )}

        {/* 4. Aviso del caso A, B o C: una sola línea con icono pequeño */}
        {activeDevice && (
          <div className="flex items-center justify-between text-xs text-neutral-300 min-h-[22px]">
            {isCaseA && (
              <div className="flex items-center gap-1.5">
                <Check size={13} className="text-emerald-400 shrink-0" />
                <span>Caso A: Dispositivo multicanal unificado ({activeDevice.channels} salidas disponibles).</span>
              </div>
            )}
            {isCaseB && (
              <div className="flex items-center gap-1.5">
                <AlertTriangle size={13} className="text-amber-400 shrink-0" />
                <span>Caso B: Salidas estéreo separadas. Usa ASIO para todas simultáneas.</span>
              </div>
            )}
            {isCaseC && (
              <>
                <div className="flex items-center gap-1.5">
                  <Info size={13} className="text-neutral-400 shrink-0" />
                  <span>Caso C: Salida estéreo (2 canales).</span>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-neutral-300 cursor-pointer select-none ml-auto">
                  <input
                    type="checkbox"
                    checked={splitMono}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      void handleSplitMonoChange(checked);
                    }}
                    className="rounded border-neutral-700 bg-neutral-900 text-studio-ink focus:ring-0 cursor-pointer"
                  />
                  <span>Split-Mono</span>
                </label>
              </>
            )}
          </div>
        )}

        {/* 5. Prueba de salida: en la misma fila, selector de canal y botón «Probar» */}
        {activeDevice && (
          <div className="flex items-center gap-2 pt-0.5">
            <span className="text-xs text-neutral-400 shrink-0">Prueba de salida:</span>
            <select
              value={selectedChannel}
              onChange={(e) => setSelectedChannel(Number(e.target.value))}
              className="bg-studio-strip border border-studio-line rounded-lg px-2.5 py-1 text-xs text-neutral-200 focus:outline-none focus:border-neutral-500 cursor-pointer"
            >
              {Array.from({ length: activeDevice.channels }).map((_, idx) => (
                <option key={idx} value={idx}>
                  Salida {idx + 1} ({idx === 0 ? 'Left' : idx === 1 ? 'Right' : `Canal ${idx + 1}`})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleTestTone()}
              disabled={isPlayingTestTone}
              className="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-colors shrink-0"
            >
              <Play size={11} className={isPlayingTestTone ? 'animate-pulse text-amber-400' : ''} />
              <span>{isPlayingTestTone ? 'Probando...' : 'Probar'}</span>
            </button>
            {statusNotice && (
              <span className="text-[11px] text-neutral-400 truncate flex-1">{statusNotice}</span>
            )}
          </div>
        )}

        {/* 6. Sección plegable «Diagnóstico», cerrada por defecto (Se retirará en Fase 6) */}
        <div className="border-t border-neutral-800 pt-2 space-y-2">
          <button
            type="button"
            onClick={() => setIsDiagnosticsOpen(!isDiagnosticsOpen)}
            className="flex items-center justify-between w-full text-xs font-semibold text-neutral-400 hover:text-neutral-200 py-0.5 cursor-pointer select-none transition-colors"
          >
            <div className="flex items-center gap-1.5">
              <Activity size={13} className="text-neutral-400" />
              <span>Diagnóstico</span>
            </div>
            <ChevronDown
              size={13}
              className={`text-neutral-400 transition-transform ${isDiagnosticsOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {isDiagnosticsOpen && (
            <div className="space-y-2 pt-1">
              {/* Fila 1: Canción + Cargar + Botones de Caché + Estado */}
              <div className="flex items-center gap-2">
                <select
                  value={selectedProjectId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedProjectId(id);
                    const p = songProjects.find((x) => x.id === id);
                    if (p?.sections?.length) {
                      setSelectedSectionId(p.sections[0].id);
                    } else {
                      setSelectedSectionId('');
                    }
                    setIsNativeLoaded(false);
                    setLoadErrorDetails(null);
                    setNativeNotice('');
                  }}
                  className="flex-1 min-w-0 bg-studio-strip border border-studio-line rounded-lg px-2.5 py-1 text-xs text-neutral-200 truncate cursor-pointer"
                >
                  <option value="">Seleccionar canción...</option>
                  {songProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleNativeLoad}
                  disabled={!selectedProjectId}
                  className="px-2.5 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-neutral-200 cursor-pointer disabled:opacity-50 shrink-0"
                >
                  Cargar
                </button>
                {selectedProjectId && !isNativeLoaded && (
                  <>
                    <button
                      type="button"
                      onClick={handleGenerateNativeCache}
                      disabled={isGeneratingCache}
                      className="px-2.5 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-300 cursor-pointer disabled:opacity-50 shrink-0"
                      title="Generar caché nativa a 48 kHz desde IndexedDB"
                    >
                      {isGeneratingCache ? 'Generando...' : 'Generar caché'}
                    </button>
                    <button
                      type="button"
                      onClick={handleImportFromFolder}
                      disabled={isGeneratingCache}
                      className="p-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 cursor-pointer disabled:opacity-50 shrink-0"
                      title="Seleccionar carpeta de la canción multitrack en disco"
                    >
                      <FolderOpen size={13} />
                    </button>
                  </>
                )}
                {nativeNotice && (
                  <span className="text-[11px] text-neutral-400 truncate shrink-0 max-w-[140px]">
                    {nativeNotice}
                  </span>
                )}
              </div>

              {/* Progreso de generación si está activa */}
              {isGeneratingCache && (
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-neutral-400">
                    <span className="truncate">{cacheProgressText}</span>
                    <span>{cacheProgressPercent}%</span>
                  </div>
                  <div className="h-1 bg-neutral-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-studio-ink transition-all duration-200"
                      style={{ width: `${cacheProgressPercent}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Detalle de error si existe */}
              {loadErrorDetails && (
                <div className="text-[11px] text-rose-400 bg-rose-950/20 border border-rose-900/40 rounded px-2 py-1 truncate">
                  {loadErrorDetails}
                </div>
              )}

              {/* Fila 2: Transporte + Barra de posición + Carga UI */}
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={handleNativePlay}
                    disabled={!isNativeLoaded}
                    className="p-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 disabled:opacity-40 cursor-pointer"
                    title="Play"
                  >
                    <Play size={12} className={playbackState.isPlaying ? 'text-emerald-400' : ''} />
                  </button>
                  <button
                    type="button"
                    onClick={handleNativePause}
                    disabled={!isNativeLoaded}
                    className="p-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 disabled:opacity-40 cursor-pointer"
                    title="Pausa"
                  >
                    <Pause size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={handleNativeStop}
                    disabled={!isNativeLoaded}
                    className="p-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 disabled:opacity-40 cursor-pointer"
                    title="Detener"
                  >
                    <Square size={12} />
                  </button>
                </div>

                <input
                  type="range"
                  min={0}
                  max={playbackState.durationSec || 100}
                  step={0.1}
                  value={seekInputSec}
                  onChange={(e) => {
                    setSeekInputSec(Number(e.target.value));
                  }}
                  onPointerDown={() => setIsDraggingSeek(true)}
                  onPointerUp={(e) => {
                    setIsDraggingSeek(false);
                    void handleNativeSeek(Number((e.target as HTMLInputElement).value));
                  }}
                  disabled={!isNativeLoaded}
                  className="flex-1 h-1 bg-neutral-800 rounded appearance-none cursor-pointer accent-studio-ink"
                />

                {playbackState.isBuffering && (
                  <span className="text-[10px] text-amber-400 font-medium animate-pulse shrink-0">
                    Llenando...
                  </span>
                )}

                <span className="font-mono text-[10px] text-neutral-400 shrink-0 tabular-nums">
                  {formatTime(playbackState.positionSec)} / {formatTime(playbackState.durationSec)}
                </span>

                <button
                  type="button"
                  onClick={handleStressTest}
                  disabled={isStressTesting}
                  className="px-2 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-[10px] text-neutral-300 shrink-0 cursor-pointer disabled:opacity-50"
                  title="Congela el hilo WebView por 3s para probar aislamiento del audio"
                >
                  {isStressTesting ? 'Probando...' : 'Carga UI (3s)'}
                </button>
              </div>

              {/* Resultado de carga pesada UI como texto de una línea */}
              {stressNotice && (
                <div className="text-[10px] text-neutral-400 truncate">
                  {stressNotice}
                </div>
              )}

              {/* Fila 3: Saltos cuantizados y Vamp */}
              <div className="flex items-center gap-2 p-2 rounded-lg bg-neutral-900/60 border border-neutral-800 text-xs">
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <span className="text-[10px] text-neutral-400 uppercase tracking-wider shrink-0">Sección:</span>
                  <select
                    value={selectedSectionId}
                    onChange={(e) => setSelectedSectionId(e.target.value)}
                    disabled={!isNativeLoaded || !currentProject?.sections?.length}
                    className="bg-studio-strip border border-studio-line rounded px-2 py-0.5 text-xs text-neutral-200 truncate cursor-pointer flex-1"
                  >
                    {currentProject?.sections && currentProject.sections.length > 0 ? (
                      currentProject.sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({Math.floor(s.startTimeSec / 60)}:{String(Math.floor(s.startTimeSec % 60)).padStart(2, '0')})
                        </option>
                      ))
                    ) : (
                      <option value="">Sin secciones</option>
                    )}
                  </select>

                  <select
                    value={quantizeMode}
                    onChange={(e) => {
                      setQuantizeMode(e.target.value);
                      if (invoke) {
                        void invoke('audio_configure_song', { quantizeMode: e.target.value });
                      }
                    }}
                    className="bg-studio-strip border border-studio-line rounded px-1.5 py-0.5 text-[11px] text-neutral-300 cursor-pointer shrink-0"
                    title="Modo de cuantización del salto"
                  >
                    <option value="1-bar">1 compás</option>
                    <option value="2-bars">2 compases</option>
                    <option value="section-end">Fin sección</option>
                    <option value="immediate">Inmediato</option>
                  </select>

                  <button
                    type="button"
                    onClick={() => void handleQueueJump(selectedSectionId)}
                    disabled={!isNativeLoaded || !selectedSectionId}
                    className="px-2.5 py-0.5 rounded bg-studio-ink hover:bg-neutral-200 text-studio-ground text-[11px] font-semibold cursor-pointer disabled:opacity-40 shrink-0 transition-colors"
                  >
                    Saltar
                  </button>

                  <button
                    type="button"
                    onClick={handleToggleVamp}
                    disabled={!isNativeLoaded}
                    className={`px-2.5 py-0.5 rounded text-[11px] font-semibold cursor-pointer transition-colors shrink-0 ${
                      playbackState.isVamping
                        ? 'bg-amber-500 text-black font-bold animate-pulse'
                        : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-300'
                    }`}
                    title="Repetir (vamp) la sección activa indefinidamente sin hueco ni chasquido"
                  >
                    {playbackState.isVamping ? 'Vamping ON' : 'Vamp'}
                  </button>
                </div>
              </div>

              {/* Indicador de sección activa y salto en cola */}
              {(playbackState.activeSectionId || playbackState.queuedSectionId) && (
                <div className="flex items-center justify-between text-[11px] px-2 py-1 rounded bg-neutral-900 border border-neutral-800">
                  <div className="flex items-center gap-2 truncate">
                    {playbackState.activeSectionId && (
                      <span>
                        Sección activa:{' '}
                        <strong className="text-emerald-400">
                          {currentProject?.sections?.find((s) => s.id === playbackState.activeSectionId)?.name || playbackState.activeSectionId}
                        </strong>
                      </span>
                    )}
                    {playbackState.queuedSectionId && (
                      <span className="text-amber-400">
                        ➜ Saltando a:{' '}
                        <strong>
                          {currentProject?.sections?.find((s) => s.id === playbackState.queuedSectionId)?.name || playbackState.queuedSectionId}
                        </strong>
                      </span>
                    )}
                  </div>
                  {playbackState.queuedSectionId && (
                    <button
                      type="button"
                      onClick={handleCancelJump}
                      className="text-[10px] text-rose-400 hover:text-rose-300 underline cursor-pointer shrink-0"
                    >
                      Cancelar salto
                    </button>
                  )}
                </div>
              )}

              {/* Fila 4: Click sintetizado + Tono (Varispeed rubato) */}
              <div className="flex items-center justify-between gap-3 p-2 rounded-lg bg-neutral-900/60 border border-neutral-800 text-xs">
                {/* Click sintetizado */}
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={clickEnabled}
                      onChange={(e) => void handleMetronomeChange(e.target.checked, clickGain, clickSubdiv)}
                      className="rounded border-neutral-700 bg-neutral-900 text-studio-ink focus:ring-0 cursor-pointer"
                    />
                    <span className="text-[11px] text-neutral-300 font-medium">Click</span>
                  </label>

                  <select
                    value={clickSubdiv}
                    onChange={(e) => void handleMetronomeChange(clickEnabled, clickGain, Number(e.target.value) as 1 | 2)}
                    className="bg-studio-strip border border-studio-line rounded px-1.5 py-0.5 text-[10px] text-neutral-300 cursor-pointer"
                    title="Subdivisión del click"
                  >
                    <option value={1}>1/4 (Negra)</option>
                    <option value={2}>1/8 (Corchea)</option>
                  </select>

                  <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.05}
                    value={clickGain}
                    onChange={(e) => void handleMetronomeChange(clickEnabled, Number(e.target.value), clickSubdiv)}
                    className="w-16 h-1 bg-neutral-800 rounded appearance-none cursor-pointer accent-studio-ink"
                    title={`Volumen click: ${Math.round(clickGain * 100)}%`}
                  />
                </div>

                {/* Tono / Varispeed (-6 a +6 st) */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-neutral-400 uppercase tracking-wider shrink-0">Tono:</span>
                  <span className="font-mono text-[11px] text-neutral-200 w-10 text-right">
                    {pitchSemitones > 0 ? `+${pitchSemitones}` : pitchSemitones} st
                  </span>
                  <input
                    type="range"
                    min={-6}
                    max={6}
                    step={1}
                    value={pitchSemitones}
                    onChange={(e) => void handlePitchChange(Number(e.target.value))}
                    className="w-20 h-1 bg-neutral-800 rounded appearance-none cursor-pointer accent-studio-ink"
                    title="Varispeed pitch shift (-6 a +6 semitonos). Con 0 st el remuestreo se desactiva por bypass."
                  />
                  {pitchSemitones !== 0 && (
                    <button
                      type="button"
                      onClick={() => void handlePitchChange(0)}
                      className="text-[10px] px-1 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 cursor-pointer"
                      title="Restablecer tono a 0 (sin remuestreo)"
                    >
                      0 st
                    </button>
                  )}
                </div>
              </div>

              {/* Fila: Precarga y conmutación de canción (Setlist) */}
              <div className="flex items-center gap-2 p-2 rounded-lg bg-neutral-900/60 border border-neutral-800 text-xs">
                <span className="text-[10px] text-neutral-400 uppercase tracking-wider shrink-0">Precarga:</span>
                <select
                  value={preloadProjectId}
                  onChange={(e) => setPreloadProjectId(e.target.value)}
                  className="bg-studio-strip border border-studio-line rounded px-2 py-0.5 text-xs text-neutral-200 truncate cursor-pointer flex-1"
                >
                  <option value="">Canción a precargar...</option>
                  {songProjects
                    .filter((p) => p.id !== selectedProjectId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  onClick={handlePreloadSong}
                  disabled={!preloadProjectId || isPreloading}
                  className="px-2.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-[11px] font-medium cursor-pointer disabled:opacity-40 shrink-0"
                  title="Precargar pistas de la siguiente canción en memoria/disco"
                >
                  {isPreloading ? 'Cargando...' : 'Precargar'}
                </button>
                <button
                  type="button"
                  onClick={handleSwitchToPreloaded}
                  className="px-2.5 py-0.5 rounded bg-studio-ink hover:bg-neutral-200 text-studio-ground text-[11px] font-semibold cursor-pointer shrink-0 transition-colors"
                  title="Cambia a la canción precargada sin latencia y mide duración"
                >
                  Cambiar
                </button>
                {switchDurationMs != null && (
                  <span className="font-mono text-[10px] text-emerald-400 shrink-0">
                    {switchDurationMs} ms
                  </span>
                )}
              </div>

              {/* Fila de contadores de telemetría + botón reiniciar */}
              <div className="p-2 rounded-lg bg-studio-strip border border-studio-line text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 flex-1 text-[10px]">
                    <div>
                      <span className="text-neutral-400 uppercase tracking-wider block">Callbacks</span>
                      <span className="font-mono text-neutral-200 text-xs">{stats.callbacks.toLocaleString()}</span>
                    </div>
                    <div>
                      <span className="text-neutral-400 uppercase tracking-wider block">Underruns</span>
                      <span className={`font-mono text-xs ${stats.underruns === 0 ? 'text-emerald-400' : 'text-rose-400 font-bold'}`}>
                        {stats.underruns}
                      </span>
                    </div>
                    <div>
                      <span className="text-neutral-400 uppercase tracking-wider block">Callback máx</span>
                      <span className="font-mono text-neutral-200 text-xs">
                        {stats.maxCallbackDurationUs > 0 ? `${stats.maxCallbackDurationUs} µs` : '0 µs'}
                      </span>
                    </div>
                    <div>
                      <span className="text-neutral-400 uppercase tracking-wider block">Feeder máx</span>
                      <span className="font-mono text-neutral-200 text-xs">
                        {(stats.maxFeederBlockDurationUs || playbackState.maxFeederBlockDurationUs || 0) > 0
                          ? `${stats.maxFeederBlockDurationUs || playbackState.maxFeederBlockDurationUs} µs`
                          : '0 µs'}
                      </span>
                    </div>
                    <div>
                      <span className="text-neutral-400 uppercase tracking-wider block">Búfer mín</span>
                      <span className="font-mono text-emerald-400 text-xs">
                        {stats.minRingBufferLevelMs != null ? `${stats.minRingBufferLevelMs} ms` : '—'}
                      </span>
                    </div>
                    <div>
                      <span className="text-neutral-400 uppercase tracking-wider block">Prefill</span>
                      <span className="font-mono text-neutral-300 text-xs">
                        {playbackState.prefillDurationMs ? `${playbackState.prefillDurationMs} ms` : '0 ms'}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleResetStats()}
                    className="text-[10px] text-neutral-400 hover:text-white flex items-center gap-1 cursor-pointer shrink-0 transition-colors ml-2 self-start pt-1"
                    title="Reiniciar contadores a cero"
                  >
                    <RotateCcw size={10} />
                    <span>Reiniciar</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 7. Pie: «Cancelar» y «Guardar», alineados a la derecha */}
        <div className="flex items-center justify-between pt-2.5 border-t border-neutral-800">
          <span className="text-xs text-neutral-400">{savingNotice}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-neutral-300 cursor-pointer transition-colors"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleSaveConfig()}
              className="px-4 py-2 rounded-lg bg-studio-ink hover:bg-neutral-200 text-studio-ground text-xs font-semibold cursor-pointer transition-colors"
            >
              Guardar
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
});
