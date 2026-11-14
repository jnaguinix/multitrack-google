import React, { useRef, useState } from 'react';
import { Plus, Trash2, X, Repeat, Flag, Clock } from 'lucide-react';
import { SongProject, SongSection } from '../../types/project';
import { formatMmSs } from '../TransportDeck';

/* ============================================================================
 * TIME-BASED SECTION MARKER EDITOR MODAL (MM:SS)
 * ============================================================================ */

interface SectionEditorModalProps {
  isOpen: boolean;
  project: SongProject;
  currentTimeSec: number;
  totalDurationSec: number;
  onClose: () => void;
  onSaveSections: (sections: SongSection[]) => void;
}

const SECTION_COLORS = [
  '#06B6D4',
  '#3B82F6',
  '#10B981',
  '#F59E0B',
  '#8B5CF6',
  '#EC4899',
  '#EF4444',
];

const QUICK_SECTION_PRESETS = [
  { name: 'Intro', code: 'IN', color: '#06B6D4' },
  { name: 'Verso 1', code: 'V1', color: '#3B82F6' },
  { name: 'Verso 2', code: 'V2', color: '#3B82F6' },
  { name: 'Pre-Coro', code: 'PC', color: '#8B5CF6' },
  { name: 'Coro', code: 'CO', color: '#10B981' },
  { name: 'Puente', code: 'PU', color: '#F59E0B' },
  { name: 'Instrumental', code: 'IS', color: '#EC4899' },
  { name: 'Final', code: 'FI', color: '#EF4444' },
];

function roundSectionSec(sec: number): number {
  return Math.round(Math.max(0, sec || 0) * 100) / 100;
}

