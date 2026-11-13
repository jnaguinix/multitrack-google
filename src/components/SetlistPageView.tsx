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
  Radio,
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
import { SongPickerModal } from './SongPickerModal';
import { SetlistStrip, SongTileStatus } from './SetlistStrip';
import { SECTION_TEMPLATES } from '../utils/sectionTemplates';
import { useSetlistMeta } from '../hooks/useSetlistMeta';

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
  /** Guarda las notas de una canción. */
  onUpdateSongNotes: (songId: string, notes: string) => void;
  /** Monta la primera canción del setlist y abre la página En vivo. */
  onStartLive: () => void;
  /** Qué hacer al terminar una canción (la flecha entre fichas); undefined = ajuste general. */
  onSetSongTransition: (songId: string, mode: SetlistTransitionMode | undefined) => void;
  /** Añade una sección de plantilla (Intro, Verso 1, Coro…) en la posición del cursor. */
  onAddSectionTemplate: (templateKey: string) => void;
}

function songDuration(song: SongProject): number {
  return song.durationSec || ((song.totalBars || 24) * 4 * 60) / (song.bpm || 120);
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
  allProjects,
  setlistQueue,
  transport,
  ramCacheVersion: _ramCacheVersion,
  setlistTransitionMode,
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
  onQuickImportNativeFolder,
  onQuickImportNativeFiles,
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
  onStartLive,
  onSetSongTransition,
  onAddSectionTemplate,
}) => {
  const [trackFilterText, setTrackFilterText] = useState('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [dragOverCardIdx, setDragOverCardIdx] = useState<number | null>(null);
  const [cursorNotice, setCursorNotice] = useState<string | null>(null);
  const [isFloatingMixerOpen, setIsFloatingMixerOpen] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isEditingStrip, setIsEditingStrip] = useState(false);
  const openPicker = () => setIsPickerOpen(true);
  const setlistIds = useMemo(() => new Set(setlistQueue.map((s) => s.id)), [setlistQueue]);

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
        ctx.globalAlpha = queued || section.id === activeSection?.id ? 0.34 : 0.2;
        ctx.fillRect(startX, 0, Math.max(0, endX - startX), height);
        ctx.globalAlpha = 0.6;
        ctx.fillRect(startX, 0, 1, height);
      }

      const barCount = Math.min(masterPeaks.length, Math.max(1, Math.floor(width / 4)));
      const stepX = width / Math.max(1, barCount);
      // Onda simétrica sobre el eje central, normalizada al pico más alto para que ocupe todo el alto
      // aunque la mezcla de varias pistas sea baja. Deja arriba una franja libre para los círculos.
      const top = 34;
      const bottom = height - 8;
      const centerY = (top + bottom) / 2;
      const halfMax = (bottom - top) / 2;
      let maxPeak = 0;
      for (let index = 0; index < masterPeaks.length; index++) maxPeak = Math.max(maxPeak, masterPeaks[index]);
      const norm = maxPeak > 0 ? 1 / maxPeak : 1;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.5, Math.min(3, stepX * 0.62));
      ctx.globalAlpha = 1;
      for (let i = 0; i < barCount; i++) {
        const first = Math.floor(i * masterPeaks.length / barCount);
        const last = Math.max(first + 1, Math.floor((i + 1) * masterPeaks.length / barCount));
        let peak = 0;
        for (let index = first; index < last; index++) peak = Math.max(peak, masterPeaks[index] ?? 0);
        const half = Math.max(1.5, Math.sqrt(peak * norm) * halfMax);
        const seconds = ((i + 0.5) / barCount) * totalDurationSec;
        const section = sections.find((item) => item.startTimeSec <= seconds && seconds < item.endTimeSec);
        const x = (i + 0.5) * stepX;
        ctx.strokeStyle = section?.color || '#8dd6cd';
        ctx.beginPath();
        ctx.moveTo(x, centerY - half);
        ctx.lineTo(x, centerY + half);
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
  const startOffsets = setlistQueue.reduce<number[]>((acc, song, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + songDuration(setlistQueue[i - 1]));
    return acc;
  }, []);
  const { meta: setlistMeta, setName: setSetlistName, setDate: setSetlistDate } = useSetlistMeta();
  const setlistTotalSec = setlistQueue.reduce((sum, song) => sum + songDuration(song), 0);

  /** Estado de la caché de audio de una canción, tal como lo muestra su ficha. */
  const statusOf = (song: SongProject): SongTileStatus => {
    const liveText = isDesktopApp() ? nativeAudioEngine.formatImportProgress(song.id) : null;
    if (isDesktopApp()) {
      if (liveText) return { text: liveText, tone: 'busy', title: `Generando la caché de audio: ${liveText}` };
      const ready = nativeAudioEngine.isNativeCacheReady(song.id);
      if (ready) return { text: 'Lista', tone: 'ready', title: 'Caché de audio lista: suena sin esperas.' };
      if (ready === null) return { text: 'Comprobando', tone: 'idle', title: 'Comprobando la caché de audio...' };
      return { text: 'Sin preparar', tone: 'idle', title: 'Sin caché de audio: se genera al añadir al setlist o al cargar en el DAW.' };
    }
    const info = audioEngine.getSongRamCacheInfo(song);
    if (info.isReady || audioEngine.isProjectPcmReady(song)) return { text: 'Lista', tone: 'ready', title: 'Lista para sonar.' };
    const live = nativeAudioEngine.formatImportProgress(song.id);
    if (live) return { text: live, tone: 'busy', title: live };
    return { text: `${info.cachedCount}/${info.totalCount}`, tone: 'idle', title: `${info.cachedCount}/${info.totalCount} pistas en RAM` };
  };
  const readyCount = setlistQueue.filter((song) => statusOf(song).tone === 'ready').length;

  const mapPanel =
    isProjectInSetlist && project ? (
      <section className="lt-map" aria-label="Mapa de la canción">
        <header className="lt-map-header">
          <div className="min-w-0">
            <strong title={project.title}>{project.title}</strong>
            <span>
              mapa de la canción · {sections.length === 0 ? 'sin secciones' : sections.length === 1 ? '1 sección' : `${sections.length} secciones`}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" popoverTarget="section-templates" className="lt-control">
              <Plus size={15} /> Añadir sección
            </button>
            <button type="button" onClick={onAddMarkerAtPlayhead} className="lt-control" title="Marca una sección sin nombre en la posición del cursor">
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
          <div id="section-templates" popover="auto" className="lt-popover space-y-0.5">
            <div className="px-2.5 py-1 text-xs text-studio-muted font-semibold">
              Añadir en {formatTimecode(playheadSec)}
            </div>
            {SECTION_TEMPLATES.map((tpl) => (
              <button
                key={tpl.key}
                type="button"
                onClick={(event) => {
                  onAddSectionTemplate(tpl.key);
                  closePopover(event);
                }}
                className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-neutral-800 text-neutral-100 flex items-center gap-2.5 cursor-pointer"
              >
                <span className="lt-code" style={{ '--sec': tpl.color } as React.CSSProperties}>{tpl.code}</span>
                {tpl.name}
              </button>
            ))}
          </div>
        </header>

        <div className="lt-waveform lt-map-wave relative shrink-0 overflow-hidden">
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
          {sections.map((sec) => (
            <button
              key={sec.id}
              type="button"
              className="lt-map-badge"
              data-active={sec.id === transport.activeSectionId || undefined}
              data-queued={sec.id === transport.queuedSectionId || undefined}
              style={{
                left: `${(sec.startTimeSec / totalDurationSec) * 100}%`,
                '--sec': sec.color || 'var(--lt-accent)',
              } as React.CSSProperties}
              onClick={() => onJumpSection(sec.id)}
              title={`${sec.name} · ${formatMmSs(sec.startTimeSec)}`}
              aria-label={`${sec.name}, ${formatMmSs(sec.startTimeSec)}`}
            >
              {sec.code}
            </button>
          ))}
          {transport.isMountingSong && (
            <div className="absolute inset-0 bg-neutral-950/75 flex flex-col items-center justify-center p-4 text-center z-20">
              <div className="px-4 py-2.5 rounded-xl bg-studio-panel border border-amber-500/50 text-amber-300 text-sm font-bold shadow-xl">
                {transport.mountingProgressText || 'Cargando pistas en RAM...'}
              </div>
            </div>
          )}
        </div>
        {sections.length === 0 && (
          <p className="lt-plan-hint">
            Esta canción aún no tiene secciones. Usa «Añadir sección» mientras reproduces para dividirla en Intro, Verso, Coro, Puente…
          </p>
        )}
      </section>
    ) : null;

  return (
    <section className="lt-setlist lt-setlist-plan flex-1 min-w-0 min-h-0" aria-labelledby="setlist-title">
      <header className="lt-plan-header">
        <div className="lt-plan-name">
          <input
            id="setlist-title"
            type="text"
            value={setlistMeta.name}
            onChange={(e) => setSetlistName(e.target.value)}
            placeholder="Nombre del servicio"
            aria-label="Nombre del servicio"
          />
          <div className="lt-plan-summary">
            <input
              type="date"
              value={setlistMeta.date}
              onChange={(e) => setSetlistDate(e.target.value)}
              aria-label="Fecha del servicio"
            />
            <span>
              {setlistQueue.length === 0
                ? 'Sin canciones'
                : `${setlistQueue.length === 1 ? '1 canción' : setlistQueue.length + ' canciones'} · ${formatMmSs(setlistTotalSec)}`}
            </span>
            {setlistQueue.length > 0 && (
              <span className={readyCount === setlistQueue.length ? 'lt-plan-ok' : 'lt-plan-warn'}>
                {readyCount === setlistQueue.length
                  ? `${readyCount} de ${setlistQueue.length} listas`
                  : `${readyCount} de ${setlistQueue.length} listas · preparando`}
              </span>
            )}
          </div>
        </div>
        <div className="lt-plan-header-actions">
          {setlistQueue.length > 0 && (
            <button
              type="button"
              onClick={() => setIsEditingStrip((v) => !v)}
              aria-pressed={isEditingStrip}
              className="lt-control"
              title="Muestra los botones para quitar canciones del setlist"
            >
              {isEditingStrip ? 'Listo' : 'Editar'}
            </button>
          )}
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
          <button
            type="button"
            onClick={onStartLive}
            disabled={setlistQueue.length === 0}
            className="lt-live-btn"
            title="Monta la primera canción y abre la página En vivo"
          >
            <Radio size={16} aria-hidden="true" /> Iniciar en vivo
          </button>
        </div>
      </header>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={async (e) => {
          if ((e.target as HTMLElement).closest('.lt-tile')) return;
          e.preventDefault();
          const songId = e.dataTransfer.getData('application/x-omnitracks-song-id');
          if (songId) {
            onAddToSetlist(songId);
            return;
          }
          const audioFiles = await extractAudioFilesFromDataTransfer(e.dataTransfer);
          if (audioFiles.length > 0) onQuickImportNewSongFiles(audioFiles);
        }}
      >
        <SetlistStrip
          songs={setlistQueue}
          currentId={project?.id ?? null}
          isPlaying={transport.isPlaying}
          isMounting={Boolean(transport.isMountingSong)}
          mountingText={transport.mountingProgressText ?? undefined}
          globalMode={setlistTransitionMode}
          isEditing={isEditingStrip}
          startOffsets={startOffsets}
          statusOf={statusOf}
          canOptimize={(song) => !isDesktopApp() && !audioEngine.isProjectPcmReady(song) && song.tracks.length > 0}
          onSelect={onRequestSongAction}
          onPlay={(song) => {
            if (project?.id === song.id) onPlayPause();
            else onLoadAndPlaySong(song.id, audioEngine.getSongRamCacheInfo(song).isReady || isDesktopApp());
          }}
          onMount={(song) => onLoadAndPlaySong(song.id, false)}
          onMove={onMoveInSetlist}
          onRemove={onRemoveFromSetlist}
          onOptimize={onOptimizeProject}
          onReorder={onReorderSetlist}
          onDropLibrarySong={onAddToSetlist}
          onAddSong={openPicker}
          onSetTransition={onSetSongTransition}
        />
      </div>

      {setlistQueue.length > 0 && !isProjectInSetlist && (
        <p className="lt-plan-hint">Pulsa una canción para montarla en consola. Aquí verás su mapa con las secciones y tus notas.</p>
      )}

      {mapPanel}

      {isPickerOpen && (
        <SongPickerModal
          songs={allProjects}
          setlistIds={setlistIds}
          onClose={() => setIsPickerOpen(false)}
          onAddToSetlist={onAddToSetlist}
          onRemoveFromSetlist={onRemoveFromSetlist}
          onQuickImportNewSongFiles={onQuickImportNewSongFiles}
          onQuickImportNativeFolder={onQuickImportNativeFolder}
          onQuickImportNativeFiles={onQuickImportNativeFiles}
        />
      )}

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
