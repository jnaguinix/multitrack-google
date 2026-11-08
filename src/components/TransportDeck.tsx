import React from 'react';
import {
  Play,
  Pause,
  Square,
  Repeat,
  Volume2,
  Mic,
  Sliders,
  Flag,
  SkipBack,
  SkipForward,
  ListMusic,
} from 'lucide-react';
import {
  QuantizeMode,
  SetlistTransitionMode,
  SongProject,
  TransportState,
} from '../types/project';

interface TransportDeckProps {
  project: SongProject;
  transport: TransportState;
  setlistQueue: SongProject[];
  setlistTransitionMode: SetlistTransitionMode;
  importStatusText: string | null;
  onPlayPause: () => void;
  onStop: () => void;
  onToggleVamp: () => void;
  onPrevSetlistSong: () => void;
  onNextSetlistSong: () => void;
  onChangeSetlistTransitionMode: (mode: SetlistTransitionMode) => void;
  onChangeBpm: (bpm: number) => void;
  onChangePitch: (semitones: number) => void;
  onChangeQuantize: (mode: QuantizeMode) => void;
  onToggleClick: () => void;
  onToggleGuide: () => void;
  onToggleSplitRouting: () => void;
  onAddMarkerAtPlayhead: () => void;
  onOpenSectionEditor: () => void;
}

export function formatTimecode(sec: number): string {
  const safe = Math.max(0, sec || 0);
  const mins = Math.floor(safe / 60);
  const remSec = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}.${tenths}`;
}

export function formatMmSs(sec: number): string {
  const safe = Math.max(0, sec || 0);
  const mins = Math.floor(safe / 60);
  const remSec = Math.floor(safe % 60);
  return `${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
}

