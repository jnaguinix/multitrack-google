import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Music2, X } from 'lucide-react';
import { INSTRUMENTS, FIXED_INSTRUMENTS, getInstrument, numberedNames } from '../../utils/instrumentCatalog';

/* ============================================================================
 * ASISTENTE DE IMPORTACIÓN
 *
 * Paso 1 «Canción»: nombre, artista y datos musicales (solo al crear una canción nueva).
 * Paso 2 «Pistas»: el usuario elige a mano qué instrumento es cada archivo. No hay mapeo inteligente: lo único
 * que se rellena solo son elecciones anteriores con el nombre de archivo exacto, marcadas como «recordado».
 * ========================================================================== */

export type ImportWizardMode = 'new-song' | 'add-tracks' | 'edit-tracks';

export interface WizardFile {
  id: string;
  /** Nombre del archivo tal como está en la carpeta (puede ser larguísimo: solo se muestra recortado). */
  fileName: string;
  durationSec?: number | null;
  /** Instrumento elegido; `null` = sin asignar. */
  instrumentId: string | null;
  /** `true` si lo eligió una importación anterior con este mismo nombre de archivo. */
  remembered?: boolean;
  /** Ignorar esta pista (no se importa). */
  skipped?: boolean;
}

export interface WizardMeta {
  title: string;
  artist: string;
  key: string;
  bpm: number;
  beatsPerBar: number;
}

export interface WizardResult {
  meta: WizardMeta;
  /** Una fila por archivo, en el mismo orden. `instrumentId: null` = ignorar. */
  rows: Array<{ id: string; instrumentId: string | null }>;
}

interface Props {
  mode: ImportWizardMode;
  /** Cuántas pistas ya existen al añadir a una canción (solo para el subtítulo). */
  initialMeta: WizardMeta;
  files: WizardFile[];
  onConfirm: (result: WizardResult) => void;
  onCancel: () => void;
}

