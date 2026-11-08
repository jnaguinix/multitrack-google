import React from 'react';
import {
  Play,
  Pause,
  Square,
  Repeat,
  Volume2,
  Mic,
  Sliders,
  Plus,
  Wand2,
} from 'lucide-react';
import { QuantizeMode, SongProject, TransportState } from '../types/project';

interface TransportDeckProps {
  project: SongProject;
  transport: TransportState;
  importStatusText: string | null;
  onPlayPause: () => void;
  onStop: () => void;
  onToggleVamp: () => void;
  onChangeBpm: (bpm: number) => void;
  onChangePitch: (semitones: number) => void;
  onChangeQuantize: (mode: QuantizeMode) => void;
  onToggleClick: () => void;
  onToggleGuide: () => void;
  onToggleSplitRouting: () => void;
  onAutoDetectSections: () => void;
  onOpenSectionEditor: () => void;
}

function formatTimecode(sec: number): string {
  const mins = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  const tenths = Math.floor((sec % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}.${tenths}`;
}

export const TransportDeck: React.FC<TransportDeckProps> = ({
  project,
  transport,
  importStatusText,
  onPlayPause,
  onStop,
  onToggleVamp,
  onChangeBpm,
  onChangePitch,
  onChangeQuantize,
  onToggleClick,
  onToggleGuide,
  onToggleSplitRouting,
  onAutoDetectSections,
  onOpenSectionEditor,
}) => {
  const activeSection = project.sections.find((s) => s.id === transport.activeSectionId);
  const queuedSection = project.sections.find((s) => s.id === transport.queuedSectionId);

  const quantizeOptions: { value: QuantizeMode; label: string }[] = [
    { value: '1-bar', label: '1 Bar' },
    { value: '2-bars', label: '2 Bars' },
    { value: 'section-end', label: 'End' },
    { value: 'immediate', label: 'Now' },
  ];

  return (
    <section
      aria-label="Controles de Transporte y Compás"
      className="bg-[#111827] border-b border-slate-800 px-5 py-2.5 flex flex-wrap items-center justify-between gap-3 select-none"
    >
      {/* Left: Project identity & Primary Transport Triggers */}
      <div className="flex items-center gap-3.5">
        <div className="min-w-[160px] max-w-[220px]">
          <div className="font-display text-sm font-bold text-slate-100 truncate">
            {project.title}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-400 truncate">
            <span>{project.keySignature}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{project.beatsPerBar}/{project.beatUnit}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{project.totalBars} comp.</span>
          </div>
        </div>

        <div className="h-7 w-px bg-slate-800 hidden sm:block" />

        {/* Play/Pause, Stop, Vamp */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onPlayPause}
            title="Reproducir / Pausar (Barra Espaciadora)"
            className={`min-h-[38px] px-3.5 py-1.5 rounded-lg font-semibold text-xs flex items-center gap-1.5 transition-all whitespace-nowrap shrink-0 cursor-pointer ${
              transport.isPlaying
                ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                : 'bg-slate-800 text-slate-100 hover:bg-slate-700 border border-slate-700'
            }`}
          >
            {transport.isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
            <span>{transport.isPlaying ? 'Pause' : 'Play'}</span>
          </button>

          <button
            type="button"
            onClick={onStop}
            title="Detener y volver al inicio"
            className="min-h-[38px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Square className="w-3 h-3 fill-current" />
            <span>Stop</span>
          </button>

          <button
            type="button"
            onClick={onToggleVamp}
            title="Activar/Liberar Bucle de Sección (Tecla V)"
            className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all whitespace-nowrap shrink-0 cursor-pointer border ${
              transport.isVamping
                ? 'bg-amber-500 text-slate-950 border-amber-400'
                : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
            }`}
          >
            <Repeat className="w-3.5 h-3.5" />
            <span>{transport.isVamping ? 'Vamp ON' : 'Vamp'}</span>
          </button>
        </div>
      </div>

      {/* Center: Studio Digital Clock (BAR : BEAT | Timecode | Section Telemetry) */}
      <div className="flex items-center gap-3.5 bg-[#0B0F17] border border-slate-800 rounded-lg px-3.5 py-1.5">
        {/* Bar : Beat Counter */}
        <div className="flex items-baseline gap-1">
          <span className="text-[11px] font-medium text-slate-500">Bar</span>
          <span className="font-mono tabular-nums text-lg font-bold text-slate-100 tracking-tight">
            {String(transport.currentBar).padStart(3, '0')}
          </span>
          <span className="font-mono text-slate-600">:</span>
          <span className="font-mono tabular-nums text-lg font-bold text-cyan-400">
            {transport.currentBeat}
          </span>
        </div>

        {/* Visual Beat Pulse Bars */}
        <div className="flex items-center gap-1" aria-label={`Pulso ${transport.currentBeat} de ${project.beatsPerBar}`}>
          {Array.from({ length: project.beatsPerBar }).map((_, idx) => {
            const beatNum = idx + 1;
            const isCurrent = transport.isPlaying && transport.currentBeat === beatNum;
            const isDownbeat = beatNum === 1;
            return (
              <div
                key={beatNum}
                className={`w-2 h-4 rounded-xs transition-opacity ${
                  isCurrent
                    ? isDownbeat
                      ? 'bg-amber-400 opacity-100'
                      : 'bg-cyan-400 opacity-100'
                    : 'bg-slate-800 opacity-50'
                }`}
              />
            );
          })}
        </div>

        <div className="h-5 w-px bg-slate-800" />

        {/* Timecode MM:SS.d */}
        <div className="font-mono tabular-nums text-xs font-semibold text-slate-300">
          {formatTimecode(transport.currentTimeSec)}
        </div>

        <div className="h-5 w-px bg-slate-800 hidden xl:block" />

        {/* Active & Queued Section Readout or Live Import Progress */}
        <div className="hidden xl:flex items-center gap-2 min-w-[165px]">
          {importStatusText ? (
            <span className="text-xs font-semibold text-cyan-400 truncate">
              {importStatusText}
            </span>
          ) : (
            <>
              <div className="text-xs truncate">
                <span className="text-slate-500 mr-1">Sec:</span>
                <span className="font-semibold text-emerald-400">
                  {activeSection ? activeSection.name : '—'}
                </span>
              </div>
              {queuedSection && (
                <div className="text-xs font-mono tabular-nums text-amber-400 font-bold">
                  → {queuedSection.code} ({transport.countdownBeats}p)
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right: Quantize, Tempo/Pitch, Click/Cues, Auto-Detect */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Quantize Mode Selector */}
        <div className="flex items-center bg-[#0B0F17] p-0.5 rounded-lg border border-slate-800">
          <span className="text-[11px] text-slate-400 px-2 whitespace-nowrap shrink-0">
            Sync:
          </span>
          {quantizeOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChangeQuantize(opt.value)}
              className={`px-2 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                project.quantizeMode === opt.value
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* BPM & Pitch controls */}
        <div className="flex items-center gap-1.5 bg-[#0B0F17] px-2.5 py-1 rounded-lg border border-slate-800">
          <label htmlFor="bpm-input" className="text-[11px] text-slate-400">
            BPM
          </label>
          <input
            id="bpm-input"
            type="number"
            min={50}
            max={220}
            value={project.bpm}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (val >= 50 && val <= 220) onChangeBpm(val);
            }}
            className="w-12 bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-xs font-mono tabular-nums text-slate-100 text-right focus:outline-none focus:border-cyan-500"
          />

          <span className="text-slate-700">|</span>

          <select
            id="pitch-select"
            aria-label="Transposición de tono"
            value={project.pitchSemitones}
            onChange={(e) => onChangePitch(Number(e.target.value))}
            className="bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-500 cursor-pointer"
          >
            {[-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].map((st) => (
              <option key={st} value={st}>
                {st > 0 ? `+${st} st` : `${st} st`}
              </option>
            ))}
          </select>
        </div>

        {/* Click, Voice Cues, Split-Mono & Auto-Detect Sections */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleClick}
            title="Activar/Desactivar Metrónomo (Click Bus)"
            className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1 border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              project.clickEnabled
                ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            <Volume2 className="w-3.5 h-3.5" />
            <span>Click</span>
          </button>

          <button
            type="button"
            onClick={onToggleGuide}
            title="Activar/Desactivar Cues de Guía Vocal"
            className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1 border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              project.guideCuesEnabled
                ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            <Mic className="w-3.5 h-3.5" />
            <span>Cues</span>
          </button>

          <button
            type="button"
            onClick={onToggleSplitRouting}
            title="Alternar salida Estéreo vs Split-Mono (L: Click/Guía · R: Pistas)"
            className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1 border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              project.splitRoutingMode === 'split-mono'
                ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>{project.splitRoutingMode === 'split-mono' ? 'Split L/R' : 'Stereo'}</span>
          </button>

          <button
            type="button"
            onClick={onAutoDetectSections}
            title="Auto-detectar secciones y compases a partir de la energía del audio"
            className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Wand2 className="w-3.5 h-3.5 text-cyan-400" />
            <span>Auto-Secciones</span>
          </button>

          <button
            type="button"
            onClick={onOpenSectionEditor}
            title="Editar manualmente las secciones y compases"
            className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Secciones</span>
          </button>
        </div>
      </div>
    </section>
  );
};