export const TransportDeck: React.FC<TransportDeckProps> = ({
  project,
  transport,
  setlistQueue,
  setlistTransitionMode,
  importStatusText,
  onPlayPause,
  onStop,
  onToggleVamp,
  onPrevSetlistSong,
  onNextSetlistSong,
  onChangeSetlistTransitionMode,
  onChangeBpm,
  onChangePitch,
  onChangeQuantize,
  onToggleClick,
  onToggleGuide,
  onToggleSplitRouting,
  onAddMarkerAtPlayhead,
  onOpenSectionEditor,
}) => {
  const activeSection = project.sections.find((s) => s.id === transport.activeSectionId);
  const queuedSection = project.sections.find((s) => s.id === transport.queuedSectionId);

  const currentSetlistIdx = setlistQueue.findIndex((s) => s.id === project.id);
  const nextSetlistSong =
    currentSetlistIdx >= 0 && currentSetlistIdx < setlistQueue.length - 1
      ? setlistQueue[currentSetlistIdx + 1]
      : null;

  const quantizeOptions: { value: QuantizeMode; label: string }[] = [
    { value: 'immediate', label: 'Inmediato' },
    { value: '1-bar', label: '1 Compás' },
    { value: 'section-end', label: 'Fin Sec.' },
  ];

  return (
    <section
      aria-label="Controles de Transporte y Setlist"
      className="bg-[#111827] border-b border-slate-800 px-4 py-2 flex flex-wrap items-center justify-between gap-2.5 select-none"
    >
      {/* Left: Project identity + Setlist Prev/Next + Transport */}
      <div className="flex items-center gap-3">
        <div className="min-w-[145px] max-w-[200px]">
          <div className="font-display text-sm font-bold text-slate-100 truncate">
            {project.title}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400 truncate">
            <span>{project.keySignature}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{project.bpm} BPM</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {formatMmSs(transport.totalDurationSec)}
            </span>
          </div>
        </div>

        {/* Setlist Live Mini-Controller */}
        {setlistQueue.length > 0 && (
          <div className="flex items-center gap-1 bg-[#0B0F17] border border-slate-800 rounded-lg px-2 py-1">
            <button
              type="button"
              onClick={onPrevSetlistSong}
              disabled={currentSetlistIdx <= 0}
              title="Canción anterior en el Setlist"
              className="p-1 rounded hover:bg-slate-800 text-slate-300 disabled:opacity-30 cursor-pointer"
            >
              <SkipBack className="w-3.5 h-3.5" />
            </button>

            <div className="px-1.5 text-center">
              <div className="text-[10px] font-mono font-bold text-amber-400 flex items-center gap-1">
                <ListMusic className="w-3 h-3" />
                <span>
                  {currentSetlistIdx >= 0
                    ? `${currentSetlistIdx + 1}/${setlistQueue.length}`
                    : `Setlist (${setlistQueue.length})`}
                </span>
              </div>
              {nextSetlistSong && (
                <div
                  className="text-[9px] text-slate-400 max-w-[95px] truncate"
                  title={`Siguiente: ${nextSetlistSong.title}`}
                >
                  Sig: {nextSetlistSong.title}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={onNextSetlistSong}
              disabled={
                currentSetlistIdx === -1
                  ? setlistQueue.length === 0
                  : currentSetlistIdx >= setlistQueue.length - 1
              }
              title="Siguiente canción en el Setlist"
              className="p-1 rounded hover:bg-amber-500/20 text-amber-300 disabled:opacity-30 cursor-pointer"
            >
              <SkipForward className="w-3.5 h-3.5" />
            </button>

            <select
              aria-label="Modo de transición del Setlist"
              value={setlistTransitionMode}
              onChange={(e) =>
                onChangeSetlistTransitionMode(
                  e.target.value as SetlistTransitionMode
                )
              }
              title="Acción al terminar la canción en el Setlist"
              className="bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-[10px] text-slate-300 focus:outline-none focus:border-amber-400 cursor-pointer ml-0.5"
            >
              <option value="stop">Fin: Parar</option>
              <option value="cue-next">Fin: Preparar Sig.</option>
              <option value="auto-play">Fin: Auto-Play Sig.</option>
            </select>
          </div>
        )}

        {/* Play/Pause, Stop, Vamp */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={Boolean(transport.isMountingSong)}
            onClick={onPlayPause}
            title={
              transport.isMountingSong
                ? transport.mountingProgressText || 'Cargando pistas en RAM...'
                : 'Reproducir / Pausar (Barra Espaciadora)'
            }
            className={`min-h-[36px] px-3.5 py-1.5 rounded-lg font-semibold text-xs flex items-center gap-1.5 transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
              transport.isMountingSong
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : transport.isPlaying
                ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                : 'bg-slate-800 text-slate-100 hover:bg-slate-700 border border-slate-700'
            }`}
          >
            {transport.isPlaying ? (
              <Pause className="w-3.5 h-3.5 fill-current" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current" />
            )}
            <span>
              {transport.isMountingSong
                ? 'Cargando RAM...'
                : transport.isPlaying
                ? 'Pause'
                : 'Play'}
            </span>
          </button>

          <button
            type="button"
            onClick={onStop}
            title="Detener y volver a 00:00"
            className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Square className="w-3 h-3 fill-current" />
            <span>Stop</span>
          </button>

          <button
            type="button"
            onClick={onToggleVamp}
            title="Activar/Liberar Bucle en la Sección Actual (Tecla V)"
            className={`min-h-[36px] px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all whitespace-nowrap shrink-0 cursor-pointer border ${
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

      {/* Center: Studio Digital Clock (MM:SS.d / Duration | Beat Pulse | Active Section) */}
      <div className="flex items-center gap-3 bg-[#0B0F17] border border-slate-800 rounded-lg px-3.5 py-1.5">
        {/* Primary Timecode MM:SS.d */}
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono tabular-nums text-lg font-bold text-cyan-400 tracking-tight">
            {formatTimecode(transport.currentTimeSec)}
          </span>
          <span className="font-mono text-xs text-slate-600">/</span>
          <span className="font-mono tabular-nums text-xs font-semibold text-slate-400">
            {formatMmSs(transport.totalDurationSec)}
          </span>
        </div>

        <div className="h-5 w-px bg-slate-800" />

        {/* Visual Beat Pulse Bars */}
        <div
          className="flex items-center gap-1"
          aria-label={`Pulso ${transport.currentBeat} de ${project.beatsPerBar}`}
        >
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

        <div className="h-5 w-px bg-slate-800 hidden xl:block" />

        {/* Active & Queued Section Readout or Live Import / RAM Mounting Progress */}
        <div className="hidden xl:flex items-center gap-2 min-w-[140px]">
          {transport.mountingProgressText || importStatusText ? (
            <span className="text-xs font-semibold text-amber-400 truncate">
              {transport.mountingProgressText || importStatusText}
            </span>
          ) : (
            <>
              <div className="text-xs truncate">
                <span className="text-slate-500 mr-1">Sec:</span>
                <span className="font-semibold text-emerald-400">
                  {activeSection ? activeSection.name : 'Sin marcador'}
                </span>
              </div>
              {queuedSection && (
                <div className="text-xs font-mono tabular-nums text-amber-400 font-bold">
                  → {queuedSection.code}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right: Playhead Section Marker, Quantize, Tempo/Pitch, Click/Cues */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Playhead Marker Creation & Section Time Editor */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onAddMarkerAtPlayhead}
            title="Crear marcador de sección exactamente en el segundo actual del cabezal"
            className="min-h-[34px] px-2.5 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/40 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Flag className="w-3.5 h-3.5 text-cyan-400" />
            <span>
              + Marcar aquí ({formatMmSs(transport.currentTimeSec)})
            </span>
          </button>

          <button
            type="button"
            onClick={onOpenSectionEditor}
            title="Abrir editor de secciones por minutos y segundos (mm:ss)"
            className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>Secciones ({project.sections.length})</span>
          </button>
        </div>

        {/* Quantize Mode Selector */}
        <div className="flex items-center bg-[#0B0F17] p-0.5 rounded-lg border border-slate-800">
          <span className="text-[11px] text-slate-400 px-2 whitespace-nowrap shrink-0">
            Salto:
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

        {/* Click, Voice Cues, Split-Mono */}
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
        </div>
      </div>
    </section>
  );
};
