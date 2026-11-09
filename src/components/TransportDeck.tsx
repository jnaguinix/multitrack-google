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
  X,
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
  onCancelQueuedJump?: () => void;
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
  onCancelQueuedJump,
}) => {
  const activeSection = project.sections.find((s) => s.id === transport.activeSectionId);
  const queuedSection = project.sections.find((s) => s.id === transport.queuedSectionId);

  const currentSetlistIdx = setlistQueue.findIndex((s) => s.id === project.id);

  const quantizeOptions: { value: QuantizeMode; label: string }[] = [
    { value: 'immediate', label: 'Inmed.' },
    { value: '1-bar', label: '1 Comp.' },
    { value: 'section-end', label: 'Fin Sec.' },
  ];

  return (
    <section
      aria-label="Controles de Transporte y Setlist"
      className="h-10 bg-[#111827] border-b border-slate-800 px-3 py-1 flex items-center justify-between gap-2 overflow-x-auto whitespace-nowrap select-none shrink-0"
    >
      {/* Left: Project identity + Setlist Prev/Next + Transport */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="max-w-[165px] leading-tight">
          <div
            className="font-display text-xs font-bold text-slate-100 truncate"
            title={`${project.title} (${project.keySignature} · ${project.bpm} BPM)`}
          >
            {project.title}
          </div>
          <div className="flex items-center gap-1 text-[10px] text-slate-400 truncate">
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
          <div className="flex items-center gap-0.5 bg-[#0B0F17] border border-slate-800 rounded px-1.5 py-0.5">
            <button
              type="button"
              onClick={onPrevSetlistSong}
              disabled={currentSetlistIdx <= 0}
              title="Canción anterior en el Setlist"
              className="p-0.5 rounded hover:bg-slate-800 text-slate-300 disabled:opacity-30 cursor-pointer"
            >
              <SkipBack className="w-3 h-3" />
            </button>

            <div className="px-1 text-[10px] font-mono font-bold text-amber-400 flex items-center gap-0.5">
              <ListMusic className="w-2.5 h-2.5" />
              <span>
                {currentSetlistIdx >= 0
                  ? `${currentSetlistIdx + 1}/${setlistQueue.length}`
                  : `${setlistQueue.length}`}
              </span>
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
              className="p-0.5 rounded hover:bg-amber-500/20 text-amber-300 disabled:opacity-30 cursor-pointer"
            >
              <SkipForward className="w-3 h-3" />
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
              className="bg-slate-900 border border-slate-800 rounded px-1 py-0.5 text-[10px] text-slate-300 focus:outline-none focus:border-amber-400 cursor-pointer"
            >
              <option value="stop">Fin: Parar</option>
              <option value="cue-next">Fin: Prep. Sig.</option>
              <option value="auto-play">Fin: Auto-Play</option>
            </select>
          </div>
        )}

        {/* Play/Pause, Stop, Vamp */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={Boolean(transport.isMountingSong)}
            onClick={onPlayPause}
            title={
              transport.isMountingSong
                ? transport.mountingProgressText || 'Cargando pistas en RAM...'
                : 'Reproducir / Pausar (Barra Espaciadora)'
            }
            className={`h-7 px-2.5 rounded font-semibold text-[11px] flex items-center gap-1 transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
              transport.isMountingSong
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : transport.isPlaying
                ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                : 'bg-slate-800 text-slate-100 hover:bg-slate-700 border border-slate-700'
            }`}
          >
            {transport.isPlaying ? (
              <Pause className="w-3 h-3 fill-current" />
            ) : (
              <Play className="w-3 h-3 fill-current" />
            )}
            <span>
              {transport.isMountingSong
                ? 'RAM...'
                : transport.isPlaying
                ? 'Pause'
                : 'Play'}
            </span>
          </button>

          <button
            type="button"
            onClick={onStop}
            title="Detener y volver a 00:00"
            className="h-7 px-2 rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-[11px] font-medium flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Square className="w-2.5 h-2.5 fill-current" />
            <span>Stop</span>
          </button>

          <button
            type="button"
            onClick={onToggleVamp}
            title="Activar/Liberar Bucle en la Sección Actual (Tecla V)"
            className={`h-7 px-2 rounded text-[11px] font-semibold flex items-center gap-1 transition-all whitespace-nowrap shrink-0 cursor-pointer border ${
              transport.isVamping
                ? 'bg-amber-500 text-slate-950 border-amber-400'
                : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
            }`}
          >
            <Repeat className="w-3 h-3" />
            <span>{transport.isVamping ? 'Vamp ON' : 'Vamp'}</span>
          </button>
        </div>
      </div>

      {/* Center: Studio Digital Clock (MM:SS.d / Duration | Beat Pulse | Active Section) */}
      <div className="flex items-center gap-2 bg-[#0B0F17] border border-slate-800 rounded px-2.5 py-0.5 h-7 shrink-0">
        {/* Primary Timecode MM:SS.d */}
        <div className="flex items-baseline gap-1">
          <span className="font-mono tabular-nums text-sm font-bold text-cyan-400 tracking-tight">
            {formatTimecode(transport.currentTimeSec)}
          </span>
          <span className="font-mono text-[10px] text-slate-600">/</span>
          <span className="font-mono tabular-nums text-[10px] font-semibold text-slate-400">
            {formatMmSs(transport.totalDurationSec)}
          </span>
        </div>

        <div className="h-3.5 w-px bg-slate-800" />

        {/* Visual Beat Pulse Bars */}
        <div
          className="flex items-center gap-0.5"
          aria-label={`Pulso ${transport.currentBeat} de ${project.beatsPerBar}`}
        >
          {Array.from({ length: project.beatsPerBar }).map((_, idx) => {
            const beatNum = idx + 1;
            const isCurrent = transport.isPlaying && transport.currentBeat === beatNum;
            const isDownbeat = beatNum === 1;
            return (
              <div
                key={beatNum}
                className={`w-1.5 h-3 rounded-xs transition-opacity ${
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

        <div className="h-3.5 w-px bg-slate-800" />

        {/* Active & Queued Section Readout or Live Import / RAM Mounting Progress */}
        <div className="flex items-center gap-1.5 max-w-[160px]">
          {transport.mountingProgressText || importStatusText ? (
            <span className="text-[10px] font-semibold text-amber-400 truncate">
              {transport.mountingProgressText || importStatusText}
            </span>
          ) : (
            <>
              <div className="text-[11px] truncate">
                <span className="font-semibold text-emerald-400">
                  {activeSection ? activeSection.name : 'Sin marca'}
                </span>
              </div>
              {queuedSection && (
                <div className="flex items-center gap-0.5 text-[10px] font-mono tabular-nums text-amber-400 font-bold">
                  <span>→{queuedSection.code}</span>
                  {onCancelQueuedJump && (
                    <button
                      type="button"
                      onClick={onCancelQueuedJump}
                      title="Cancelar salto en cola"
                      className="p-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white cursor-pointer"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right: Playhead Section Marker, Quantize, Tempo/Pitch, Click/Cues */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Playhead Marker Creation & Section Time Editor */}
        <button
          type="button"
          onClick={onAddMarkerAtPlayhead}
          title="Crear marcador de sección exactamente en el segundo actual del cabezal"
          className="h-7 px-2 rounded bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/40 text-[11px] font-semibold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Flag className="w-3 h-3 text-cyan-400" />
          <span>+Marca</span>
        </button>

        <button
          type="button"
          onClick={onOpenSectionEditor}
          title="Abrir editor de secciones por minutos y segundos (mm:ss)"
          className="h-7 px-2 rounded bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 text-[11px] font-medium flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <span>Sec ({project.sections.length})</span>
        </button>

        {/* Quantize Mode Selector */}
        <div className="flex items-center bg-[#0B0F17] p-0.5 rounded border border-slate-800 h-7">
          <span className="text-[10px] text-slate-400 px-1.5 whitespace-nowrap shrink-0">
            Salto:
          </span>
          {quantizeOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChangeQuantize(opt.value)}
              className={`px-1.5 py-0.5 text-[10px] font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                project.quantizeMode === opt.value
                  ? 'bg-slate-800 text-cyan-300 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* BPM & Pitch controls */}
        <div className="flex items-center gap-1 bg-[#0B0F17] px-1.5 py-0.5 rounded border border-slate-800 h-7">
          <label htmlFor="bpm-input" className="text-[10px] text-slate-400">
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
            className="w-10 bg-slate-900 border border-slate-800 rounded px-1 py-0.2 text-[11px] font-mono tabular-nums text-slate-100 text-right focus:outline-none focus:border-cyan-500"
          />

          <select
            id="pitch-select"
            aria-label="Transposición de tono"
            value={project.pitchSemitones}
            onChange={(e) => onChangePitch(Number(e.target.value))}
            className="bg-slate-900 border border-slate-800 rounded px-1 py-0.2 text-[11px] font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-500 cursor-pointer"
          >
            {[-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].map((st) => (
              <option key={st} value={st}>
                {st > 0 ? `+${st}st` : `${st}st`}
              </option>
            ))}
          </select>
        </div>

        {/* Click, Voice Cues, Split-Mono */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleClick}
            title="Activar/Desactivar Metrónomo (Click Bus)"
            className={`h-7 px-2 rounded text-[11px] font-medium flex items-center gap-1 border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              project.clickEnabled
                ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            <Volume2 className="w-3 h-3" />
            <span>Click</span>
          </button>

          <button
            type="button"
            onClick={onToggleGuide}
            title="Activar/Desactivar Cues de Guía Vocal"
            className={`h-7 px-2 rounded text-[11px] font-medium flex items-center gap-1 border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              project.guideCuesEnabled
                ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            <Mic className="w-3 h-3" />
            <span>Cues</span>
          </button>

          <button
            type="button"
            onClick={onToggleSplitRouting}
            title="Alternar salida Estéreo vs Split-Mono (L: Click/Guía · R: Pistas)"
            className={`h-7 px-2 rounded text-[11px] font-medium flex items-center gap-1 border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              project.splitRoutingMode === 'split-mono'
                ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            <Sliders className="w-3 h-3" />
            <span>{project.splitRoutingMode === 'split-mono' ? 'Split' : 'Stereo'}</span>
          </button>
        </div>
      </div>
    </section>
  );
};