function formatSectionMmSs(sec: number): string {
  const safe = roundSectionSec(sec);
  const totalCentis = Math.round(safe * 100);
  const mins = Math.floor(totalCentis / 6000);
  const remCentis = totalCentis - mins * 6000;
  const wholeSec = Math.floor(remCentis / 100);
  const centis = remCentis % 100;
  return `${String(mins).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function parseMmSsInput(text: string, fallbackSec: number): number {
  const clean = text.trim().replace(',', '.');
  if (!clean) return fallbackSec;
  if (clean.includes(':')) {
    const [mStr, sStr] = clean.split(':');
    const mins = Number(mStr);
    const secs = Number(sStr);
    if (!Number.isFinite(mins) || !Number.isFinite(secs) || mins < 0 || secs < 0) {
      return fallbackSec;
    }
    return roundSectionSec(mins * 60 + secs);
  }
  const num = Number(clean);
  return !Number.isFinite(num) || num < 0 ? fallbackSec : roundSectionSec(num);
}

export const SectionEditorModal: React.FC<SectionEditorModalProps> = ({
  isOpen,
  project,
  currentTimeSec,
  totalDurationSec,
  onClose,
  onSaveSections,
}) => {
  const safeDuration = Math.max(10, roundSectionSec(totalDurationSec || project.durationSec || 60));
  const [sections, setSectionsState] = useState<SongSection[]>(project.sections);
  const sectionsRef = useRef<SongSection[]>(project.sections);

  const setSections = (
    nextOrUpdater: SongSection[] | ((prev: SongSection[]) => SongSection[])
  ) => {
    setSectionsState((prev) => {
      const next =
        typeof nextOrUpdater === 'function' ? nextOrUpdater(prev) : nextOrUpdater;
      sectionsRef.current = next;
      return next;
    });
  };

  if (!isOpen) return null;

  /**
   * Sorts sections by startTimeSec and links each section's endTimeSec directly
   * to the next section's startTimeSec (and the last section to safeDuration),
   * so there are never gaps or overlaps between consecutive markers.
   */
  const sortAndRecalculateEndTimes = (list: SongSection[]): SongSection[] => {
    const minLen = 0.05;
    const sorted = [...list]
      .map((sec) => ({
        ...sec,
        startTimeSec: Math.max(
          0,
          Math.min(Math.max(0, safeDuration - minLen), roundSectionSec(sec.startTimeSec))
        ),
      }))
      .sort((a, b) => a.startTimeSec - b.startTimeSec);

    return sorted.map((sec, idx) => {
      const nextSec = sorted[idx + 1];
      const targetEnd = nextSec ? nextSec.startTimeSec : safeDuration;
      return {
        ...sec,
        endTimeSec: roundSectionSec(
          Math.max(sec.startTimeSec + minLen, Math.min(safeDuration, targetEnd))
        ),
      };
    });
  };

  const handleAddPresetAtTime = (
    preset: { name: string; code: string; color: string },
    atTimeSec: number
  ) => {
    const startSec = Math.max(0, Math.min(safeDuration - 0.1, roundSectionSec(atTimeSec)));
    const currentList = sectionsRef.current;

    const newSec: SongSection = {
      id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: preset.name,
      code: preset.code,
      color: preset.color,
      startTimeSec: startSec,
      endTimeSec: safeDuration,
      vampByDefault: false,
      cueName: preset.name,
    };

    setSections(sortAndRecalculateEndTimes([...currentList, newSec]));
  };

  const handleUpdateField = (
    id: string,
    field: keyof SongSection,
    value: string | number | boolean
  ) => {
    setSections((prev) => {
      if (field === 'startTimeSec' && typeof value === 'number') {
        const newStart = Math.max(0, Math.min(safeDuration - 0.1, roundSectionSec(value)));
        const updated = prev.map((s) =>
          s.id === id ? { ...s, startTimeSec: newStart } : s
        );
        return sortAndRecalculateEndTimes(updated);
      }

      if (field === 'endTimeSec' && typeof value === 'number') {
        const sorted = sortAndRecalculateEndTimes(prev);
        const idx = sorted.findIndex((s) => s.id === id);
        if (idx === -1) return prev;
        const target = sorted[idx];
        const newEnd = Math.max(
          target.startTimeSec + 0.05,
          Math.min(safeDuration, roundSectionSec(value))
        );
        const nextSec = sorted[idx + 1];
        if (nextSec) {
          // Moving the end of section `idx` moves the start of section `idx + 1` so no gap is left
          const updated = sorted.map((s, i) =>
            i === idx
              ? { ...s, endTimeSec: newEnd }
              : i === idx + 1
              ? { ...s, startTimeSec: newEnd }
              : s
          );
          return sortAndRecalculateEndTimes(updated);
        }
        return sorted.map((s, i) => (i === idx ? { ...s, endTimeSec: newEnd } : s));
      }

      return prev.map((s) => (s.id === id ? { ...s, [field]: value } : s));
    });
  };

  const handleRemoveSection = (id: string) => {
    setSections((prev) => sortAndRecalculateEndTimes(prev.filter((s) => s.id !== id)));
  };

  const handleSave = () => {
    const clean = sortAndRecalculateEndTimes(sectionsRef.current);
    onSaveSections(clean);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-studio-panel border border-neutral-800 rounded-2xl max-w-3xl w-full p-6 space-y-5 max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-neutral-100">
              Marcadores de Sección por Tiempo (Minutos y Segundos)
            </h2>
            <p className="text-xs text-neutral-400">
              Define en qué minuto y segundo (<code className="text-studio-ink">mm:ss</code>) empieza y termina cada parte de la canción.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-white p-1 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Playhead Quick Insert Box */}
        <div className="bg-studio-ground border border-neutral-800 rounded-xl p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-neutral-300">
              <Flag className="w-4 h-4 text-studio-ink" />
              <span>
                Insertar sección en la posición actual del cabezal:{' '}
                <strong className="text-studio-ink">
                  {formatSectionMmSs(currentTimeSec)}
                </strong>{' '}
                <span className="text-neutral-400">
                  (Duración total: {formatMmSs(safeDuration)})
                </span>
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {QUICK_SECTION_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => handleAddPresetAtTime(preset, currentTimeSec)}
                className="px-2.5 py-1 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 text-xs font-medium text-neutral-200 flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                <span
                  style={{ backgroundColor: preset.color }}
                  className="w-2 h-2 rounded-full"
                />
                <span>+ {preset.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Section List in MM:SS */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {sections.length === 0 ? (
            <div className="p-8 text-center border border-dashed border-neutral-800 rounded-xl text-xs text-neutral-400">
              Esta canción no tiene marcadores de sección. Usa los botones de arriba para añadir un marcador en el segundo actual del cabezal.
            </div>
          ) : (
            sections.map((sec) => (
              <div
                key={sec.id}
                className="bg-studio-ground border border-neutral-800 rounded-xl p-3 flex flex-wrap items-center gap-2.5"
              >
                <input
                  type="color"
                  value={sec.color}
                  onChange={(e) => handleUpdateField(sec.id, 'color', e.target.value)}
                  className="w-7 h-7 rounded bg-transparent border-0 cursor-pointer shrink-0"
                />

                <input
                  type="text"
                  value={sec.code}
                  maxLength={3}
                  onChange={(e) =>
                    handleUpdateField(sec.id, 'code', e.target.value.toUpperCase())
                  }
                  className="w-12 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-xs font-bold text-neutral-100 text-center"
                  title="Código corto (ej. IN, V1, CO)"
                />

                <input
                  type="text"
                  value={sec.name}
                  onChange={(e) => handleUpdateField(sec.id, 'name', e.target.value)}
                  className="flex-1 min-w-[130px] bg-neutral-900 border border-neutral-800 rounded px-2.5 py-1 text-xs text-neutral-100"
                  placeholder="Nombre de sección"
                />

                {/* Start Time MM:SS + Capture Playhead */}
                <div className="flex items-center gap-1 text-xs text-neutral-400">
                  <span>Inicio:</span>
                  <input
                    type="text"
                    defaultValue={formatSectionMmSs(sec.startTimeSec)}
                    key={`start-${sec.id}-${sec.startTimeSec}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    onBlur={(e) => {
                      const parsed = parseMmSsInput(e.target.value, sec.startTimeSec);
                      handleUpdateField(sec.id, 'startTimeSec', parsed);
                    }}
                    placeholder="00:00"
                    className="w-20 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-xs tabular-nums text-studio-ink text-center"
                    title="Formato mm:ss o mm:ss.d (ej. 01:14.35)"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      handleUpdateField(
                        sec.id,
                        'startTimeSec',
                        roundSectionSec(currentTimeSec)
                      )
                    }
                    title={`Fijar inicio en el cabezal actual (${formatSectionMmSs(currentTimeSec)})`}
                    className="px-1.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs text-studio-ink flex items-center gap-1 cursor-pointer"
                  >
                    <Clock className="w-3 h-3" />
                    <span>Cabezal</span>
                  </button>
                </div>

                {/* End Time MM:SS */}
                <div className="flex items-center gap-1 text-xs text-neutral-400">
                  <span>Fin:</span>
                  <input
                    type="text"
                    defaultValue={formatSectionMmSs(sec.endTimeSec)}
                    key={`end-${sec.id}-${sec.endTimeSec}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    onBlur={(e) => {
                      const parsed = parseMmSsInput(e.target.value, sec.endTimeSec);
                      handleUpdateField(
                        sec.id,
                        'endTimeSec',
                        Math.max(sec.startTimeSec + 0.1, parsed)
                      );
                    }}
                    placeholder="00:30"
                    className="w-20 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-xs tabular-nums text-neutral-200 text-center"
                    title="Formato mm:ss o mm:ss.d (ej. 01:45.5)"
                  />
                </div>

                <button
                  type="button"
                  onClick={() =>
                    handleUpdateField(sec.id, 'vampByDefault', !sec.vampByDefault)
                  }
                  title="Repetir esta sección en bucle automáticamente"
                  className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 border cursor-pointer ${
                    sec.vampByDefault
                      ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400'
                  }`}
                >
                  <Repeat className="w-3 h-3" />
                  <span>Loop</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleRemoveSection(sec.id)}
                  title="Eliminar este marcador de sección"
                  className="p-1.5 rounded bg-neutral-900 hover:bg-red-500/20 text-neutral-400 hover:text-red-400 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-neutral-800">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                handleAddPresetAtTime(
                  {
                    name: `Sección ${sections.length + 1}`,
                    code: `S${sections.length + 1}`,
                    color: SECTION_COLORS[sections.length % SECTION_COLORS.length],
                  },
                  currentTimeSec
                )
              }
              className="px-3.5 py-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-xs font-semibold text-studio-ink flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Añadir en {formatSectionMmSs(currentTimeSec)}</span>
            </button>

            {sections.length > 0 && (
              <button
                type="button"
                onClick={() => setSections([])}
                className="px-3 py-2 rounded-lg bg-neutral-900 hover:bg-red-500/15 border border-neutral-800 text-xs font-medium text-neutral-400 hover:text-red-300 cursor-pointer"
              >
                Borrar todas
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-neutral-300 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-2 rounded-lg bg-studio-ink hover:bg-neutral-200 text-studio-ground text-xs font-semibold cursor-pointer"
            >
              Guardar Secciones (mm:ss)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
