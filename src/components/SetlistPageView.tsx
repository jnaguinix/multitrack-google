import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Flag,
  RotateCcw,
  Sliders,
  Radio,
} from 'lucide-react';
import {
  QuantizeMode,
  SetlistTransitionMode,
  SongProject,
  TransportState,
} from '../types/project';
import { audioEngine } from '../audio/audioEngine';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';
import { extractAudioFilesFromDataTransfer } from '../utils/fileImportHelper';
import { formatMmSs, formatTimecode } from './TransportDeck';
import { drawSectionWaveBars, getSongWaveformPeaks } from '../utils/songWaveform';
import { MultitrackMixer } from './MultitrackMixer';
import { isDesktopApp } from '../utils/nativeDialog';
import { SongPickerModal } from './SongPickerModal';
import { SetlistStrip, SongTileStatus } from './SetlistStrip';
import { CreatePadSongModal } from './modals/CreatePadSongModal';
import { PadStagePanel } from './PadStagePanel';
import { isPadOnlySong } from '../utils/padSong';
import { SECTION_TEMPLATES } from '../utils/sectionTemplates';
import { MenuItem, MenuLabel, PopoverMenu } from './ui/Menu';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from './ui/Dialog';
import { useSetlistMeta } from '../hooks/useSetlistMeta';

interface SetlistPageViewProps {
  project: SongProject | null;
  allProjects: SongProject[];
  setlistQueue: SongProject[];
  transport: TransportState;
  ramCacheVersion: number;
  setlistTransitionMode: SetlistTransitionMode;
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
  onEditTracks?: () => void;
  onPickInstrument?: (trackId: string) => void;
  onQuickImportNewSongFiles: (files: FileList | File[]) => void;
  onQuickImportNativeFolder?: (folderPath: string) => void;
  onQuickImportNativeFiles?: (filePaths: string[]) => void;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onChangeTrackGain: (trackId: string, gain: number) => void;
  onChangeTrackPan: (trackId: string, pan: number) => void;
  onChangeClickGain: (gain: number) => void;
  onToggleClick: () => void;
  onChangeMasterGain: (gain: number) => void;
  onToggleTrackMonitor?: (trackId: string) => void;
  onChangeMonitorGain?: (gain: number) => void;
  onChangeTrackCueGain?: (trackId: string, gain: number) => void;
  onToggleTrackCueMute?: (trackId: string) => void;
  onTogglePad?: () => void;
  onChangePadGain?: (gain: number) => void;
  onTogglePadMonitor?: () => void;
  onChangeKeySignature?: (key: string) => void;
  onChangeBeatsPerBar?: (beatsPerBar: number) => void;
  onChangeClickSubdivision?: (subdivision: 1 | 2 | 4) => void;
  onCreatePadSong?: (song: SongProject) => void;
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
  if (isPadOnlySong(song)) return 0;
  return song.durationSec || ((song.totalBars || 24) * 4 * 60) / (song.bpm || 120);
}

