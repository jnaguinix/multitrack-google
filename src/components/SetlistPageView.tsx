import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  MoreHorizontal,
  Plus,
  GripHorizontal,
  Flag,
  Filter,
  Music,
  X,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Zap,
  RotateCcw,
  Sliders,
  Repeat,
} from 'lucide-react';
import {
  MetersSnapshot,
  OutputBus,
  QuantizeMode,
  SetlistTransitionMode,
  SongProject,
  TrackChannel,
  TransportState,
} from '../types/project';
import { audioEngine } from '../audio/audioEngine';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';
import { extractAudioFilesFromDataTransfer } from '../utils/fileImportHelper';
import { formatMmSs, formatTimecode } from './TransportDeck';
import { getSongWaveformPeaks } from '../utils/songWaveform';
import { MultitrackMixer, gainToDb } from './MultitrackMixer';
import { isDesktopApp } from '../utils/nativeDialog';

interface SetlistPageViewProps {
  project: SongProject | null;
  allProjects: SongProject[];
  setlistQueue: SongProject[];
  transport: TransportState;
  ramCacheVersion: number;
  setlistTransitionMode: SetlistTransitionMode;
  metersRef: React.MutableRefObject<MetersSnapshot>;
  onPlayPause: () => void;
  onStop: () => void;
  onToggleVamp: () => void;
  onLoadAndPlaySong: (songId: string, autoPlay: boolean) => void;
  onRequestSongAction: (song: SongProject) => void;
  onAddToSetlist: (songId: string) => void;
  onRemoveFromSetlist: (songId: string) => void;
  onClearSetlist?: () => void;
  onMoveInSetlist: (songId: string, direction: 'up' | 'down') => void;
  onReorderSetlist: (fromIndex: number, toIndex: number) => void;
  onChangeSetlistTransitionMode: (mode: SetlistTransitionMode) => void;
  onChangeQuantize: (mode: QuantizeMode) => void;
  onChangePitch: (semitones: number) => void;
  onChangeBpm: (bpm: number) => void;
  onSeekSeconds: (seconds: number) => void;
  onJumpSection: (sectionId: string) => void;
  onCancelQueuedJump: () => void;
  onAddMarkerAtPlayhead: () => void;
  onOpenSectionEditor: () => void;
  onAddStemsToCurrentSong: (files: FileList | File[]) => void;
  onQuickImportNewSongFiles: (files: FileList | File[]) => void;
  onQuickImportNativeFolder?: (folderPath: string) => void;
  onQuickImportNativeFiles?: (filePaths: string[]) => void;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onChangeTrackGain: (trackId: string, gain: number) => void;
  onChangeTrackPan: (trackId: string, pan: number) => void;
  onChangeTrackBus: (trackId: string, bus: OutputBus) => void;
  onChangeClickGain: (gain: number) => void;
  onChangeClickPan?: (pan: number) => void;
  onToggleClick: () => void;
  onChangeGuideGain: (gain: number) => void;
  onChangeGuidePan?: (pan: number) => void;
  onToggleGuide: () => void;
  onChangeMasterGain: (gain: number) => void;
  onChangeCueMasterGain: (gain: number) => void;
  onResetMixer: () => void;
  onOptimizeProject: (song: SongProject) => void;
  /** Abre la biblioteca lateral para añadir canciones al setlist. */
  onOpenLibrary: () => void;
}

function closePopover(event: React.MouseEvent<HTMLButtonElement>) {
  event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
}

