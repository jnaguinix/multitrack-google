import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  MoreHorizontal,
  Plus,
  FolderOpen,
  ArrowRight,
  GripHorizontal,
  Edit3,
  Flag,
  Filter,
  Upload,
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
import { extractAudioFilesFromDataTransfer } from '../utils/fileImportHelper';
import { formatMmSs, formatTimecode } from './TransportDeck';
import { MultitrackMixer, gainToDb } from './MultitrackMixer';

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
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onChangeTrackGain: (trackId: string, gain: number) => void;
  onChangeTrackPan: (trackId: string, pan: number) => void;
  onChangeTrackBus: (trackId: string, bus: OutputBus) => void;
  onChangeClickGain: (gain: number) => void;
  onToggleClick: () => void;
  onChangeGuideGain: (gain: number) => void;
  onToggleGuide: () => void;
  onChangeMasterGain: (gain: number) => void;
  onChangeCueMasterGain: (gain: number) => void;
  onResetMixer: () => void;
  onOptimizeProject: (song: SongProject) => void;
}

function formatTrackDb(gain: number): string {
  const db = gainToDb(gain);
  if (!isFinite(db)) return '-∞ dB';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export const SetlistPageView: React.FC<SetlistPageViewProps> = ({
  project,
  allProjects,
  setlistQueue,
  transport,
  ramCacheVersion: _ramCacheVersion,
  metersRef,
  onPlayPause,
  onLoadAndPlaySong,
  onRequestSongAction,
  onAddToSetlist,
  onRemoveFromSetlist,
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
  onToggleClick,
  onChangeGuideGain,
  onToggleGuide,
  onChangeMasterGain,
  onChangeCueMasterGain,
  onResetMixer,
}) => {
  const [openCardMenuId, setOpenCardMenuId] = useState<string | null>(null);
  const [isNewSongDropdownOpen, setIsNewSongDropdownOpen] = useState(false);
  const [trackFilterText, setTrackFilterText] = useState('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [dragOverCardIdx, setDragOverCardIdx] = useState<number | null>(null);
  const [cursorNotice, setCursorNotice] = useState<string | null>(null);
  const [isFloatingMixerOpen, setIsFloatingMixerOpen] = useState(false);
  const [, setMeterTick] = useState(0);

  const masterCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const addAudioInputRef = useRef<HTMLInputElement | null>(null);
  const newSongFolderInputRef = useRef<HTMLInputElement | null>(null);
  const newSongFilesInputRef = useRef<HTMLInputElement | null>(null);

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

  // Poll meters at 20fps when playing so the quick-mute track cards show live levels
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

  const totalDurationSec = useMemo(() => {
    if (!project) return 0;
    const secPerBar = (60 / (project.bpm || 120)) * (project.beatsPerBar || 4);
    return Math.max(
      1,
      transport.totalDurationSec || project.durationSec || project.totalBars * secPerBar
    );
  }, [project, transport.totalDurationSec]);

  // Compute combined master waveform peaks from all audible tracks
  const masterPeaks = useMemo(() => {
    if (!project || project.tracks.length === 0) return [];
    const numBuckets = 380;
    const combined = new Array<number>(numBuckets).fill(0);
    const anySolo = project.tracks.some((t) => t.soloed);
    const activeTracks = project.tracks.filter(
      (t) =>
        t.role !== 'click' &&
        t.role !== 'guide' &&
        (anySolo ? t.soloed && !t.muted : !t.muted)
    );
    const sourceList = activeTracks.length > 0 ? activeTracks : project.tracks;

    for (let i = 0; i < numBuckets; i++) {
      let sum = 0;
      for (const trk of sourceList) {
        if (!trk.peaks || trk.peaks.length === 0) continue;
        const pIdx = Math.min(
          trk.peaks.length - 1,
          Math.floor((i / numBuckets) * trk.peaks.length)
        );
        sum += (trk.peaks[pIdx] || 0) * trk.gain;
      }
      combined[i] = Math.min(1, sum / Math.max(1, sourceList.length * 0.65));
    }
    return combined;
  }, [project]);

  // Draw the Master Overview Waveform Canvas
  useEffect(() => {
    const canvas = masterCanvasRef.current;
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

    ctx.fillStyle = '#263030';
    ctx.fillRect(0, 0, width, height);

    if (!project || masterPeaks.length === 0 || totalDurationSec <= 0) {
      ctx.restore();
      return;
    }

    // Draw section regions if any
    for (const sec of project.sections) {
      const startX = (sec.startTimeSec / totalDurationSec) * width;
      const endX = (sec.endTimeSec / totalDurationSec) * width;
      const isActive = sec.id === transport.activeSectionId;
      const isQueued = sec.id === transport.queuedSectionId;

      if (isActive) {
        ctx.fillStyle = 'rgba(47, 208, 200, 0.12)';
        ctx.fillRect(startX, 0, Math.max(2, endX - startX), height);
      } else if (isQueued) {
        ctx.fillStyle = 'rgba(255, 194, 51, 0.14)';
        ctx.fillRect(startX, 0, Math.max(2, endX - startX), height);
      }

      ctx.strokeStyle = sec.color || '#2fd0c8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(startX, height);
      ctx.stroke();
    }

    // Center line
    const midY = height / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // Draw dense vertical waveform spikes
    const numPeaks = masterPeaks.length;
    const stepX = width / numPeaks;
    const playheadRatio = Math.max(0, Math.min(1, transport.currentTimeSec / totalDurationSec));
    const playheadX = playheadRatio * width;

    for (let i = 0; i < numPeaks; i++) {
      const amp = Math.max(0.02, masterPeaks[i] || 0.02);
      const x = i * stepX;
      const halfH = amp * (height * 0.44);

      ctx.strokeStyle = x <= playheadX ? '#a8d5d1' : '#859c9a';
      ctx.lineWidth = Math.max(1, stepX * 0.75);
      ctx.beginPath();
      ctx.moveTo(x, midY - halfH);
      ctx.lineTo(x, midY + halfH);
      ctx.stroke();
    }

    // Playhead cursor line
    ctx.strokeStyle = '#2fd0c8';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    ctx.restore();
  }, [
    masterPeaks,
    project,
    totalDurationSec,
    transport.activeSectionId,
    transport.currentTimeSec,
    transport.queuedSectionId,
  ]);

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

  const activeSection = project?.sections.find((s) => s.id === transport.activeSectionId);
  const anySolo = project?.tracks.some((t) => t.soloed) ?? false;
  const meters = metersRef.current.tracks;

  return (
    <div className="flex-1 flex flex-col bg-[#0e1118] text-[#e9ecf2] overflow-hidden select-none relative">
      {/* 1. HORIZONTAL SETLIST SONG CARDS ROW (Clear, legible 60px cards) */}
      <div className="bg-[#0e1118] px-3.5 py-2 flex items-center justify-between gap-3 border-b border-[#252d3c] shrink-0">
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
          {setlistQueue.map((song, idx) => {
            const isCurrent = project?.id === song.id;
            const isPlayingThis = isCurrent && transport.isPlaying;
            const cacheInfo = audioEngine.getSongRamCacheInfo(song);
            const isPcmReady = audioEngine.isProjectPcmReady(song);
            const pcmMB = audioEngine.getProjectPcmEstimatedMB(song);
            const durSec =
              song.durationSec ||
              ((song.totalBars || 24) * 4 * 60) / (song.bpm || 120);

            return (
              <React.Fragment key={song.id}>
                <div
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      'application/x-libretracks-setlist-index',
                      String(idx)
                    );
                    e.dataTransfer.setData(
                      'application/x-libretracks-song-id',
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
                    setDragOverCardIdx(null);
                    const fromIdxStr = e.dataTransfer.getData(
                      'application/x-libretracks-setlist-index'
                    );
                    const droppedSongId = e.dataTransfer.getData(
                      'application/x-libretracks-song-id'
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
                  className={`relative w-56 h-15 rounded-xl px-3 py-2 flex flex-col justify-between shrink-0 border transition-all cursor-pointer ${
                    dragOverCardIdx === idx
                      ? 'border-amber-400 bg-amber-500/20'
                      : isCurrent
                      ? 'border-[#2fd0c8] bg-[#162929] shadow-[0_0_0_1px_rgba(47,208,200,0.3)]'
                      : 'border-[#252d3c] bg-[#161c24] hover:border-slate-500'
                  }`}
                >
                  {/* Row 1: Grip + Index Badge + Song Title + Play + Menu */}
                  <div className="flex items-center justify-between gap-1.5 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <GripHorizontal className="w-3.5 h-3.5 text-[#7f8899] cursor-grab shrink-0" />
                      <span className="px-1.5 py-0.2 rounded bg-black/60 text-[11px] font-mono font-bold text-slate-200 shrink-0">
                        {idx + 1}
                      </span>
                      <span
                        className="text-[13px] font-bold text-[#e9ecf2] truncate"
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
                            onLoadAndPlaySong(song.id, cacheInfo.isReady);
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
                        className="w-6 h-6 rounded-md bg-[#0c1414] hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/40 flex items-center justify-center cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-wait"
                      >
                        {isPlayingThis ? (
                          <Pause className="w-3 h-3 fill-current" />
                        ) : (
                          <Play className="w-3 h-3 fill-current" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenCardMenuId((prev) =>
                            prev === song.id ? null : song.id
                          );
                        }}
                        className="w-6 h-6 rounded-md bg-[#0c1414] hover:bg-slate-800 text-slate-300 flex items-center justify-center cursor-pointer"
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Row 2: BPM + Duration + RAM Status + PCM/Opt Badge */}
                  <div className="flex items-center justify-between gap-1.5 text-[11px] font-mono">
                    <span className="text-slate-300 truncate">
                      {song.bpm} BPM · {formatMmSs(durSec)}
                    </span>

                    <div className="flex items-center gap-1 shrink-0">
                      {cacheInfo.totalCount > 0 && (
                        <span
                          title={
                            cacheInfo.isReady
                              ? `100% en caché RAM (${cacheInfo.cachedCount}/${cacheInfo.totalCount} pistas · ${((cacheInfo.cachedBytes || 0) / (1024 * 1024)).toFixed(0)} MB)`
                              : `${cacheInfo.cachedCount}/${cacheInfo.totalCount} pistas en RAM`
                          }
                          className={`px-1.5 py-0.2 rounded text-[10px] font-mono font-bold tracking-tight ${
                            cacheInfo.isReady
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                              : cacheInfo.skippedByRamBudget
                              ? 'bg-rose-500/15 text-rose-300 border border-rose-500/40'
                              : cacheInfo.isPreloading || cacheInfo.cachedCount > 0
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                              : 'bg-slate-800/80 text-slate-400 border border-slate-700'
                          }`}
                        >
                          {cacheInfo.isReady
                            ? `RAM`
                            : cacheInfo.skippedByRamBudget
                            ? 'Lím'
                            : `${cacheInfo.cachedCount}/${cacheInfo.totalCount}`}
                        </span>
                      )}

                      {isPcmReady ? (
                        <span
                          title={`Audio PCM Int16 optimizado en OPFS (~${pcmMB} MB en disco)`}
                          className="px-1.5 py-0.2 rounded text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
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
                            className="px-1.5 py-0.2 rounded text-[10px] font-mono font-bold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 cursor-pointer flex items-center gap-0.5"
                          >
                            <Zap className="w-2.5 h-2.5 text-amber-400" />
                            <span>Opt</span>
                          </button>
                        )
                      )}
                    </div>
                  </div>

                  {/* Card Context Menu Popover */}
                  {openCardMenuId === song.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-14 right-1 z-30 w-44 bg-[#151a24] border border-[#252d3c] rounded-xl shadow-2xl p-1.5 text-xs space-y-0.5"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onLoadAndPlaySong(song.id, false);
                          setOpenCardMenuId(null);
                        }}
                        className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-slate-800 text-cyan-300 font-semibold cursor-pointer"
                      >
                        Montar en consola (00:00)
                      </button>
                      {!isPcmReady && song.tracks.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            onOptimizeProject(song);
                            setOpenCardMenuId(null);
                          }}
                          className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-slate-800 text-amber-300 flex items-center gap-1.5 cursor-pointer font-medium"
                        >
                          <Zap className="w-3.5 h-3.5 text-amber-400" /> Optimizar (OPFS)
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => {
                          onMoveInSetlist(song.id, 'up');
                          setOpenCardMenuId(null);
                        }}
                        className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-1.5 disabled:opacity-30 cursor-pointer"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" /> Mover antes
                      </button>
                      <button
                        type="button"
                        disabled={idx === setlistQueue.length - 1}
                        onClick={() => {
                          onMoveInSetlist(song.id, 'down');
                          setOpenCardMenuId(null);
                        }}
                        className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-1.5 disabled:opacity-30 cursor-pointer"
                      >
                        <ChevronRight className="w-3.5 h-3.5" /> Mover después
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onRemoveFromSetlist(song.id);
                          setOpenCardMenuId(null);
                        }}
                        className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-red-500/20 text-red-400 flex items-center gap-1.5 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Quitar del Setlist
                      </button>
                    </div>
                  )}
                </div>

                <ArrowRight className="w-3.5 h-3.5 text-[#7f8899] shrink-0" />
              </React.Fragment>
            );
          })}

          {/* "+ Nueva canción" Dashed Tile */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              e.preventDefault();
              const songId = e.dataTransfer.getData(
                'application/x-libretracks-song-id'
              );
              if (songId) {
                onAddToSetlist(songId);
                return;
              }
              const audioFiles = await extractAudioFilesFromDataTransfer(e.dataTransfer);
              if (audioFiles.length > 0) {
                onQuickImportNewSongFiles(audioFiles);
              }
            }}
            className="relative h-15 px-3.5 rounded-xl border border-dashed border-[#252d3c] hover:border-[#2fd0c8] bg-[#12161f]/60 flex items-center justify-center gap-2 shrink-0 transition-colors"
          >
            <button
              type="button"
              onClick={() => setIsNewSongDropdownOpen((prev) => !prev)}
              className="px-2 py-1 text-xs font-bold text-[#e9ecf2] hover:text-[#2fd0c8] flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Nueva canción</span>
            </button>

            <button
              type="button"
              onClick={() => newSongFolderInputRef.current?.click()}
              title="Importar carpeta de stems al Setlist"
              className="p-2 rounded-lg bg-[#171d29] hover:bg-slate-800 text-slate-200 border border-[#252d3c] cursor-pointer"
            >
              <FolderOpen className="w-4 h-4" />
            </button>

            {/* Dropdown to pick from existing Repertoire or Import */}
            {isNewSongDropdownOpen && (
              <div className="absolute top-16 left-0 z-40 w-64 bg-[#151a24] border border-[#252d3c] rounded-xl shadow-2xl p-2.5 space-y-2">
                <div className="flex items-center justify-between px-2 py-1 border-b border-[#252d3c]">
                  <span className="text-xs font-bold text-slate-200">
                    Añadir al Setlist
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsNewSongDropdownOpen(false)}
                    className="text-slate-400 hover:text-white cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {allProjects.length > 0 && (
                  <div className="max-h-40 overflow-y-auto space-y-0.5">
                    <div className="px-2 py-0.5 text-[11px] text-[#7f8899] uppercase font-semibold">
                      Desde tu Repertorio:
                    </div>
                    {allProjects.map((repSong) => (
                      <button
                        key={repSong.id}
                        type="button"
                        onClick={() => {
                          onAddToSetlist(repSong.id);
                          setIsNewSongDropdownOpen(false);
                        }}
                        className="w-full px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-left text-xs text-slate-100 flex items-center justify-between cursor-pointer"
                      >
                        <span className="truncate font-medium">{repSong.title}</span>
                        <span className="text-[11px] font-mono text-cyan-400 ml-2 shrink-0 font-bold">
                          + Añadir
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="pt-1 border-t border-[#252d3c] flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setIsNewSongDropdownOpen(false);
                      newSongFilesInputRef.current?.click();
                    }}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 text-xs font-semibold flex items-center gap-2 cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Importar archivos de audio...</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsNewSongDropdownOpen(false);
                      newSongFolderInputRef.current?.click();
                    }}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-2 cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Importar carpeta de canción...</span>
                  </button>
                </div>
              </div>
            )}

            <input
              ref={newSongFilesInputRef}
              type="file"
              multiple
              accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.webm,.opus,.aif,.aiff,.caf"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  const files = Array.from(e.target.files);
                  e.target.value = '';
                  onQuickImportNewSongFiles(files);
                }
              }}
            />
            <input
              ref={newSongFolderInputRef}
              type="file"
              multiple
              // @ts-expect-error webkitdirectory is standard
              webkitdirectory=""
              directory=""
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  const files = Array.from(e.target.files);
                  e.target.value = '';
                  onQuickImportNewSongFiles(files);
                }
              }}
            />
          </div>
        </div>

        {/* Right Actions on Song Cards Row */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={!project}
            onClick={onAddMarkerAtPlayhead}
            className="h-9 px-3 rounded-lg bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-xs font-semibold text-cyan-300 flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
          >
            <Flag className="w-3.5 h-3.5" />
            <span>+ Marcar ({formatMmSs(transport.currentTimeSec)})</span>
          </button>

          <button
            type="button"
            disabled={!project}
            onClick={onOpenSectionEditor}
            className="h-9 px-3 rounded-lg bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-xs font-semibold text-[#e9ecf2] flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>Editar secciones</span>
          </button>

          <button
            type="button"
            disabled={!project}
            onClick={() => setIsFloatingMixerOpen((prev) => !prev)}
            className={`h-9 px-3.5 rounded-lg text-xs font-bold flex items-center gap-2 border transition-all disabled:opacity-40 cursor-pointer ${
              isFloatingMixerOpen
                ? 'bg-cyan-400 text-slate-950 border-cyan-300 shadow-[0_0_16px_rgba(34,211,238,0.35)]'
                : 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border-emerald-500/50'
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span>{isFloatingMixerOpen ? 'Cerrar Mixer' : 'Abrir Mixer'}</span>
          </button>
        </div>
      </div>

      {/* 2. LARGE MASTER WAVEFORM OVERVIEW (180px height for clear visual structure) */}
      <div className="relative h-44 shrink-0 bg-[#263030] border-b border-[#252d3c] overflow-hidden">
        <canvas
          ref={masterCanvasRef}
          onClick={handleMasterWaveformClick}
          className="w-full h-full block cursor-pointer"
        />

        {project ? (
          <>
            {/* Top-left Song Title & Duration Overlay */}
            <div className="absolute top-3 left-4 pointer-events-none flex items-baseline gap-2.5">
              <span className="font-display text-base font-bold text-white drop-shadow">
                {project.title}
              </span>
              <span className="font-mono text-sm font-semibold text-slate-200/90">
                {formatMmSs(totalDurationSec)}
              </span>
            </div>

            {/* Mounting in RAM Progress Overlay Banner */}
            {transport.isMountingSong && (
              <div className="absolute inset-0 bg-slate-950/75 backdrop-blur-xs flex flex-col items-center justify-center p-4 text-center z-20">
                <div className="px-4 py-2.5 rounded-xl bg-[#151a24] border border-amber-500/50 text-amber-300 text-sm font-bold shadow-xl">
                  {transport.mountingProgressText || 'Cargando pistas en RAM...'}
                </div>
              </div>
            )}
          </>
        ) : (
          /* Clean Empty State when no song is loaded on startup */
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
            <Music className="w-8 h-8 text-[#2fd0c8] mb-2 opacity-80" />
            <h3 className="font-display text-base font-bold text-slate-100">
              Ninguna canción cargada en consola
            </h3>
            <p className="text-xs text-slate-200/80 max-w-lg mt-1">
              Haz clic en una canción de tu <strong>Repertorio</strong> izquierdo, arrástrala hacia aquí o pulsa <strong>+ Nueva canción</strong> arriba.
            </p>
          </div>
        )}
      </div>

      {/* 3. MAIN SETLIST PERFORMANCE DECK: LARGE SECTION PADS + QUICK TRACK MUTE/SOLO */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {project ? (
          <>
            {/* 3A. LARGE SECTION JUMP PADS */}
            <div className="bg-[#12161f] border border-[#252d3c] rounded-xl p-3.5">
              <div className="flex items-center justify-between gap-2 mb-2.5">
                <div className="flex items-center gap-2">
                  <Flag className="w-4 h-4 text-cyan-400" />
                  <h3 className="font-display text-sm font-bold text-slate-100">
                    Secciones de la Canción ({project.sections.length})
                  </h3>
                  {activeSection && (
                    <span className="px-2 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold">
                      Actual: {activeSection.name}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onAddMarkerAtPlayhead}
                    className="px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    <span>+ Marcar aquí ({formatMmSs(transport.currentTimeSec)})</span>
                  </button>
                  <button
                    type="button"
                    onClick={onOpenSectionEditor}
                    className="px-3 py-1.5 rounded-lg bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-slate-200 text-xs font-semibold cursor-pointer"
                  >
                    Editar secciones (mm:ss)...
                  </button>
                </div>
              </div>

              {project.sections.length === 0 ? (
                <div className="py-3 px-4 rounded-lg bg-[#0e1118] border border-slate-800/80 text-xs text-slate-300 flex items-center justify-between">
                  <span>
                    Esta canción aún no tiene secciones marcadas. Pulsa <strong>+ Marcar aquí</strong> mientras reproduces para dividirla en Intro, Verso, Coro, Puente, etc.
                  </span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {project.sections.map((sec, idx) => {
                    const isActive = sec.id === transport.activeSectionId;
                    const isQueued = sec.id === transport.queuedSectionId;
                    const isVampHere = isActive && transport.isVamping;

                    return (
                      <button
                        key={sec.id}
                        type="button"
                        onClick={() => onJumpSection(sec.id)}
                        className={`min-h-[42px] px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 border transition-all cursor-pointer ${
                          isQueued
                            ? 'bg-amber-500/25 border-amber-400 text-amber-200 shadow-[0_0_12px_rgba(245,158,11,0.25)]'
                            : isActive
                            ? 'bg-emerald-500 text-slate-950 border-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                            : 'bg-[#171d29] hover:bg-slate-800 border-[#252d3c] text-slate-100'
                        }`}
                      >
                        <span className="font-mono text-xs opacity-75">{idx + 1}.</span>
                        <span
                          style={{ backgroundColor: sec.color }}
                          className="w-3 h-3 rounded-full shrink-0"
                        />
                        <span>{sec.name}</span>
                        <span className="font-mono text-xs opacity-80">
                          {formatMmSs(sec.startTimeSec)}
                        </span>
                        {isVampHere && <Repeat className="w-3.5 h-3.5" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 3B. QUICK TRACK MUTE / SOLO GRID + FLOATING MIXER LAUNCHER */}
            <div className="bg-[#12161f] border border-[#252d3c] rounded-xl p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-3">
                  <span className="px-3 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/50 text-emerald-300 text-sm font-bold">
                    Pistas ({project.tracks.length})
                  </span>
                  <div className="flex items-center gap-2 text-sm font-mono tabular-nums text-[#e9ecf2]">
                    <span className="text-slate-400 text-xs">Compás</span>
                    <span className="font-bold text-cyan-300 text-base">
                      {String(transport.currentBar).padStart(3, '0')}
                    </span>
                    <span className="text-slate-600">·</span>
                    <span className="text-xs font-sans font-semibold text-slate-300">
                      {activeSection ? activeSection.name : 'Listo'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Prominent Button to Open the Floating Mixer Card */}
                  <button
                    type="button"
                    onClick={() => setIsFloatingMixerOpen(true)}
                    className="h-9 px-3.5 rounded-lg bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-bold flex items-center gap-2 shadow-md cursor-pointer transition-all"
                  >
                    <Sliders className="w-4 h-4" />
                    <span>Abrir Consola Mixer</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => addAudioInputRef.current?.click()}
                    className="h-9 px-3 rounded-lg bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-xs font-semibold text-slate-200 flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Añadir audio...</span>
                  </button>

                  <input
                    ref={addAudioInputRef}
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

                  {isFilterOpen ? (
                    <div className="flex items-center gap-1.5 bg-[#171d29] border border-emerald-500/50 rounded-lg px-2.5 h-9">
                      <Filter className="w-3.5 h-3.5 text-emerald-400" />
                      <input
                        type="search"
                        value={trackFilterText}
                        onChange={(e) => setTrackFilterText(e.target.value)}
                        placeholder="Filtrar canal..."
                        className="w-32 bg-transparent text-xs text-slate-100 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setTrackFilterText('');
                          setIsFilterOpen(false);
                        }}
                        className="text-slate-400 hover:text-white cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsFilterOpen(true)}
                      className="h-9 px-3 rounded-lg bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-xs font-semibold text-slate-200 flex items-center gap-1.5 cursor-pointer"
                    >
                      <Filter className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Filtrar</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={onResetMixer}
                    title="Restablecer mezcla a 0.0 dB"
                    className="h-9 px-3 rounded-lg bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-xs font-semibold text-slate-300 hover:text-white flex items-center gap-1.5 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>0 dB</span>
                  </button>
                </div>
              </div>

              {/* Quick Track Cards Grid (Large legible names + Mute/Solo + Quick Volume) */}
              {filteredProjectForMixer && filteredProjectForMixer.tracks.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
                  {filteredProjectForMixer.tracks.map((track: TrackChannel) => {
                    const isAudible = anySolo ? track.soloed && !track.muted : !track.muted;
                    const meter = meters[track.id] || { rms: 0, peak: 0, clipping: false };

                    return (
                      <div
                        key={track.id}
                        className={`rounded-xl border p-3 bg-[#171d29] flex flex-col justify-between gap-2.5 transition-all ${
                          isAudible
                            ? 'border-[#252d3c] hover:border-slate-600'
                            : 'border-slate-800/80 opacity-50'
                        }`}
                      >
                        {/* Top color bar + Full Track Name + Bus Badge */}
                        <div>
                          <div
                            style={{ backgroundColor: track.color }}
                            className="h-1 w-full rounded-full mb-2"
                          />
                          <div className="flex items-center justify-between gap-1.5">
                            <span
                              className="text-[13px] font-bold text-slate-100 truncate"
                              title={track.name}
                            >
                              {track.name}
                            </span>
                            <span className="font-mono text-[11px] font-semibold text-slate-300 shrink-0">
                              {formatTrackDb(track.gain)}
                            </span>
                          </div>
                        </div>

                        {/* Quick Volume Slider + Mute & Solo Buttons */}
                        <div className="flex items-center justify-between gap-2">
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
                            className="flex-1 min-w-0 accent-cyan-400 h-1.5 bg-slate-900 rounded-lg cursor-pointer"
                          />

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => onToggleTrackMute(track.id)}
                              className={`w-7 h-7 rounded-md text-xs font-bold transition-colors cursor-pointer border ${
                                track.muted
                                  ? 'bg-[#ff5a50] border-[#ff5a50] text-white'
                                  : 'bg-[#12161f] border-[#252d3c] text-slate-200 hover:border-slate-500'
                              }`}
                            >
                              M
                            </button>
                            <button
                              type="button"
                              onClick={() => onToggleTrackSolo(track.id)}
                              className={`w-7 h-7 rounded-md text-xs font-bold transition-colors cursor-pointer border ${
                                track.soloed
                                  ? 'bg-[#ffc233] border-[#ffc233] text-slate-950'
                                  : 'bg-[#12161f] border-[#252d3c] text-slate-200 hover:border-slate-500'
                              }`}
                            >
                              S
                            </button>
                          </div>
                        </div>

                        {/* Live Level Meter Bar */}
                        <div className="w-full h-1.5 bg-[#0a0d13] rounded-full overflow-hidden">
                          <div
                            style={{
                              width: `${Math.min(100, (isAudible && transport.isPlaying ? meter.rms : 0) * 100)}%`,
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
                    );
                  })}
                </div>
              ) : (
                <div className="py-6 text-center text-xs text-slate-400">
                  No hay pistas que coincidan con el filtro actual.
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>

      {/* 4. FLOATING MIXER CARD MODAL / DRAWER (Opens on demand, closes with 1 click or Esc) */}
      {isFloatingMixerOpen && filteredProjectForMixer && (
        <div
          onClick={() => setIsFloatingMixerOpen(false)}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-end justify-center p-3 sm:p-5"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Consola Mixer Flotante"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[1440px] bg-[#12161f] border-2 border-cyan-500/50 rounded-2xl shadow-[0_24px_70px_rgba(0,0,0,0.9)] overflow-hidden flex flex-col max-h-[86vh]"
          >
            {/* Floating Card Header with Intuitive Close Button */}
            <div className="px-5 py-3 bg-[#151a24] border-b border-[#252d3c] flex items-center justify-between gap-4 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center text-cyan-300">
                  <Sliders className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-display text-base font-bold text-white">
                      Consola Mixer — {filteredProjectForMixer.title}
                    </h2>
                    <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-xs font-bold">
                      Compás {String(transport.currentBar).padStart(3, '0')}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400">
                    Doble clic en fader = 0.0 dB · Doble clic en knob = Centrar (C) · Pulsa Esc o fuera de la tarjeta para cerrar
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={onResetMixer}
                  className="h-9 px-3.5 rounded-lg bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-xs font-semibold text-slate-200 flex items-center gap-1.5 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Restablecer mezcla a 0 dB</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsFloatingMixerOpen(false)}
                  className="h-9 px-4 rounded-lg bg-rose-500 hover:bg-rose-400 text-white text-xs font-bold flex items-center gap-1.5 shadow-md cursor-pointer transition-colors"
                >
                  <X className="w-4 h-4 stroke-[2.5]" />
                  <span>Cerrar Mixer</span>
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
                onToggleClick={onToggleClick}
                onChangeGuideGain={onChangeGuideGain}
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
        <div className="fixed bottom-4 right-4 z-40 bg-[#151a24] border border-[#252d3c] text-slate-200 px-3 py-1.5 rounded-lg text-xs font-mono shadow-lg">
          {cursorNotice}
        </div>
      )}
    </div>
  );
};
