import React, { useState } from 'react';
import { Activity, AlertTriangle, ChevronDown, RotateCcw } from 'lucide-react';
import { logAsyncError } from '../../src/utils/asyncErrors';
import { useDebugMode } from '../../src/hooks/useDebugMode';
import { diagnosticFileName, downloadTextFile, fullDiagnosticReport } from '../../src/utils/debugExport';
import type { DebugCategory } from '../../src/utils/debugMode';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface AudioStreamStatsSnapshot {
  underruns: number;
  callbacks: number;
  maxCallbackDurationUs: number;
  minRingBufferLevelMs?: number | null;
  maxFeederBlockDurationUs?: number;
  limitedSamples?: number;
  outputSamples?: number;
  /** Bloques omitidos por contención del callback (try_lock), por causa. Deben quedar en 0. */
  lockMissTracks?: number;
  lockMissFade?: number;
  lockMissConsumer?: number;
  lockMissMetronome?: number;
}

/** Lo que el Diagnóstico lee del estado de reproducción del motor. */
export interface DiagnosticsPlayback {
  isPlaying: boolean;
  positionSec: number;
  deviceDisconnected?: boolean;
  prefillDurationMs?: number;
  maxFeederBlockDurationUs?: number;
}

/** Total de veces que el callback omitió trabajo por un recurso ocupado, y el detalle por causa. */
function contentionTotal(s: AudioStreamStatsSnapshot): number {
  return (s.lockMissTracks ?? 0) + (s.lockMissFade ?? 0) + (s.lockMissConsumer ?? 0) + (s.lockMissMetronome ?? 0);
}

function contentionDetail(s: AudioStreamStatsSnapshot): string {
  return `pistas ${s.lockMissTracks ?? 0} · fundido ${s.lockMissFade ?? 0} · anillo de pista ${s.lockMissConsumer ?? 0} · metrónomo ${s.lockMissMetronome ?? 0}`;
}

/** Porcentaje de muestras de salida que pasaron por el limitador. */
function limiterShare(s: AudioStreamStatsSnapshot): number | null {
  if (!s.outputSamples) return null;
  return ((s.limitedSamples ?? 0) / s.outputSamples) * 100;
}

function limiterLabel(s: AudioStreamStatsSnapshot): string {
  const share = limiterShare(s);
  if (share == null) return '—';
  if (share === 0) return '0 %';
  return share < 0.01 ? '< 0,01 %' : `${share.toLocaleString('es', { maximumFractionDigits: 2 })} %`;
}

function limiterTone(s: AudioStreamStatsSnapshot): string {
  const share = limiterShare(s);
  if (!share) return 'text-emerald-400';
  return share < 0.1 ? 'text-amber-300' : 'text-rose-400 font-bold';
}

interface Props {
  invoke: Invoke | undefined;
  stats: AudioStreamStatsSnapshot;
  playbackState: DiagnosticsPlayback;
  device: { name: string; channels: number } | undefined;
  /** Canciones de la biblioteca: la caché de cualquier otra es huérfana. */
  validProjectIds: string[];
  onResetStats: () => void;
}

