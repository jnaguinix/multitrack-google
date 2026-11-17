import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Info, Play, RotateCcw } from 'lucide-react';
import {
  ROUTE_SOURCES,
  SOURCE_LABEL,
  toggleSource,
  validateRouting,
  type RoutingConfig,
  type RoutingInfo,
} from './routing';

type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface Props {
  invoke: Invoke | undefined;
  /** Dispositivo elegido en Ajustes de audio (`null` = el predeterminado de Windows). */
  deviceName: string | null;
  /** Mientras suena no se puede cambiar el ruteo. */
  isPlaying: boolean;
  /** Reproduce un tono en esa salida (índice desde 0) para comprobar el conector. */
  onTestChannel: (channel: number) => void;
  testingChannel: number | null;
}

/**
 * Ruteo de salidas del dispositivo activo: qué va a cada canal (música izquierda/derecha/mono, click, guía).
 * La propuesta sale de los canales independientes que expone el dispositivo; se puede editar y se guarda por
 * dispositivo. Nada se guarda ni se aplica si el motor lo considera inseguro (click o guía llegando al público).
 */
export const AudioRoutingPanel: React.FC<Props> = ({ invoke, deviceName, isPlaying, onTestChannel, testingChannel }) => {
  const [info, setInfo] = useState<RoutingInfo | null>(null);
  const [draft, setDraft] = useState<RoutingConfig | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!invoke) return;
    try {
      const res = await invoke<RoutingInfo>('audio_get_routing', { deviceName });
      setInfo(res);
      setDraft(res.config);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [invoke, deviceName]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => Boolean(info && draft && JSON.stringify(info.config) !== JSON.stringify(draft)), [info, draft]);
  const liveIssues = useMemo(() => (info && draft ? validateRouting(draft, info.channels) : []), [info, draft]);

  const save = async () => {
    if (!invoke || !draft) return;
    setBusy(true);
    setMessage('');
    try {
      const res = await invoke<RoutingInfo>('audio_set_routing', { deviceName, config: draft });
      setInfo(res);
      if (res.valid) {
        setDraft(res.config);
        setMessage('Ruteo guardado para este dispositivo.');
      } else {
        setError(res.issues.join(' '));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!invoke) return;
    setBusy(true);
    setMessage('');
    try {
      const res = await invoke<RoutingInfo>('audio_reset_routing', { deviceName });
      setInfo(res);
      setDraft(res.config);
      setError('');
      setMessage('Se restableció la propuesta automática.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!info || !draft) {
    return error ? <p className="text-xs text-red-400">{error}</p> : null;
  }

  const noDevice = !info.deviceFound;
  const issues = dirty ? liveIssues : info.issues;
  const locked = isPlaying || noDevice;

  return (
    <section className="space-y-2 border-t border-neutral-800 pt-2" aria-label="Ruteo de salidas">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-neutral-200">Ruteo de salidas</h3>
        <span className="text-[11px] text-neutral-400 tabular-nums">
          {info.channels} {info.channels === 1 ? 'salida independiente' : 'salidas independientes'}
        </span>
      </div>

      {info.stale && (
        <p className="flex items-start gap-1.5 text-xs text-amber-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          Había un ruteo guardado para otra cantidad de canales. No se aplicó: se propone uno nuevo para este dispositivo.
        </p>
      )}

      <ul className="space-y-1" aria-label="Asignación por salida">
        {draft.outputs.map((out, i) => (
          <li key={i} className="flex items-center gap-2 rounded-lg bg-studio-strip/60 px-2 py-1">
            <span className="w-14 shrink-0 text-xs font-medium text-neutral-300 tabular-nums">Salida {i + 1}</span>
            <div className="flex flex-wrap gap-1 flex-1">
              {ROUTE_SOURCES.map((src) => {
                const on = out.sources.some((e) => e.source === src);
                return (
                  <button
                    key={src}
                    type="button"
                    aria-pressed={on}
                    disabled={locked}
                    onClick={() => setDraft((d) => (d ? toggleSource(d, i, src) : d))}
                    className={`px-2 py-0.5 rounded-md text-xs border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                      on
                        ? 'bg-studio-accent/15 border-studio-accent text-studio-accent'
                        : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {SOURCE_LABEL[src]}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => onTestChannel(i)}
              disabled={noDevice || testingChannel !== null}
              title={`Tono de prueba en la salida ${i + 1}`}
              className="shrink-0 px-2 py-0.5 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 flex items-center gap-1 cursor-pointer disabled:opacity-40"
            >
              <Play size={10} className={testingChannel === i ? 'animate-pulse text-amber-400' : ''} />
              Probar
            </button>
          </li>
        ))}
      </ul>

      <label className="flex items-center gap-1.5 text-xs text-neutral-400 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={draft.allowMixed}
          disabled={locked}
          onChange={(e) => setDraft((d) => (d ? { ...d, allowMixed: e.target.checked, custom: true } : d))}
          className="rounded border-neutral-700 bg-neutral-900 cursor-pointer"
        />
        Permitir mezclar música con click o guía en una misma salida (el click llegaría al público)
      </label>

      {issues.length > 0 ? (
        <ul className="space-y-0.5" role="alert">
          {issues.map((m) => (
            <li key={m} className="flex items-start gap-1.5 text-xs text-red-400">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {m}
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-emerald-400">
          <Check size={13} className="shrink-0" />
          Ruteo válido{info.saved ? ' (guardado para este dispositivo)' : ' (propuesta automática)'}
        </p>
      )}
      {error && !issues.length && <p className="text-xs text-red-400">{error}</p>}
      {message && <p className="text-xs text-neutral-300">{message}</p>}
      {isPlaying && <p className="text-xs text-neutral-400">Detén la reproducción para cambiar el ruteo.</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || busy || locked || liveIssues.length > 0}
          className="px-3 py-1 rounded-lg bg-neutral-100 text-neutral-950 text-xs font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Guardar ruteo
        </button>
        <button
          type="button"
          onClick={() => void reset()}
          disabled={busy || locked || (!info.saved && !dirty)}
          className="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RotateCcw size={11} /> Restablecer propuesta
        </button>
      </div>

      <details className="text-xs text-neutral-400">
        <summary className="cursor-pointer select-none flex items-center gap-1.5 w-fit">
          <Info size={12} /> Qué canales ve Windows
        </summary>
        <ul className="mt-1 space-y-1 list-disc pl-5">
          {info.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </details>
    </section>
  );
};