export const SetlistPageView: React.FC<SetlistPageViewProps> = ({
  project,
  allProjects,
  setlistQueue,
  transport,
  ramCacheVersion: _ramCacheVersion,
  setlistTransitionMode,
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
  onEditTracks,
  onPickInstrument,
  onQuickImportNewSongFiles,
  onQuickImportNativeFolder,
  onQuickImportNativeFiles,
  onToggleTrackMute,
  onToggleTrackSolo,
  onChangeTrackGain,
  onChangeTrackPan,
  onChangeClickGain,
  onToggleClick,
  onChangeMasterGain,
  onToggleTrackMonitor,
  onChangeMonitorGain,
  onChangeTrackCueGain,
  onToggleTrackCueMute,
  onTogglePad,
  onChangePadGain,
  onTogglePadMonitor,
  onChangeKeySignature,
  onChangeBeatsPerBar,
  onChangeClickSubdivision,
  onCreatePadSong,
  onResetMixer,
  onStartLive,
  onSetSongTransition,
  onAddSectionTemplate,
  onChangeBpm,
}) => {
  const [cursorNotice, setCursorNotice] = useState<string | null>(null);
  const [isFloatingMixerOpen, setIsFloatingMixerOpen] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isCreatePadOpen, setIsCreatePadOpen] = useState(false);
  const [isEditingStrip, setIsEditingStrip] = useState(false);
  const openPicker = () => setIsPickerOpen(true);
  const setlistIds = useMemo(() => new Set(setlistQueue.map((s) => s.id)), [setlistQueue]);

  const masterCanvasRef = useRef<HTMLCanvasElement | null>(null);

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
        ctx.fillStyle = queued ? '#e8ba68' : section.color || '#F5F5F3';
        ctx.globalAlpha = queued || section.id === activeSection?.id ? 0.34 : 0.2;
        ctx.fillRect(startX, 0, Math.max(0, endX - startX), height);
        ctx.globalAlpha = 0.6;
        ctx.fillRect(startX, 0, 1, height);
      }

      // Onda simétrica por colores de sección (la misma función que el mapa de En vivo). Deja arriba una franja
      // libre para los círculos de las secciones.
      drawSectionWaveBars(ctx, {
        width,
        height,
        peaks: masterPeaks,
        sections,
        totalDurationSec,
        top: 34,
        bottom: height - 8,
      });
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

  // La consola flotante muestra la canción completa (el filtro de pistas por texto se retiró: no tenía interfaz).
  const filteredProjectForMixer = project;

  const isProjectInSetlist = Boolean(project && setlistQueue.some((s) => s.id === project.id));
  const startOffsets = setlistQueue.reduce<number[]>((acc, _song, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + songDuration(setlistQueue[i - 1]));
    return acc;
  }, []);
  const { meta: setlistMeta, setName: setSetlistName, setDate: setSetlistDate } = useSetlistMeta();
  const setlistTotalSec = setlistQueue.reduce((sum, song) => sum + songDuration(song), 0);

  /** Estado de la caché de audio de una canción, tal como lo muestra su ficha. */
  const statusOf = (song: SongProject): SongTileStatus => {
    if (isPadOnlySong(song)) return { text: 'Lista', tone: 'ready', title: 'Pad + Click listos al instante.' };
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
      isPadOnlySong(project) ? (
        <section className="lt-map" aria-label="Preparar pad y metrónomo">
          <header className="lt-map-header">
            <div className="min-w-0">
              <strong title={project.title}>{project.title}</strong>
              <span>modo sin secuencia · prepara tono, BPM y subdivisión antes de pasar a En vivo</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setIsFloatingMixerOpen(true)} className="lt-control">
                <Sliders size={16} /> Mezcla
              </button>
            </div>
          </header>
          <PadStagePanel
            mode="prepare"
            project={project}
            transport={transport}
            onChangeKeySignature={onChangeKeySignature}
            onChangeBpm={onChangeBpm}
            onChangeBeatsPerBar={onChangeBeatsPerBar}
            onChangeClickSubdivision={onChangeClickSubdivision}
            onTogglePad={onTogglePad}
            onToggleClick={onToggleClick}
          />
        </section>
      ) : (
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
            {onEditTracks && (
              <button type="button" onClick={onEditTracks} className="lt-control">
                Editar pistas
              </button>
            )}
            <button type="button" onClick={() => setIsFloatingMixerOpen(true)} className="lt-control">
              <Sliders size={16} /> Mezcla
            </button>
          </div>
          <PopoverMenu id="section-templates" label={`Añadir sección en ${formatTimecode(playheadSec)}`}>
            <MenuLabel>Añadir en {formatTimecode(playheadSec)}</MenuLabel>
            {SECTION_TEMPLATES.map((tpl) => (
              <MenuItem
                key={tpl.key}
                label={tpl.name}
                leading={<span className="lt-code" style={{ '--sec': tpl.color } as React.CSSProperties}>{tpl.code}</span>}
                onSelect={() => onAddSectionTemplate(tpl.key)}
              />
            ))}
          </PopoverMenu>
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
      )
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
                : `${setlistQueue.length === 1 ? '1 canción' : setlistQueue.length + ' canciones'}${setlistTotalSec > 0 ? ` · ${formatMmSs(setlistTotalSec)}` : ''}`}
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
            className="lt-control lt-start-live"
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
          canOptimize={(song) => !isDesktopApp() && !isPadOnlySong(song) && !audioEngine.isProjectPcmReady(song) && song.tracks.length > 0}
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
        <p className="lt-plan-hint">Pulsa una canción para montarla en consola. Aquí verás su mapa con las secciones.</p>
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
          onOpenCreatePad={onCreatePadSong ? () => setIsCreatePadOpen(true) : undefined}
        />
      )}

      {isCreatePadOpen && (
        <CreatePadSongModal
          isOpen={isCreatePadOpen}
          nextSetlistOrder={setlistQueue.length}
          onClose={() => setIsCreatePadOpen(false)}
          onCreate={(song) => onCreatePadSong?.(song)}
        />
      )}

      {/* 4. FLOATING MIXER CARD MODAL / DRAWER (Opens on demand, closes with 1 click or Esc) */}
      {isFloatingMixerOpen && filteredProjectForMixer && (
        <Dialog label="Mezcla de la canción" onClose={() => setIsFloatingMixerOpen(false)} size="fill" placement="bottom" dismissOnBackdrop>
          <DialogHeader
            icon={Sliders}
            title={
              <>
                Consola Mixer — {filteredProjectForMixer.title}{' '}
                <span className="lt-dialog-badge">Compás {String(transport.currentBar).padStart(3, '0')}</span>
              </>
            }
            description="Doble clic en fader = 0.0 dB · Doble clic en knob = Centrar (C) · Pulsa Esc o fuera de la tarjeta para cerrar"
            actions={
              <button type="button" onClick={onResetMixer} className="lt-control">
                <RotateCcw size={14} aria-hidden="true" />
                <span>Restablecer mezcla a 0 dB</span>
              </button>
            }
            onClose={() => setIsFloatingMixerOpen(false)}
          />
          <div className="overflow-y-auto">
            <MultitrackMixer
              project={filteredProjectForMixer}
              transport={transport}
              docked={true}
              onToggleTrackMute={onToggleTrackMute}
              onToggleTrackSolo={onToggleTrackSolo}
              onChangeTrackGain={onChangeTrackGain}
              onChangeTrackPan={onChangeTrackPan}
              onChangeClickGain={onChangeClickGain}
              onToggleClick={onToggleClick}
              onChangeMasterGain={onChangeMasterGain}
              onToggleTrackMonitor={onToggleTrackMonitor}
              onChangeMonitorGain={onChangeMonitorGain}
              onChangeTrackCueGain={onChangeTrackCueGain}
              onToggleTrackCueMute={onToggleTrackCueMute}
              onTogglePad={onTogglePad}
              onChangePadGain={onChangePadGain}
              onTogglePadMonitor={onTogglePadMonitor}
              onResetMixer={onResetMixer}
              onPickInstrument={onPickInstrument}
            />
          </div>
        </Dialog>
      )}

      {cursorNotice && (
        <div className="fixed bottom-4 right-4 z-40 bg-studio-panel border border-studio-line text-neutral-200 px-3 py-1.5 rounded-lg text-xs shadow-lg">
          {cursorNotice}
        </div>
      )}

      {/* Confirmación para limpiar la sesión (Setlist) */}
      {showClearConfirm && (
        <Dialog label="Limpiar la sesión actual" onClose={() => setShowClearConfirm(false)} size="sm">
          <DialogHeader
            icon={RotateCcw}
            tone="warning"
            title="¿Limpiar la sesión actual?"
            description={`Se quitarán las ${setlistQueue.length} canciones del setlist activo.`}
            onClose={() => setShowClearConfirm(false)}
          />
          <DialogBody>
            <p className="lt-dialog-note">
              Tus canciones normales, pistas y marcadores seguirán <strong>completamente intactos en tu biblioteca</strong>. Podrás volver a agregarlas en cualquier momento.
            </p>
          </DialogBody>
          <DialogFooter>
            {/* Quitar canciones del setlist en directo no es trivial: el foco empieza en Cancelar. */}
            <button type="button" data-autofocus onClick={() => setShowClearConfirm(false)} className="lt-control">
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => {
                setShowClearConfirm(false);
                onClearSetlist?.();
              }}
              className="lt-control lt-btn-primary"
            >
              <RotateCcw size={14} aria-hidden="true" />
              <span>Limpiar sesión</span>
            </button>
          </DialogFooter>
        </Dialog>
      )}
    </section>
  );
};
