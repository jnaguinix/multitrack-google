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
} from 'lucide-react';
import {
  MetersSnapshot,
  OutputBus,
  QuantizeMode,
  SetlistTransitionMode,
  SongProject,
  TransportState,
} from '../types/project';
import { audioEngine } from '../audio/audioEngine';
import { extractAudioFilesFromDataTransfer } from '../utils/fileImportHelper';
import { formatMmSs, formatTimecode } from './TransportDeck';
import { MultitrackMixer } from './MultitrackMixer';

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

  const masterCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const addAudioInputRef = useRef<HTMLInputElement | null>(null);
  const newSongFolderInputRef = useRef<HTMLInputElement | null>(null);
  const newSongFilesInputRef = useRef<HTMLInputElement | null>(null);

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
    const numBuckets = 360;
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
        ctx.fillStyle = 'rgba(47, 208, 200, 0.10)';
        ctx.fillRect(startX, 0, Math.max(2, endX - startX), height);
      } else if (isQueued) {
        ctx.fillStyle = 'rgba(255, 194, 51, 0.12)';
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
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
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
    ctx.lineWidth = 2;
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

  // Filtered project for the Mixer if user typed a filter query
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

  return (
    <div className="flex-1 flex flex-col bg-[#0e1118] text-[#e9ecf2] overflow-hidden select-none">
      {/* 1. COMPACT HORIZONTAL SETLIST SONG CARDS ROW ([1] -> [2] -> [+ Nueva canción]) */}
      <div className="bg-[#0e1118] px-2.5 py-1.5 flex items-center justify-between gap-2 border-b border-[#252d3c] shrink-0">
        <div className="flex items-center gap-1.5 overflow-x-auto">
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
                  className={`relative w-46 h-12 rounded-lg px-2 py-1 flex flex-col justify-between shrink-0 border transition-all cursor-pointer ${
                    dragOverCardIdx === idx
                      ? 'border-amber-400 bg-amber-500/20'
                      : isCurrent
                      ? 'border-[#2fd0c8] bg-[#162929] shadow-[0_0_0_1px_rgba(47,208,200,0.3)]'
                      : 'border-[#252d3c] bg-[#161c24] hover:border-slate-600'
                  }`}
                >
                  {/* Row 1: Grip + Index Badge + Song Title + Play + Menu */}
                  <div className="flex items-center justify-between gap-1 min-w-0">
                    <div className="flex items-center gap-1 min-w-0 flex-1">
                      <GripHorizontal className="w-3 h-3 text-[#7f8899] cursor-grab shrink-0" />
                      <span className="px-1 rounded bg-black/50 text-[9px] font-mono font-bold text-slate-300 shrink-0">
                        {idx + 1}
                      </span>
                      <span
                        className="text-[11px] font-bold text-[#e9ecf2] truncate"
                        title={song.title}
                      >
                        {song.title}
                      </span>
                    </div>

                    <div className="flex items-center gap-0.5 shrink-0">
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
                        className="w-5 h-5 rounded bg-[#0c1414] hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/40 flex items-center justify-center cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-wait"
                      >
                        {isPlayingThis ? (
                          <Pause className="w-2.5 h-2.5 fill-current" />
                        ) : (
                          <Play className="w-2.5 h-2.5 fill-current" />
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
                        className="w-5 h-5 rounded bg-[#0c1414] hover:bg-slate-800 text-slate-300 flex items-center justify-center cursor-pointer"
                      >
                        <MoreHorizontal className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* Row 2: BPM + Duration + RAM Status + PCM/Opt Badge */}
                  <div className="flex items-center justify-between gap-1 text-[9px] font-mono">
                    <span className="text-[#7f8899] truncate">
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
                          className={`px-1 rounded text-[8px] font-mono font-semibold tracking-tight ${
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
                          className="px-1 rounded text-[8px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
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
                            className="px-1 rounded text-[8px] font-mono font-bold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 cursor-pointer flex items-center gap-0.5"
                          >
                            <Zap className="w-2 h-2 text-amber-400" />
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
                      className="absolute top-11 right-1 z-30 w-40 bg-[#151a24] border border-[#252d3c] rounded-lg shadow-xl p-1 text-xs space-y-0.5"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onLoadAndPlaySong(song.id, false);
                          setOpenCardMenuId(null);
                        }}
                        className="w-full px-2 py-1 text-left rounded hover:bg-slate-800 text-cyan-300 font-semibold cursor-pointer"
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
                          className="w-full px-2 py-1 text-left rounded hover:bg-slate-800 text-amber-300 flex items-center gap-1.5 cursor-pointer font-medium"
                        >
                          <Zap className="w-3 h-3 text-amber-400" /> Optimizar (OPFS)
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => {
                          onMoveInSetlist(song.id, 'up');
                          setOpenCardMenuId(null);
                        }}
                        className="w-full px-2 py-1 text-left rounded hover:bg-slate-800 text-slate-300 flex items-center gap-1.5 disabled:opacity-30 cursor-pointer"
                      >
                        <ChevronLeft className="w-3 h-3" /> Mover antes
                      </button>
                      <button
                        type="button"
                        disabled={idx === setlistQueue.length - 1}
                        onClick={() => {
                          onMoveInSetlist(song.id, 'down');
                          setOpenCardMenuId(null);
                        }}
                        className="w-full px-2 py-1 text-left rounded hover:bg-slate-800 text-slate-300 flex items-center gap-1.5 disabled:opacity-30 cursor-pointer"
                      >
                        <ChevronRight className="w-3 h-3" /> Mover después
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onRemoveFromSetlist(song.id);
                          setOpenCardMenuId(null);
                        }}
                        className="w-full px-2 py-1 text-left rounded hover:bg-red-500/20 text-red-400 flex items-center gap-1.5 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" /> Quitar del Setlist
                      </button>
                    </div>
                  )}
                </div>

                <ArrowRight className="w-3 h-3 text-[#7f8899] shrink-0" />
              </React.Fragment>
            );
          })}

          {/* "+ Nueva canción" Compact Dashed Tile */}
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
            className="relative h-12 px-2.5 rounded-lg border border-dashed border-[#252d3c] hover:border-[#2fd0c8] bg-[#12161f]/60 flex items-center justify-center gap-1.5 shrink-0 transition-colors"
          >
            <button
              type="button"
              onClick={() => setIsNewSongDropdownOpen((prev) => !prev)}
              className="px-1.5 py-1 text-[11px] font-semibold text-[#e9ecf2] hover:text-[#2fd0c8] flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nueva canción</span>
            </button>

            <button
              type="button"
              onClick={() => newSongFolderInputRef.current?.click()}
              title="Importar carpeta de stems al Setlist"
              className="p-1.5 rounded bg-[#171d29] hover:bg-slate-800 text-slate-300 border border-[#252d3c] cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>

            {/* Dropdown to pick from existing Repertoire or Import */}
            {isNewSongDropdownOpen && (
              <div className="absolute top-13 left-0 z-40 w-60 bg-[#151a24] border border-[#252d3c] rounded-xl shadow-2xl p-2 space-y-1.5">
                <div className="flex items-center justify-between px-2 py-1 border-b border-[#252d3c]">
                  <span className="text-[11px] font-bold text-slate-300">
                    Añadir al Setlist
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsNewSongDropdownOpen(false)}
                    className="text-slate-400 hover:text-white cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {allProjects.length > 0 && (
                  <div className="max-h-36 overflow-y-auto space-y-0.5">
                    <div className="px-2 py-0.5 text-[10px] text-[#7f8899] uppercase">
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
                        className="w-full px-2 py-1 rounded hover:bg-slate-800 text-left text-xs text-slate-200 flex items-center justify-between cursor-pointer"
                      >
                        <span className="truncate">{repSong.title}</span>
                        <span className="text-[10px] font-mono text-cyan-400 ml-2 shrink-0">
                          + Añadir
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="pt-1 border-t border-[#252d3c] flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setIsNewSongDropdownOpen(false);
                      newSongFilesInputRef.current?.click();
                    }}
                    className="w-full px-2 py-1.5 rounded bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 text-xs font-semibold flex items-center gap-2 cursor-pointer"
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
                    className="w-full px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-2 cursor-pointer"
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

        {/* Right Actions on Song Cards Row: Telemetry + "+ Marcar" & "Editar" */}
        <div className="flex items-center gap-2 shrink-0">
          {project && (
            <span className="hidden lg:inline font-mono text-[10px] text-[#7f8899]">
              {project.tracks.length} PISTAS · {project.sections.length} MARCAS
            </span>
          )}
          <button
            type="button"
            disabled={!project}
            onClick={onAddMarkerAtPlayhead}
            className="h-7 px-2.5 rounded bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-[11px] font-medium text-cyan-300 flex items-center gap-1 disabled:opacity-40 cursor-pointer"
          >
            <Flag className="w-3 h-3" />
            <span>+ Marcar ({formatMmSs(transport.currentTimeSec)})</span>
          </button>

          <button
            type="button"
            disabled={!project}
            onClick={onOpenSectionEditor}
            className="h-7 px-2.5 rounded bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-[11px] font-medium text-[#e9ecf2] flex items-center gap-1 disabled:opacity-40 cursor-pointer"
          >
            <Edit3 className="w-3 h-3" />
            <span>Editar</span>
          </button>
        </div>
      </div>

      {/* 2. COMPACT MASTER WAVEFORM OVERVIEW (80px height so Mixer fits in full below) */}
      <div className="relative h-20 shrink-0 bg-[#263030] border-b border-[#252d3c] overflow-hidden">
        <canvas
          ref={masterCanvasRef}
          onClick={handleMasterWaveformClick}
          className="w-full h-full block cursor-pointer"
        />

        {project ? (
          <>
            {/* Top-left Song Title, Duration & Inline Section Jump Pills */}
            <div className="absolute top-1.5 left-3 right-3 flex items-center justify-between gap-2 pointer-events-none">
              <div className="flex items-center gap-2 min-w-0 overflow-x-auto pointer-events-auto">
                <span className="font-display text-xs font-bold text-white drop-shadow shrink-0">
                  {project.title}
                </span>
                <span className="font-mono text-[10px] text-slate-300/80 shrink-0">
                  {formatMmSs(totalDurationSec)}
                </span>

                {project.sections.length > 0 && (
                  <div className="flex items-center gap-1 ml-1">
                    {project.sections.map((sec) => {
                      const isActive = sec.id === transport.activeSectionId;
                      return (
                        <button
                          key={sec.id}
                          type="button"
                          onClick={() => onJumpSection(sec.id)}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 border cursor-pointer shrink-0 ${
                            isActive
                              ? 'bg-emerald-500 text-slate-950 border-emerald-300'
                              : 'bg-black/55 text-slate-200 border-white/15 hover:bg-black/80'
                          }`}
                        >
                          <span
                            style={{ backgroundColor: sec.color }}
                            className="w-1.5 h-1.5 rounded-full"
                          />
                          <span>{sec.name}</span>
                          <span className="font-mono text-[9px] opacity-80">
                            {formatMmSs(sec.startTimeSec)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={onOpenSectionEditor}
                className="pointer-events-auto px-2 py-0.5 rounded bg-[#151a24]/90 hover:bg-[#151a24] border border-[#252d3c] text-[10px] font-medium text-slate-200 cursor-pointer shrink-0"
              >
                Secciones ({project.sections.length})
              </button>
            </div>

            {/* Mounting in RAM Progress Overlay Banner */}
            {transport.isMountingSong && (
              <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-2 text-center z-20">
                <div className="px-3 py-1.5 rounded-lg bg-[#151a24] border border-amber-500/50 text-amber-300 text-xs font-semibold shadow-xl">
                  {transport.mountingProgressText || 'Cargando pistas en RAM...'}
                </div>
              </div>
            )}
          </>
        ) : (
          /* Clean Empty State when no song is loaded on startup */
          <div className="absolute inset-0 flex items-center justify-center gap-3 px-4 text-center">
            <Music className="w-5 h-5 text-[#2fd0c8] opacity-80 shrink-0" />
            <div className="text-left">
              <h3 className="font-display text-xs font-bold text-slate-100">
                Ninguna canción cargada en consola
              </h3>
              <p className="text-[11px] text-slate-300/80">
                Haz clic en una canción del <strong>Repertorio</strong> izquierdo, arrástrala aquí o pulsa <strong>+ Nueva canción</strong>.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* 3. UNIFIED PISTAS & MIXER TOOLBAR (Merged header to save vertical space) */}
      <div className="bg-[#12161f] border-b border-[#252d3c] px-3 py-1 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/50 text-emerald-300 text-[11px] font-semibold">
            Pistas ({project ? project.tracks.length : 0})
          </span>

          {project && (
            <div className="flex items-center gap-1.5 text-xs font-mono tabular-nums text-[#e9ecf2]">
              <span className="text-slate-500 text-[10px]">Compás</span>
              <span className="font-bold text-cyan-300">
                {String(transport.currentBar).padStart(3, '0')}
              </span>
              <span className="text-slate-600">·</span>
              <span className="text-[11px] font-sans font-medium text-[#7f8899]">
                {activeSection ? activeSection.name : 'Listo'}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!project}
            onClick={() => addAudioInputRef.current?.click()}
            className="h-6 px-2 rounded bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-[11px] font-medium text-slate-200 flex items-center gap-1 disabled:opacity-40 cursor-pointer"
          >
            <Plus className="w-3 h-3" />
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
            <div className="flex items-center gap-1 bg-[#171d29] border border-emerald-500/50 rounded px-2 h-6">
              <Filter className="w-3 h-3 text-emerald-400" />
              <input
                type="search"
                value={trackFilterText}
                onChange={(e) => setTrackFilterText(e.target.value)}
                placeholder="Filtrar canal..."
                className="w-28 bg-transparent text-[11px] text-slate-100 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  setTrackFilterText('');
                  setIsFilterOpen(false);
                }}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!project}
              onClick={() => setIsFilterOpen(true)}
              className="h-6 px-2 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/50 text-emerald-300 text-[11px] font-medium flex items-center gap-1 disabled:opacity-40 cursor-pointer"
            >
              <Filter className="w-3 h-3" />
              <span>Filtrar pistas</span>
            </button>
          )}

          <button
            type="button"
            disabled={!project}
            onClick={onResetMixer}
            title="Restablecer todos los faders a 0.0 dB y paneos al centro"
            className="h-6 px-2 rounded bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-[11px] font-medium text-[#7f8899] hover:text-[#e9ecf2] flex items-center gap-1 disabled:opacity-40 cursor-pointer"
          >
            <RotateCcw className="w-2.5 h-2.5" />
            <span>0 dB</span>
          </button>
        </div>
      </div>

      {/* 4. BOTTOM ZONE: FULL COMPACT STUDIO MIXER (FITS COMPLETELY ON LAPTOP SCREEN) */}
      <div className="flex-1 overflow-y-auto relative">
        {filteredProjectForMixer ? (
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
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-[#7f8899] p-6">
            Selecciona o confirma una canción para ver sus canales en el Mixer.
          </div>
        )}

        {cursorNotice && (
          <div className="fixed bottom-3 right-3 z-40 bg-[#151a24] border border-[#252d3c] text-slate-300 px-2.5 py-1 rounded text-[10px] font-mono shadow-lg">
            {cursorNotice}
          </div>
        )}
      </div>
    </div>
  );
};