/** Sección plegable «Diagnóstico» de Ajustes de audio (cerrada por defecto). */
export const AudioDiagnostics: React.FC<Props> = ({ invoke, stats, playbackState, device, validProjectIds, onResetStats }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [diagNotice, setDiagNotice] = useState('');
  const [cacheStats, setCacheStats] = useState<{ totalBytes: number; projectCount: number; projectIds: string[] }>({
    totalBytes: 0,
    projectCount: 0,
    projectIds: [],
  });
  const debug = useDebugMode();
  const [onlyAlarms, setOnlyAlarms] = useState(false);
  const [isCleaningCache, setIsCleaningCache] = useState(false);
  const [cleanCacheNotice, setCleanCacheNotice] = useState('');

  const diagnosticText = () =>
    fullDiagnosticReport({
      navegador: navigator.userAgent,
      dispositivo: device?.name,
      salidas: device?.channels,
      reproduciendo: playbackState.isPlaying,
      posicionSeg: Math.round(playbackState.positionSec * 10) / 10,
      callbacks: stats.callbacks,
      underruns: stats.underruns,
      callbackMaxUs: stats.maxCallbackDurationUs,
      feederMaxUs: stats.maxFeederBlockDurationUs ?? playbackState.maxFeederBlockDurationUs,
      bufferMinMs: stats.minRingBufferLevelMs,
      limitador: limiterLabel(stats),
      contencionCallback: `${contentionTotal(stats)} (${contentionDetail(stats)})`,
    });

  const saveDiagnostic = () => {
    try {
      downloadTextFile(diagnosticFileName(), diagnosticText());
      setDiagNotice('Archivo de diagnóstico generado (revisa la carpeta de descargas).');
    } catch (err) {
      logAsyncError('guardar el diagnóstico')(err);
      setDiagNotice('No se pudo generar el archivo; usa «Copiar diagnóstico».');
    }
  };

  const visible = (() => {
    const all = debug.all(onlyAlarms ? new Set<DebugCategory>(['alarma', 'error']) : undefined);
    return all.slice(-40).reverse();
  })();

  // Caja negra: los últimos eventos de control y las discrepancias corregidas, listos para pegar en un mensaje.
  const copyDiagnostic = async () => {
    const text = diagnosticText();
    try {
      await navigator.clipboard.writeText(text);
      setDiagNotice('Diagnóstico copiado: pégalo en un mensaje.');
    } catch (err) {
      logAsyncError('copiar el diagnóstico')(err);
      console.info(text);
      setDiagNotice('No se pudo copiar; el texto quedó en la consola.');
    }
  };

  const refreshCacheStats = async () => {
    if (!invoke) return;
    try {
      const s = await invoke<any>('audio_get_cache_stats');
      if (s) setCacheStats(s);
    } catch (err) {
      logAsyncError('leer el tamaño de la caché nativa')(err);
    }
  };

  const handleCleanOrphanCache = async () => {
    if (!invoke) return;
    const confirmed = window.confirm(
      '¿Deseas eliminar las carpetas de caché nativa de canciones que ya no están en tu biblioteca?'
    );
    if (!confirmed) return;

    setIsCleaningCache(true);
    setCleanCacheNotice('');
    try {
      const res: any = await invoke('audio_clean_orphan_caches', { validProjectIds });
      const freedMb = (res.freedBytes / (1024 * 1024)).toFixed(1);
      setCleanCacheNotice(`Se eliminaron ${res.deletedCount} carpetas huérfanas (${freedMb} MB liberados).`);
      await refreshCacheStats();
    } catch (err: any) {
      setCleanCacheNotice(`Error limpiando caché: ${err}`);
    } finally {
      setIsCleaningCache(false);
    }
  };

  const handleReopenDevice = async () => {
    if (!invoke) return;
    try {
      await invoke('audio_reopen_stream');
      setDiagNotice('Dispositivo reabierto');
    } catch (err: any) {
      setDiagNotice(`Error reabriendo: ${err}`);
    }
  };

  return (
    <div className="border-t border-neutral-800 pt-2 space-y-2">
      <button
        type="button"
        onClick={() => {
          const next = !isOpen;
          setIsOpen(next);
          if (next) refreshCacheStats();
        }}
        className="flex items-center justify-between w-full text-xs font-semibold text-neutral-400 hover:text-neutral-200 py-0.5 cursor-pointer select-none transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <Activity size={13} className="text-neutral-400" />
          <span>Diagnóstico</span>
        </div>
        <ChevronDown size={13} className={`text-neutral-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="space-y-2 pt-1">
          {/* Caja negra de los controles de la mezcla */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copyDiagnostic()}
              className="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-medium cursor-pointer transition-colors shrink-0"
            >
              Copiar diagnóstico
            </button>
            <button
              type="button"
              onClick={saveDiagnostic}
              className="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-medium cursor-pointer transition-colors shrink-0"
            >
              Guardar archivo
            </button>
            {diagNotice && <span className="text-[11px] text-neutral-400 truncate">{diagNotice}</span>}
          </div>

          {/* Modo diagnóstico: registro detallado y alarmas de coherencia */}
          <div className="p-2 rounded-lg bg-neutral-900/60 border border-neutral-800 text-xs space-y-1.5">
            <label className="flex items-center justify-between gap-2 cursor-pointer select-none">
              <span>
                <span className="text-neutral-200 font-medium block">Modo diagnóstico</span>
                <span className="text-neutral-400 text-[11px]">
                  Anota cada comando al motor, cambios de canción, control remoto y errores. Apagado no consume nada.
                </span>
              </span>
              <input
                type="checkbox"
                checked={debug.enabled}
                onChange={(e) => debug.setEnabled(e.target.checked)}
                className="h-4 w-4 shrink-0 cursor-pointer"
                aria-label="Modo diagnóstico"
              />
            </label>
            {debug.enabled && (
              <>
                <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-400">
                  <span>
                    Alarmas: <span className={debug.alarms() > 0 ? 'text-rose-400 font-bold' : 'text-emerald-400'}>{debug.alarms()}</span>
                    {' · '}Eventos: {debug.all().length}
                  </span>
                  <span className="flex items-center gap-3">
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input type="checkbox" checked={onlyAlarms} onChange={(e) => setOnlyAlarms(e.target.checked)} />
                      Solo alarmas y errores
                    </label>
                    <button type="button" onClick={() => debug.clear()} className="hover:text-white cursor-pointer">
                      Vaciar
                    </button>
                  </span>
                </div>
                <ol className="max-h-48 overflow-y-auto font-mono text-[11px] leading-snug space-y-0.5" aria-label="Últimos eventos">
                  {visible.length === 0 && <li className="text-neutral-500">Sin eventos todavía.</li>}
                  {visible.map((e, i) => (
                    <li
                      key={`${e.t}-${i}`}
                      className={e.category === 'alarma' || e.category === 'error' ? 'text-rose-300' : 'text-neutral-300'}
                    >
                      <span className="text-neutral-500">+{(e.t / 1000).toFixed(2)} </span>
                      <span className="text-neutral-400">{e.category}</span> {e.detail}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
          {/* Alerta si el hardware de audio fue desconectado */}
          {playbackState.deviceDisconnected && (
            <div className="flex items-center justify-between p-2 rounded-lg bg-rose-950/80 border border-rose-800 text-rose-200 text-xs">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>Dispositivo de audio desconectado. Reproducción en pausa.</span>
              </div>
              <button
                type="button"
                onClick={() => void handleReopenDevice()}
                className="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-medium cursor-pointer transition-colors shrink-0 text-[11px]"
              >
                Reabrir dispositivo
              </button>
            </div>
          )}

          {/* Fila: Gestión de caché nativa y limpieza de huérfanos */}
          <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-neutral-900/60 border border-neutral-800 text-xs">
            <div>
              <span className="text-neutral-400 text-[11px] block">Caché nativa en disco:</span>
              <span className="font-mono text-neutral-200 text-xs">
                {(cacheStats.totalBytes / (1024 * 1024)).toFixed(1)} MB ({cacheStats.projectCount} {cacheStats.projectCount === 1 ? 'canción' : 'canciones'})
              </span>
            </div>
            <button
              type="button"
              onClick={handleCleanOrphanCache}
              disabled={isCleaningCache}
              className="px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-[11px] font-medium cursor-pointer disabled:opacity-50 shrink-0"
              title="Elimina carpetas de caché de canciones que ya no existen en tu biblioteca"
            >
              {isCleaningCache ? 'Limpiando...' : 'Limpiar caché huérfana'}
            </button>
          </div>
          {cleanCacheNotice && (
            <div className="text-[10px] text-emerald-400 px-1 truncate">
              {cleanCacheNotice}
            </div>
          )}

          {/* Fila de contadores de telemetría + botón reiniciar */}
          <div className="p-2 rounded-lg bg-studio-strip border border-studio-line text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="grid grid-cols-3 sm:grid-cols-8 gap-2 flex-1 text-[10px]">
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
                <div title="Parte del audio de salida que pasó por el limitador (picos suavizados). Debería quedar en 0 %; si sube, baja el volumen de las pistas o el Main.">
                  <span className="text-neutral-400 uppercase tracking-wider block">Limitador</span>
                  <span className={`font-mono text-xs ${limiterTone(stats)}`}>{limiterLabel(stats)}</span>
                </div>
                <div title={`Veces que el callback de audio no pudo tomar un recurso y omitió trabajo (${contentionDetail(stats)}). Debería quedar en 0: si sube, un hilo del motor retiene un bloqueo que el audio necesita.`}>
                  <span className="text-neutral-400 uppercase tracking-wider block">Contención</span>
                  <span className={`font-mono text-xs ${contentionTotal(stats) === 0 ? 'text-emerald-400' : 'text-rose-400 font-bold'}`}>
                    {contentionTotal(stats)}
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
                onClick={onResetStats}
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
  );
};
