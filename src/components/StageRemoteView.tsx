import React, { useState } from 'react';
import {
  Volume2,
  Mic,
  Check,
  Copy,
} from 'lucide-react';
import { QuantizeMode, SongProject, TransportState } from '../types/project';
import { formatMmSs, formatTimecode } from './TransportDeck';
import { dbFromPos, dbToGain, formatDb, gainToDb, posFromDb } from './MultitrackMixer';

function gainToSliderPos(gain: number): number {
  return Number(posFromDb(gainToDb(gain)).toFixed(3));
}

function sliderPosToGain(pos: number): number {
  const db = dbFromPos(Math.max(0, Math.min(1, pos)));
  return !Number.isFinite(db) ? 0 : dbToGain(Math.round(db * 10) / 10);
}

interface StageRemoteViewProps {
  project: SongProject;
  transport: TransportState;
  setlistQueue: SongProject[];
  onJumpSection: (sectionId: string) => void;
  onToggleClick: () => void;
  onToggleGuide: () => void;
  onChangeQuantize: (mode: QuantizeMode) => void;
  onChangeClickGain: (gain: number) => void;
  onChangeGuideGain: (gain: number) => void;
  onChangeMasterGain: (gain: number) => void;
  onToggleTrackMute: (trackId: string) => void;
}

