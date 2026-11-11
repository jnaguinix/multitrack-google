import React, { useRef, useState } from 'react';
import {
  FolderOpen,
  Upload,
  Download,
  MoreHorizontal,
  Plus,
  Trash2,
  X,
  Music,
  CheckCircle2,
  Repeat,
  FolderPlus,
  Flag,
  Clock,
  ListMusic,
  Play,
  Zap,
  HardDrive,
} from 'lucide-react';
import { OutputBus, SongProject, SongSection, TrackChannel } from '../types/project';
import { audioEngine } from '../audio/audioEngine';
import { PcmOptimizationProgress } from '../storage/pcmOptimizer';
import { isFsAccessSupported, pickAudioSources } from '../storage/sourceFiles';
import { isDesktopApp, pickNativeFiles, pickNativeFolder } from '../utils/nativeDialog';
import { formatMmSs } from './TransportDeck';

interface LibraryViewProps {
  projects: SongProject[];
  currentProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onAddToSetlist: (projectId: string) => void;
  onCreateNewProject: (title: string, artist: string, bpm: number, keySig: string) => void;
  onDeleteProject: (projectId: string) => void;
  onExportJson: (project: SongProject) => void;
  onImportJsonFile: (file: File) => void;
  onOpenStemImporter: () => void;
  onOptimizeProject: (project: SongProject) => void;
  onRelinkProject?: (project: SongProject) => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  projects,
  currentProjectId,
  onSelectProject,
  onAddToSetlist,
  onCreateNewProject,
  onDeleteProject,
  onExportJson,
  onImportJsonFile,
  onOpenStemImporter,
  onOptimizeProject,
  onRelinkProject,
}) => {
  const [newTitle, setNewTitle] = useState('');
  const [newArtist, setNewArtist] = useState('');
  const [newBpm, setNewBpm] = useState(120);
  const [newKey, setNewKey] = useState('C Major');

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    onCreateNewProject(
      newTitle.trim(),
      newArtist.trim() || 'Artista en Vivo',
      newBpm,
      newKey
    );
    setNewTitle('');
    setNewArtist('');
  };

  return (
    <div className="flex-1 min-w-0 bg-studio-ground p-4 sm:p-6 overflow-y-auto">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header & JSON Project Import/Export */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-800 pb-5">
          <div>
            <h1 className="text-2xl font-bold text-neutral-100">
              Biblioteca
            </h1>
            <p className="text-sm text-neutral-400 mt-1">
              {isDesktopApp()
                ? 'Canciones indexadas en la biblioteca de OmniTracks (almacenadas en library.json).'
                : 'Canciones guardadas en este navegador.'}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <label className="px-4 py-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-xs font-semibold text-neutral-200 flex items-center gap-2 cursor-pointer transition-colors">
              <Upload className="w-4 h-4 text-studio-ink" />
              <span>Importar proyecto JSON</span>
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onImportJsonFile(file);
                  e.target.value = '';
                }}
              />
            </label>

            <button
              type="button"
              onClick={onOpenStemImporter}
              className="px-4 py-2 rounded-lg bg-studio-ink hover:bg-neutral-200 text-studio-ground text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors"
            >
              <Music className="w-4 h-4" />
              <span>Importar pistas</span>
            </button>
          </div>
        </div>

        {/* Grid of Saved & Demo Projects + Create New Project Form */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Saved Songs List (8 cols) */}
          <div className="lg:col-span-8 space-y-3">
            <h2 className="text-base font-semibold text-neutral-200">
              Canciones ({projects.length})
            </h2>

            <div className="divide-y divide-studio-line">
              {projects.length === 0 && <p className="rounded-lg bg-studio-panel p-4 text-sm text-studio-muted">Importa pistas o crea una canción para empezar.</p>}
              {projects.map((proj, index) => {
                const isCurrent = proj.id === currentProjectId;
                const durSec =
                  proj.durationSec || ((proj.totalBars || 24) * 4 * 60) / (proj.bpm || 120);
                const isPcmReady = audioEngine.isProjectPcmReady(proj);
                const pcmMB = audioEngine.getProjectPcmEstimatedMB(proj);

                return (
                  <div
                    key={proj.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3.5"
                  >
                    <div className="min-w-[10rem] flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="text-base font-bold text-neutral-100 truncate">
                          {proj.title}
                        </h3>
                        {isCurrent && (
                          <span className="text-xs font-medium text-studio-ink flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Activa
                          </span>
                        )}
                        {/* OPFS Streaming PCM Status Badge */}
                        {isPcmReady ? (
                          <span
                            title={`Audio PCM Int16 optimizado en OPFS (~${pcmMB} MB en disco). Carga rápida y streaming por ventanas.`}
                            className="px-2 py-0.5 rounded text-[11px] font-bold bg-studio-strip text-studio-ink border border-studio-line flex items-center gap-1"
                          >
                            <HardDrive className="w-3 h-3" />
                            <span>PCM listo ({pcmMB} MB)</span>
                          </span>
                        ) : (
                          <span
                            title="Esta canción aún no tiene archivos PCM generados en OPFS. Pulsa 'Optimizar' para generar PCM en disco."
                            className="px-2 py-0.5 rounded text-[11px] text-studio-muted flex items-center gap-1"
                          >
                            <span>Sin optimizar</span>
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400 mt-1">
                        <span>{proj.artist}</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">{formatMmSs(durSec)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">{proj.bpm} BPM</span>
                        <span aria-hidden="true">·</span>
                        <span>{proj.keySignature}</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          {proj.tracks.length} pistas
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          {proj.sections.length} marcadores
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button type="button" className="lt-control" onClick={() => onSelectProject(proj.id)}>{isCurrent ? 'Abierta' : 'Abrir'}</button>
                      <button type="button" popoverTarget={`library-song-${index}`} aria-label={`Acciones de ${proj.title}`} className="lt-control lt-icon-control">
                        <MoreHorizontal size={17} />
                      </button>
                      <div id={`library-song-${index}`} popover="auto" className="lt-popover lt-library-actions space-y-1">
                        {/* Relink original files (moved/renamed folder or permission lost) */}
                        {onRelinkProject && (isDesktopApp() || (!isPcmReady && isFsAccessSupported())) && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                              onRelinkProject(proj);
                            }}
                            title="Elegir la carpeta donde están ahora los stems originales de esta canción"
                            className="px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                          >
                            <FolderPlus className="w-3.5 h-3.5 text-studio-ink" />
                            <span>Ubicar carpeta</span>
                          </button>
                        )}

                        {/* Optimize for Streaming Button if not yet optimized */}
                        {!isPcmReady && proj.tracks.length > 0 && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                              onOptimizeProject(proj);
                            }}
                            title="Convertir stems a PCM estéreo Int16 en OPFS para streaming estilo REAPER"
                            className="px-3 py-2 rounded-lg bg-studio-strip hover:bg-neutral-700 text-studio-ink border border-studio-line text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                          >
                            <Zap className="w-3.5 h-3.5 text-studio-ink" />
                            <span>Optimizar para streaming</span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={(event) => {
                              event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                              onAddToSetlist(proj.id);
                            }}
                          className="px-3 py-2 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/40 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                        >
                          <ListMusic className="w-3.5 h-3.5" />
                          <span>Añadir al Setlist</span>
                        </button>

                        <button
                          type="button"
                          onClick={(event) => {
                              event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                              onExportJson(proj);
                            }}
                          title="Exportar configuración del proyecto en JSON"
                          className="p-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 text-neutral-300 border border-neutral-800 cursor-pointer"
                        >
                          <Download className="w-4 h-4" /> Exportar JSON
                        </button>

                        <button
                          type="button"
                          onClick={(event) => {
                              event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                              onDeleteProject(proj.id);
                            }}
                          title="Eliminar proyecto de la biblioteca"
                          className="p-2 rounded-lg bg-neutral-900 hover:bg-red-500/20 text-neutral-400 hover:text-red-400 border border-neutral-800 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" /> Eliminar canción
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Create New Song Project Card (4 cols) */}
          <form
            onSubmit={handleCreate}
            className="lg:col-span-4 bg-studio-panel border border-neutral-800 rounded-xl p-5 space-y-4"
          >
            <h2 className="text-base font-bold text-neutral-100">
              Crear canción
            </h2>
            <p className="text-xs text-neutral-400">
              Inicia una sesión vacía o suelta directamente tus archivos de audio para crearla.
            </p>

            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">
                Título de la Canción
              </label>
              <input
                type="text"
                required
                placeholder="Ej. Amanecer Eléctrico (Live)"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="w-full bg-studio-ground border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-studio-line"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">
                Artista / Ensamble
              </label>
              <input
                type="text"
                placeholder="Ej. Banda Principal"
                value={newArtist}
                onChange={(e) => setNewArtist(e.target.value)}
                className="w-full bg-studio-ground border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-studio-line"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">
                  Tempo (BPM)
                </label>
                <input
                  type="number"
                  min={50}
                  max={220}
                  value={newBpm}
                  onChange={(e) => setNewBpm(Number(e.target.value))}
                  className="w-full bg-studio-ground border border-neutral-800 rounded-lg px-3 py-2 text-sm tabular-nums text-neutral-100 focus:outline-none focus:border-studio-line"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">
                  Tonalidad
                </label>
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  className="w-full bg-studio-ground border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-studio-line"
                />
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-studio-ink hover:bg-neutral-200 text-studio-ground font-semibold text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Crear Proyecto y Abrir Consola</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * REPERTOIRE SONG SELECTION CONFIRMATION MODAL
 * ============================================================================ */

interface ConfirmSongActionModalProps {
  song: SongProject | null;
  currentSongId: string | null;
  isInSetlist: boolean;
  onClose: () => void;
  onConfirmLoadInDaw: (songId: string) => void;
  onConfirmAddToSetlist: (songId: string) => void;
}

export const ConfirmSongActionModal: React.FC<ConfirmSongActionModalProps> = ({
  song,
  currentSongId,
  isInSetlist,
  onClose,
  onConfirmLoadInDaw,
  onConfirmAddToSetlist,
}) => {
  if (!song) return null;

  const isAlreadyInDaw = song.id === currentSongId;
  const durSec =
    song.durationSec || ((song.totalBars || 24) * 4 * 60) / (song.bpm || 120);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-studio-panel border border-neutral-800 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-studio-strip border border-studio-line flex items-center justify-center shrink-0">
              <Music className="w-5 h-5 text-studio-ink" />
            </div>
            <div>
              <h2 className="text-base font-bold text-neutral-100">
                {song.title}
              </h2>
              <p className="text-xs text-neutral-400">
                {song.artist} · {formatMmSs(durSec)} · {song.bpm} BPM · {song.keySignature}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-white p-1 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="bg-studio-ground border border-neutral-800 rounded-xl p-3.5 text-xs text-neutral-300 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-neutral-400">Pistas multipista incluidas:</span>
            <span className="font-bold text-studio-ink">
              {song.tracks.length} stems
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-neutral-400">Marcadores de sección:</span>
            <span className="font-bold text-neutral-200">
              {song.sections.length}
            </span>
          </div>
        </div>

        <p className="text-xs text-neutral-400">
          ¿Confirmas que deseas montar esta canción en el DAW ahora, o prefieres enviarla a la cola del Modo Setlist?
        </p>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
          <button
            type="button"
            onClick={() => {
              onConfirmLoadInDaw(song.id);
              onClose();
            }}
            className="flex-1 py-2.5 px-4 rounded-xl bg-studio-ink hover:bg-neutral-200 text-studio-ground font-bold text-xs flex items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>
              {isAlreadyInDaw ? 'Reiniciar en el DAW' : 'Sí, Cargar en el DAW'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              onConfirmAddToSetlist(song.id);
              onClose();
            }}
            className="py-2.5 px-4 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
          >
            <ListMusic className="w-3.5 h-3.5" />
            <span>{isInSetlist ? 'Ver en Setlist' : 'Añadir al Setlist'}</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="py-2.5 px-3.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-medium cursor-pointer transition-colors"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * INSTANT STEM & FOLDER IMPORTER MODAL
 * ============================================================================ */

interface StemImporterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportFiles: (
    files: FileList | File[],
    defaultBus: OutputBus,
    importMode: 'new-song' | 'current-song'
  ) => void;
  onImportNativeFolder?: (
    folderPath: string,
    defaultBus: OutputBus,
    importMode: 'new-song' | 'current-song'
  ) => void;
  onImportNativeFiles?: (
    filePaths: string[],
    defaultBus: OutputBus,
    importMode: 'new-song' | 'current-song'
  ) => void;
}

export const StemImporterModal: React.FC<StemImporterModalProps> = ({
  isOpen,
  onClose,
  onImportFiles,
  onImportNativeFolder,
  onImportNativeFiles,
}) => {
  const [defaultBus, setDefaultBus] = useState<OutputBus>('main');
  const [importMode, setImportMode] = useState<'new-song' | 'current-song'>('new-song');
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-studio-panel border border-neutral-800 rounded-xl max-w-lg w-full max-h-[92dvh] overflow-y-auto p-4 sm:p-6 space-y-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-neutral-100">
            Importación Instantánea de Canción o Stems
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-white p-1 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Selection: Create New Song vs Add to Current */}
        <div className="grid grid-cols-2 gap-2 bg-studio-ground p-1 rounded-xl border border-neutral-800">
          <button
            type="button"
            onClick={() => setImportMode('new-song')}
            className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
              importMode === 'new-song'
                ? 'bg-neutral-800 text-studio-ink shadow-2xs'
                : 'text-neutral-400'
            }`}
          >
            <Music className="w-3.5 h-3.5" />
            <span>Crear Canción Nueva</span>
          </button>
          <button
            type="button"
            onClick={() => setImportMode('current-song')}
            className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
              importMode === 'current-song'
                ? 'bg-neutral-800 text-studio-ink shadow-2xs'
                : 'text-neutral-400'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Añadir a Canción Actual</span>
          </button>
        </div>

        <p className="text-xs text-neutral-400 leading-relaxed">
          Selecciona tus pistas (<code className="text-neutral-200">.wav</code>,{' '}
          <code className="text-neutral-200">.mp3</code>,{' '}
          <code className="text-neutral-200">.ogg</code>,{' '}
          <code className="text-neutral-200">.flac</code>,{' '}
          <code className="text-neutral-200">.m4a</code>). La canción se cargará limpia con su duración real en minutos y segundos.
        </p>

        <div>
          <label className="block text-xs font-medium text-neutral-300 mb-1.5">
            Bus de Salida Predeterminado
          </label>
          <select
            value={defaultBus}
            onChange={(e) => setDefaultBus(e.target.value as OutputBus)}
            className="w-full bg-studio-ground border border-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-100 focus:outline-none focus:border-studio-line"
          >
            <option value="main">Main L/R (Pistas Click/Guide van a Cue automáticamente)</option>
            <option value="cue-click">Click / Cue Bus (Solo Monitoreo)</option>
            <option value="both">Ambos Buses (Main + Cue)</option>
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Multi-file Picker */}
          <label
            onClick={(e) => {
              if (isDesktopApp()) {
                e.preventDefault();
                pickNativeFiles().then((paths) => {
                  if (paths && paths.length > 0) {
                    onClose();
                    onImportNativeFiles?.(paths, defaultBus, importMode);
                  }
                });
                return;
              }
              if (!isFsAccessSupported()) return;
              e.preventDefault();
              pickAudioSources('files', null, (files) => {
                onClose();
                onImportFiles(files, defaultBus, importMode);
              });
            }}
            className="border-2 border-dashed border-neutral-700 hover:border-studio-line rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors bg-studio-ground/60"
          >
            <Upload className="w-7 h-7 text-studio-ink mb-2" />
            <span className="text-xs font-bold text-neutral-200">
              Elegir Archivos de Audio
            </span>
            <span className="text-[11px] text-neutral-400 mt-1">
              Selección múltiple (.wav, .mp3...)
            </span>
            <input
              type="file"
              multiple
              accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.webm,.opus,.aif,.aiff,.caf"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  const selected = Array.from(e.target.files);
                  e.target.value = '';
                  onClose();
                  onImportFiles(selected, defaultBus, importMode);
                }
              }}
            />
          </label>

          {/* Directory / Folder Picker */}
          <button
            type="button"
            onClick={() => {
              if (isDesktopApp()) {
                pickNativeFolder().then((folderPath) => {
                  if (folderPath) {
                    onClose();
                    onImportNativeFolder?.(folderPath, defaultBus, importMode);
                  }
                });
                return;
              }
              pickAudioSources('folder', folderInputRef.current, (files) => {
                onClose();
                onImportFiles(files, defaultBus, importMode);
              });
            }}
            className="border-2 border-dashed border-neutral-700 hover:border-studio-line rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors bg-studio-ground/60"
          >
            <FolderPlus className="w-7 h-7 text-studio-ink mb-2" />
            <span className="text-xs font-bold text-neutral-200">
              Importar Carpeta Completa
            </span>
            <span className="text-[11px] text-neutral-400 mt-1">
              Detecta título y todos los stems
            </span>
          </button>

          <input
            ref={folderInputRef}
            type="file"
            multiple
            // @ts-expect-error webkitdirectory is standard for folder selection
            webkitdirectory=""
            directory=""
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                const selected = Array.from(e.target.files);
                e.target.value = '';
                onClose();
                onImportFiles(selected, defaultBus, importMode);
              }
            }}
          />
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-neutral-200 cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * TIME-BASED SECTION MARKER EDITOR MODAL (MM:SS)
 * ============================================================================ */

interface SectionEditorModalProps {
  isOpen: boolean;
  project: SongProject;
  currentTimeSec: number;
  totalDurationSec: number;
  onClose: () => void;
  onSaveSections: (sections: SongSection[]) => void;
}

const SECTION_COLORS = [
  '#06B6D4',
  '#3B82F6',
  '#10B981',
  '#F59E0B',
  '#8B5CF6',
  '#EC4899',
  '#EF4444',
];

const QUICK_SECTION_PRESETS = [
  { name: 'Intro', code: 'IN', color: '#06B6D4' },
  { name: 'Verso 1', code: 'V1', color: '#3B82F6' },
  { name: 'Verso 2', code: 'V2', color: '#3B82F6' },
  { name: 'Pre-Coro', code: 'PC', color: '#8B5CF6' },
  { name: 'Coro', code: 'CO', color: '#10B981' },
  { name: 'Puente', code: 'PU', color: '#F59E0B' },
  { name: 'Instrumental', code: 'IS', color: '#EC4899' },
  { name: 'Final', code: 'FI', color: '#EF4444' },
];

function roundSectionSec(sec: number): number {
  return Math.round(Math.max(0, sec || 0) * 100) / 100;
}

function formatSectionMmSs(sec: number): string {
  const safe = roundSectionSec(sec);
  const totalCentis = Math.round(safe * 100);
  const mins = Math.floor(totalCentis / 6000);
  const remCentis = totalCentis - mins * 6000;
  const wholeSec = Math.floor(remCentis / 100);
  const centis = remCentis % 100;
  return `${String(mins).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function parseMmSsInput(text: string, fallbackSec: number): number {
  const clean = text.trim().replace(',', '.');
  if (!clean) return fallbackSec;
  if (clean.includes(':')) {
    const [mStr, sStr] = clean.split(':');
    const mins = Number(mStr);
    const secs = Number(sStr);
    if (!Number.isFinite(mins) || !Number.isFinite(secs) || mins < 0 || secs < 0) {
      return fallbackSec;
    }
    return roundSectionSec(mins * 60 + secs);
  }
  const num = Number(clean);
  return !Number.isFinite(num) || num < 0 ? fallbackSec : roundSectionSec(num);
}

export const SectionEditorModal: React.FC<SectionEditorModalProps> = ({
  isOpen,
  project,
  currentTimeSec,
  totalDurationSec,
  onClose,
  onSaveSections,
}) => {
  const safeDuration = Math.max(10, roundSectionSec(totalDurationSec || project.durationSec || 60));
  const [sections, setSectionsState] = useState<SongSection[]>(project.sections);
  const sectionsRef = useRef<SongSection[]>(project.sections);

  const setSections = (
    nextOrUpdater: SongSection[] | ((prev: SongSection[]) => SongSection[])
  ) => {
    setSectionsState((prev) => {
      const next =
        typeof nextOrUpdater === 'function' ? nextOrUpdater(prev) : nextOrUpdater;
      sectionsRef.current = next;
      return next;
    });
  };

  if (!isOpen) return null;

  /**
   * Sorts sections by startTimeSec and links each section's endTimeSec directly
   * to the next section's startTimeSec (and the last section to safeDuration),
   * so there are never gaps or overlaps between consecutive markers.
   */
  const sortAndRecalculateEndTimes = (list: SongSection[]): SongSection[] => {
    const minLen = 0.05;
    const sorted = [...list]
      .map((sec) => ({
        ...sec,
        startTimeSec: Math.max(
          0,
          Math.min(Math.max(0, safeDuration - minLen), roundSectionSec(sec.startTimeSec))
        ),
      }))
      .sort((a, b) => a.startTimeSec - b.startTimeSec);

    return sorted.map((sec, idx) => {
      const nextSec = sorted[idx + 1];
      const targetEnd = nextSec ? nextSec.startTimeSec : safeDuration;
      return {
        ...sec,
        endTimeSec: roundSectionSec(
          Math.max(sec.startTimeSec + minLen, Math.min(safeDuration, targetEnd))
        ),
      };
    });
  };

  const handleAddPresetAtTime = (
    preset: { name: string; code: string; color: string },
    atTimeSec: number
  ) => {
    const startSec = Math.max(0, Math.min(safeDuration - 0.1, roundSectionSec(atTimeSec)));
    const currentList = sectionsRef.current;

    const newSec: SongSection = {
      id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: preset.name,
      code: preset.code,
      color: preset.color,
      startTimeSec: startSec,
      endTimeSec: safeDuration,
      vampByDefault: false,
      cueName: preset.name,
    };

    setSections(sortAndRecalculateEndTimes([...currentList, newSec]));
  };

  const handleUpdateField = (
    id: string,
    field: keyof SongSection,
    value: string | number | boolean
  ) => {
    setSections((prev) => {
      if (field === 'startTimeSec' && typeof value === 'number') {
        const newStart = Math.max(0, Math.min(safeDuration - 0.1, roundSectionSec(value)));
        const updated = prev.map((s) =>
          s.id === id ? { ...s, startTimeSec: newStart } : s
        );
        return sortAndRecalculateEndTimes(updated);
      }

      if (field === 'endTimeSec' && typeof value === 'number') {
        const sorted = sortAndRecalculateEndTimes(prev);
        const idx = sorted.findIndex((s) => s.id === id);
        if (idx === -1) return prev;
        const target = sorted[idx];
        const newEnd = Math.max(
          target.startTimeSec + 0.05,
          Math.min(safeDuration, roundSectionSec(value))
        );
        const nextSec = sorted[idx + 1];
        if (nextSec) {
          // Moving the end of section `idx` moves the start of section `idx + 1` so no gap is left
          const updated = sorted.map((s, i) =>
            i === idx
              ? { ...s, endTimeSec: newEnd }
              : i === idx + 1
              ? { ...s, startTimeSec: newEnd }
              : s
          );
          return sortAndRecalculateEndTimes(updated);
        }
        return sorted.map((s, i) => (i === idx ? { ...s, endTimeSec: newEnd } : s));
      }

      return prev.map((s) => (s.id === id ? { ...s, [field]: value } : s));
    });
  };

  const handleRemoveSection = (id: string) => {
    setSections((prev) => sortAndRecalculateEndTimes(prev.filter((s) => s.id !== id)));
  };

  const handleSave = () => {
    const clean = sortAndRecalculateEndTimes(sectionsRef.current);
    onSaveSections(clean);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-studio-panel border border-neutral-800 rounded-2xl max-w-3xl w-full p-6 space-y-5 max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-neutral-100">
              Marcadores de Sección por Tiempo (Minutos y Segundos)
            </h2>
            <p className="text-xs text-neutral-400">
              Define en qué minuto y segundo (<code className="text-studio-ink">mm:ss</code>) empieza y termina cada parte de la canción.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-white p-1 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Playhead Quick Insert Box */}
        <div className="bg-studio-ground border border-neutral-800 rounded-xl p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-neutral-300">
              <Flag className="w-4 h-4 text-studio-ink" />
              <span>
                Insertar sección en la posición actual del cabezal:{' '}
                <strong className="text-studio-ink">
                  {formatSectionMmSs(currentTimeSec)}
                </strong>{' '}
                <span className="text-neutral-400">
                  (Duración total: {formatMmSs(safeDuration)})
                </span>
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {QUICK_SECTION_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => handleAddPresetAtTime(preset, currentTimeSec)}
                className="px-2.5 py-1 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 text-xs font-medium text-neutral-200 flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                <span
                  style={{ backgroundColor: preset.color }}
                  className="w-2 h-2 rounded-full"
                />
                <span>+ {preset.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Section List in MM:SS */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {sections.length === 0 ? (
            <div className="p-8 text-center border border-dashed border-neutral-800 rounded-xl text-xs text-neutral-400">
              Esta canción no tiene marcadores de sección. Usa los botones de arriba para añadir un marcador en el segundo actual del cabezal.
            </div>
          ) : (
            sections.map((sec) => (
              <div
                key={sec.id}
                className="bg-studio-ground border border-neutral-800 rounded-xl p-3 flex flex-wrap items-center gap-2.5"
              >
                <input
                  type="color"
                  value={sec.color}
                  onChange={(e) => handleUpdateField(sec.id, 'color', e.target.value)}
                  className="w-7 h-7 rounded bg-transparent border-0 cursor-pointer shrink-0"
                />

                <input
                  type="text"
                  value={sec.code}
                  maxLength={3}
                  onChange={(e) =>
                    handleUpdateField(sec.id, 'code', e.target.value.toUpperCase())
                  }
                  className="w-12 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-xs font-bold text-neutral-100 text-center"
                  title="Código corto (ej. IN, V1, CO)"
                />

                <input
                  type="text"
                  value={sec.name}
                  onChange={(e) => handleUpdateField(sec.id, 'name', e.target.value)}
                  className="flex-1 min-w-[130px] bg-neutral-900 border border-neutral-800 rounded px-2.5 py-1 text-xs text-neutral-100"
                  placeholder="Nombre de sección"
                />

                {/* Start Time MM:SS + Capture Playhead */}
                <div className="flex items-center gap-1 text-xs text-neutral-400">
                  <span>Inicio:</span>
                  <input
                    type="text"
                    defaultValue={formatSectionMmSs(sec.startTimeSec)}
                    key={`start-${sec.id}-${sec.startTimeSec}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    onBlur={(e) => {
                      const parsed = parseMmSsInput(e.target.value, sec.startTimeSec);
                      handleUpdateField(sec.id, 'startTimeSec', parsed);
                    }}
                    placeholder="00:00"
                    className="w-20 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-xs tabular-nums text-studio-ink text-center"
                    title="Formato mm:ss o mm:ss.d (ej. 01:14.35)"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      handleUpdateField(
                        sec.id,
                        'startTimeSec',
                        roundSectionSec(currentTimeSec)
                      )
                    }
                    title={`Fijar inicio en el cabezal actual (${formatSectionMmSs(currentTimeSec)})`}
                    className="px-1.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[11px] text-studio-ink flex items-center gap-1 cursor-pointer"
                  >
                    <Clock className="w-3 h-3" />
                    <span>Cabezal</span>
                  </button>
                </div>

                {/* End Time MM:SS */}
                <div className="flex items-center gap-1 text-xs text-neutral-400">
                  <span>Fin:</span>
                  <input
                    type="text"
                    defaultValue={formatSectionMmSs(sec.endTimeSec)}
                    key={`end-${sec.id}-${sec.endTimeSec}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    onBlur={(e) => {
                      const parsed = parseMmSsInput(e.target.value, sec.endTimeSec);
                      handleUpdateField(
                        sec.id,
                        'endTimeSec',
                        Math.max(sec.startTimeSec + 0.1, parsed)
                      );
                    }}
                    placeholder="00:30"
                    className="w-20 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-xs tabular-nums text-neutral-200 text-center"
                    title="Formato mm:ss o mm:ss.d (ej. 01:45.5)"
                  />
                </div>

                <button
                  type="button"
                  onClick={() =>
                    handleUpdateField(sec.id, 'vampByDefault', !sec.vampByDefault)
                  }
                  title="Repetir esta sección en bucle automáticamente"
                  className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 border cursor-pointer ${
                    sec.vampByDefault
                      ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400'
                  }`}
                >
                  <Repeat className="w-3 h-3" />
                  <span>Loop</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleRemoveSection(sec.id)}
                  title="Eliminar este marcador de sección"
                  className="p-1.5 rounded bg-neutral-900 hover:bg-red-500/20 text-neutral-400 hover:text-red-400 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-neutral-800">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                handleAddPresetAtTime(
                  {
                    name: `Sección ${sections.length + 1}`,
                    code: `S${sections.length + 1}`,
                    color: SECTION_COLORS[sections.length % SECTION_COLORS.length],
                  },
                  currentTimeSec
                )
              }
              className="px-3.5 py-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-xs font-semibold text-studio-ink flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Añadir en {formatSectionMmSs(currentTimeSec)}</span>
            </button>

            {sections.length > 0 && (
              <button
                type="button"
                onClick={() => setSections([])}
                className="px-3 py-2 rounded-lg bg-neutral-900 hover:bg-red-500/15 border border-neutral-800 text-xs font-medium text-neutral-400 hover:text-red-300 cursor-pointer"
              >
                Borrar todas
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs font-medium text-neutral-300 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-2 rounded-lg bg-studio-ink hover:bg-neutral-200 text-studio-ground text-xs font-semibold cursor-pointer"
            >
              Guardar Secciones (mm:ss)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export function inferTrackRoleAndColor(
  fileName: string,
  index: number
): Pick<TrackChannel, 'role' | 'color' | 'bus'> {
  const lower = (fileName || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (lower.includes('click') || lower.includes('metro')) {
    return { role: 'click', color: '#0891B2', bus: 'cue-click' };
  }
  if (lower.includes('guide') || lower.includes('cue') || lower.includes('guia')) {
    return { role: 'guide', color: '#0284C7', bus: 'cue-click' };
  }
  if (lower.includes('drum') || lower.includes('bateria') || lower.includes('kick')) {
    return { role: 'drums', color: '#D97706', bus: 'main' };
  }
  if (lower.includes('bass') || lower.includes('bajo') || lower.includes('sub')) {
    return { role: 'bass', color: '#DC2626', bus: 'main' };
  }
  if (lower.includes('key') || lower.includes('piano') || lower.includes('rhodes')) {
    return { role: 'keys', color: '#0891B2', bus: 'main' };
  }
  if (lower.includes('gtr') || lower.includes('guitar')) {
    return { role: 'guitar', color: '#059669', bus: 'main' };
  }
  if (lower.includes('vox') || lower.includes('choir') || lower.includes('coro')) {
    return { role: 'vox', color: '#DB2777', bus: 'main' };
  }
  const palette = ['#2563EB', '#7C3AED', '#059669', '#D97706', '#DB2777', '#0891B2'];
  return {
    role: 'custom',
    color: palette[index % palette.length],
    bus: 'main',
  };
}

interface OptimizationProgressModalProps {
  isOpen: boolean;
  songTitle: string;
  progress: PcmOptimizationProgress | null;
  onCancel: () => void;
  /** Hides the dialog; the job keeps running in the background */
  onHide?: () => void;
}

export const OptimizationProgressModal: React.FC<OptimizationProgressModalProps> = ({
  isOpen,
  songTitle,
  progress,
  onCancel,
  onHide,
}) => {
  if (!isOpen) return null;

  const percent = progress?.percent ?? 0;
  const isComplete = progress?.phase === 'complete';
  const isCancelled = progress?.phase === 'cancelled';

  return (
    <div className="fixed inset-0 z-50 bg-neutral-950/80 flex items-center justify-center p-4">
      <div className="bg-studio-panel border border-neutral-700 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-studio-strip text-studio-ink">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-neutral-100">
                Optimizar para Streaming OPFS
              </h2>
              <p className="text-xs text-neutral-400 truncate max-w-xs">{songTitle}</p>
            </div>
          </div>
          {!isComplete && !isCancelled && (
            <button
              type="button"
              onClick={onHide ?? onCancel}
              title={onHide ? 'Ocultar (sigue en segundo plano)' : 'Cancelar'}
              className="text-neutral-400 hover:text-neutral-200 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Status description */}
        <div className="bg-studio-ground border border-neutral-800 rounded-xl p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-300 font-semibold truncate max-w-[240px]">
              {progress?.phase === 'checking'
                ? 'Verificando almacenamiento...'
                : progress?.phase === 'converting'
                ? `Pista ${progress.currentTrackIndex}/${progress.totalTracks}: ${progress.trackName}`
                : progress?.phase === 'saving'
                ? 'Guardando configuración...'
                : progress?.phase === 'complete'
                ? '¡Listo! Audio optimizado en OPFS'
                : 'Cancelando...'}
            </span>
            <span className="text-studio-ink font-bold">{percent}%</span>
          </div>

          {/* Progress bar */}
          <div className="w-full h-2.5 bg-neutral-800 rounded-full overflow-hidden">
            <div
              className={`h-full transition-colors duration-200 rounded-full ${
                isComplete
                  ? 'bg-emerald-400'
                  : isCancelled
                  ? 'bg-red-400'
                  : 'bg-studio-accent'              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        <p className="text-[11px] text-neutral-400 leading-relaxed">
          Guarda cada pista una sola vez en el disco del navegador (OPFS) para reproducirla en streaming sin ocupar RAM. Se procesan varias pistas en paralelo; puedes cerrar esta ventana y seguirá en segundo plano.</p>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          {!isComplete && (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs font-semibold text-neutral-300 cursor-pointer transition-colors"
            >
              Cancelar
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
