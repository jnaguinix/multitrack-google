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
  OutputBus,
  SongProject,
  SongSection,
  TrackChannel,
  TransportState,
} from '../types/project';
import { audioEngine } from '../audio/audioEngine';
import { orderTracksForDisplay } from '../utils/instrumentCatalog';
import { useLiveMeters } from '../audio/liveMeters';
import { formatMmSs } from './TransportDeck';
import { isDesktopApp, pickNativeFiles } from '../utils/nativeDialog';

interface TimelineArrangerProps {
  project: SongProject;
  transport: TransportState;
  isDarkMode: boolean;
  isDockedMixerOpen?: boolean;
  onToggleDockedMixer?: () => void;
  onJumpSection: (sectionId: string) => void;
  onSeekSeconds: (seconds: number) => void;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onChangeTrackGain: (trackId: string, gain: number) => void;
  onChangeTrackPan: (trackId: string, pan: number) => void;
  onDeleteTrack: (trackId: string) => void;
  onAddStemsToCurrentSong: (files: FileList | File[]) => void;
  onAddNativeStemsToCurrentSong?: (filePaths: string[]) => void;
  onAddMarkerAtPlayhead: () => void;
  onOpenImportModal: () => void;
  onOpenSectionEditor: () => void;
  onEditTracks?: () => void;
}