function formatTrackDb(gain: number): string {
  const db = gainToDb(gain);
  if (!isFinite(db)) return '-∞ dB';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export const SetlistPageView: React.FC<SetlistPageViewProps> = ({
  project,
  setlistQueue,
  transport,
  ramCacheVersion: _ramCacheVersion,
  metersRef,
  onPlayPause,
  onLoadAndPlaySong,
  onRequestSongAction,
  onAddToSetlist,
  onRemoveFromSetlist,
  onClearSetlist,
  onMoveInSetlist,
  onReorderSetlist,
  onOptimizeProject,
  onSeekSeconds,
  onJumpSection,
  onAddMarkerAtPlayhead,
  onOpenSectionEditor,
  onAddStemsToCurrentSong,
  onQuickImportNewSongFiles,
  onToggleTrackMute,
  onToggleTrackSolo,
  onChangeTrackGain,
  onChangeTrackPan,
  onChangeTrackBus,
  onChangeClickGain,
  onChangeClickPan,
  onToggleClick,
  onChangeGuideGain,
  onChangeGuidePan,
  onToggleGuide,
  onChangeMasterGain,
  onChangeCueMasterGain,
  onResetMixer,
  onOpenLibrary,
}) => {
  const [trackFilterText, setTrackFilterText] = useState('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [dragOverCardIdx, setDragOverCardIdx] = useState<number | null>(null);
  const [cursorNotice, setCursorNotice] = useState<string | null>(null);
  const [isFloatingMixerOpen, setIsFloatingMixerOpen] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const masterCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const addAudioInputRef = useRef<HTMLInputElement | null>(null);

  // Close floating Mixer on Escape key
  useEffect(() => {
    if (!isFloatingMixerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFloatingMixerOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFloatingMixerOpen]);

  const totalDurationSec = useMemo(() => {
    if (!project) return 0;
    const secPerBar = (60 / (project.bpm || 120)) * (project.beatsPerBar || 4);
    return Math.max(
      1,
      transport.totalDurationSec || project.durationSec || project.totalBars * secPerBar
    );
  }, [project, transport.totalDurationSec]);

  // Compute combined master waveform peaks from all audible tracks
  const masterPeaks = useMemo(() => getSongWaveformPeaks(project, totalDurationSec), [project, totalDurationSec]);
  const sections = useMemo(() => [...(project?.sections ?? [])].sort((a, b) => a.startTimeSec - b.startTimeSec), [project]);
  const activeSection = sections.find((section) => section.id === transport.activeSectionId);
  const playheadSec = Math.max(0, Math.min(transport.currentTimeSec, totalDurationSec));
  const playheadPct = totalDurationSec > 0 ? playheadSec / totalDurationSec * 100 : 0;

  // Draw the Master Overview Waveform Canvas
  useEffect(() => {
    const canvas = masterCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const { clientWidth: width, clientHeight: height } = canvas;
      if (!width || !height || totalDurationSec <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      for (const section of sections) {
        const startX = (section.startTimeSec / totalDurationSec) * width;
        const endX = (section.endTimeSec / totalDurationSec) * width;
        const queued = section.id === transport.queuedSectionId;
        ctx.fillStyle = queued ? '#e8ba68' : section.color || '#8dd6cd';
        ctx.globalAlpha = queued || section.id === activeSection?.id ? 0.14 : 0.05;
        ctx.fillRect(startX, 0, Math.max(0, endX - startX), height);
        ctx.globalAlpha = 0.6;
        ctx.fillRect(startX, 0, 1, height);
      }

      const barCount = Math.min(masterPeaks.length, Math.max(1, Math.floor(width / 4)));
      const stepX = width / Math.max(1, barCount);
      const baseline = height - 12;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.min(3, stepX * 0.6);
      ctx.globalAlpha = 0.8;
      for (let i = 0; i < barCount; i++) {
        const first = Math.floor(i * masterPeaks.length / barCount);
        const last = Math.floor((i + 1) * masterPeaks.length / barCount);
        let peak = 0;
        for (let index = first; index < last; index++) peak = Math.max(peak, masterPeaks[index]);
        if (peak <= 0) continue;
        const seconds = ((i + 0.5) / barCount) * totalDurationSec;
        const section = sections.find((item) => item.startTimeSec <= seconds && seconds < item.endTimeSec);
        const x = (i + 0.5) * stepX;
        ctx.strokeStyle = section?.color || '#8dd6cd';
        ctx.beginPath();
        ctx.moveTo(x, baseline);
        ctx.lineTo(x, baseline - Math.max(1, peak * (height - 38)));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [masterPeaks, sections, totalDurationSec, activeSection?.id, transport.queuedSectionId]);

  const handleMasterWaveformClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!project || totalDurationSec <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetSec = ratio * totalDurationSec;
    onSeekSeconds(targetSec);
    const msg = `Cursor movido a ${formatTimecode(targetSec)}`;
    setCursorNotice(msg);
    setTimeout(() => {
      setCursorNotice((prev) => (prev === msg ? null : prev));
    }, 2500);
  };

  // Filtered project for the tracks grid & floating Mixer
  const filteredProjectForMixer = useMemo(() => {
    if (!project) return null;
    const q = trackFilterText.trim().toLowerCase();
    if (!q) return project;
    return {
      ...project,
      tracks: project.tracks.filter((t) => t.name.toLowerCase().includes(q)),
    };
  }, [project, trackFilterText]);

  const isProjectInSetlist = Boolean(project && setlistQueue.some((s) => s.id === project.id));
  const setlistTotalSec = setlistQueue.reduce(
    (sum, song) => sum + (song.durationSec || ((song.totalBars || 24) * 4 * 60) / (song.bpm || 120)),
    0
  );

  return (
    <section className="lt-setlist lt-setlist-split flex-1 min-w-0 min-h-0" aria-labelledby="setlist-title">
      {/* Columna izquierda: el setlist es el protagonista de esta página */}
      <div
        className="lt-setlist-list"
        onDragOver={(e) => e.preventDefault()}
        onDrop={async (e) => {
          // Las tarjetas gestionan su propio drop (reordenar o añadir); aquí solo el espacio libre.
          if ((e.target as HTMLElement).closest('.lt-queue-item')) return;
          e.preventDefault();
          const songId = e.dataTransfer.getData('application/x-omnitracks-song-id');
          if (songId) {
            onAddToSetlist(songId);
            return;
          }
          const audioFiles = await extractAudioFilesFromDataTransfer(e.dataTransfer);
          if (audioFiles.length > 0) {
            onQuickImportNewSongFiles(audioFiles);
          }
        }}
      >
        <header className="lt-setlist-order-header">
          <div>
            <h1 id="setlist-title">Setlist</h1>
            <p>
              {setlistQueue.length === 0
                ? 'Sin canciones'
                : `${setlistQueue.length === 1 ? '1 canción' : setlistQueue.length + ' canciones'} · ${formatMmSs(setlistTotalSec)}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {onClearSetlist && setlistQueue.length > 0 && (
              <button
                type="button"
                onClick={() => setShowClearConfirm(true)}
                className="lt-control lt-icon-control text-neutral-300 hover:text-amber-400"
                aria-label="Limpiar sesión"
                title="Vaciar el setlist sin borrar las canciones de la biblioteca"
              >
                <RotateCcw size={15} />
              </button>
            )}
            <button type="button" onClick={onOpenLibrary} className="lt-control" title="Abrir la biblioteca para añadir canciones">
              <Plus size={16} /> Añadir
            </button>
          </div>
        </header>

        {setlistQueue.length === 0 ? (
          <div className="lt-empty">
            <Music size={24} className="text-neutral-400" aria-hidden="true" />
            <h2>Setlist vacío</h2>
            <p>Abre la biblioteca y pulsa «+ Set» en cada canción, o arrástrala hasta aquí.</p>
            <button type="button" onClick={onOpenLibrary} className="lt-primary"><Plus size={16} /> Añadir canción</button>
          </div>
        ) : (
          <div className="lt-setlist-queue" role="group" aria-label="Canciones del setlist">
          {setlistQueue.map((song, idx) => {
            const isCurrent = project?.id === song.id;
            const isPlayingThis = isCurrent && transport.isPlaying;
            const cacheInfo = audioEngine.getSongRamCacheInfo(song);
            // Avance real de decodificación (pista N de M) emitido por el motor nativo.
            const liveCacheText = isDesktopApp() ? nativeAudioEngine.formatImportProgress(song.id) : null;
            // Escritorio: estado real de la caché PCM nativa (no el del motor web).
            const nativeLiveText = liveCacheText;
            const nativeReady = isDesktopApp() ? nativeAudioEngine.isNativeCacheReady(song.id) : null;
            const isPcmReady = audioEngine.isProjectPcmReady(song);
            const isStreamSong = audioEngine.getEffectiveEngineModeForProject(song) === 'stream';
            const pcmMB = audioEngine.getProjectPcmEstimatedMB(song);
            const durSec =
              song.durationSec ||
              ((song.totalBars || 24) * 4 * 60) / (song.bpm || 120);

            return (
              <div
                  key={song.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      'application/x-omnitracks-setlist-index',
                      String(idx)
                    );
                    e.dataTransfer.setData(
                      'application/x-omnitracks-song-id',
                      song.id
                    );
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverCardIdx(idx);
                  }}
                  onDragLeave={() => setDragOverCardIdx(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (e.dataTransfer.types.includes('application/x-omnitracks-setlist-index')) e.stopPropagation();
                    setDragOverCardIdx(null);
                    const fromIdxStr = e.dataTransfer.getData(
                      'application/x-omnitracks-setlist-index'
                    );
                    const droppedSongId = e.dataTransfer.getData(
                      'application/x-omnitracks-song-id'
                    );
                    if (fromIdxStr !== '') {
                      const fromIdx = Number(fromIdxStr);
                      if (!Number.isNaN(fromIdx) && fromIdx !== idx) {
                        onReorderSetlist(fromIdx, idx);
                      }
                    } else if (droppedSongId) {
                      onAddToSetlist(droppedSongId);
                    }
                  }}
                  onClick={() => {
                    if (!isCurrent) {
                      onRequestSongAction(song);
                    }
                  }}
                  className="lt-queue-item relative flex flex-col justify-between shrink-0 cursor-pointer"
                  data-current={isCurrent || undefined}
                  data-dragging={dragOverCardIdx === idx || undefined}
                >
                  {/* Row 1: Grip + Index Badge + Song Title + Play + Menu */}
                  <div className="flex items-center justify-between gap-1.5 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <GripHorizontal className="w-3.5 h-3.5 text-studio-muted cursor-grab shrink-0" />
                      <span className="w-4 text-xs text-neutral-400 shrink-0">
                        {idx + 1}
                      </span>
                      <span
                        className="text-[13px] font-bold text-studio-ink truncate"
                        title={song.title}
                      >
                        {song.title}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={Boolean(isCurrent && transport.isMountingSong)}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isCurrent) {
                            onPlayPause();
                          } else {
                            onLoadAndPlaySong(song.id, cacheInfo.isReady || isDesktopApp());
                          }
                        }}
                        title={
                          isCurrent && transport.isMountingSong
                            ? transport.mountingProgressText || 'Cargando pistas en RAM...'
                            : isPlayingThis
                            ? 'Pausar canción'
                            : isCurrent
                            ? 'Reproducir desde posición actual'
                            : cacheInfo.isReady
                            ? 'En RAM: Montar y reproducir al instante'
                            : 'Montar en consola en 00:00'
                        }
                        className="lt-control lt-queue-action"
                      >
                        {isPlayingThis ? (
                          <Pause className="w-3 h-3 fill-current" />
                        ) : (
                          <Play className="w-3 h-3 fill-current" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={(event) => event.stopPropagation()}
                        popoverTarget={`song-actions-${idx}`}
                        aria-label={`Acciones de ${song.title}`}
                        className="lt-control lt-queue-action"
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Row 2: BPM + Duration + RAM Status + PCM/Opt Badge */}
                  <div className="flex items-center justify-between gap-1.5 text-[11px]">
                    <span className="text-neutral-300 truncate">
                      {song.keySignature} · {song.bpm} BPM · {formatMmSs(durSec)}
                    </span>

                    <div className="flex items-center gap-1 shrink-0">
                      {isDesktopApp() && song.tracks.length > 0 && (
                        <span
                          title={
                            nativeLiveText
                              ? `Generando la caché de audio nativa: ${nativeLiveText}`
                              : nativeReady
                              ? 'Caché de audio nativa lista: suena sin esperas.'
                              : nativeReady === null
                              ? 'Comprobando la caché de audio nativa...'
                              : 'Sin caché de audio nativa: se genera al añadir al setlist o al cargar en el DAW.'
                          }
                          className={`px-1.5 py-0.2 rounded text-[11px] font-bold tracking-tight ${
                            nativeLiveText
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                              : nativeReady
                              ? 'bg-studio-strip text-studio-ink border border-studio-line'
                              : 'bg-neutral-800/80 text-neutral-400 border border-neutral-700'
                          }`}
                        >
                          {nativeLiveText ?? (nativeReady ? 'Lista' : nativeReady === null ? 'Comprobando' : 'Sin preparar')}
                        </span>
                      )}

                      {!isDesktopApp() && cacheInfo.totalCount > 0 && (
                        <span
                          title={
                            isStreamSong
                              ? cacheInfo.isReady
                                ? `Lista: suena desde el disco (streaming). En RAM solo hay ${((cacheInfo.cachedBytes || 0) / (1024 * 1024)).toFixed(0)} MB (los primeros segundos de cada pista).`
                                : 'Se reproduce desde el disco (streaming); se prepara al acercarse su turno.'
                              : cacheInfo.isReady
                              ? `100% en caché RAM (${cacheInfo.cachedCount}/${cacheInfo.totalCount} pistas · ${((cacheInfo.cachedBytes || 0) / (1024 * 1024)).toFixed(0)} MB)`
                              : `${cacheInfo.cachedCount}/${cacheInfo.totalCount} pistas en RAM`
                          }
                          className={`px-1.5 py-0.2 rounded text-[11px] font-bold tracking-tight ${
                            cacheInfo.isReady
                              ? 'bg-studio-strip text-studio-ink border border-studio-line'
                              : cacheInfo.skippedByRamBudget
                              ? 'bg-rose-500/15 text-rose-300 border border-rose-500/40'
                              : cacheInfo.isPreloading || cacheInfo.cachedCount > 0
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                              : 'bg-neutral-800/80 text-neutral-400 border border-neutral-700'
                          }`}
                        >
                          {isStreamSong
                            ? cacheInfo.isReady
                              ? 'Lista'
                              : liveCacheText ?? 'Disco'
                            : cacheInfo.isReady
                            ? `RAM`
                            : cacheInfo.skippedByRamBudget
                            ? 'Lím'
                            : liveCacheText
                            ? liveCacheText
                            : `${cacheInfo.cachedCount}/${cacheInfo.totalCount}`}
                        </span>
                      )}

                      {isDesktopApp() ? null : isPcmReady ? (
                        <span
                          title={`Guardada en el disco del navegador (OPFS, ~${pcmMB} MB)`}
                          className="px-1.5 py-0.2 rounded text-[11px] font-bold bg-studio-strip text-studio-ink border border-studio-line"
                        >
                          PCM
                        </span>
                      ) : (
                        song.tracks.length > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOptimizeProject(song);
                            }}
                            title="Optimizar canción para streaming OPFS"
                            className="px-1.5 py-0.2 rounded text-[11px] font-bold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 cursor-pointer flex items-center gap-0.5"
                          >
                            <Zap className="w-2.5 h-2.5 text-amber-400" />
                            <span>Opt</span>
                          </button>
                        )
                      )}
                    </div>
                  </div>

                  {/* Card Context Menu Popover */}
                  <div
                      id={`song-actions-${idx}`}
                      popover="auto"
                      onClick={(event) => event.stopPropagation()}
                      className="lt-popover space-y-1"
                    >
                      <button
                        type="button"
                        onClick={(event) => {
                          onLoadAndPlaySong(song.id, false);
                          closePopover(event);
                        }}
                        className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-neutral-800 text-studio-ink font-semibold cursor-pointer"
                      >
                        Montar en consola (00:00)
                      </button>
                      {!isDesktopApp() && !isPcmReady && song.tracks.length > 0 && (
                        <button
                          type="button"
                          onClick={(event) => {
                            onOptimizeProject(song);
                          closePopover(event);
                          }}
                          className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-neutral-800 text-amber-300 flex items-center gap-1.5 cursor-pointer font-medium"
                        >
                          <Zap className="w-3.5 h-3.5 text-amber-400" /> Optimizar (OPFS)
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={(event) => {
                          onMoveInSetlist(song.id, 'up');
                          closePopover(event);
                        }}
                        className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-neutral-800 text-neutral-200 flex items-center gap-1.5 disabled:opacity-30 cursor-pointer"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" /> Mover antes
                      </button>
                      <button
                        type="button"
                        disabled={idx === setlistQueue.length - 1}
                        onClick={(event) => {
                          onMoveInSetlist(song.id, 'down');
                          closePopover(event);
                        }}
                        className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-neutral-800 text-neutral-200 flex items-center gap-1.5 disabled:opacity-30 cursor-pointer"
                      >
                        <ChevronRight className="w-3.5 h-3.5" /> Mover después
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          onRemoveFromSetlist(song.id);
                          closePopover(event);
                        }}
                        className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-red-500/20 text-red-400 flex items-center gap-1.5 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Quitar del Setlist
                      </button>
                    </div>
                </div>
            );
          })}
          </div>
        )}
      </div>

      {/* Columna derecha: detalle de la canción montada (onda y secciones) */}
      <div className="lt-setlist-detail">
        {isProjectInSetlist && project ? (
          <>
            <header className="lt-setlist-detail-header">
              <p>
                {project.tracks.length === 1 ? '1 pista' : `${project.tracks.length} pistas`}
                {sections.length > 0 && ` · ${sections.length === 1 ? '1 sección' : sections.length + ' secciones'}`}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={onAddMarkerAtPlayhead} className="lt-control">
                  <Flag className="w-3.5 h-3.5" />
                  <span>Marcar aquí</span>
                </button>
                <button type="button" onClick={onOpenSectionEditor} className="lt-control">
                  Editar secciones
                </button>
                <button type="button" onClick={() => setIsFloatingMixerOpen(true)} className="lt-control">
                  <Sliders size={16} /> Mezcla
                </button>
              </div>
            </header>

        <div className="lt-waveform relative shrink-0 overflow-hidden">
          <canvas
            ref={masterCanvasRef}
            onClick={handleMasterWaveformClick}
            className="w-full h-full block cursor-pointer"
            aria-label="Forma de onda. Haz clic para mover el cursor."
          />
          <span className="lt-setlist-waveform-unplayed" style={{ left: playheadPct + '%' }} aria-hidden="true" />
          <span
            className="lt-setlist-waveform-cursor"
            style={{ left: 'min(' + playheadPct + '%, calc(100% - 2px))' }}
            aria-hidden="true"
          />
          <span className="lt-setlist-waveform-label">Forma de onda</span>
              {transport.isMountingSong && (
                <div className="absolute inset-0 bg-neutral-950/75 flex flex-col items-center justify-center p-4 text-center z-20">
                  <div className="px-4 py-2.5 rounded-xl bg-studio-panel border border-amber-500/50 text-amber-300 text-sm font-bold shadow-xl">
                    {transport.mountingProgressText || 'Cargando pistas en RAM...'}
                  </div>
                </div>
              )}
        </div>

            <section aria-label="Secciones" className="lt-setlist-sections">
              {sections.length === 0 ? (
                <div className="py-3 px-4 rounded-lg bg-studio-ground border border-neutral-800/80 text-xs text-neutral-300 flex items-center justify-between">
                  <span>
                    Esta canción aún no tiene secciones marcadas. Pulsa <strong>+ Marcar aquí</strong> mientras reproduces para dividirla en Intro, Verso, Coro, Puente, etc.
                  </span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {sections.map((sec) => {
                    const isActive = sec.id === transport.activeSectionId;
                    const isQueued = sec.id === transport.queuedSectionId;
                    const isVampHere = isActive && transport.isVamping;

                    return (
                      <button
                        key={sec.id}
                        type="button"
                        onClick={() => onJumpSection(sec.id)}
                        className="lt-setlist-section"
                        data-active={isActive || undefined}
                        data-queued={isQueued || undefined}
                        aria-pressed={isActive}
                        style={{ '--sec': sec.color || 'var(--lt-accent)' } as React.CSSProperties}
                      >
                        <i aria-hidden="true" />
                        <span>{sec.name}</span>
                        <span className="lt-setlist-section-time">
                          {formatMmSs(sec.startTimeSec)}
                        </span>
                        {isQueued && <span className="lt-setlist-section-queued">En cola</span>}
                        {isVampHere && <Repeat className="w-3.5 h-3.5 shrink-0" aria-label="En bucle" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="lt-empty">
            <Music size={24} className="text-neutral-400" aria-hidden="true" />
            <h2>{setlistQueue.length ? 'Elige una canción' : 'Sin canción montada'}</h2>
            <p>
              {setlistQueue.length
                ? 'Pulsa una canción de la lista para montarla. Aquí verás su forma de onda y sus secciones.'
                : 'Cuando añadas una canción al setlist y la montes, aquí verás su forma de onda y sus secciones.'}
            </p>
          </div>
        )}
      </div>

      {/* 4. FLOATING MIXER CARD MODAL / DRAWER (Opens on demand, closes with 1 click or Esc) */}
      {isFloatingMixerOpen && filteredProjectForMixer && (
        <div
          onClick={() => setIsFloatingMixerOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 flex items-end justify-center p-3 sm:p-5"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Mezcla de la canción"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[1440px] bg-studio-panel border-2 border-studio-line rounded-2xl shadow-[0_24px_70px_rgba(0,0,0,0.9)] overflow-hidden flex flex-col max-h-[86vh]"
          >
            {/* Floating Card Header with Intuitive Close Button */}
            <div className="px-4 py-3 bg-studio-panel border-b border-studio-line flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-studio-strip border border-studio-line flex items-center justify-center text-studio-ink">
                  <Sliders className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-white">
                      Consola Mixer — {filteredProjectForMixer.title}
                    </h2>
                    <span className="px-2 py-0.5 rounded bg-studio-strip border border-studio-line text-studio-ink text-xs font-bold">
                      Compás {String(transport.currentBar).padStart(3, '0')}
                    </span>
                  </div>
                  <p className="text-xs text-neutral-400">
                    Doble clic en fader = 0.0 dB · Doble clic en knob = Centrar (C) · Pulsa Esc o fuera de la tarjeta para cerrar
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={onResetMixer}
                  className="h-9 px-3.5 rounded-lg bg-studio-strip hover:bg-neutral-800 border border-studio-line text-xs font-semibold text-neutral-200 flex items-center gap-1.5 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Restablecer mezcla a 0 dB</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsFloatingMixerOpen(false)}
                  className="lt-control"
                >
                  <X className="w-4 h-4 stroke-[2.5]" />
                  <span>Cerrar mezcla</span>
                </button>
              </div>
            </div>

            {/* Mixer Strips Body */}
            <div className="overflow-y-auto">
              <MultitrackMixer
                project={filteredProjectForMixer}
                transport={transport}
                metersRef={metersRef}
                docked={true}
                onToggleTrackMute={onToggleTrackMute}
                onToggleTrackSolo={onToggleTrackSolo}
                onChangeTrackGain={onChangeTrackGain}
                onChangeTrackPan={onChangeTrackPan}
                onChangeTrackBus={onChangeTrackBus}
                onChangeClickGain={onChangeClickGain}
                onChangeClickPan={onChangeClickPan}
                onToggleClick={onToggleClick}
                onChangeGuideGain={onChangeGuideGain}
                onChangeGuidePan={onChangeGuidePan}
                onToggleGuide={onToggleGuide}
                onChangeMasterGain={onChangeMasterGain}
                onChangeCueMasterGain={onChangeCueMasterGain}
                onResetMixer={onResetMixer}
              />
            </div>
          </div>
        </div>
      )}

      {cursorNotice && (
        <div className="fixed bottom-4 right-4 z-40 bg-studio-panel border border-studio-line text-neutral-200 px-3 py-1.5 rounded-lg text-xs shadow-lg">
          {cursorNotice}
        </div>
      )}

      {/* Modal de confirmación para limpiar la sesión (Setlist) */}
      {showClearConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
        >
          <div className="bg-studio-panel border border-neutral-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center shrink-0">
                <RotateCcw className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="text-base font-bold text-neutral-100">¿Limpiar la sesión actual?</h3>
                <p className="text-xs text-neutral-400">
                  Se quitarán las {setlistQueue.length} canciones del setlist activo.
                </p>
              </div>
            </div>
            <p className="text-xs text-neutral-300 bg-studio-ground border border-neutral-800 rounded-lg p-3">
              Tus canciones, pistas y marcadores seguirán <strong>completamente intactos en tu biblioteca</strong>. Podrás volver a agregarlas en cualquier momento.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                className="px-3.5 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-300 font-medium cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowClearConfirm(false);
                  onClearSetlist?.();
                }}
                className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-neutral-950 font-bold text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-amber-500/20"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Limpiar sesión</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