export const StageRemoteView: React.FC<StageRemoteViewProps> = ({
  project,
  transport,
  setlistQueue,
  onJumpSection,
  onToggleClick,
  onToggleGuide,
  onChangeQuantize,
  onChangeClickGain,
  onChangeGuideGain,
  onChangeMasterGain,
  onToggleTrackMute,
}) => {
  const [linkStatus, setLinkStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const activeSection = project.sections.find((s) => s.id === transport.activeSectionId);
  const queuedSection = project.sections.find((s) => s.id === transport.queuedSectionId);
  const currentSetlistIdx = setlistQueue.findIndex((s) => s.id === project.id);

  const handleCopyViewUrl = async () => {
    const url = new URL(window.location.href);
    url.hash = 'remote';
    try {
      await navigator.clipboard.writeText(url.toString());
      setLinkStatus('copied');
    } catch {
      setLinkStatus('failed');
    }
    setTimeout(() => setLinkStatus('idle'), 2000);
  };

  return (
    <div className="flex-1 bg-studio-ground p-4 md:p-6 overflow-y-auto select-none">
      <div className="max-w-7xl mx-auto flex flex-col gap-4">
        <header>
          <h1 className="text-xl font-semibold">Control rápido</h1>
          <p className="mt-1 text-sm text-[var(--lt-mut)]">Estado de la canción, saltos y mezcla de esta ventana.</p>
        </header>
        {/* Top Stage HUD: Giant Timecode Clock + Active/Queued Section & Setlist Banner */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          {/* Giant Timecode Telemetry Card (5 cols) */}
          <div className="lg:col-span-5 bg-studio-panel border border-studio-line rounded-lg p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span className="font-semibold text-neutral-200 truncate">
                {project.title}
              </span>
              <span className="tabular-nums">
                {project.bpm} BPM · {project.keySignature}
              </span>
            </div>

            <div className="my-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-baseline gap-2">
                <span className="tabular-nums text-4xl sm:text-5xl font-bold text-studio-ink tracking-tight">
                  {formatTimecode(transport.currentTimeSec)}
                </span>
                <span className="text-xl text-neutral-400">
                  / {formatMmSs(transport.totalDurationSec)}
                </span>
              </div>

              {/* High-visibility Beat Blocks for Stage Peripheral Vision */}
              <div className="flex items-center gap-1 sm:gap-2">
                {Array.from({ length: project.beatsPerBar }).map((_, idx) => {
                  const beatNum = idx + 1;
                  const isCurrent = transport.isPlaying && transport.currentBeat === beatNum;
                  return (
                    <div
                      key={beatNum}
                      className={`w-2.5 h-8 sm:w-5 sm:h-12 rounded-md transition-opacity ${
                        isCurrent
                          ? beatNum === 1
                            ? 'bg-amber-500 opacity-100'
                            : 'bg-studio-accent opacity-100'
                          : 'bg-neutral-800/80 opacity-40'
                      }`}
                    />
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 text-xs text-neutral-400 pt-2 border-t border-studio-line">
              <span>Tiempo transcurrido</span>
              <button
                type="button"
                onClick={handleCopyViewUrl}
                className="text-neutral-300 hover:text-white flex items-center gap-1 cursor-pointer"
              >
                {linkStatus === 'copied' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-studio-ink" />
                    <span className="text-studio-ink">Enlace copiado</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>{linkStatus === 'failed' ? 'No se pudo copiar' : 'Copiar enlace de esta vista'}</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Active & Queued Section Status HUD + Setlist Navigation (7 cols) */}
          <div className="lg:col-span-7 bg-studio-panel border border-studio-line rounded-lg p-4 flex flex-col justify-between">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Current Active Section */}
              <div className="min-w-0">
                <div className="text-xs text-neutral-400 mb-1">Sección actual</div>
                <div className="text-xl font-semibold text-studio-ink wrap-anywhere">
                  {activeSection ? activeSection.name : 'Reproducción Libre'}
                </div>
                <div className="text-xs tabular-nums text-neutral-400 mt-1">
                  {activeSection
                    ? `${formatMmSs(activeSection.startTimeSec)} – ${formatMmSs(activeSection.endTimeSec)}`
                    : 'Sin marcadores activos'}
                </div>
              </div>

              {/* Next / Queued Jump Status or Setlist Status */}
              <div
                className="min-w-0"
              >
                <div className="text-xs text-neutral-300 mb-1">
                  {queuedSection
                    ? 'Salto programado'
                    : transport.isVamping
                    ? 'Repetición de sección'
                    : 'Setlist'}
                </div>
                <div className={`text-xl font-semibold wrap-anywhere ${queuedSection || transport.isVamping ? 'text-amber-300' : 'text-studio-ink'}`}>
                  {queuedSection
                    ? `→ ${queuedSection.name}`
                    : transport.isVamping
                    ? 'Repitiendo'
                    : currentSetlistIdx >= 0
                    ? `Tema ${currentSetlistIdx + 1} de ${setlistQueue.length}`
                    : `${setlistQueue.length} temas en Setlist`}
                </div>
                <div className="text-xs tabular-nums text-neutral-300 mt-1 flex items-center justify-between">
                  <span>
                    {queuedSection
                      ? `Entra en ${formatMmSs(queuedSection.startTimeSec)}`
                      : currentSetlistIdx >= 0 &&
                        currentSetlistIdx < setlistQueue.length - 1
                      ? `Siguiente: ${setlistQueue[currentSetlistIdx + 1].title}`
                      : currentSetlistIdx >= 0 ? 'Fin del setlist' : 'Canción fuera del setlist'}
                  </span>
                </div>
              </div>
            </div>

            <div role="radiogroup" aria-label="Cuándo saltar de sección" className="mt-4 flex flex-wrap items-center gap-2 pt-3 border-t border-studio-line">
              <span className="text-xs text-neutral-400">Saltar</span>
              <div className="lt-live-seg flex-wrap">
                {(
                  [
                    { id: 'immediate', label: 'Inmediato' },
                    { id: '1-bar', label: 'Al compás' },
                    { id: 'section-end', label: 'Al final' },
                  ] as { id: QuantizeMode; label: string }[]
                ).map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => onChangeQuantize(q.id)}
                    role="radio"
                    aria-checked={project.quantizeMode === q.id}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Stretch Zone: Large Tactile Section Jump Pads */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-1 mb-2.5">
            <h2 className="text-base font-semibold text-neutral-200">
              Secciones
            </h2>
            <span className="text-xs text-neutral-400">
              Toca una sección para programar el salto.
            </span>
          </div>

          {project.sections.length === 0 ? (
            <div className="p-8 rounded-2xl bg-studio-panel border border-neutral-800 text-center text-xs text-neutral-400">
              Esta canción aún no tiene marcadores de sección. Puedes añadirlos con el botón «+ Marcar aquí» en la barra de transporte.
            </div>
          ) : (
            <div className="lt-live-pads">
              {project.sections.map((sec, idx) => {
                const isActive = sec.id === transport.activeSectionId;
                const isQueued = sec.id === transport.queuedSectionId;
                const isVampingHere = isActive && transport.isVamping;

                return (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => onJumpSection(sec.id)}
                    className="lt-live-pad"
                    data-active={isActive || undefined}
                    data-queued={isQueued || undefined}
                    aria-pressed={isActive}
                    style={{ '--sec': sec.color || 'var(--lt-accent)' } as React.CSSProperties}
                  >
                    <span className="lt-live-pad-heading">
                      <span className="lt-live-pad-name">{sec.name}</span>
                      {isQueued && <span className="lt-live-pad-flag">En cola</span>}
                    </span>
                    <span className="lt-live-pad-meta gap-2">
                      <span>{formatMmSs(sec.startTimeSec)} · {sec.code || idx + 1}</span>
                      {isVampingHere ? <span className="text-amber-300">En bucle</span> : isActive ? <span>Actual</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <section aria-labelledby="quick-mix-title">
          <h2 id="quick-mix-title" className="mb-2 text-base font-semibold">Mezcla rápida</h2>
          <div className="bg-studio-panel border border-studio-line rounded-lg p-4 flex flex-col gap-4">
            {/* Click, Cues, Master Touch Sliders */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-studio-ground border border-studio-line rounded-md p-3">
                <div className="flex items-center justify-between mb-2">
                  <button
                    type="button"
                    onClick={onToggleClick}
                    className={`text-xs font-semibold flex items-center gap-1 cursor-pointer ${
                      project.clickEnabled ? 'text-studio-ink' : 'text-neutral-400 line-through'
                    }`}
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Click</span>
                  </button>
                  <span className="tabular-nums text-xs text-neutral-400">
                    {formatDb(gainToDb(project.clickGain))}
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Nivel de Click"
                  min={0}
                  max={1}
                  step={0.001}
                  value={gainToSliderPos(project.clickGain)}
                  onChange={(e) => onChangeClickGain(sliderPosToGain(Number(e.target.value)))}
                  onDoubleClick={() => onChangeClickGain(1.0)}
                  className="w-full accent-studio-accent h-2 bg-neutral-800 rounded-lg cursor-pointer"
                />
              </div>

              <div className="bg-studio-ground border border-studio-line rounded-md p-3">
                <div className="flex items-center justify-between mb-2">
                  <button
                    type="button"
                    onClick={onToggleGuide}
                    className={`text-xs font-semibold flex items-center gap-1 cursor-pointer ${
                      project.guideCuesEnabled ? 'text-studio-ink' : 'text-neutral-400 line-through'
                    }`}
                  >
                    <Mic className="w-3.5 h-3.5" />
                    <span>Guía Vocal</span>
                  </button>
                  <span className="tabular-nums text-xs text-neutral-400">
                    {formatDb(gainToDb(project.guideGain))}
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Nivel de Guía"
                  min={0}
                  max={1}
                  step={0.001}
                  value={gainToSliderPos(project.guideGain)}
                  onChange={(e) => onChangeGuideGain(sliderPosToGain(Number(e.target.value)))}
                  onDoubleClick={() => onChangeGuideGain(1.0)}
                  className="w-full accent-studio-accent h-2 bg-neutral-800 rounded-lg cursor-pointer"
                />
              </div>

              <div className="bg-studio-ground border border-studio-line rounded-md p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-studio-ink">
                    Master L/R
                  </span>
                  <span className="tabular-nums text-xs text-neutral-400">
                    {formatDb(gainToDb(project.masterGain))}
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Nivel Master"
                  min={0}
                  max={1}
                  step={0.001}
                  value={gainToSliderPos(project.masterGain)}
                  onChange={(e) => onChangeMasterGain(sliderPosToGain(Number(e.target.value)))}
                  onDoubleClick={() => onChangeMasterGain(1.0)}
                  className="w-full accent-emerald-400 h-2 bg-neutral-800 rounded-lg cursor-pointer"
                />
              </div>
            </div>

            {/* Quick Stem Mute Pads */}
            <div className="flex flex-wrap items-center gap-2">
              {project.tracks.map((trk) => (
                <button
                  key={trk.id}
                  type="button"
                  onClick={() => onToggleTrackMute(trk.id)}
                  className={`min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold border flex items-center gap-2 transition-colors cursor-pointer ${
                    trk.muted
                      ? 'bg-red-500/15 border-red-500/50 text-red-300 line-through'
                      : 'bg-studio-ground border-neutral-800 text-neutral-200 hover:bg-neutral-800'
                  }`}
                >
                  <span
                    style={{ backgroundColor: trk.color }}
                    className="w-2 h-2 rounded-xs shrink-0"
                  />
                  <span className="truncate max-w-[120px]">{trk.name}</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