function gainToDbText(gain: number): string {
  if (gain <= 0.001) return '-∞ dB';
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

const ZERO_METER = { rms: 0, peak: 0, clipping: false };

const TrackMiniMeter: React.FC<{ live: boolean; trackId: string }> = ({ live, trackId }) => {
  const meter = useLiveMeters(live).tracks[trackId] || ZERO_METER;
  return (
    <div className="w-full h-1 bg-neutral-900 rounded-full overflow-hidden">
      <div
        style={{ width: `${Math.min(100, meter.rms * 100)}%` }}
        className={`h-full transition-[width] duration-75 ${
          meter.clipping ? 'bg-red-500' : meter.rms > 0.75 ? 'bg-amber-500' : 'bg-studio-accent'
        }`}
      />
    </div>
  );
};

interface WaveformCanvasProps {
  peaks: number[];
  color: string;
  muted: boolean;
  sections: SongSection[];
  totalDurationSec: number;
  activeSectionId: string | null;
  queuedSectionId: string | null;
  isVamping: boolean;
  progressRatio: number; // 0..1 posición del cursor
  onSeekRatio: (ratio: number) => void;
}

/**
 * Onda de una pista en tres capas (UI02):
 *  1. Base (canvas): secciones, cuadrícula y barras de la parte «no reproducida». Solo se redibuja si cambian los
 *     datos, el color, el silencio, las secciones o el tamaño.
 *  2. Reproducido (canvas): las mismas barras en color sólido, recortadas con `clip-path` hasta el cursor.
 *  3. Cursor: una línea que se mueve con `transform`.
 * Avanzar la posición solo cambia el estilo de las capas 2 y 3: no se redibuja ningún canvas.
 */
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const playedRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });

  // Tamaño y densidad de píxeles: se redibuja nítido al cambiar de tamaño o de monitor.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      setSize((prev) => (prev.w === w && prev.h === h && prev.dpr === dpr ? prev : { w, h, dpr }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    const base = baseRef.current;
    const played = playedRef.current;
    const { w: width, h: height, dpr } = size;
    if (!base || !played || width <= 0 || height <= 0) return;
    const baseCtx = base.getContext('2d');
    const playedCtx = played.getContext('2d');
    if (!baseCtx || !playedCtx) return;

    for (const c of [base, played]) {
      if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
        c.width = Math.round(width * dpr);
        c.height = Math.round(height * dpr);
      }
    }
    baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    playedCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    baseCtx.clearRect(0, 0, width, height);
    playedCtx.clearRect(0, 0, width, height);

    const safeTotalSec = Math.max(1, totalDurationSec);

    // 1. Fondos de sección y divisores
    for (const sec of sections) {
      const startX = (sec.startTimeSec / safeTotalSec) * width;
      const endX = (sec.endTimeSec / safeTotalSec) * width;
      const secW = Math.max(2, endX - startX);
      const isActive = sec.id === activeSectionId;
      const isQueued = sec.id === queuedSectionId;

      if (isActive && isVamping) {
        baseCtx.fillStyle = 'rgba(245, 158, 11, 0.12)';
        baseCtx.fillRect(startX, 0, secW, height);
      } else if (isActive) {
        baseCtx.fillStyle = 'rgba(16, 185, 129, 0.07)';
        baseCtx.fillRect(startX, 0, secW, height);
      } else if (isQueued) {
        baseCtx.fillStyle = 'rgba(245, 158, 11, 0.08)';
        baseCtx.fillRect(startX, 0, secW, height);
      }

      baseCtx.strokeStyle = `${sec.color}66`;
      baseCtx.lineWidth = 1;
      baseCtx.beginPath();
      baseCtx.moveTo(startX, 0);
      baseCtx.lineTo(startX, height);
      baseCtx.stroke();
    }

    // Cuadrícula de tiempo cada 5, 10 o 15 s
    const tickStepSec = safeTotalSec > 180 ? 15 : safeTotalSec > 60 ? 10 : 5;
    for (let tt = tickStepSec; tt < safeTotalSec; tt += tickStepSec) {
      const x = (tt / safeTotalSec) * width;
      baseCtx.strokeStyle = tt % 30 === 0 ? 'rgba(148, 163, 184, 0.14)' : 'rgba(148, 163, 184, 0.05)';
      baseCtx.lineWidth = 1;
      baseCtx.beginPath();
      baseCtx.moveTo(x, 0);
      baseCtx.lineTo(x, height);
      baseCtx.stroke();
    }

    // Línea central
    const midY = height / 2;
    baseCtx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    baseCtx.beginPath();
    baseCtx.moveTo(0, midY);
    baseCtx.lineTo(width, midY);
    baseCtx.stroke();

    // 2. Barras: la capa base lleva la parte «no reproducida»; la de reproducido, el color sólido
    const numPeaks = peaks.length || 1;
    const barStep = width / numPeaks;
    const barWidth = Math.max(1.2, barStep * 0.68);
    baseCtx.fillStyle = muted ? 'rgba(100, 116, 139, 0.30)' : `${color}88`;
    playedCtx.fillStyle = color;
    for (let i = 0; i < numPeaks; i++) {
      const amp = Math.max(0.04, peaks[i] || 0.05);
      const x = i * barStep;
      const halfH = amp * (height * 0.42);
      baseCtx.fillRect(x, midY - halfH, barWidth, halfH * 2);
      if (!muted) playedCtx.fillRect(x, midY - halfH, barWidth, halfH * 2);
    }
  }, [peaks, color, muted, sections, totalDurationSec, activeSectionId, queuedSectionId, isVamping, size]);

  const ratio = Math.max(0, Math.min(1, progressRatio));

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const r = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeekRatio(r);
  };

  return (
    <div ref={containerRef} onClick={handleClick} className="relative w-full h-full block cursor-pointer">
      <canvas ref={baseRef} className="absolute inset-0 w-full h-full" />
      <canvas
        ref={playedRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ clipPath: `inset(0 ${((1 - ratio) * 100).toFixed(3)}% 0 0)` }}
      />
      <div
        // Misma geometría que la línea de la regla de tiempo: 2 px de ancho con el borde izquierdo en la posición.
        className="absolute top-0 bottom-0 left-0 pointer-events-none"
        style={{
          width: 2,
          backgroundColor: '#8dd6cd',
          transform: `translateX(${(ratio * size.w).toFixed(2)}px)`,
          willChange: 'transform',
        }}
      />
    </div>
  );
};

