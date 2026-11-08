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
  Repeat,
  Zap,
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
  onAddStemsToCurrentSong: (files: FileList) => void;
  onQuickImportNewSongFiles: (files: FileList) => void;
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
  setlistTransitionMode,
  metersRef,
  onPlayPause,
  onToggleVamp,
  onLoadAndPlaySong,
  onRequestSongAction,
  onAddToSetlist,
  onRemoveFromSetlist,
  onMoveInSetlist,
  onReorderSetlist,
  onOptimizeProject,
  onChangeSetlistTransitionMode,
  onChangeQuantize,
  onChangePitch,
  onChangeBpm,
  onSeekSeconds,
  onJumpSection,
  onCancelQueuedJump,
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

  // Draw the Master Overview Waveform Canvas (matching the LibreTracks Setlist screenshot)
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

    // Background fill matching the dark studio slate in the screenshot
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

    // Draw dense vertical waveform spikes like LibreTracks
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

  return (
    <div className="flex-1 flex flex-col bg-[#0e1118] text-[#e9ecf2] overflow-hidden select-none">
      {/* 1. TOP SETLIST PERFORMANCE BAR (Matching LibreTracks Screenshot) */}
      <div className="bg-[#12161f] border-b border-[#252d3c] px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          {/* SETLIST Badge */}
          <div className="flex items-center gap-1 bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 px-2.5 py-1.5 rounded font-semibold">
            <span>SETLIST</span>
          </div>

          {/* MODO VAMP Box */}
          <div className="flex items-center gap-2 bg-[#171d29] border border-[#252d3c] rounded px-2.5 py-1">
            <div>
              <div className="text-[9px] uppercase tracking-wider text-[#7f8899]">
                MODO VAMP
              </div>
              <div className="text-[11px] font-medium text-[#e9ecf2]">
                Cualquier marca
              </div>
            </div>
            <button
              type="button"
              disabled={!project}
              onClick={onToggleVamp}
              className={`px-2 py-1 rounded text-[10px] font-bold flex items-center gap-1 border cursor-pointer disabled:opacity-40 ${
                transport.isVamping
                  ? 'bg-amber-500 text-slate-950 border-amber-400'
                  : 'bg-[#262015] text-amber-300 border-amber-500/40 hover:bg-amber-500/20'
              }`}
            >
              <Repeat className="w-3 h-3" />
              <span>VAMP</span>
            </button>
          </div>

          {/* SALTO DE MARCA Box */}
          <div className="bg-[#171d29] border border-[#252d3c] rounded px-2.5 py-1">
            <div className="text-[9px] uppercase tracking-wider text-[#7f8899]">
              SALTO DE MARCA
            </div>
            <select
              disabled={!project}
              value={project?.quantizeMode || 'immediate'}
              onChange={(e) => onChangeQuantize(e.target.value as QuantizeMode)}
              className="bg-transparent text-[11px] font-medium text-[#e9ecf2] focus:outline-none cursor-pointer disabled:opacity-40"
            >
              <option value="immediate" className="bg-[#171d29]">
                Inmediato
              </option>
              <option value="section-end" className="bg-[#171d29]">
                Siguiente sección
              </option>
              <option value="1-bar" className="bg-[#171d29]">
                Al compás (1 Bar)
              </option>
            </select>
          </div>

          {/* TRANSICIÓN DE CANCIÓN Box */}
          <div className="bg-[#171d29] border border-[#252d3c] rounded px-2.5 py-1">
            <div className="text-[9px] uppercase tracking-wider text-[#7f8899]">
              TRANSICIÓN DE CANCIÓN
            </div>
            <select
              value={setlistTransitionMode}
              onChange={(e) =>
                onChangeSetlistTransitionMode(
                  e.target.value as SetlistTransitionMode
                )
              }
              className="bg-transparent text-[11px] font-medium text-[#e9ecf2] focus:outline-none cursor-pointer"
            >
              <option value="auto-play" className="bg-[#171d29]">
                Inmediato / Corte limpio
              </option>
              <option value="cue-next" className="bg-[#171d29]">
                Preparar siguiente (00:00)
              </option>
              <option value="stop" className="bg-[#171d29]">
                Parar al terminar
              </option>
            </select>
          </div>

          {/* TRANSPOSICIÓN DE REGIÓN Box */}
          <div className="bg-[#171d29] border border-[#252d3c] rounded px-2.5 py-1">
            <div className="text-[9px] uppercase tracking-wider text-[#7f8899]">
              TRANSPOSICIÓN DE REGIÓN
            </div>
            <select
              disabled={!project}
              value={project?.pitchSemitones ?? 0}
              onChange={(e) => onChangePitch(Number(e.target.value))}
              className="bg-transparent text-[11px] font-mono font-medium text-[#e9ecf2] focus:outline-none cursor-pointer disabled:opacity-40"
            >
              {[-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].map((st) => (
                <option key={st} value={st} className="bg-[#171d29]">
                  {st > 0 ? `+${st} st` : `${st} st`}
                </option>
              ))}
            </select>
          </div>

          {/* TEMPO Box */}
          <div className="bg-[#171d29] border border-[#252d3c] rounded px-2.5 py-1">
            <div className="text-[9px] uppercase tracking-wider text-[#7f8899]">
              TEMPO
            </div>
            <div className="flex items-center gap-1">
              <input
                type="number"
                disabled={!project}
                min={50}
                max={220}
                value={project?.bpm ?? 120}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 50 && v <= 220) onChangeBpm(v);
                }}
                className="w-11 bg-transparent text-[11px] font-mono font-semibold text-[#e9ecf2] focus:outline-none disabled:opacity-40"
              />
              <span className="text-[10px] text-[#7f8899] font-mono">BPM</span>
            </div>
          </div>

          {/* CANCELAR SALTO Button */}
          <button
            type="button"
            disabled={!transport.queuedSectionId}
            onClick={onCancelQueuedJump}
            className="px-2.5 py-1.5 rounded text-[10px] font-mono uppercase tracking-wider text-[#7f8899] hover:text-white disabled:opacity-35 cursor-pointer flex items-center gap-1"
          >
            <X className="w-3 h-3" />
            <span>CANCELAR SALTO</span>
          </button>
        </div>

        {/* Right Telemetry: TRACKS · CLIPS · MARCAS */}
        <div className="flex items-center gap-3 font-mono text-[10px] text-[#7f8899] pr-1">
          <span>{project ? project.tracks.length : 0} TRACKS</span>
          <span>{project ? project.tracks.length : 0} CLIPS</span>
          <span>{project ? project.sections.length : 0} MARCAS</span>
        </div>
      </div>

      {/* 2. HORIZONTAL SETLIST SONG CARDS ROW ([1] -> [2] -> [+ Nueva canción]) */}
      <div className="bg-[#0e1118] px-3 py-2.5 flex items-center justify-between gap-4 border-b border-[#252d3c]">
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
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
                  className={`relative w-44 h-27 rounded-lg p-2.5 flex flex-col justify-between shrink-0 border transition-all cursor-pointer ${
                    dragOverCardIdx === idx
                      ? 'border-amber-400 bg-amber-500/20'
                      : isCurrent
                      ? 'border-[#2fd0c8] bg-[#162929] shadow-[0_0_0_1px_rgba(47,208,200,0.3)]'
                      : 'border-[#252d3c] bg-[#161c24] hover:border-slate-600'
                  }`}
                >
                  {/* Card Top: Grip + RAM Status Badge + OPFS PCM Status + Play Button + Menu */}
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1 min-w-0 overflow-hidden">
                      <GripHorizontal className="w-3.5 h-3.5 text-[#7f8899] cursor-grab shrink-0" />
                      {cacheInfo.totalCount > 0 && (
                        <span
                          title={
                            cacheInfo.isReady
                              ? `100% en caché RAM (${cacheInfo.cachedCount}/${cacheInfo.totalCount} pistas · ${((cacheInfo.cachedBytes || 0) / (1024 * 1024)).toFixed(0)} MB) — Cambio instantáneo (0 ms)`
                              : cacheInfo.skippedByRamBudget
                              ? `No precargada en segundo plano para proteger el presupuesto de RAM (estimado ~${((cacheInfo.estimatedBytes || 0) / (1024 * 1024)).toFixed(0)} MB; límite actual: ${audioEngine.getRamBudgetMB()} MB)`
                              : cacheInfo.isPreloading
                              ? `Precargando pistas en RAM en segundo plano (${cacheInfo.cachedCount}/${cacheInfo.totalCount})...`
                              : `${cacheInfo.cachedCount}/${cacheInfo.totalCount} pistas en RAM`
                          }
                          className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold tracking-tight truncate ${
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
                            ? `● RAM (${Math.round((cacheInfo.cachedBytes || 0) / (1024 * 1024))}M)`
                            : cacheInfo.skippedByRamBudget
                            ? 'No precargada (RAM)'
                            : `◐ ${cacheInfo.cachedCount}/${cacheInfo.totalCount}`}
                        </span>
                      )}

                      {/* OPFS PCM Indicator */}
                      {isPcmReady ? (
                        <span
                          title={`Audio PCM Int16 optimizado en OPFS (~${pcmMB} MB en disco)`}
                          className="px-1 py-0.2 rounded text-[8px] font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shrink-0"
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
                            title="Optimizar canción para streaming OPFS (REAPER mode)"
                            className="px-1 py-0.2 rounded text-[8px] font-mono font-bold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 cursor-pointer flex items-center gap-0.5 shrink-0"
                          >
                            <Zap className="w-2.5 h-2.5 text-amber-400" />
                            <span>Opt</span>
                          </button>
                        )
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={Boolean(isCurrent && transport.isMountingSong)}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isCurrent) {
                            onPlayPause();
                          } else {
                            // Only start immediate playback if 100% of stems are already in RAM;
                            // otherwise mount in pause at 00:00 so it never starts playing unexpectedly later
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
                            : 'Montar en consola en 00:00 (esperar 100% RAM antes de sonar)'
                        }
                        className="w-6 h-6 rounded bg-[#0c1414] hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/40 flex items-center justify-center cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-wait"
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
                        className="w-6 h-6 rounded bg-[#0c1414] hover:bg-slate-800 text-slate-300 flex items-center justify-center cursor-pointer"
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Center Note Icon */}
                  <div className="flex items-center justify-center my-0.5">
                    <Music className="w-3.5 h-3.5 text-[#7f8899]" />
                  </div>

                  {/* Card Bottom: Index Badge + Title + BPM & Duration */}
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="px-1.5 py-0.2 rounded bg-black/50 text-[10px] font-mono font-bold text-slate-300">
                        {idx + 1}
                      </span>
                      <span
                        className="text-xs font-bold text-[#e9ecf2] truncate"
                        title={song.title}
                      >
                        {song.title}
                      </span>
                    </div>
                    <div className="text-[10px] font-mono text-[#7f8899] mt-0.5">
                      {song.bpm} BPM &nbsp;{formatMmSs(durSec)}
                    </div>
                  </div>

                  {/* Card Context Menu Popover */}
                  {openCardMenuId === song.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-9 right-2 z-30 w-40 bg-[#151a24] border border-[#252d3c] rounded-lg shadow-xl p-1 text-xs space-y-0.5"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onLoadAndPlaySong(song.id, false);
                          setOpenCardMenuId(null);
                        }}
                        className="w-full px-2.5 py-1.5 text-left rounded hover:bg-slate-800 text-cyan-300 font-semibold cursor-pointer"
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
                          className="w-full px-2.5 py-1.5 text-left rounded hover:bg-slate-800 text-amber-300 flex items-center gap-1.5 cursor-pointer font-medium"
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
                        className="w-full px-2.5 py-1.5 text-left rounded hover:bg-slate-800 text-slate-300 flex items-center gap-1.5 disabled:opacity-30 cursor-pointer"
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
                        className="w-full px-2.5 py-1.5 text-left rounded hover:bg-slate-800 text-slate-300 flex items-center gap-1.5 disabled:opacity-30 cursor-pointer"
                      >
                        <ChevronRight className="w-3.5 h-3.5" /> Mover después
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onRemoveFromSetlist(song.id);
                          setOpenCardMenuId(null);
                        }}
                        className="w-full px-2.5 py-1.5 text-left rounded hover:bg-red-500/20 text-red-400 flex items-center gap-1.5 cursor-pointer"
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

          {/* "+ Nueva canción" Dashed Card (Matching LibreTracks Screenshot) */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const songId = e.dataTransfer.getData(
                'application/x-libretracks-song-id'
              );
              if (songId) {
                onAddToSetlist(songId);
              } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                onQuickImportNewSongFiles(e.dataTransfer.files);
              }
            }}
            className="relative w-44 h-27 rounded-lg border border-dashed border-[#252d3c] hover:border-[#2fd0c8] bg-[#12161f]/60 flex items-center justify-center gap-2 shrink-0 transition-colors"
          >
            <button
              type="button"
              onClick={() => setIsNewSongDropdownOpen((prev) => !prev)}
              className="px-2.5 py-1.5 text-xs font-semibold text-[#e9ecf2] hover:text-[#2fd0c8] flex items-center gap-1.5 cursor-pointer"
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
              <div className="absolute top-28 left-0 z-40 w-64 bg-[#151a24] border border-[#252d3c] rounded-xl shadow-2xl p-2 space-y-1.5">
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
                  <div className="max-h-40 overflow-y-auto space-y-0.5">
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
                        className="w-full px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-left text-xs text-slate-200 flex items-center justify-between cursor-pointer"
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
              accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  onQuickImportNewSongFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
            <input
              ref={newSongFolderInputRef}
              type="file"
              multiple
              // @ts-expect-error webkitdirectory is standard
              webkitdirectory="true"
              directory="true"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  onQuickImportNewSongFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
          </div>
        </div>

        {/* Right Actions on Song Cards Row: "+ Marcar aquí" & "Editar" */}
        <div className="flex items-center gap-2 shrink-0 self-start">
          <button
            type="button"
            disabled={!project}
            onClick={onAddMarkerAtPlayhead}
            className="px-3 py-1.5 rounded-md bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-xs font-medium text-cyan-300 flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
          >
            <Flag className="w-3.5 h-3.5" />
            <span>+ Marcar ({formatMmSs(transport.currentTimeSec)})</span>
          </button>

          <button
            type="button"
            disabled={!project}
            onClick={onOpenSectionEditor}
            className="px-3 py-1.5 rounded-md bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-xs font-medium text-[#e9ecf2] flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>Editar</span>
          </button>
        </div>
      </div>

      {/* 3. CENTER UNIFIED MASTER WAVEFORM OVERVIEW (Matching LibreTracks Screenshot) */}
      <div className="relative h-48 shrink-0 bg-[#263030] border-b border-[#252d3c] overflow-hidden">
        <canvas
          ref={masterCanvasRef}
          onClick={handleMasterWaveformClick}
          className="w-full h-full block cursor-pointer"
        />

        {project ? (
          <>
            {/* Top-left Song Title & Duration Overlay */}
            <div className="absolute top-2.5 left-3.5 pointer-events-none flex items-baseline gap-2">
              <span className="font-display text-sm font-bold text-white drop-shadow">
                {project.title}
              </span>
              <span className="font-mono text-xs text-slate-300/80">
                {formatMmSs(totalDurationSec)}
              </span>
            </div>

            {/* Mounting in RAM Progress Overlay Banner */}
            {transport.isMountingSong && (
              <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs flex flex-col items-center justify-center p-4 text-center z-20">
                <div className="px-4 py-2.5 rounded-xl bg-[#151a24] border border-amber-500/50 text-amber-300 text-xs font-semibold shadow-xl">
                  {transport.mountingProgressText || 'Cargando pistas en RAM...'}
                </div>
                <span className="text-[11px] text-slate-300 mt-1.5">
                  Play está bloqueado hasta que el 100% de los instrumentos estén listos en RAM.
                </span>
              </div>
            )}

            {/* Section Markers Overlay Pills */}
            {project.sections.length > 0 && (
              <div className="absolute top-9 left-3.5 right-3.5 flex items-center gap-1.5 pointer-events-auto overflow-x-auto">
                {project.sections.map((sec) => {
                  const isActive = sec.id === transport.activeSectionId;
                  return (
                    <button
                      key={sec.id}
                      type="button"
                      onClick={() => onJumpSection(sec.id)}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold flex items-center gap-1 border cursor-pointer ${
                        isActive
                          ? 'bg-emerald-500 text-slate-950 border-emerald-300'
                          : 'bg-black/55 text-slate-200 border-white/15 hover:bg-black/80'
                      }`}
                    >
                      <span
                        style={{ backgroundColor: sec.color }}
                        className="w-2 h-2 rounded-full"
                      />
                      <span>{sec.name}</span>
                      <span className="font-mono text-[10px] opacity-80">
                        {formatMmSs(sec.startTimeSec)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Bottom-right Empty Sections Notice & Edit Button (Matching Screenshot) */}
            <div className="absolute bottom-2.5 right-3.5 flex items-center gap-2.5">
              {project.sections.length === 0 && (
                <span className="text-xs text-slate-300/80">
                  Esta canción no tiene secciones. Añádelas en Editar.
                </span>
              )}
              <button
                type="button"
                onClick={onOpenSectionEditor}
                className="px-3 py-1 rounded bg-[#151a24]/90 hover:bg-[#151a24] border border-[#252d3c] text-xs font-medium text-slate-200 cursor-pointer"
              >
                Editar secciones (mm:ss)...
              </button>
            </div>
          </>
        ) : (
          /* Clean Empty State when no song is loaded on startup */
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
            <Music className="w-8 h-8 text-[#2fd0c8] mb-2 opacity-80" />
            <h3 className="font-display text-sm font-bold text-slate-100">
              Ninguna canción cargada en consola
            </h3>
            <p className="text-xs text-slate-300/80 max-w-lg mt-1">
              No se autocarga ninguna canción al iniciar. Haz clic en una canción de tu{' '}
              <strong>Repertorio</strong> izquierdo, arrástrala hacia aquí o pulsa{' '}
              <strong>+ Nueva canción</strong> arriba.
            </p>
          </div>
        )}
      </div>

      {/* 4. SUB-TOOLBAR (Pistas | Añadir audio... | Filtrar pistas de la canción) */}
      <div className="bg-[#12161f] border-b border-[#252d3c] px-3.5 py-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="px-3 py-1 rounded bg-emerald-500/15 border border-emerald-500/50 text-emerald-300 text-xs font-semibold">
            Pistas ({project ? project.tracks.length : 0})
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!project}
            onClick={() => addAudioInputRef.current?.click()}
            className="px-3 py-1 rounded bg-[#171d29] hover:bg-slate-800 border border-[#252d3c] text-xs font-medium text-slate-200 flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Añadir audio...</span>
          </button>

          <input
            ref={addAudioInputRef}
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

          {isFilterOpen ? (
            <div className="flex items-center gap-1 bg-[#171d29] border border-emerald-500/50 rounded px-2 py-0.5">
              <Filter className="w-3 h-3 text-emerald-400" />
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
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!project}
              onClick={() => setIsFilterOpen(true)}
              className="px-3 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/50 text-emerald-300 text-xs font-medium flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>Filtrar pistas de la canción</span>
            </button>
          )}
        </div>
      </div>

      {/* 5. BOTTOM ZONE: OUR REDESIGNED DARK-MODE MIXER */}
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
          <div className="h-full flex items-center justify-center text-xs text-[#7f8899] p-8">
            Selecciona o confirma una canción para ver sus canales en el Mixer rediseñado.
          </div>
        )}

        {cursorNotice && (
          <div className="fixed bottom-4 right-4 z-40 bg-[#151a24] border border-[#252d3c] text-slate-300 px-3 py-1.5 rounded-lg text-[11px] font-mono shadow-lg">
            {cursorNotice}
          </div>
        )}
      </div>
    </div>
  );
};
