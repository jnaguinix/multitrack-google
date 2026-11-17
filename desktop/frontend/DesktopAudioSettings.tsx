import React, { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { logAsyncError } from '../../src/utils/asyncErrors';
import { AudioRoutingPanel } from './AudioRoutingPanel';
import { AudioDiagnostics, type AudioStreamStatsSnapshot } from './AudioDiagnostics';
import { Sliders, Volume2, RefreshCw, X, Play } from 'lucide-react';
import { loadAllProjectsFromDb } from '../../src/storage/projectDb';
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

interface PlaybackStateSnapshot {
  isPlaying: boolean;
  isBuffering?: boolean;
  prefillDurationMs?: number;
  deviceDisconnected?: boolean;
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
  // El sondeo del estado solo corre con el diálogo abierto: consultar el motor también pone a cero los picos de los medidores.
  const [isOpen, setIsOpen] = useState(false);
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
    if (invoke && isOpen) {
      timer = window.setInterval(async () => {
        try {
          const pb = await invoke<PlaybackStateSnapshot>('audio_get_playback_state');
          if (pb) setPlaybackState(pb);
          const s = await invoke<AudioStreamStatsSnapshot>('audio_get_stats');
          if (s) setStats(s);
        } catch (err) {
          logAsyncError('sondeo del estado en Ajustes de audio')(err);
        }
      }, 250);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isOpen]);

  const handleTestTone = async (channel: number = selectedChannel) => {
    if (!invoke || !activeDevice) return;
    setSelectedChannel(channel);
    setIsPlayingTestTone(true);
    setStatusNotice(`Tono 440 Hz en Salida ${channel + 1}...`);

    try {
      await invoke<TestToneResult>('audio_test_tone', {
        deviceName: activeDevice.name,
        channel,
        frequency: 440.0,
        durationMs: 1200,
      });

      void pollStats();

      setTimeout(() => {
        setIsPlayingTestTone(false);
        setStatusNotice(`Tono completado en Salida ${channel + 1}.`);
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
              setIsOpen(true);
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
        className="fixed inset-0 m-auto z-50 bg-studio-panel border border-neutral-800 rounded-2xl w-full max-w-xl p-5 space-y-3 shadow-2xl backdrop:bg-black/70 text-neutral-100 max-h-[92dvh] overflow-y-auto"
        aria-labelledby="desktop-audio-title"
        onClose={() => setIsOpen(false)}
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

        {/* 4. Ruteo de salidas: se propone según los canales independientes del dispositivo y se guarda por dispositivo */}
        {activeDevice && (
          <AudioRoutingPanel
            invoke={invoke}
            deviceName={activeDevice.name}
            isPlaying={Boolean(playbackState?.isPlaying)}
            onTestChannel={(ch) => void handleTestTone(ch)}
            testingChannel={isPlayingTestTone ? selectedChannel : null}
          />
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
              onClick={() => void handleTestTone(selectedChannel)}
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

        {/* 6. Sección plegable «Diagnóstico», cerrada por defecto */}
        <AudioDiagnostics
          invoke={invoke}
          stats={stats}
          playbackState={playbackState}
          device={activeDevice}
          validProjectIds={songProjects.map((p) => p.id)}
          onResetStats={() => void handleResetStats()}
        />

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