export const TimelineArranger: React.FC<TimelineArrangerProps> = ({
  project,
  transport,
  isDockedMixerOpen = false,
  onToggleDockedMixer,
  onJumpSection,
  onSeekSeconds,
  onToggleTrackMute,
  onToggleTrackSolo,
  onChangeTrackGain,
  onDeleteTrack,
  onAddStemsToCurrentSong,
  onAddNativeStemsToCurrentSong,
  onAddMarkerAtPlayhead,
  onOpenImportModal,
  onOpenSectionEditor,
  onEditTracks,
}) => {
  const addStemInputRef = useRef<HTMLInputElement | null>(null);
  // Quitar una pista exige dos clics (el segundo en 3 s): un roce junto a M/S no debe borrar un stem.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingDeleteId) return;
    const timer = window.setTimeout(() => setPendingDeleteId(null), 3000);
    return () => window.clearTimeout(timer);
  }, [pendingDeleteId]);

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
    <div className="flex-1 flex flex-col bg-studio-ground overflow-hidden select-none">
      {/* Main Multitrack Timeline Viewport */}
      <div className="lt-arranger-scroll flex-1 min-h-0">
        {/* Sticky Timeline Header Row (Track Column Header + Section Time Blocks + MM:SS Time Ruler) */}
        <div className="lt-arranger-lane sticky top-0 z-20 flex bg-studio-panel border-b border-neutral-800 shrink-0">
          {/* Left Header matching Track Controls width (264px / w-66) */}
          <div className="lt-arranger-channel bg-studio-panel shrink-0 px-3.5 py-2 border-r border-neutral-800 flex items-center justify-between">
            <span className="text-xs font-bold text-neutral-200">
              Pistas ({project.tracks.length})
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (isDesktopApp()) {
                    pickNativeFiles().then((paths) => {
                      if (paths && paths.length > 0) onAddNativeStemsToCurrentSong?.(paths);
                    });
                    return;
                  }
                  addStemInputRef.current?.click();
                }}
                className="text-xs font-bold text-studio-ink hover:text-studio-ink flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                title="Añadir archivo de audio a esta canción actual"
              >
                <Plus className="w-3.5 h-3.5" />
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
          <div className="flex-1 flex flex-col min-w-[550px]">
            {/* Section Regions Lane (Positioned by startTimeSec and endTimeSec) */}
            <div className="relative h-7 border-b border-neutral-800/80 bg-studio-ground">
              {project.sections.length === 0 ? (
                <div className="h-full px-3 flex items-center justify-between text-xs text-neutral-400">
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
                      className={`absolute top-0 bottom-0 px-2 border-r border-neutral-800 flex items-center justify-between text-xs font-semibold transition-colors overflow-hidden cursor-pointer ${
                        isQueued
                          ? 'bg-amber-500/25 text-amber-200 font-bold'
                          : isActive
                          ? 'bg-studio-strip text-studio-ink font-bold'
                          : 'bg-neutral-900/80 text-neutral-200 hover:bg-neutral-800/90'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        <span
                          style={{ backgroundColor: sec.color }}
                          className="w-2 h-2 rounded-xs shrink-0"
                        />
                        <span className="truncate font-bold">{sec.name}</span>
                        {isVampHere && <Repeat className="w-3 h-3 text-amber-400 shrink-0" />}
                      </span>
                      <span className="tabular-nums text-xs opacity-80 shrink-0 ml-1">
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
              className="relative h-6 bg-studio-panel cursor-pointer overflow-hidden"
            >
              {timeMarks.map((secMark) => {
                const leftPct = (secMark / totalDurationSec) * 100;
                return (
                  <div
                    key={secMark}
                    style={{ left: `${leftPct}%` }}
                    className="absolute top-0 bottom-0 border-l border-neutral-700/80 pl-1.5 flex items-center text-xs tabular-nums text-neutral-300"
                  >
                    {formatMmSs(secMark)}
                  </div>
                );
              })}

              {/* Playhead Line on Time Ruler */}
              <div
                style={{ left: `${progressRatio * 100}%` }}
                className="absolute top-0 bottom-0 w-0.5 bg-studio-accent pointer-events-none"
              />
            </div>
          </div>
        </div>

        {/* 2-Line Track Rows (64px / h-16 height so instrument names are large and 100% readable) */}
        {project.tracks.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
            <Volume2 className="w-10 h-10 text-neutral-400 mb-2.5" />
            <h3 className="text-base font-bold text-neutral-100 mb-1">
              No hay pistas en este proyecto
            </h3>
            <p className="text-xs text-neutral-300 max-w-md mb-4">
              Arrastra una canción desde el Repertorio izquierdo o suelta tus archivos de audio (.wav, .mp3, .m4a).
            </p>
            <button
              type="button"
              onClick={onOpenImportModal}
              className="px-4 py-2 bg-studio-ink hover:bg-neutral-200 text-studio-ground font-bold text-xs rounded-lg cursor-pointer"
            >
              Importar Archivos de Audio
            </button>
          </div>
        ) : (
          <div className="divide-y divide-neutral-800/90">
            {orderTracksForDisplay(project.tracks).map((track: TrackChannel) => {
              const isAudible = anySolo ? track.soloed && !track.muted : !track.muted;

              return (
                <div
                  key={track.id}
                  className="lt-arranger-lane flex h-16 bg-studio-ground hover:bg-studio-panel transition-colors"
                >
                  {/* Left 2-Line Track Control Strip (264px / w-66) */}
                  <div className="lt-arranger-channel shrink-0 px-3 py-1.5 border-r border-neutral-800 bg-studio-panel flex flex-col justify-between">
                    {/* Line 1: Color Dot + Full Instrument Name (13px bold) + M + S + Delete */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span
                          style={{ backgroundColor: track.color }}
                          className="w-3 h-3 rounded-xs shrink-0"
                        />
                        <span
                          className={`text-[13px] font-bold truncate ${
                            isAudible
                              ? 'text-neutral-100'
                              : 'text-neutral-400 line-through'
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
                          className={`w-6 h-5.5 rounded text-xs font-bold transition-colors cursor-pointer ${
                            track.muted
                              ? 'bg-red-600 text-white'
                              : 'bg-neutral-800 text-neutral-300 hover:text-white'
                          }`}
                        >
                          M
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleTrackSolo(track.id)}
                          title="Aislar Pista (Solo)"
                          className={`w-6 h-5.5 rounded text-xs font-bold transition-colors cursor-pointer ${
                            track.soloed
                              ? 'bg-amber-400 text-neutral-950'
                              : 'bg-neutral-800 text-neutral-300 hover:text-white'
                          }`}
                        >
                          S
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (pendingDeleteId === track.id) {
                              setPendingDeleteId(null);
                              onDeleteTrack(track.id);
                            } else {
                              setPendingDeleteId(track.id);
                            }
                          }}
                          title={pendingDeleteId === track.id ? 'Pulsa otra vez para quitar la pista' : 'Quitar pista de esta canción'}
                          aria-label={pendingDeleteId === track.id ? 'Confirmar: quitar pista' : 'Quitar pista de esta canción'}
                          className={`${pendingDeleteId === track.id ? 'w-auto px-1.5 bg-red-600 text-white' : 'w-6 bg-neutral-900 hover:bg-red-500/20 text-neutral-400 hover:text-red-400'} h-5.5 rounded flex items-center justify-center gap-1 text-xs font-bold transition-colors cursor-pointer`}
                        >
                          {pendingDeleteId === track.id ? <span>¿Quitar?</span> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>

                    {/* Line 2: Volume Slider + Clear dB Readout + Bus Selector */}
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
                        onDoubleClick={() => onChangeTrackGain(track.id, 1.0)}
                        title="Arrastra para ajustar volumen · Doble clic = 0.0 dB"
                        className="w-20 min-w-0 flex-1 accent-studio-accent h-1.5 bg-neutral-800 rounded-lg cursor-pointer"
                      />
                      <span className="tabular-nums text-xs font-semibold text-neutral-300 w-14 text-right shrink-0">
                        {gainToDbText(track.gain)}
                      </span>

                    </div>

                    {/* Mini VU horizontal (componente hoja: solo él se renderiza con cada lectura) */}
                    <TrackMiniMeter live={transport.isPlaying} trackId={track.id} />
                  </div>

                  {/* Right Waveform Canvas Area */}
                  <div className="flex-1 min-w-[550px] relative">
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

      {/* Bottom Arranger Bar */}
      <div className="min-h-9 bg-studio-panel border-t border-neutral-800 px-2 sm:px-4 py-1 flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-300 shrink-0">
        <div className="flex items-center gap-2.5">
          {onToggleDockedMixer && (
            <button
              type="button"
              onClick={onToggleDockedMixer}
              className={`h-7 px-3 rounded-lg text-xs font-bold flex items-center gap-1.5 border transition-colors cursor-pointer ${
                isDockedMixerOpen
                  ? 'bg-studio-ink text-studio-ground hover:bg-neutral-200 border-studio-line'
                  : 'bg-neutral-900 border-neutral-700 text-neutral-200 hover:bg-neutral-800'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>
                {isDockedMixerOpen ? 'Cerrar Consola Mixer' : 'Abrir Consola Mixer'}
              </span>
            </button>
          )}
          {transport.lastCueMessage && (
            <span className="text-xs tabular-nums text-studio-ink bg-neutral-900 border border-neutral-800 px-2.5 py-0.5 rounded font-semibold">
              {transport.lastCueMessage}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onAddMarkerAtPlayhead}
            className="text-studio-ink hover:underline font-semibold flex items-center gap-1 cursor-pointer"
          >
            <Flag className="w-3.5 h-3.5" />
            <span>+ Marcar Sección ({formatMmSs(transport.currentTimeSec)})</span>
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onOpenSectionEditor}
            className="text-neutral-200 hover:underline font-semibold cursor-pointer"
          >
            Editar Secciones ({project.sections.length})
          </button>
          {onEditTracks && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={onEditTracks}
                className="text-neutral-200 hover:underline font-semibold cursor-pointer"
              >
                Editar Pistas ({project.tracks.length})
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