const SKIP = 'skip';
const KEY_ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function splitKey(key: string): { root: string; quality: 'Major' | 'Minor' } {
  const m = /^([A-G][#b]?)\s*(maj|major|min|minor|m)?/i.exec((key || '').trim());
  const root = m ? m[1][0].toUpperCase() + m[1].slice(1) : 'C';
  const q = (m?.[2] || '').toLowerCase();
  return { root: KEY_ROOTS.includes(root) ? root : 'C', quality: q.startsWith('min') || q === 'm' ? 'Minor' : 'Major' };
}

function fmtDuration(sec?: number | null): string {
  if (!sec || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const fieldClass =
  'w-full bg-studio-ground border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-studio-accent transition-colors';

export const ImportWizardModal: React.FC<Props> = ({ mode, initialMeta, files, onConfirm, onCancel }) => {
  const hasSongStep = mode === 'new-song';
  const [step, setStep] = useState<1 | 2>(hasSongStep ? 1 : 2);

  // --- Paso 1
  const [title, setTitle] = useState(initialMeta.title);
  const [artist, setArtist] = useState(initialMeta.artist);
  const initialKey = useMemo(() => splitKey(initialMeta.key), [initialMeta.key]);
  const [keyRoot, setKeyRoot] = useState(initialKey.root);
  const [keyQuality, setKeyQuality] = useState<'Major' | 'Minor'>(initialKey.quality);
  const [bpm, setBpm] = useState(String(Math.round(initialMeta.bpm || 120)));
  const [beats, setBeats] = useState(String(initialMeta.beatsPerBar || 4));

  // --- Paso 2: valor del selector por archivo: '' = sin asignar, 'skip' = ignorar, o el id del instrumento
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(files.map((f) => [f.id, f.skipped ? SKIP : f.instrumentId ?? '']))
  );
  const [remembered, setRemembered] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(files.map((f) => [f.id, Boolean(f.remembered)]))
  );

  const titleRef = useRef<HTMLInputElement>(null);
  const firstEmptyRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (step === 1) titleRef.current?.focus();
    else firstEmptyRef.current?.focus();
  }, [step]);

  const instrumentIds = files.map((f) => (choice[f.id] && choice[f.id] !== SKIP ? choice[f.id] : null));
  const names = numberedNames(instrumentIds);
  const assigned = files.filter((f) => choice[f.id]).length;
  const importing = files.filter((f) => choice[f.id] && choice[f.id] !== SKIP).length;
  const pending = files.length - assigned;
  const titleOk = title.trim().length > 0;
  const bpmNum = Number(bpm);
  const bpmOk = Number.isFinite(bpmNum) && bpmNum >= 20 && bpmNum <= 300;
  const step1Ok = titleOk && bpmOk;
  const canImport = pending === 0 && importing > 0;
  const firstEmptyId = files.find((f) => !choice[f.id])?.id;

  const confirm = () => {
    if (!canImport || (hasSongStep && !step1Ok)) return;
    onConfirm({
      meta: {
        title: title.trim(),
        artist: artist.trim() || 'Artista Desconocido',
        key: `${keyRoot} ${keyQuality}`,
        bpm: Math.round(bpmNum * 100) / 100,
        beatsPerBar: Number(beats) || 4,
      },
      rows: files.map((f, i) => ({ id: f.id, instrumentId: instrumentIds[i] })),
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter' && step === 1 && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      if (step1Ok) setStep(2);
    }
  };

  const heading =
    mode === 'new-song' ? 'Importar canción' : mode === 'add-tracks' ? 'Añadir pistas' : 'Editar pistas';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-wizard-title"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px] flex items-center justify-center p-4"
    >
      <div className="bg-studio-panel border border-neutral-800 rounded-2xl w-full max-w-2xl max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
        {/* Cabecera */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3 border-b border-neutral-800">
          <div className="w-8 h-8 rounded-lg bg-studio-strip flex items-center justify-center text-studio-accent shrink-0">
            <Music2 className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="import-wizard-title" className="text-sm font-semibold text-neutral-100 leading-tight">
              {heading}
            </h2>
            <p className="text-xs text-studio-muted truncate">
              {files.length} {files.length === 1 ? 'pista' : 'pistas'}
              {hasSongStep && step === 2 && title.trim() ? ` · ${title.trim()}` : ''}
            </p>
          </div>
          {hasSongStep && (
            <ol className="hidden sm:flex items-center gap-1.5 text-xs" aria-label="Pasos">
              {(['Canción', 'Pistas'] as const).map((label, i) => {
                const n = (i + 1) as 1 | 2;
                const active = step === n;
                const done = step > n;
                return (
                  <li key={label} className="flex items-center gap-1.5">
                    {i > 0 && <span className="w-4 h-px bg-neutral-700" aria-hidden="true" />}
                    <span
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-full border ${
                        active
                          ? 'border-studio-accent text-studio-accent'
                          : done
                            ? 'border-neutral-700 text-neutral-300'
                            : 'border-neutral-800 text-studio-muted'
                      }`}
                      aria-current={active ? 'step' : undefined}
                    >
                      <span className="font-semibold tabular-nums">{done ? <Check className="w-3 h-3" /> : n}</span>
                      {label}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancelar"
            className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Cuerpo */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === 1 ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
              <label className="col-span-2 block">
                <span className="block text-xs font-medium text-neutral-300 mb-1">Nombre de la canción</span>
                <input
                  ref={titleRef}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ej. Sublime Gracia"
                  className={fieldClass}
                  aria-invalid={!titleOk}
                />
              </label>
              <label className="col-span-2 block">
                <span className="block text-xs font-medium text-neutral-300 mb-1">Artista</span>
                <input
                  value={artist}
                  onChange={(e) => setArtist(e.target.value)}
                  placeholder="Opcional"
                  className={fieldClass}
                />
              </label>
              <div>
                <span className="block text-xs font-medium text-neutral-300 mb-1">Tono</span>
                <div className="flex gap-1.5">
                  <select
                    value={keyRoot}
                    onChange={(e) => setKeyRoot(e.target.value)}
                    aria-label="Nota del tono"
                    className={`${fieldClass} flex-1`}
                  >
                    {KEY_ROOTS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <select
                    value={keyQuality}
                    onChange={(e) => setKeyQuality(e.target.value as 'Major' | 'Minor')}
                    aria-label="Modo del tono"
                    className={`${fieldClass} flex-[1.4]`}
                  >
                    <option value="Major">Mayor</option>
                    <option value="Minor">Menor</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <label className="block">
                  <span className="block text-xs font-medium text-neutral-300 mb-1">BPM</span>
                  <input
                    value={bpm}
                    onChange={(e) => setBpm(e.target.value.replace(/[^\d.]/g, ''))}
                    inputMode="decimal"
                    className={`${fieldClass} tabular-nums`}
                    aria-invalid={!bpmOk}
                  />
                </label>
                <label className="block">
                  <span className="block text-xs font-medium text-neutral-300 mb-1">Pulsos por compás</span>
                  <select value={beats} onChange={(e) => setBeats(e.target.value)} className={fieldClass}>
                    {[2, 3, 4, 5, 6, 7].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {!bpmOk && <p className="col-span-2 text-xs text-red-400">El BPM debe estar entre 20 y 300.</p>}
            </div>
          ) : (
            <div>
              <p className="text-xs text-studio-muted mb-3">
                Elige qué instrumento es cada archivo. El nombre del archivo no importa: en la app se verá el del
                instrumento.
              </p>
              <ul className="space-y-1.5" aria-label="Pistas a importar">
                {files.map((f, i) => {
                  const value = choice[f.id] ?? '';
                  const def = getInstrument(value);
                  const finalName = names[i];
                  const numbered = finalName && def && finalName !== def.label;
                  return (
                    <li
                      key={f.id}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,13.5rem)] items-center gap-3 rounded-lg bg-studio-strip/60 px-3 py-1.5"
                    >
                      <div className="min-w-0">
                        <p className="text-xs text-neutral-300 truncate" title={f.fileName}>
                          {f.fileName}
                        </p>
                        <p className="text-xs text-studio-muted tabular-nums flex items-center gap-1.5 min-h-4">
                          {fmtDuration(f.durationSec)}
                          {remembered[f.id] && value && (
                            <span className="text-studio-accent" title="Elegido en una importación anterior con este mismo nombre de archivo">
                              · recordado
                            </span>
                          )}
                          {numbered && <span className="text-neutral-400">· se llamará «{finalName}»</span>}
                        </p>
                      </div>
                      <div className="relative">
                        <span
                          aria-hidden="true"
                          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full"
                          style={{ background: value === SKIP ? '#525252' : def?.color ?? 'transparent', border: value ? 'none' : '1px dashed #666' }}
                        />
                        <select
                          ref={f.id === firstEmptyId ? firstEmptyRef : undefined}
                          value={value}
                          onChange={(e) => {
                            setChoice((c) => ({ ...c, [f.id]: e.target.value }));
                            setRemembered((r) => ({ ...r, [f.id]: false }));
                          }}
                          aria-label={`Instrumento de ${f.fileName}`}
                          className={`w-full appearance-none bg-studio-ground border rounded-lg pl-7 pr-2 py-1.5 text-sm focus:outline-none focus:border-studio-accent cursor-pointer ${
                            value ? 'border-neutral-700 text-neutral-100' : 'border-amber-500/60 text-studio-muted'
                          }`}
                        >
                          <option value="">Elegir instrumento…</option>
                          {INSTRUMENTS.map((ins) => (
                            <option key={ins.id} value={ins.id}>
                              {ins.label}
                            </option>
                          ))}
                          <optgroup label="Fijos (van a auriculares)">
                            {FIXED_INSTRUMENTS.map((ins) => (
                              <option key={ins.id} value={ins.id}>
                                {ins.label}
                              </option>
                            ))}
                          </optgroup>
                          <option value={SKIP}>— No importar —</option>
                        </select>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        {/* Pie */}
        <div className="flex items-center gap-3 px-5 py-3 border-t border-neutral-800 bg-studio-panel">
          <div className="text-xs text-studio-muted tabular-nums min-w-0 flex-1">
            {step === 2 &&
              (pending > 0 ? (
                <span>
                  <span className="text-amber-400 font-medium">{pending}</span> sin elegir · {assigned} de {files.length}
                </span>
              ) : (
                <span>
                  {importing} {importing === 1 ? 'pista' : 'pistas'} a importar
                  {files.length - importing > 0 ? ` · ${files.length - importing} ignoradas` : ''}
                </span>
              ))}
          </div>
          {step === 2 && hasSongStep && (
            <button
              type="button"
              onClick={() => setStep(1)}
              className="px-3 py-2 rounded-lg text-sm text-neutral-300 hover:text-white hover:bg-neutral-800 flex items-center gap-1.5 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Atrás
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-2 rounded-lg text-sm text-neutral-400 hover:text-white hover:bg-neutral-800 cursor-pointer"
          >
            Cancelar
          </button>
          {step === 1 ? (
            <button
              type="button"
              onClick={() => step1Ok && setStep(2)}
              disabled={!step1Ok}
              className="lt-primary disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              Siguiente <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={confirm}
              disabled={!canImport || (hasSongStep && !step1Ok)}
              className="lt-primary disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" /> {mode === 'edit-tracks' ? 'Guardar' : 'Importar'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
