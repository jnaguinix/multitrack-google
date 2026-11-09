import React, { useEffect, useRef, useState } from 'react';
import {
  Repeat,
  Trash2,
  Plus,
  Volume2,
  Sliders,
  Flag,
} from 'lucide-react';
import {
  MetersSnapshot,
  OutputBus,
  SongProject,
  SongSection,
  TrackChannel,
  TransportState,
} from '../types/project';
import { audioEngine } from '../audio/audioEngine';
import { formatMmSs } from './TransportDeck';

interface TimelineArrangerProps {
  project: SongProject;
  transport: TransportState;
  metersRef: React.MutableRefObject<MetersSnapshot>;
  isDarkMode: boolean;
  isDockedMixerOpen?: boolean;
  onToggleDockedMixer?: () => void;
  onJumpSection: (sectionId: string) => void;
  onSeekSeconds: (seconds: number) => void;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onChangeTrackGain: (trackId: string, gain: number) => void;
  onChangeTrackPan: (trackId: string, pan: number) => void;
  onChangeTrackBus: (trackId: string, bus: OutputBus) => void;
  onDeleteTrack: (trackId: string) => void;
  onAddStemsToCurrentSong: (files: FileList | File[]) => void;
  onAddMarkerAtPlayhead: () => void;
  onOpenImportModal: () => void;
  onOpenSectionEditor: () => void;
}

function gainToDbText(gain: number): string {
  if (gain <= 0.001) return '-∞';
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
}

interface WaveformCanvasProps {
  peaks: number[];
  color: string;
  muted: boolean;
  sections: SongSection[];
  totalDurationSec: number;
  activeSectionId: string | null;
  queuedSectionId: string | null;
  isVamping: boolean;
  progressRatio: number; // 0..1 playhead position
  onSeekRatio: (ratio: number) => void;
}

const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
  peaks,
  color,
  muted,
  sections,
  totalDurationSec,
  activeSectionId,
  queuedSectionId,
  isVamping,
  progressRatio,
  onSeekRatio,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const safeTotalSec = Math.max(1, totalDurationSec);

    // 1. Draw time-based section region backgrounds & divider lines
    for (const sec of sections) {
      const startX = (sec.startTimeSec / safeTotalSec) * width;
      const endX = (sec.endTimeSec / safeTotalSec) * width;
      const secW = Math.max(2, endX - startX);
      const isActive = sec.id === activeSectionId;
      const isQueued = sec.id === queuedSectionId;

      if (isActive && isVamping) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
        ctx.fillRect(startX, 0, secW, height);
      } else if (isActive) {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.07)';
        ctx.fillRect(startX, 0, secW, height);
      } else if (isQueued) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';
        ctx.fillRect(startX, 0, secW, height);
      }

      // Section boundary vertical line
      ctx.strokeStyle = `${sec.color}66`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(startX, height);
      ctx.stroke();
    }

    // Time grid vertical ticks every 5 or 15 seconds
    const tickStepSec = safeTotalSec > 180 ? 15 : safeTotalSec > 60 ? 10 : 5;
    for (let t = tickStepSec; t < safeTotalSec; t += tickStepSec) {
      const x = (t / safeTotalSec) * width;
      ctx.strokeStyle =
        t % 30 === 0 ? 'rgba(148, 163, 184, 0.14)' : 'rgba(148, 163, 184, 0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Center zero-crossing hairline
    const midY = height / 2;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // 2. Draw waveform bars
    const numPeaks = peaks.length || 1;
    const barStep = width / numPeaks;
    const barWidth = Math.max(1.2, barStep * 0.68);
    const playheadX = progressRatio * width;

    for (let i = 0; i < numPeaks; i++) {
      const amp = Math.max(0.04, peaks[i] || 0.05);
      const x = i * barStep;
      const halfH = amp * (height * 0.42);

      if (muted) {
        ctx.fillStyle = 'rgba(100, 116, 139, 0.30)';
      } else if (x <= playheadX) {
        ctx.fillStyle = color;
      } else {
        ctx.fillStyle = `${color}88`;
      }

      ctx.fillRect(x, midY - halfH, barWidth, halfH * 2);
    }

    // 3. Draw Playhead Cursor
    ctx.strokeStyle = '#22D3EE';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    ctx.restore();
  }, [
    peaks,
    color,
    muted,
    sections,
    totalDurationSec,
    activeSectionId,
    queuedSectionId,
    isVamping,
    progressRatio,
  ]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeekRatio(ratio);
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      className="w-full h-full block cursor-pointer"
    />
  );
};

