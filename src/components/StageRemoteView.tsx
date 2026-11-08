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
} from 'lucide-react';
import { QuantizeMode, SongProject, TransportState } from '../types/project';

interface StageRemoteViewProps {
  project: SongProject;
  transport: TransportState;
  onPlayPause: () => void;
  onStop: () => void;
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
  onPlayPause,
  onStop,
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

  const handleCopyRemoteUrl = () => {
    const url = new URL(window.location.href);
    url.hash = 'remote';
    navigator.clipboard?.writeText(url.toString());
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  return (
    <div className="flex-1 bg-[#0B0F17] p-4 md:p-6 overflow-y-auto select-none">
      <div className="max-w-7xl mx-auto flex flex-col gap-5">
        {/* Top Stage HUD: Giant Bar:Beat Clock + Active/Queued Section Banner */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          {/* Giant Bar : Beat Telemetry Card (5 cols) */}
          <div className="lg:col-span-5 bg-[#111827] border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="font-semibold text-slate-200 truncate">
                {project.title}
              </span>
              <span className="font-mono tabular-nums">
                {project.bpm} BPM · {project.beatsPerBar}/{project.beatUnit}
              </span>
            </div>

            <div className="my-4 flex items-center justify-between gap-4">
              <div className="flex items-baseline gap-2">
                <span className="font-mono tabular-nums text-5xl sm:text-6xl font-bold text-slate-100 tracking-tight">
                  {String(transport.currentBar).padStart(3, '0')}
                </span>
                <span className="font-mono text-4xl text-slate-600">:</span>
                <span className="font-mono tabular-nums text-5xl sm:text-6xl font-bold text-cyan-400">
                  {transport.currentBeat}
                </span>
              </div>

              {/* High-visibility Beat Blocks for Stage Peripheral Vision */}
              <div className="flex items-center gap-2">
                {Array.from({ length: project.beatsPerBar }).map((_, idx) => {
                  const beatNum = idx + 1;
                  const isCurrent = transport.isPlaying && transport.currentBeat === beatNum;
                  return (
                    <div
                      key={beatNum}
                      className={`w-5 h-12 rounded-md transition-opacity ${
                        isCurrent
                          ? beatNum === 1
                            ? 'bg-amber-400 opacity-100'
                            : 'bg-cyan-400 opacity-100'
                          : 'bg-slate-800/80 opacity-40'
                      }`}
                    />
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-slate-400 pt-2 border-t border-slate-800/80">
              <span className="flex items-center gap-1.5 text-cyan-300">
                <Radio className="w-3.5 h-3.5" />
                <span>Sync multi-ventana activo</span>
              </span>
              <button
                type="button"
                onClick={handleCopyRemoteUrl}
                className="text-slate-300 hover:text-white flex items-center gap-1 cursor-pointer"
              >
                {copiedLink ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-400">Enlace copiado</span>
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

          {/* Active & Queued Section Status HUD (7 cols) */}
          <div className="lg:col-span-7 bg-[#111827] border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Current Active Section */}
              <div className="bg-[#0B0F17] border border-slate-800 rounded-xl p-4">
                <div className="text-xs text-slate-400 mb-1">Sección en Curso</div>
                <div className="font-display text-2xl sm:text-3xl font-bold text-emerald-400 truncate">
                  {activeSection ? activeSection.name : 'Detenido'}
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-400 mt-1">
                  {activeSection
                    ? `Compases ${activeSection.startBar}–${activeSection.startBar + activeSection.lengthBars - 1}`
                    : 'Listo para iniciar'}
                </div>
              </div>

              {/* Next / Queued Jump Status */}
              <div
                className={`rounded-xl p-4 border ${
                  queuedSection
                    ? 'bg-amber-500/15 border-amber-400'
                    : transport.isVamping
                    ? 'bg-amber-500/10 border-amber-500/50'
                    : 'bg-[#0B0F17] border-slate-800'
                }`}
              >
                <div className="text-xs text-slate-300 mb-1">
                  {queuedSection
                    ? 'Salto en Cola (Sincronizado al Compás)'
                    : transport.isVamping
                    ? 'Modo Bucle Dinámico'
                    : 'Estado de Transición'}
                </div>
                <div className="font-display text-2xl sm:text-3xl font-bold text-amber-300 truncate">
                  {queuedSection
                    ? `→ ${queuedSection.name}`
                    : transport.isVamping
                    ? 'VAMP LOOP ACTIVO'
                    : 'Flujo Lineal'}
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-300 mt-1">
                  {queuedSection
                    ? `Entra en ${transport.countdownBeats} pulsos (Compás ${transport.queuedTargetBar})`
                    : transport.isVamping
                    ? 'Repitiendo sección actual indefinidamente'
                    : `Cuantización: ${project.quantizeMode}`}
                </div>
              </div>
            </div>

            {/* Quantize Mode Selector Bar for Stage */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-800">
              <span className="text-xs font-medium text-slate-400">
                Cuantización de Salto:
              </span>
              <div className="flex items-center gap-1.5">
                {(
                  [
                    { id: '1-bar', label: '1 Compás' },
                    { id: '2-bars', label: '2 Compases' },
                    { id: 'section-end', label: 'Fin Sección' },
                    { id: 'immediate', label: 'Inmediato' },
                  ] as { id: QuantizeMode; label: string }[]
                ).map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => onChangeQuantize(q.id)}
                    className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                      project.quantizeMode === q.id
                        ? 'bg-cyan-400 text-slate-950'
                        : 'bg-slate-900 text-slate-300 border border-slate-800 hover:bg-slate-800'
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
            <h2 className="font-display text-base font-semibold text-slate-200">
              Pads de Sección en Vivo (Toca para saltar al compás)
            </h2>
            <span className="text-xs text-slate-400">
              Toca de nuevo una sección en cola para cancelar el salto
            </span>
          </div>

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
                      ? 'bg-amber-500/20 border-amber-400 text-amber-100'
                      : isVampingHere
                      ? 'bg-amber-500/15 border-amber-500 text-amber-200'
                      : isActive
                      ? 'bg-emerald-500/20 border-emerald-400 text-emerald-100'
                      : 'bg-[#111827] border-slate-800 text-slate-200 hover:bg-slate-800/80'
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <span
                      style={{ backgroundColor: sec.color }}
                      className="px-2 py-0.5 rounded text-xs font-mono font-bold text-slate-950"
                    >
                      {sec.code || idx + 1}
                    </span>
                    <span className="font-mono tabular-nums text-xs text-slate-400">
                      c.{sec.startBar} ({sec.lengthBars}c)
                    </span>
                  </div>

                  <div className="my-2">
                    <div className="font-display text-lg font-bold leading-snug truncate">
                      {sec.name}
                    </div>
                  </div>

                  <div className="text-xs font-mono tabular-nums flex items-center justify-between">
                    {isQueued ? (
                      <span className="text-amber-300 font-bold">
                        EN COLA · {transport.countdownBeats} PULSOS
                      </span>
                    ) : isVampingHere ? (
                      <span className="text-amber-300 font-semibold flex items-center gap-1">
                        <Repeat className="w-3.5 h-3.5" /> VAMP ACTIVO
                      </span>
                    ) : isActive ? (
                      <span className="text-emerald-300 font-semibold">
                        REPRODUCIENDO
                      </span>
                    ) : (
                      <span className="text-slate-500">Tocar para saltar</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Bottom Natural Thumb Zone: Primary Stage Transport Triggers + Quick Mix & Stems Mute */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          {/* Big Stage Transport Controls (6 cols) */}
          <div className="lg:col-span-6 bg-[#111827] border border-slate-800 rounded-2xl p-4 grid grid-cols-3 gap-3">
            <button
              type="button"
              onClick={onPlayPause}
              className={`min-h-[72px] rounded-xl font-display text-base font-bold flex flex-col items-center justify-center gap-1.5 transition-transform active:scale-[0.98] cursor-pointer ${
                transport.isPlaying
                  ? 'bg-emerald-500 text-slate-950'
                  : 'bg-cyan-400 text-slate-950'
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
              className={`min-h-[72px] rounded-xl font-display text-base font-bold flex flex-col items-center justify-center gap-1.5 border transition-transform active:scale-[0.98] cursor-pointer ${
                transport.isVamping
                  ? 'bg-amber-400 text-slate-950 border-amber-300'
                  : 'bg-slate-900 text-slate-200 border-slate-700 hover:bg-slate-800'
              }`}
            >
              <Repeat className="w-6 h-6" />
              <span>{transport.isVamping ? 'SALIR VAMP' : 'VAMP LOOP'}</span>
            </button>

            <button
              type="button"
              onClick={onStop}
              className="min-h-[72px] rounded-xl bg-slate-900 hover:bg-red-500/20 text-slate-200 hover:text-red-300 border border-slate-800 font-display text-base font-bold flex flex-col items-center justify-center gap-1.5 transition-transform active:scale-[0.98] cursor-pointer"
            >
              <Square className="w-6 h-6 fill-current" />
              <span>STOP / INICIO</span>
            </button>
          </div>

          {/* Quick Monitor Bus Faders & Stem Mute Matrix (6 cols) */}
          <div className="lg:col-span-6 bg-[#111827] border border-slate-800 rounded-2xl p-4 flex flex-col justify-between gap-4">
            {/* Click, Cues, Master Touch Sliders */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-[#0B0F17] border border-slate-800 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <button
                    type="button"
                    onClick={onToggleClick}
                    className={`text-xs font-semibold flex items-center gap-1 cursor-pointer ${
                      project.clickEnabled ? 'text-cyan-400' : 'text-slate-500 line-through'
                    }`}
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Click</span>
                  </button>
                  <span className="font-mono tabular-nums text-xs text-slate-400">
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
                  className="w-full accent-cyan-400 h-2 bg-slate-800 rounded-lg cursor-pointer"
                />
              </div>

              <div className="bg-[#0B0F17] border border-slate-800 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <button
                    type="button"
                    onClick={onToggleGuide}
                    className={`text-xs font-semibold flex items-center gap-1 cursor-pointer ${
                      project.guideCuesEnabled ? 'text-cyan-400' : 'text-slate-500 line-through'
                    }`}
                  >
                    <Mic className="w-3.5 h-3.5" />
                    <span>Guía Vocal</span>
                  </button>
                  <span className="font-mono tabular-nums text-xs text-slate-400">
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
                  className="w-full accent-cyan-400 h-2 bg-slate-800 rounded-lg cursor-pointer"
                />
              </div>

              <div className="bg-[#0B0F17] border border-slate-800 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-emerald-400">
                    Master L/R
                  </span>
                  <span className="font-mono tabular-nums text-xs text-slate-400">
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
                  className="w-full accent-emerald-400 h-2 bg-slate-800 rounded-lg cursor-pointer"
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
                      : 'bg-[#0B0F17] border-slate-800 text-slate-200 hover:bg-slate-800'
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
