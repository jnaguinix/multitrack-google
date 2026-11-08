import React, { useEffect, useRef } from 'react';
import {
  Repeat,
  Trash2,
  Plus,
  Volume2,
  CornerDownRight,
} from 'lucide-react';
import {
  OutputBus,
  SongProject,
  SongSection,
  TrackChannel,
  TrackMeterReading,
  TransportState,
} from '../types/project';

interface TimelineArrangerProps {
  project: SongProject;
  transport: TransportState;
  meters: Record<string, TrackMeterReading>;
  onJumpSection: (sectionId: string) => void;
  onSeekSeconds: (seconds: number) => void;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onChangeTrackGain: (trackId: string, gain: number) => void;
  onChangeTrackPan: (trackId: string, pan: number) => void;
  onChangeTrackBus: (trackId: string, bus: OutputBus) => void;
  onDeleteTrack: (trackId: string) => void;
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
  totalBars: number;
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
  totalBars,
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

    // 1. Draw subtle section region backgrounds & bar grid lines
    for (const sec of sections) {
      const startX = ((sec.startBar - 1) / totalBars) * width;
      const secW = (sec.lengthBars / totalBars) * width;
      const isActive = sec.id === activeSectionId;
      const isQueued = sec.id === queuedSectionId;

      if (isActive && isVamping) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.09)';
        ctx.fillRect(startX, 0, secW, height);
      } else if (isActive) {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.05)';
        ctx.fillRect(startX, 0, secW, height);
      } else if (isQueued) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.07)';
        ctx.fillRect(startX, 0, secW, height);
      }
    }

    // Bar vertical grid lines
    for (let b = 1; b <= totalBars; b++) {
      const x = ((b - 1) / totalBars) * width;
      ctx.strokeStyle = b % 4 === 1 ? 'rgba(148, 163, 184, 0.16)' : 'rgba(148, 163, 184, 0.06)';
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
        ctx.fillStyle = 'rgba(100, 116, 139, 0.32)';
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
    totalBars,
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
  meters,
  onJumpSection,
  onSeekSeconds,
  onToggleTrackMute,
  onToggleTrackSolo,
  onChangeTrackGain,
  onChangeTrackPan,
  onChangeTrackBus,
  onDeleteTrack,
  onOpenImportModal,
  onOpenSectionEditor,
}) => {
  const secPerBar = (60 / project.bpm) * project.beatsPerBar;
  const totalDurationSec = Math.max(1, project.totalBars * secPerBar);
  const progressRatio = Math.max(0, Math.min(1, transport.currentTimeSec / totalDurationSec));

  const anySolo = project.tracks.some((t) => t.soloed);

  const handleSeekByRatio = (ratio: number) => {
    onSeekSeconds(ratio * totalDurationSec);
  };

  return (
    <div className="flex-1 flex flex-col bg-[#0B0F17] overflow-hidden select-none">
      {/* Section Jump Matrix Strip (Quick Stage Bar with Keyboard Numbers 1..9) */}
      <div className="bg-[#0F1623] border-b border-slate-800 px-6 py-2.5 flex items-center justify-between gap-4 overflow-x-auto">
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-medium text-slate-400">
            Saltos de Sección (Teclas 1–{Math.min(9, project.sections.length)}):
          </span>
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
                  className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-2 border transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                    isQueued
                      ? 'bg-amber-500/20 border-amber-400 text-amber-200'
                      : isVampHere
                      ? 'bg-amber-500/15 border-amber-500/70 text-amber-300'
                      : isActive
                      ? 'bg-emerald-500/15 border-emerald-500/70 text-emerald-300'
                      : 'bg-slate-900/90 border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <span className="font-mono tabular-nums text-[11px] text-slate-400">
                    {idx + 1}.
                  </span>
                  <span className="font-semibold">{sec.name}</span>
                  <span className="font-mono tabular-nums text-[11px] text-slate-400">
                    c.{sec.startBar}
                  </span>
                  {isVampHere && <Repeat className="w-3.5 h-3.5 text-amber-400" />}
                  {isQueued && (
                    <span className="font-mono tabular-nums text-[11px] text-amber-300 font-bold">
                      ({transport.countdownBeats}p)
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Live Guide Cue Readout Banner */}
        <div className="flex items-center gap-3 shrink-0">
          {transport.lastCueMessage && (
            <div className="text-xs font-mono tabular-nums text-cyan-300 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-md">
              {transport.lastCueMessage}
            </div>
          )}
        </div>
      </div>

      {/* Main Multitrack Timeline Viewport */}
      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Sticky Timeline Header Row (Track Column Header + Section Blocks + Bar Ruler) */}
        <div className="sticky top-0 z-20 flex bg-[#111827] border-b border-slate-800">
          {/* Left Header matching Track Controls width */}
          <div className="w-72 shrink-0 px-4 py-2.5 border-r border-slate-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">
              Pistas ({project.tracks.length})
            </span>
            <button
              type="button"
              onClick={onOpenImportModal}
              className="text-xs font-medium text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Añadir Stem</span>
            </button>
          </div>

          {/* Right Timeline Ruler & Section Arrangement Blocks */}
          <div className="flex-1 flex flex-col min-w-[640px]">
            {/* Section Regions Lane */}
            <div className="relative h-8 border-b border-slate-800/80 bg-[#0B0F17]">
              {project.sections.map((sec) => {
                const leftPct = ((sec.startBar - 1) / project.totalBars) * 100;
                const widthPct = (sec.lengthBars / project.totalBars) * 100;
                const isActive = sec.id === transport.activeSectionId;
                const isQueued = sec.id === transport.queuedSectionId;

                return (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => onJumpSection(sec.id)}
                    title={`Saltar a ${sec.name} (Compás ${sec.startBar}–${sec.startBar + sec.lengthBars - 1})`}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                    }}
                    className={`absolute top-0 bottom-0 px-2 border-r border-slate-800 flex items-center justify-between text-xs font-medium transition-colors overflow-hidden cursor-pointer ${
                      isQueued
                        ? 'bg-amber-500/25 text-amber-200'
                        : isActive
                        ? 'bg-emerald-500/20 text-emerald-200'
                        : 'bg-slate-900/80 text-slate-300 hover:bg-slate-800/90'
                    }`}
                  >
                    <span className="truncate font-semibold">{sec.name}</span>
                    <span className="font-mono tabular-nums text-[10px] opacity-75 shrink-0 ml-1">
                      {sec.lengthBars}c
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Bar Number Ruler */}
            <div
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                handleSeekByRatio(ratio);
              }}
              className="relative h-6 bg-[#111827] cursor-pointer"
            >
              {Array.from({ length: project.totalBars }).map((_, idx) => {
                const barNum = idx + 1;
                const leftPct = (idx / project.totalBars) * 100;
                const isCurrentBar = transport.currentBar === barNum;
                return (
                  <div
                    key={barNum}
                    style={{ left: `${leftPct}%` }}
                    className={`absolute top-0 bottom-0 border-l pl-1 flex items-center text-[10px] font-mono tabular-nums ${
                      isCurrentBar
                        ? 'border-cyan-400 text-cyan-300 font-bold'
                        : barNum % 4 === 1
                        ? 'border-slate-700 text-slate-300'
                        : 'border-slate-800/70 text-slate-500'
                    }`}
                  >
                    {barNum}
                  </div>
                );
              })}

              {/* Playhead Triangle Marker on Ruler */}
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
            <Volume2 className="w-10 h-10 text-slate-600 mb-3" />
            <h3 className="font-display text-base font-semibold text-slate-200 mb-1">
              No hay pistas en este proyecto
            </h3>
            <p className="text-sm text-slate-400 max-w-md mb-4">
              Importa tus archivos multipista (.wav, .mp3, .ogg) o carga uno de los proyectos de demostración.
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
                  className="flex h-20 bg-[#0B0F17] hover:bg-[#0E1420] transition-colors"
                >
                  {/* Left Track Control Strip (288px) */}
                  <div className="w-72 shrink-0 px-4 py-2.5 border-r border-slate-800 bg-[#111827]/90 flex flex-col justify-between">
                    {/* Top Row: Track Name, Mute, Solo, Delete */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          style={{ backgroundColor: track.color }}
                          className="w-2.5 h-2.5 rounded-xs shrink-0"
                        />
                        <span
                          className={`text-xs font-semibold truncate ${
                            isAudible ? 'text-slate-100' : 'text-slate-500 line-through'
                          }`}
                        >
                          {track.name}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => onToggleTrackMute(track.id)}
                          title="Silenciar Pista (Mute)"
                          className={`w-6 h-6 rounded text-[11px] font-mono font-bold transition-colors cursor-pointer ${
                            track.muted
                              ? 'bg-red-500 text-slate-950'
                              : 'bg-slate-800 text-slate-400 hover:text-slate-100'
                          }`}
                        >
                          M
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleTrackSolo(track.id)}
                          title="Aislar Pista (Solo)"
                          className={`w-6 h-6 rounded text-[11px] font-mono font-bold transition-colors cursor-pointer ${
                            track.soloed
                              ? 'bg-amber-400 text-slate-950'
                              : 'bg-slate-800 text-slate-400 hover:text-slate-100'
                          }`}
                        >
                          S
                        </button>
                        {track.isCustomAudio && (
                          <button
                            type="button"
                            onClick={() => onDeleteTrack(track.id)}
                            title="Eliminar pista"
                            className="w-6 h-6 rounded bg-slate-900 hover:bg-red-500/20 text-slate-500 hover:text-red-400 flex items-center justify-center transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Bottom Row: Gain Fader, dB Readout, Bus Selector & Live Meter Bar */}
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        aria-label={`Volumen ${track.name}`}
                        min={0}
                        max={1.25}
                        step={0.01}
                        value={track.gain}
                        onChange={(e) => onChangeTrackGain(track.id, Number(e.target.value))}
                        className="w-24 accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                      />
                      <span className="font-mono tabular-nums text-[11px] text-slate-400 w-14 text-right shrink-0">
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
                            ? 'bg-amber-400'
                            : 'bg-emerald-400'
                        }`}
                      />
                    </div>
                  </div>

                  {/* Right Waveform Canvas Area */}
                  <div className="flex-1 min-w-[640px] relative">
                    <WaveformCanvas
                      peaks={track.peaks}
                      color={track.color}
                      muted={!isAudible}
                      sections={project.sections}
                      totalBars={project.totalBars}
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
      <div className="bg-[#111827] border-t border-slate-800 px-6 py-2.5 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <CornerDownRight className="w-3.5 h-3.5 text-cyan-400" />
            <span>
              Haz clic en cualquier sección durante la reproducción para agendar un salto cuantizado al compás.
            </span>
          </span>
        </div>

        <div className="flex items-center gap-4">
          <span>
            Paneo y ruteo detallado disponible en la vista{' '}
            <strong className="text-slate-200 font-medium">Mixer</strong>
          </span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onOpenSectionEditor}
            className="text-cyan-400 hover:text-cyan-300 font-medium cursor-pointer"
          >
            Configurar Compases y Secciones ({project.sections.length})
          </button>
        </div>
      </div>
    </div>
  );
};