export const TimelineArranger: React.FC<TimelineArrangerProps> = ({
  project,
  transport,
  metersRef,
  isDockedMixerOpen = false,
  onToggleDockedMixer,
  onJumpSection,
  onSeekSeconds,
  onToggleTrackMute,
  onToggleTrackSolo,
  onChangeTrackGain,
  onChangeTrackBus,
  onDeleteTrack,
  onAddStemsToCurrentSong,
  onAddMarkerAtPlayhead,
  onOpenImportModal,
  onOpenSectionEditor,
}) => {
  const addStemInputRef = useRef<HTMLInputElement | null>(null);
  const [, setMeterTick] = useState(0);

  useEffect(() => {
    if (!transport.isPlaying) {
      setMeterTick((t) => t + 1);
      return;
    }
    const intervalId = window.setInterval(() => {
      metersRef.current = audioEngine.getTrackMeters();
      setMeterTick((t) => (t + 1) % 1000000);
    }, 50);
    return () => window.clearInterval(intervalId);
  }, [transport.isPlaying, metersRef]);

  const meters = metersRef.current.tracks;

  const secPerBar = (60 / (project.bpm || 120)) * (project.beatsPerBar || 4);
  const totalDurationSec = Math.max(
    1,
    transport.totalDurationSec || project.durationSec || project.totalBars * secPerBar
  );
  const progressRatio = Math.max(
    0,
    Math.min(1, transport.currentTimeSec / totalDurationSec)
  );

  const anySolo = project.tracks.some((t) => t.soloed);

  const handleSeekByRatio = (ratio: number) => {
    onSeekSeconds(ratio * totalDurationSec);
  };

  // Generate time ruler marks in seconds (mm:ss)
  const timeRulerStepSec =
    totalDurationSec > 240
      ? 30
      : totalDurationSec > 120
      ? 15
      : totalDurationSec > 45
      ? 10
      : 5;

  const timeMarks: number[] = [];
  for (let t = 0; t <= totalDurationSec; t += timeRulerStepSec) {
    timeMarks.push(t);
  }

  return (
    <div className="flex-1 flex flex-col bg-[#0B0F17] overflow-hidden select-none">
      {/* Main Multitrack Timeline Viewport */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Sticky Timeline Header Row (Track Column Header + Section Time Blocks + MM:SS Time Ruler) */}
        <div className="sticky top-0 z-20 flex bg-[#111827] border-b border-slate-800 shrink-0">
          {/* Left Header matching Track Controls width (224px / w-56) */}
          <div className="w-56 shrink-0 px-2.5 py-1 border-r border-slate-800 flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-300">
              Pistas ({project.tracks.length})
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => addStemInputRef.current?.click()}
                className="text-[11px] font-semibold text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5 cursor-pointer whitespace-nowrap shrink-0"
                title="Añadir archivo de audio a esta canción actual"
              >
                <Plus className="w-3 h-3" />
                <span>Añadir Stem</span>
              </button>
              <input
                ref={addStemInputRef}
                type="file"
                multiple
                accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.webm,.opus,.aif,.aiff,.caf"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    const files = Array.from(e.target.files);
                    e.target.value = '';
                    onAddStemsToCurrentSong(files);
                  }
                }}
              />
            </div>
          </div>

          {/* Right Timeline Time Ruler & Section Markers Lane */}
          <div className="flex-1 flex flex-col min-w-[500px]">
            {/* Section Regions Lane (Positioned by startTimeSec and endTimeSec) */}
            <div className="relative h-5.5 border-b border-slate-800/80 bg-[#0B0F17]">
              {project.sections.length === 0 ? (
                <div className="h-full px-2.5 flex items-center justify-between text-[10px] text-slate-500">
                  <span className="truncate">
                    Haz clic en la regla de tiempo para mover el cabezal y pulsa «+Marca» para dividir por secciones.
                  </span>
                </div>
              ) : (
                project.sections.map((sec) => {
                  const leftPct = Math.max(
                    0,
                    Math.min(100, (sec.startTimeSec / totalDurationSec) * 100)
                  );
                  const widthPct = Math.max(
                    1,
                    Math.min(
                      100 - leftPct,
                      ((sec.endTimeSec - sec.startTimeSec) / totalDurationSec) * 100
                    )
                  );
                  const isActive = sec.id === transport.activeSectionId;
                  const isQueued = sec.id === transport.queuedSectionId;
                  const isVampHere = isActive && transport.isVamping;

                  return (
                    <button
                      key={sec.id}
                      type="button"
                      onClick={() => onJumpSection(sec.id)}
                      title={`Saltar a ${sec.name} (${formatMmSs(sec.startTimeSec)} – ${formatMmSs(sec.endTimeSec)})`}
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                      }}
                      className={`absolute top-0 bottom-0 px-1.5 border-r border-slate-800 flex items-center justify-between text-[10px] font-medium transition-colors overflow-hidden cursor-pointer ${
                        isQueued
                          ? 'bg-amber-500/25 text-amber-200 font-semibold'
                          : isActive
                          ? 'bg-emerald-500/20 text-emerald-200 font-semibold'
                          : 'bg-slate-900/80 text-slate-300 hover:bg-slate-800/90'
                      }`}
                    >
                      <span className="flex items-center gap-1 truncate">
                        <span
                          style={{ backgroundColor: sec.color }}
                          className="w-1.5 h-1.5 rounded-xs shrink-0"
                        />
                        <span className="truncate font-semibold">{sec.name}</span>
                        {isVampHere && <Repeat className="w-2.5 h-2.5 text-amber-400 shrink-0" />}
                      </span>
                      <span className="font-mono tabular-nums text-[9px] opacity-75 shrink-0 ml-1">
                        {formatMmSs(sec.startTimeSec)}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            {/* Time Ruler (MM:SS) */}
            <div
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.max(
                  0,
                  Math.min(1, (e.clientX - rect.left) / rect.width)
                );
                handleSeekByRatio(ratio);
              }}
              title="Haz clic en cualquier punto para mover el cabezal de reproducción"
              className="relative h-5 bg-[#111827] cursor-pointer overflow-hidden"
            >
              {timeMarks.map((secMark) => {
                const leftPct = (secMark / totalDurationSec) * 100;
                return (
                  <div
                    key={secMark}
                    style={{ left: `${leftPct}%` }}
                    className="absolute top-0 bottom-0 border-l border-slate-700/80 pl-1 flex items-center text-[9px] font-mono tabular-nums text-slate-400"
                  >
                    {formatMmSs(secMark)}
                  </div>
                );
              })}

              {/* Playhead Line on Time Ruler */}
              <div
                style={{ left: `${progressRatio * 100}%` }}
                className="absolute top-0 bottom-0 w-0.5 bg-cyan-400 pointer-events-none"
              />
            </div>
          </div>
        </div>

        {/* Compact Track Rows (42px height so 10-12 stems fit on a laptop screen simultaneously) */}
        {project.tracks.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <Volume2 className="w-8 h-8 text-slate-400 mb-2" />
            <h3 className="font-display text-sm font-semibold text-slate-200 mb-1">
              No hay pistas en este proyecto
            </h3>
            <p className="text-xs text-slate-400 max-w-md mb-3">
              Arrastra una canción desde el Repertorio izquierdo o suelta tus archivos de audio (.wav, .mp3, .m4a).
            </p>
            <button
              type="button"
              onClick={onOpenImportModal}
              className="px-3 py-1.5 bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-semibold text-xs rounded cursor-pointer"
            >
              Importar Archivos de Audio
            </button>
          </div>
        ) : (
          <div className="divide-y divide-slate-800/90">
            {project.tracks.map((track: TrackChannel) => {
              const isAudible = anySolo ? track.soloed && !track.muted : !track.muted;
              const meter = meters[track.id] || { rms: 0, peak: 0, clipping: false };

              return (
                <div
                  key={track.id}
                  className="flex h-10.5 bg-[#0B0F17] hover:bg-[#0E1420] transition-colors"
                >
                  {/* Left Compact Track Control Strip (224px / w-56) */}
                  <div className="w-56 shrink-0 px-2 py-1 border-r border-slate-800 bg-[#111827]/95 flex flex-col justify-between">
                    <div className="flex items-center justify-between gap-1 h-full">
                      {/* Color dot + Track Name */}
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <span
                          style={{ backgroundColor: track.color }}
                          className="w-2 h-2 rounded-xs shrink-0"
                        />
                        <span
                          className={`text-[11px] font-semibold truncate ${
                            isAudible
                              ? 'text-slate-100'
                              : 'text-slate-500 line-through'
                          }`}
                          title={`${track.name} (${gainToDbText(track.gain)} dB)`}
                        >
                          {track.name}
                        </span>
                      </div>

                      {/* Inline Gain Slider + Mute + Solo + Bus + Delete */}
                      <div className="flex items-center gap-1 shrink-0">
                        <input
                          type="range"
                          aria-label={`Volumen ${track.name}`}
                          min={0}
                          max={1.25}
                          step={0.01}
                          value={track.gain}
                          onChange={(e) =>
                            onChangeTrackGain(track.id, Number(e.target.value))
                          }
                          title={`Nivel: ${gainToDbText(track.gain)} dB (Doble clic = 0 dB)`}
                          onDoubleClick={() => onChangeTrackGain(track.id, 1.0)}
                          className="w-12 accent-cyan-400 h-1 bg-slate-800 rounded cursor-pointer"
                        />

                        <button
                          type="button"
                          onClick={() => onToggleTrackMute(track.id)}
                          title="Silenciar Pista (Mute)"
                          className={`w-5 h-5 rounded text-[9px] font-mono font-bold transition-colors cursor-pointer ${
                            track.muted
                              ? 'bg-red-600 text-white'
                              : 'bg-slate-800 text-slate-400 hover:text-slate-100'
                          }`}
                        >
                          M
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleTrackSolo(track.id)}
                          title="Aislar Pista (Solo)"
                          className={`w-5 h-5 rounded text-[9px] font-mono font-bold transition-colors cursor-pointer ${
                            track.soloed
                              ? 'bg-amber-400 text-slate-950'
                              : 'bg-slate-800 text-slate-400 hover:text-slate-100'
                          }`}
                        >
                          S
                        </button>

                        <select
                          aria-label={`Bus de salida para ${track.name}`}
                          value={track.bus}
                          onChange={(e) =>
                            onChangeTrackBus(track.id, e.target.value as OutputBus)
                          }
                          className="bg-slate-900 border border-slate-800 rounded px-1 py-0.2 text-[9px] font-medium text-slate-300 focus:outline-none focus:border-cyan-500 cursor-pointer"
                        >
                          <option value="main">Main</option>
                          <option value="cue-click">Cue</option>
                          <option value="both">Both</option>
                        </select>

                        <button
                          type="button"
                          onClick={() => onDeleteTrack(track.id)}
                          title="Quitar pista de esta canción"
                          className="w-5 h-5 rounded bg-slate-900 hover:bg-red-500/20 text-slate-500 hover:text-red-400 flex items-center justify-center transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    </div>

                    {/* Slim Horizontal Mini VU Meter */}
                    <div className="w-full h-0.5 bg-slate-900 rounded-full overflow-hidden">
                      <div
                        style={{
                          width: `${Math.min(100, meter.rms * 100)}%`,
                        }}
                        className={`h-full transition-all duration-75 ${
                          meter.clipping
                            ? 'bg-red-500'
                            : meter.rms > 0.75
                            ? 'bg-amber-500'
                            : 'bg-emerald-500'
                        }`}
                      />
                    </div>
                  </div>

                  {/* Right Waveform Canvas Area */}
                  <div className="flex-1 min-w-[500px] relative">
                    <WaveformCanvas
                      peaks={track.peaks}
                      color={track.color}
                      muted={!isAudible}
                      sections={project.sections}
                      totalDurationSec={totalDurationSec}
                      activeSectionId={transport.activeSectionId}
                      queuedSectionId={transport.queuedSectionId}
                      isVamping={transport.isVamping}
                      progressRatio={progressRatio}
                      onSeekRatio={handleSeekByRatio}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Slim Bottom Arranger Toolbar */}
      <div className="h-7 bg-[#111827] border-t border-slate-800 px-3 flex items-center justify-between gap-3 text-[11px] text-slate-400 shrink-0">
        <div className="flex items-center gap-2">
          {onToggleDockedMixer && (
            <button
              type="button"
              onClick={onToggleDockedMixer}
              className={`h-5.5 px-2 rounded text-[10px] font-semibold flex items-center gap-1 border transition-colors cursor-pointer ${
                isDockedMixerOpen
                  ? 'bg-cyan-500/20 border-cyan-500/60 text-cyan-300'
                  : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Sliders className="w-3 h-3 text-cyan-400" />
              <span>
                {isDockedMixerOpen ? 'Ocultar Mixer' : 'Acoplar Mixer'}
              </span>
            </button>
          )}
          {transport.lastCueMessage && (
            <span className="text-[10px] font-mono tabular-nums text-cyan-300 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded font-semibold">
              {transport.lastCueMessage}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onAddMarkerAtPlayhead}
            className="text-cyan-400 hover:underline font-medium flex items-center gap-1 cursor-pointer"
          >
            <Flag className="w-3 h-3" />
            <span>+ Marcar Sección ({formatMmSs(transport.currentTimeSec)})</span>
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onOpenSectionEditor}
            className="text-slate-300 hover:underline font-medium cursor-pointer"
          >
            Editar Secciones ({project.sections.length})
          </button>
        </div>
      </div>
    </div>
  );
};
