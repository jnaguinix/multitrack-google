import React, { useState } from 'react';
import {
  Play,
  Pause,
  Square,
  Repeat,
  Volume2,
  Mic,
  Radio,
  Check,
  Copy,
  SkipBack,
  SkipForward,
  ListMusic,
} from 'lucide-react';
import { QuantizeMode, SongProject, TransportState } from '../types/project';
import { formatMmSs, formatTimecode } from './TransportDeck';

interface StageRemoteViewProps {
  project: SongProject;
  transport: TransportState;
  setlistQueue: SongProject[];
  onPlayPause: () => void;
  onStop: () => void;
  onPrevSetlistSong: () => void;
  onNextSetlistSong: () => void;
  onJumpSection: (sectionId: string) => void;
  onToggleVamp: () => void;
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
  onPlayPause,
  onStop,
  onPrevSetlistSong,
  onNextSetlistSong,
  onJumpSection,
  onToggleVamp,
  onToggleClick,
  onToggleGuide,
  onChangeQuantize,
  onChangeClickGain,
  onChangeGuideGain,
  onChangeMasterGain,
  onToggleTrackMute,
}) => {
  const [copiedLink, setCopiedLink] = useState(false);

  const activeSection = project.sections.find((s) => s.id === transport.activeSectionId);
  const queuedSection = project.sections.find((s) => s.id === transport.queuedSectionId);
  const currentSetlistIdx = setlistQueue.findIndex((s) => s.id === project.id);

  const handleCopyRemoteUrl = () => {
    const url = new URL(window.location.href);
    url.hash = 'remote';
    navigator.clipboard?.writeText(url.toString());
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  return (
    <div className="flex-1 bg-studio-ground p-4 md:p-6 overflow-y-auto select-none">
      <div className="max-w-7xl mx-auto flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Control remoto</h1>
        {/* Top Stage HUD: Giant Timecode Clock + Active/Queued Section & Setlist Banner */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          {/* Giant Timecode Telemetry Card (5 cols) */}
          <div className="lg:col-span-5 bg-studio-panel border border-neutral-800 rounded-2xl p-5 flex flex-col justify-between">
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

            <div className="flex items-center justify-between text-xs text-neutral-400 pt-2 border-t border-neutral-800/80">
              <span className="flex items-center gap-1.5 text-studio-ink font-medium">
                <Radio className="w-3.5 h-3.5" />
                <span>Sync multi-ventana activo</span>
              </span>
              <button
                type="button"
                onClick={handleCopyRemoteUrl}
                className="text-neutral-300 hover:text-white flex items-center gap-1 cursor-pointer"
              >
                {copiedLink ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-studio-ink" />
                    <span className="text-studio-ink">Enlace copiado</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copiar URL Remote</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Active & Queued Section Status HUD + Setlist Navigation (7 cols) */}
          <div className="lg:col-span-7 bg-studio-panel border border-neutral-800 rounded-2xl p-5 flex flex-col justify-between">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Current Active Section */}
              <div className="bg-studio-ground border border-neutral-800 rounded-xl p-4">
                <div className="text-xs text-neutral-400 mb-1">Sección en Curso</div>
                <div className="text-2xl sm:text-3xl font-bold text-studio-ink truncate">
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
                className={`rounded-xl p-4 border ${
                  queuedSection
                    ? 'bg-amber-500/15 border-amber-500'
                    : transport.isVamping
                    ? 'bg-amber-500/10 border-amber-500/50'
                    : 'bg-studio-ground border-neutral-800'
                }`}
              >
                <div className="text-xs text-neutral-300 mb-1">
                  {queuedSection
                    ? 'Salto en Cola'
                    : transport.isVamping
                    ? 'Modo Bucle Dinámico'
                    : 'Cola del Setlist en Vivo'}
                </div>
                <div className="text-2xl sm:text-3xl font-bold text-amber-300 truncate">
                  {queuedSection
                    ? `→ ${queuedSection.name}`
                    : transport.isVamping
                    ? 'VAMP LOOP ACTIVO'
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
                      : `Modo Salto: ${project.quantizeMode}`}
                  </span>
                </div>
              </div>
            </div>

            {/* Setlist Prev/Next + Quantize Selector Bar */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-neutral-800">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-amber-300 flex items-center gap-1">
                  <ListMusic className="w-3.5 h-3.5" />
                  <span>Setlist:</span>
                </span>
                <button
                  type="button"
                  onClick={onPrevSetlistSong}
                  disabled={currentSetlistIdx <= 0}
                  className="min-h-[38px] px-3 py-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 disabled:opacity-30 text-neutral-200 border border-neutral-800 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <SkipBack className="w-3.5 h-3.5" />
                  <span>Anterior</span>
                </button>
                <button
                  type="button"
                  onClick={onNextSetlistSong}
                  disabled={
                    setlistQueue.length === 0 ||
                    currentSetlistIdx >= setlistQueue.length - 1
                  }
                  className="min-h-[38px] px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-30 text-neutral-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <span>Siguiente Canción</span>
                  <SkipForward className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                {(
                  [
                    { id: 'immediate', label: 'Inmediato' },
                    { id: '1-bar', label: '1 Compás' },
                    { id: 'section-end', label: 'Fin Sección' },
                  ] as { id: QuantizeMode; label: string }[]
                ).map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => onChangeQuantize(q.id)}
                    className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      project.quantizeMode === q.id
                        ? 'bg-studio-ink text-studio-ground hover:bg-neutral-200'
                        : 'bg-neutral-900 text-neutral-300 border border-neutral-800 hover:bg-neutral-800'
                    }`}
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
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-base font-semibold text-neutral-200">
              Pads de Sección en Vivo (Minutos y Segundos)
            </h2>
            <span className="text-xs text-neutral-400">
              Toca una sección para saltar a su marca de tiempo (mm:ss)
            </span>
          </div>

          {project.sections.length === 0 ? (
            <div className="p-8 rounded-2xl bg-studio-panel border border-neutral-800 text-center text-xs text-neutral-400">
              Esta canción aún no tiene marcadores de sección. Puedes añadirlos con el botón «+ Marcar aquí» en la barra de transporte.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {project.sections.map((sec, idx) => {
                const isActive = sec.id === transport.activeSectionId;
                const isQueued = sec.id === transport.queuedSectionId;
                const isVampingHere = isActive && transport.isVamping;

                return (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => onJumpSection(sec.id)}
                    className={`min-h-[104px] p-4 rounded-2xl border text-left flex flex-col justify-between transition-transform active:scale-[0.98] cursor-pointer ${
                      isQueued
                        ? 'bg-amber-500/20 border-amber-500 text-amber-100'
                        : isVampingHere
                        ? 'bg-amber-500/15 border-amber-500 text-amber-200'
                        : isActive
                        ? 'bg-studio-strip border-studio-line text-emerald-100'
                        : 'bg-studio-panel border-neutral-800 text-neutral-200 hover:bg-neutral-800/80'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span
                        style={{ backgroundColor: sec.color }}
                        className="px-2 py-0.5 rounded text-xs font-bold text-white"
                      >
                        {sec.code || idx + 1}
                      </span>
                      <span className="tabular-nums text-xs text-neutral-400">
                        {formatMmSs(sec.startTimeSec)}
                      </span>
                    </div>

                    <div className="my-2">
                      <div className="text-lg font-bold leading-snug truncate">
                        {sec.name}
                      </div>
                    </div>

                    <div className="text-xs tabular-nums flex items-center justify-between">
                      {isQueued ? (
                        <span className="text-amber-300 font-bold">EN COLA</span>
                      ) : isVampingHere ? (
                        <span className="text-amber-300 font-semibold flex items-center gap-1">
                          <Repeat className="w-3.5 h-3.5" /> VAMP ACTIVO
                        </span>
                      ) : isActive ? (
                        <span className="text-studio-ink font-semibold">
                          REPRODUCIENDO
                        </span>
                      ) : (
                        <span className="text-neutral-400">Tocar para saltar</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Bottom Natural Thumb Zone: Primary Stage Transport Triggers + Quick Mix & Stems Mute */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          {/* Big Stage Transport Controls (6 cols) */}
          <div className="lg:col-span-6 bg-studio-panel border border-neutral-800 rounded-2xl p-4 grid grid-cols-3 gap-3">
            <button
              type="button"
              onClick={onPlayPause}
              className={`min-h-[72px] rounded-xl text-base font-bold flex flex-col items-center justify-center gap-1.5 transition-transform active:scale-[0.98] cursor-pointer ${
                transport.isPlaying
                  ? 'bg-studio-ink text-studio-ground hover:bg-neutral-200'
                  : 'bg-studio-ink text-studio-ground hover:bg-neutral-200'
              }`}
            >
              {transport.isPlaying ? (
                <Pause className="w-6 h-6 fill-current" />
              ) : (
                <Play className="w-6 h-6 fill-current" />
              )}
              <span>{transport.isPlaying ? 'PAUSE' : 'PLAY SHOW'}</span>
            </button>

            <button
              type="button"
              onClick={onToggleVamp}
              className={`min-h-[72px] rounded-xl text-base font-bold flex flex-col items-center justify-center gap-1.5 border transition-transform active:scale-[0.98] cursor-pointer ${
                transport.isVamping
                  ? 'bg-amber-400 text-neutral-950 border-amber-300'
                  : 'bg-neutral-900 text-neutral-200 border-neutral-700 hover:bg-neutral-800'
              }`}
            >
              <Repeat className="w-6 h-6" />
              <span>{transport.isVamping ? 'SALIR VAMP' : 'VAMP LOOP'}</span>
            </button>

            <button
              type="button"
              onClick={onStop}
              className="min-h-[72px] rounded-xl bg-neutral-900 hover:bg-red-500/15 text-neutral-200 hover:text-red-300 border border-neutral-800 text-base font-bold flex flex-col items-center justify-center gap-1.5 transition-transform active:scale-[0.98] cursor-pointer"
            >
              <Square className="w-6 h-6 fill-current" />
              <span>STOP / INICIO</span>
            </button>
          </div>

          {/* Quick Monitor Bus Faders & Stem Mute Matrix (6 cols) */}
          <div className="lg:col-span-6 bg-studio-panel border border-neutral-800 rounded-2xl p-4 flex flex-col justify-between gap-4">
            {/* Click, Cues, Master Touch Sliders */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-studio-ground border border-neutral-800 rounded-xl p-3">
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
                    {Math.round(project.clickGain * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Nivel de Click"
                  min={0}
                  max={1.25}
                  step={0.02}
                  value={project.clickGain}
                  onChange={(e) => onChangeClickGain(Number(e.target.value))}
                  className="w-full accent-studio-accent h-2 bg-neutral-800 rounded-lg cursor-pointer"
                />
              </div>

              <div className="bg-studio-ground border border-neutral-800 rounded-xl p-3">
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
                    {Math.round(project.guideGain * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Nivel de Guía"
                  min={0}
                  max={1.25}
                  step={0.02}
                  value={project.guideGain}
                  onChange={(e) => onChangeGuideGain(Number(e.target.value))}
                  className="w-full accent-studio-accent h-2 bg-neutral-800 rounded-lg cursor-pointer"
                />
              </div>

              <div className="bg-studio-ground border border-neutral-800 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-studio-ink">
                    Master L/R
                  </span>
                  <span className="tabular-nums text-xs text-neutral-400">
                    {Math.round(project.masterGain * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Nivel Master"
                  min={0}
                  max={1.25}
                  step={0.02}
                  value={project.masterGain}
                  onChange={(e) => onChangeMasterGain(Number(e.target.value))}
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
        </div>
      </div>
    </div>
  );
};
