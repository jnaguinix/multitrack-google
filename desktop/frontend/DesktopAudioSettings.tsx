import React, { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sliders, Volume2, Check, AlertTriangle, Info, RefreshCw, X, Activity } from 'lucide-react';
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

  useEffect(() => {
    if (invoke) {
      void loadAudioConfig();
      void pollStats();
      const interval = setInterval(() => {
        void pollStats();
      }, 1500);
      return () => clearInterval(interval);
    }
  }, []);

  const handleDeviceChange = (deviceName: string) => {
    setSelectedDeviceName(deviceName);
    setSelectedChannel(0);
  };

  const handleTestTone = async () => {
    if (!invoke || !activeDevice) return;
    setIsPlayingTestTone(true);
    setStatusNotice(`Reproduciendo tono senoidal de 440 Hz en Salida ${selectedChannel + 1} (${activeDevice.name})...`);

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
      setSavingNotice('Configuración guardada en audio_settings.json');
      setTimeout(() => setSavingNotice(''), 3000);
    } catch (err) {
      setSavingNotice(`Error al guardar: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Determine Case A, B, or C according to PROMPT_MOTOR_NATIVO.md Section 6 & refined directives
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
            aria-label="Salidas y Tarjeta de Sonido (WASAPI)"
            title="Salidas y Tarjeta de Sonido (WASAPI)"
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
        className="lt-remote-dialog"
        aria-labelledby="desktop-audio-title"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <header className="flex justify-between items-center pb-3 border-b border-neutral-800">
          <div className="flex items-center gap-2">
            <Sliders size={20} className="text-amber-500" />
            <h2 id="desktop-audio-title" className="text-lg font-bold text-neutral-100">
              Dispositivos de Audio (WASAPI Nativo)
            </h2>
          </div>
          <button
            type="button"
            className="lt-control p-1 rounded-lg text-neutral-400 hover:text-white"
            onClick={() => dialogRef.current?.close()}
          >
            <X size={18} />
          </button>
        </header>

        <p className="text-xs text-neutral-400 mt-2 mb-4 leading-relaxed">
          Configuración del motor nativo en Rust para OmniTracks Escritorio. Emite sonido multicanal de baja latencia a través de Windows WASAPI.
        </p>

        <div className="space-y-4">
          {/* Driver Host Selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-neutral-300">Driver / Host de Audio</label>
            <div className="flex items-center gap-2">
              <select
                value={selectedHost}
                onChange={(e) => setSelectedHost(e.target.value)}
                className="w-full bg-studio-ground border border-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-100 focus:outline-none"
              >
                {hosts.map((h) => (
                  <option key={h} value={h}>
                    {h} (Predeterminado de Windows)
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void loadAudioConfig()}
                className="lt-control px-2.5 py-2 text-xs flex items-center gap-1"
                title="Actualizar lista de dispositivos"
                disabled={isLoading}
              >
                <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          {/* Device Selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-neutral-300">Dispositivo de Salida</label>
            {devices.length === 0 ? (
              <p className="text-xs text-amber-400">No se encontraron dispositivos de salida disponibles.</p>
            ) : (
              <select
                value={activeDevice?.name || ''}
                onChange={(e) => handleDeviceChange(e.target.value)}
                className="w-full bg-studio-ground border border-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-100 focus:outline-none"
              >
                {devices.map((dev) => (
                  <option key={dev.id} value={dev.name}>
                    {dev.name} {dev.isDefault ? '· (Predeterminado)' : ''} · {dev.channels} {dev.channels === 1 ? 'canal' : 'canales'}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Active Device Technical Details */}
          {activeDevice && (
            <div className="bg-studio-ground/80 border border-neutral-800 rounded-xl p-3.5 space-y-2 text-xs">
              <div className="flex justify-between items-center text-neutral-300">
                <span>Canales físicos detectados:</span>
                <span className="font-semibold text-white">{activeDevice.channels} salidas</span>
              </div>
              <div className="flex justify-between items-center text-neutral-300">
                <span>Frecuencia fijada por Windows:</span>
                <span className="font-semibold text-white">{activeDevice.defaultSampleRate} Hz</span>
              </div>
              <div className="flex justify-between items-center text-neutral-300">
                <span>Frecuencias soportadas reportadas:</span>
                <span className="font-mono text-neutral-400">
                  {activeDevice.supportedSampleRates.join(', ')} Hz
                </span>
              </div>
              <div className="flex justify-between items-center text-neutral-300">
                <span>Formato de muestra:</span>
                <span className="font-mono text-neutral-400">{activeDevice.sampleFormat}</span>
              </div>
              {activeDevice.minBufferSize && (
                <div className="flex justify-between items-center text-neutral-300">
                  <span>Búfer de Windows (WASAPI):</span>
                  <span className="font-mono text-neutral-300">
                    {activeDevice.minBufferSize} muestras (~{((activeDevice.minBufferSize / (activeDevice.defaultSampleRate || 48000)) * 1000).toFixed(1)} ms)
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Cases A, B, and C Alerts */}
          {isCaseA && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-emerald-950/40 border border-emerald-800/60 text-emerald-200 text-xs">
              <Check size={16} className="text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <strong className="block font-semibold">Caso A · Tarjeta Multicanal Unificada</strong>
                <span>Esta interfaz expone {activeDevice.channels} canales simultáneos. Tienes ruteo libre directo para Main L/R, Click, Guía y salidas individuales.</span>
              </div>
            </div>
          )}

          {isCaseB && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-950/40 border border-amber-800/60 text-amber-200 text-xs">
              <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
              <div>
                <strong className="block font-semibold">Caso B · Salidas Estéreo Separadas</strong>
                <span>Esta interfaz expone sus salidas como dispositivos separados en Windows. Por WASAPI sólo es posible utilizar un par estéreo a la vez. Para habilitar todas las salidas simultáneas y rutear en vivo, se requerirá el driver ASIO.</span>
              </div>
            </div>
          )}

          {isCaseC && (
            <div className="flex items-start gap-2.5 p-3 rounded-xl bg-blue-950/40 border border-blue-800/60 text-blue-200 text-xs">
              <Info size={16} className="text-blue-400 shrink-0 mt-0.5" />
              <div>
                <strong className="block font-semibold">Caso C · Salida Estéreo (2 Canales)</strong>
                <span>Dispositivo de 2 salidas. Modo Split-Mono disponible para separar Click en Canal 1 y Pistas en Canal 2.</span>
              </div>
            </div>
          )}

          {/* Test Tone Section */}
          {activeDevice && (
            <div className="border border-neutral-800 rounded-xl p-3.5 space-y-3 bg-studio-ground/40">
              <div className="flex items-center gap-2">
                <Volume2 size={16} className="text-amber-400" />
                <h3 className="text-xs font-semibold text-neutral-200">Prueba de Salida Física (Tono 440 Hz)</h3>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-xs text-neutral-400 shrink-0">Canal a probar:</label>
                <select
                  value={selectedChannel}
                  onChange={(e) => setSelectedChannel(Number(e.target.value))}
                  className="bg-studio-ground border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-neutral-100 focus:outline-none flex-1"
                >
                  {Array.from({ length: activeDevice.channels }, (_, i) => (
                    <option key={i} value={i}>
                      Salida {i + 1} {i === 0 ? '(L)' : i === 1 ? '(R)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void handleTestTone()}
                  disabled={isPlayingTestTone}
                  className={`lt-primary px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-all cursor-pointer ${
                    isPlayingTestTone ? 'opacity-70 animate-pulse' : ''
                  }`}
                >
                  <Volume2 size={14} />
                  <span>{isPlayingTestTone ? 'Sonando...' : 'Probar'}</span>
                </button>
              </div>

              {statusNotice && (
                <p className="text-[11px] text-neutral-300 bg-neutral-900/60 px-2.5 py-1.5 rounded-lg border border-neutral-800">
                  {statusNotice}
                </p>
              )}
            </div>
          )}

          {/* Telemetría del Callback en Tiempo Real */}
          <div className="border border-neutral-800 rounded-xl p-3 bg-studio-ground/50 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-neutral-200">
                <Activity size={14} className="text-cyan-400" />
                <span>Rendimiento del Callback (Rust / WASAPI)</span>
              </div>
              <button
                type="button"
                onClick={() => void pollStats()}
                className="text-[11px] text-neutral-400 hover:text-white flex items-center gap-1"
                title="Actualizar métricas"
              >
                <RefreshCw size={11} />
                <span>Refrescar</span>
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs pt-1">
              <div className="p-2 rounded-lg bg-black/30 border border-neutral-800/80">
                <div className="text-[10px] text-neutral-400 uppercase tracking-wider">Callbacks</div>
                <div className="font-mono font-semibold text-neutral-200 mt-0.5">
                  {stats.callbacks.toLocaleString()}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-black/30 border border-neutral-800/80">
                <div className="text-[10px] text-neutral-400 uppercase tracking-wider">Underruns</div>
                <div className={`font-mono font-semibold mt-0.5 ${stats.underruns === 0 ? 'text-emerald-400' : 'text-rose-400 animate-pulse'}`}>
                  {stats.underruns}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-black/30 border border-neutral-800/80">
                <div className="text-[10px] text-neutral-400 uppercase tracking-wider">Duración Máx.</div>
                <div className={`font-mono font-semibold mt-0.5 ${stats.maxCallbackDurationUs < 5000 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {stats.maxCallbackDurationUs > 0 ? `${stats.maxCallbackDurationUs} µs` : '0 µs'}
                </div>
              </div>
            </div>
          </div>

          {/* Save / Status Actions */}
          <div className="pt-2 flex items-center justify-between border-t border-neutral-800">
            <span className="text-xs text-neutral-400">{savingNotice}</span>
            <button
              type="button"
              onClick={() => void handleSaveConfig()}
              className="lt-primary px-4 py-2 text-xs font-semibold rounded-lg"
            >
              Guardar Configuración
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
});
