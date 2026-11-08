import React, { useEffect, useRef, useState } from 'react';
import {
  Repeat,
  Trash2,
  Plus,
  Volume2,
  CornerDownRight,
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
  onAddStemsToCurrentSong: (files: FileList) => void;
  onAddMarkerAtPlayhead: () => void;
  onOpenImportModal: () => void;
  onOpenSectionEditor: () => void;
}

function gainToDbText(gain: number): string {
  if (gain <= 0.001) return '-∞ dB';
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
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
      {/* Top Section Markers Bar (Time-based mm:ss + Quick Marker Creation at Playhead) */}
      <div className="bg-[#0F1623] border-b border-slate-800 px-4 py-2 flex items-center justify-between gap-4 overflow-x-auto">
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-medium text-slate-400">
            Marcadores de Sección:
          </span>

          {project.sections.length === 0 ? (
            <span className="text-xs text-slate-500 italic">
              Sin secciones definidas — usa «+ Marcar aquí» mientras reproduces para dividir tu canción en minutos y segundos.
            </span>
          ) : (
            <div className="flex items-center gap-1.5">
              {project.sections.map((sec, idx) => {
                const isActive = sec.id === transport.activeSectionId;
                const isQueued = sec.id === transport.queuedSectionId;
                const isVampHere = isActive && transport.isVamping;

                return (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => onJumpSection(sec.id)}
                    className={`min-h-[32px] px-2.5 py-1 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                      isQueued
                        ? 'bg-amber-500/20 border-amber-500 text-amber-200 font-semibold'
                        : isVampHere
                        ? 'bg-amber-500/15 border-amber-500/70 text-amber-300 font-semibold'
                        : isActive
                        ? 'bg-emerald-500/15 border-emerald-500/70 text-emerald-300 font-semibold'
                        : 'bg-slate-900/90 border-slate-800 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <span className="font-mono tabular-nums text-[10px] text-slate-400">
                      {idx + 1}.
                    </span>
                    <span
                      style={{ backgroundColor: sec.color }}
                      className="w-2 h-2 rounded-xs shrink-0"
                    />
                    <span>{sec.name}</span>
                    <span className="font-mono tabular-nums text-[10px] text-slate-400">
                      {formatMmSs(sec.startTimeSec)}
                    </span>
                    {isVampHere && <Repeat className="w-3 h-3 text-amber-400" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Quick Playhead Marker Button + Live Guide Cue Readout */}
        <div className="flex items-center gap-2 shrink-0">
          {transport.lastCueMessage && (
            <div className="text-xs font-mono tabular-nums text-cyan-300 bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-md font-semibold">
              {transport.lastCueMessage}
            </div>
          )}

          <button
            type="button"
            onClick={onAddMarkerAtPlayhead}
            title="Añadir una sección en la posición actual del cabezal"
            className="px-2.5 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
          >
            <Flag className="w-3 h-3 text-cyan-400" />
            <span>+ Marcar en {formatMmSs(transport.currentTimeSec)}</span>
          </button>
        </div>
      </div>

      {/* Main Multitrack Timeline Viewport */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Sticky Timeline Header Row (Track Column Header + Section Time Blocks + MM:SS Time Ruler) */}
        <div className="sticky top-0 z-20 flex bg-[#111827] border-b border-slate-800">
          {/* Left Header matching Track Controls width */}
          <div className="w-68 shrink-0 px-3.5 py-2 border-r border-slate-800 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-300">
              Pistas ({project.tracks.length})
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => addStemInputRef.current?.click()}
                className="text-xs font-semibold text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                title="Añadir archivo de audio a esta canción actual"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Añadir Stem</span>
              </button>
              <input
                ref={addStemInputRef}
                type="file"
                multiple
                accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    onAddStemsToCurrentSong(e.target.files);
                    e.target.value = '';
                  }
                }}
              />
            </div>
          </div>

          {/* Right Timeline Time Ruler & Section Markers Lane */}
          <div className="flex-1 flex flex-col min-w-[600px]">
            {/* Section Regions Lane (Positioned by startTimeSec and endTimeSec) */}
            <div className="relative h-7 border-b border-slate-800/80 bg-[#0B0F17]">
              {project.sections.length === 0 ? (
                <div className="h-full px-3 flex items-center justify-between text-[11px] text-slate-500">
                  <span>
                    Haz clic en la regla de tiempo para mover el cabezal y pulsa «+ Marcar aquí» para crear secciones en minutos y segundos.
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
                      className={`absolute top-0 bottom-0 px-2 border-r border-slate-800 flex items-center justify-between text-xs font-medium transition-colors overflow-hidden cursor-pointer ${
                        isQueued
                          ? 'bg-amber-500/25 text-amber-200 font-semibold'
                          : isActive
                          ? 'bg-emerald-500/20 text-emerald-200 font-semibold'
                          : 'bg-slate-900/80 text-slate-300 hover:bg-slate-800/90'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        <span
                          style={{ backgroundColor: sec.color }}
                          className="w-2 h-2 rounded-xs shrink-0"
                        />
                        <span className="truncate font-semibold">{sec.name}</span>
                      </span>
                      <span className="font-mono tabular-nums text-[10px] opacity-75 shrink-0 ml-1">
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
              className="relative h-6 bg-[#111827] cursor-pointer overflow-hidden"
            >
              {timeMarks.map((secMark) => {
                const leftPct = (secMark / totalDurationSec) * 100;
                return (
                  <div
                    key={secMark}
                    style={{ left: `${leftPct}%` }}
                    className="absolute top-0 bottom-0 border-l border-slate-700/80 pl-1 flex items-center text-[10px] font-mono tabular-nums text-slate-400"
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

        {/* Track Rows */}
        {project.tracks.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
            <Volume2 className="w-10 h-10 text-slate-400 mb-3" />
            <h3 className="font-display text-base font-semibold text-slate-200 mb-1">
              No hay pistas en este proyecto
            </h3>
            <p className="text-sm text-slate-400 max-w-md mb-4">
              Arrastra una canción desde el Repertorio izquierdo hacia aquí, o suelta tus archivos de audio (.wav, .mp3, .ogg) desde tu carpeta.
            </p>
            <button
              type="button"
              onClick={onOpenImportModal}
              className="px-4 py-2 bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-semibold text-xs rounded-lg cursor-pointer"
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
                  className="flex h-19 bg-[#0B0F17] hover:bg-[#0E1420] transition-colors"
                >
                  {/* Left Track Control Strip (272px) */}
                  <div className="w-68 shrink-0 px-3.5 py-2 border-r border-slate-800 bg-[#111827]/95 flex flex-col justify-between">
                    {/* Top Row: Track Name, Mute, Solo, Delete */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          style={{ backgroundColor: track.color }}
                          className="w-2.5 h-2.5 rounded-xs shrink-0"
                        />
                        <span
                          className={`text-xs font-semibold truncate ${
                            isAudible
                              ? 'text-slate-100'
                              : 'text-slate-500 line-through'
                          }`}
                          title={track.name}
                        >
                          {track.name}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => onToggleTrackMute(track.id)}
                          title="Silenciar Pista (Mute)"
                          className={`w-6 h-5.5 rounded text-[10px] font-mono font-bold transition-colors cursor-pointer ${
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
                          className={`w-6 h-5.5 rounded text-[10px] font-mono font-bold transition-colors cursor-pointer ${
                            track.soloed
                              ? 'bg-amber-400 text-slate-950'
                              : 'bg-slate-800 text-slate-400 hover:text-slate-100'
                          }`}
                        >
                          S
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteTrack(track.id)}
                          title="Quitar pista de esta canción"
                          className="w-6 h-5.5 rounded bg-slate-900 hover:bg-red-500/20 text-slate-400 hover:text-red-400 flex items-center justify-center transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    {/* Bottom Row: Gain Fader, dB Readout, Bus Selector */}
                    <div className="flex items-center gap-2">
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
                        className="w-22 accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                      />
                      <span className="font-mono tabular-nums text-[10px] text-slate-400 w-13 text-right shrink-0">
                        {gainToDbText(track.gain)}
                      </span>

                      <select
                        aria-label={`Bus de salida para ${track.name}`}
                        value={track.bus}
                        onChange={(e) =>
                          onChangeTrackBus(track.id, e.target.value as OutputBus)
                        }
                        className="bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-300 focus:outline-none focus:border-cyan-500 cursor-pointer ml-auto"
                      >
                        <option value="main">Main</option>
                        <option value="cue-click">Cue</option>
                        <option value="both">Both</option>
                      </select>
                    </div>

                    {/* Horizontal Mini VU Meter */}
                    <div className="w-full h-1 bg-slate-900 rounded-full overflow-hidden">
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
                  <div className="flex-1 min-w-[600px] relative">
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

      {/* Bottom Compact Live Bus & Arrangement Summary Footer */}
      <div className="bg-[#111827] border-t border-slate-800 px-5 py-2 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <CornerDownRight className="w-3.5 h-3.5 text-cyan-400" />
            <span>
              Arrastra canciones desde el Repertorio hacia este DAW para cargarlas, o marca secciones en tiempo real (mm:ss).
            </span>
          </span>
        </div>

        <div className="flex items-center gap-3">
          {onToggleDockedMixer && (
            <>
              <button
                type="button"
                onClick={onToggleDockedMixer}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 border transition-colors cursor-pointer ${
                  isDockedMixerOpen
                    ? 'bg-cyan-500/20 border-cyan-500/60 text-cyan-300'
                    : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                <span>
                  {isDockedMixerOpen ? 'Ocultar Mixer Acoplado' : 'Acoplar Consola Mixer'}
                </span>
              </button>
              <span aria-hidden="true">·</span>
            </>
          )}
          <button
            type="button"
            onClick={onAddMarkerAtPlayhead}
            className="text-cyan-400 hover:underline font-medium flex items-center gap-1 cursor-pointer"
          >
            <Flag className="w-3.5 h-3.5" />
            <span>+ Marcar Sección ({formatMmSs(transport.currentTimeSec)})</span>
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onOpenSectionEditor}
            className="text-slate-300 hover:underline font-medium cursor-pointer"
          >
            Editar Secciones en mm:ss ({project.sections.length})
          </button>
        </div>
      </div>
    </div>
  );
};
