import React, { useRef, useState } from 'react';
import {
  FolderOpen,
  Upload,
  Download,
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
    <div className="flex-1 bg-[#0B0F17] p-6 overflow-y-auto">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header & JSON Project Import/Export */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-100">
              Gestión de Repertorio y Copias de Seguridad
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Puedes arrastrar tus canciones desde el panel lateral hacia el DAW o al Modo Setlist.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <label className="px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-200 flex items-center gap-2 cursor-pointer transition-colors">
              <Upload className="w-4 h-4 text-cyan-400" />
              <span>Importar .libretracks.json</span>
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
              className="px-4 py-2 rounded-lg bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors"
            >
              <Music className="w-4 h-4" />
              <span>Importar Nueva Canción o Stems</span>
            </button>
          </div>
        </div>

        {/* Grid of Saved & Demo Projects + Create New Project Form */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Saved Songs List (8 cols) */}
          <div className="lg:col-span-8 space-y-3">
            <h2 className="font-display text-base font-semibold text-slate-200">
              Canciones en tu Biblioteca ({projects.length})
            </h2>

            <div className="space-y-3">
              {projects.map((proj) => {
                const isCurrent = proj.id === currentProjectId;
                const durSec =
                  proj.durationSec || ((proj.totalBars || 24) * 4 * 60) / (proj.bpm || 120);
                const isPcmReady = audioEngine.isProjectPcmReady(proj);
                const pcmMB = audioEngine.getProjectPcmEstimatedMB(proj);

                return (
                  <div
                    key={proj.id}
                    className={`p-4 rounded-xl border transition-colors flex flex-wrap items-center justify-between gap-4 ${
                      isCurrent
                        ? 'bg-[#111827] border-cyan-500/60'
                        : 'bg-[#111827]/70 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-display text-base font-bold text-slate-100 truncate">
                          {proj.title}
                        </h3>
                        {isCurrent && (
                          <span className="text-xs font-medium text-cyan-400 flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> En el DAW
                          </span>
                        )}
                        {/* OPFS Streaming PCM Status Badge */}
                        {isPcmReady ? (
                          <span
                            title={`Audio PCM Int16 optimizado en OPFS (~${pcmMB} MB en disco). Carga rápida y streaming por ventanas.`}
                            className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1"
                          >
                            <HardDrive className="w-3 h-3" />
                            <span>PCM listo ({pcmMB} MB)</span>
                          </span>
                        ) : (
                          <span
                            title="Esta canción aún no tiene archivos PCM generados en OPFS. Pulsa 'Optimizar' para generar PCM en disco."
                            className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1"
                          >
                            <span>Sin optimizar</span>
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-1">
                        <span>{proj.artist}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{formatMmSs(durSec)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{proj.bpm} BPM</span>
                        <span aria-hidden="true">·</span>
                        <span>{proj.keySignature}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {proj.tracks.length} pistas
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {proj.sections.length} marcadores
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {/* Relink original files (moved/renamed folder or permission lost) */}
                      {!isPcmReady && onRelinkProject && isFsAccessSupported() && (
                        <button
                          type="button"
                          onClick={() => onRelinkProject(proj)}
                          title="Elegir la carpeta donde están ahora los stems originales de esta canción"
                          className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                        >
                          <FolderPlus className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Reubicar archivos</span>
                        </button>
                      )}

                      {/* Optimize for Streaming Button if not yet optimized */}
                      {!isPcmReady && proj.tracks.length > 0 && (
                        <button
                          type="button"
                          onClick={() => onOptimizeProject(proj)}
                          title="Convertir stems a PCM estéreo Int16 en OPFS para streaming estilo REAPER"
                          className="px-3 py-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/40 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                        >
                          <Zap className="w-3.5 h-3.5 text-cyan-400" />
                          <span>Optimizar para streaming</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => onAddToSetlist(proj.id)}
                        className="px-3 py-2 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/40 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                      >
                        <ListMusic className="w-3.5 h-3.5" />
                        <span>+ Setlist</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => onSelectProject(proj.id)}
                        className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors ${
                          isCurrent
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
                            : 'bg-cyan-400 text-slate-950 hover:bg-cyan-300'
                        }`}
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                        <span>{isCurrent ? 'Abierto en Consola' : 'Cargar en DAW'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => onExportJson(proj)}
                        title="Exportar configuración del proyecto en JSON"
                        className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 cursor-pointer"
                      >
                        <Download className="w-4 h-4" />
                      </button>

                      <button
                        type="button"
                        onClick={() => onDeleteProject(proj.id)}
                        title="Eliminar proyecto de la biblioteca"
                        className="p-2 rounded-lg bg-slate-900 hover:bg-red-500/20 text-slate-400 hover:text-red-400 border border-slate-800 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Create New Song Project Card (4 cols) */}
          <form
            onSubmit={handleCreate}
            className="lg:col-span-4 bg-[#111827] border border-slate-800 rounded-xl p-5 space-y-4"
          >
            <h2 className="font-display text-base font-bold text-slate-100">
              Crear Nueva Canción Multipista
            </h2>
            <p className="text-xs text-slate-400">
              Inicia una sesión vacía o suelta directamente tus archivos de audio para crearla.
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Título de la Canción
              </label>
              <input
                type="text"
                required
                placeholder="Ej. Amanecer Eléctrico (Live)"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Artista / Ensamble
              </label>
              <input
                type="text"
                placeholder="Ej. Banda Principal"
                value={newArtist}
                onChange={(e) => setNewArtist(e.target.value)}
                className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Tempo (BPM)
                </label>
                <input
                  type="number"
                  min={50}
                  max={220}
                  value={newBpm}
                  onChange={(e) => setNewBpm(Number(e.target.value))}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Tonalidad
                </label>
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-semibold text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
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
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#111827] border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center shrink-0">
              <Music className="w-5 h-5 text-cyan-400" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold text-slate-100">
                {song.title}
              </h2>
              <p className="text-xs text-slate-400">
                {song.artist} · {formatMmSs(durSec)} · {song.bpm} BPM · {song.keySignature}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="bg-[#0B0F17] border border-slate-800 rounded-xl p-3.5 text-xs text-slate-300 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Pistas multipista incluidas:</span>
            <span className="font-mono font-bold text-cyan-300">
              {song.tracks.length} stems
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Marcadores de sección:</span>
            <span className="font-mono font-bold text-slate-200">
              {song.sections.length}
            </span>
          </div>
        </div>

        <p className="text-xs text-slate-400">
          ¿Confirmas que deseas montar esta canción en el DAW ahora, o prefieres enviarla a la cola del Modo Setlist?
        </p>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
          <button
            type="button"
            onClick={() => {
              onConfirmLoadInDaw(song.id);
              onClose();
            }}
            className="flex-1 py-2.5 px-4 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 cursor-pointer transition-colors"
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
            className="py-2.5 px-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium cursor-pointer transition-colors"
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
}

export const StemImporterModal: React.FC<StemImporterModalProps> = ({
  isOpen,
  onClose,
  onImportFiles,
}) => {
  const [defaultBus, setDefaultBus] = useState<OutputBus>('main');
  const [importMode, setImportMode] = useState<'new-song' | 'current-song'>('new-song');
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#111827] border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-bold text-slate-100">
            Importación Instantánea de Canción o Stems
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Selection: Create New Song vs Add to Current */}
        <div className="grid grid-cols-2 gap-2 bg-[#0B0F17] p-1 rounded-xl border border-slate-800">
          <button
            type="button"
            onClick={() => setImportMode('new-song')}
            className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
              importMode === 'new-song'
                ? 'bg-slate-800 text-cyan-300 shadow-2xs'
                : 'text-slate-400'
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
                ? 'bg-slate-800 text-cyan-300 shadow-2xs'
                : 'text-slate-400'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Añadir a Canción Actual</span>
          </button>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          Selecciona tus pistas (<code className="text-slate-200">.wav</code>,{' '}
          <code className="text-slate-200">.mp3</code>,{' '}
          <code className="text-slate-200">.ogg</code>,{' '}
          <code className="text-slate-200">.flac</code>,{' '}
          <code className="text-slate-200">.m4a</code>). La canción se cargará limpia con su duración real en minutos y segundos.
        </p>

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1.5">
            Bus de Salida Predeterminado
          </label>
          <select
            value={defaultBus}
            onChange={(e) => setDefaultBus(e.target.value as OutputBus)}
            className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
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
              if (!isFsAccessSupported()) return;
              e.preventDefault();
              pickAudioSources('files', null, (files) => {
                onClose();
                onImportFiles(files, defaultBus, importMode);
              });
            }}
            className="border-2 border-dashed border-slate-700 hover:border-cyan-400 rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors bg-[#0B0F17]/60"
          >
            <Upload className="w-7 h-7 text-cyan-400 mb-2" />
            <span className="text-xs font-bold text-slate-200">
              Elegir Archivos de Audio
            </span>
            <span className="text-[11px] text-slate-400 mt-1">
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
            onClick={() =>
              pickAudioSources('folder', folderInputRef.current, (files) => {
                onClose();
                onImportFiles(files, defaultBus, importMode);
              })
            }
            className="border-2 border-dashed border-slate-700 hover:border-cyan-400 rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors bg-[#0B0F17]/60"
          >
            <FolderPlus className="w-7 h-7 text-emerald-400 mb-2" />
            <span className="text-xs font-bold text-slate-200">
              Importar Carpeta Completa
            </span>
            <span className="text-[11px] text-slate-400 mt-1">
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
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 cursor-pointer"
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

function parseMmSsInput(text: string, fallbackSec: number): number {
  const clean = text.trim();
  if (!clean) return fallbackSec;
  if (clean.includes(':')) {
    const [mStr, sStr] = clean.split(':');
    const mins = Number(mStr) || 0;
    const secs = Number(sStr) || 0;
    return Math.max(0, mins * 60 + secs);
  }
  const num = Number(clean);
  return Number.isNaN(num) ? fallbackSec : Math.max(0, num);
}

export const SectionEditorModal: React.FC<SectionEditorModalProps> = ({
  isOpen,
  project,
  currentTimeSec,
  totalDurationSec,
  onClose,
  onSaveSections,
}) => {
  const safeDuration = Math.max(10, Math.round(totalDurationSec || project.durationSec || 60));
  const [sections, setSections] = useState<SongSection[]>(project.sections);

  if (!isOpen) return null;

  /**
   * Sorts sections by startTimeSec and ensures each section's endTimeSec connects cleanly
   * if overlapping or beyond totalDurationSec.
   */
  const sortAndRecalculateEndTimes = (list: SongSection[]): SongSection[] => {
    const sorted = [...list].sort((a, b) => a.startTimeSec - b.startTimeSec);
    return sorted.map((sec, idx) => {
      const nextSec = sorted[idx + 1];
      const defaultEnd = nextSec ? nextSec.startTimeSec : safeDuration;
      const validEnd =
        sec.endTimeSec > sec.startTimeSec && sec.endTimeSec <= safeDuration
          ? sec.endTimeSec
          : Math.max(sec.startTimeSec + 1, defaultEnd);
      return {
        ...sec,
        startTimeSec: Math.max(0, Math.min(safeDuration - 1, Math.round(sec.startTimeSec))),
        endTimeSec: Math.max(
          Math.round(sec.startTimeSec) + 1,
          Math.min(safeDuration, Math.round(validEnd))
        ),
      };
    });
  };

  const handleAddPresetAtTime = (
    preset: { name: string; code: string; color: string },
    atTimeSec: number
  ) => {
    const startSec = Math.max(0, Math.min(safeDuration - 2, Math.round(atTimeSec)));
    const newSec: SongSection = {
      id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: preset.name,
      code: preset.code,
      color: preset.color,
      startTimeSec: startSec,
      endTimeSec: Math.min(safeDuration, startSec + 15),
      vampByDefault: false,
      cueName: preset.name,
    };

    // Update previous section's endTimeSec if it covered this split point
    const adjusted = sections.map((s) => {
      if (s.startTimeSec < startSec && s.endTimeSec > startSec) {
        return { ...s, endTimeSec: startSec };
      }
      return s;
    });

    setSections(sortAndRecalculateEndTimes([...adjusted, newSec]));
  };

  const handleUpdateField = (
    id: string,
    field: keyof SongSection,
    value: string | number | boolean
  ) => {
    setSections((prev) =>
       prev.map((s) => (s.id === id ? { ...s, [field]: value } : s))
    );
  };

  const handleRemoveSection = (id: string) => {
    setSections((prev) => prev.filter((s) => s.id !== id));
  };

  const handleSave = () => {
    const clean = sortAndRecalculateEndTimes(sections);
    onSaveSections(clean);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#111827] border border-slate-800 rounded-2xl max-w-3xl w-full p-6 space-y-5 max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-slate-100">
              Marcadores de Sección por Tiempo (Minutos y Segundos)
            </h2>
            <p className="text-xs text-slate-400">
              Define en qué minuto y segundo (<code className="text-cyan-300">mm:ss</code>) empieza y termina cada parte de la canción.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Playhead Quick Insert Box */}
        <div className="bg-[#0B0F17] border border-slate-800 rounded-xl p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <Flag className="w-4 h-4 text-cyan-400" />
              <span>
                Insertar sección en la posición actual del cabezal:{' '}
                <strong className="font-mono text-cyan-300">
                  {formatMmSs(currentTimeSec)}
                </strong>{' '}
                <span className="text-slate-500">
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
                className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer transition-colors"
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
            <div className="p-8 text-center border border-dashed border-slate-800 rounded-xl text-xs text-slate-400">
              Esta canción no tiene marcadores de sección. Usa los botones de arriba para añadir un marcador en el segundo actual del cabezal.
            </div>
          ) : (
            sections.map((sec) => (
              <div
                key={sec.id}
                className="bg-[#0B0F17] border border-slate-800 rounded-xl p-3 flex flex-wrap items-center gap-2.5"
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
                  className="w-12 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs font-mono font-bold text-slate-100 text-center"
                  title="Código corto (ej. IN, V1, CO)"
                />

                <input
                  type="text"
                  value={sec.name}
                  onChange={(e) => handleUpdateField(sec.id, 'name', e.target.value)}
                  className="flex-1 min-w-[130px] bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-xs text-slate-100"
                  placeholder="Nombre de sección"
                />

                {/* Start Time MM:SS + Capture Playhead */}
                <div className="flex items-center gap-1 text-xs text-slate-400">
                  <span>Inicio:</span>
                  <input
                    type="text"
                    defaultValue={formatMmSs(sec.startTimeSec)}
                    key={`start-${sec.id}-${sec.startTimeSec}`}
                    onBlur={(e) => {
                      const parsed = parseMmSsInput(e.target.value, sec.startTimeSec);
                      handleUpdateField(sec.id, 'startTimeSec', parsed);
                    }}
                    placeholder="00:00"
                    className="w-15 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs font-mono tabular-nums text-cyan-300 text-center"
                    title="Formato mm:ss (ej. 01:15)"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      handleUpdateField(
                        sec.id,
                        'startTimeSec',
                        Math.round(currentTimeSec)
                      )
                    }
                    title={`Fijar inicio en el cabezal actual (${formatMmSs(currentTimeSec)})`}
                    className="px-1.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-cyan-300 flex items-center gap-1 cursor-pointer"
                  >
                    <Clock className="w-3 h-3" />
                    <span>Cabezal</span>
                  </button>
                </div>

                {/* End Time MM:SS */}
                <div className="flex items-center gap-1 text-xs text-slate-400">
                  <span>Fin:</span>
                  <input
                    type="text"
                    defaultValue={formatMmSs(sec.endTimeSec)}
                    key={`end-${sec.id}-${sec.endTimeSec}`}
                    onBlur={(e) => {
                      const parsed = parseMmSsInput(e.target.value, sec.endTimeSec);
                      handleUpdateField(
                        sec.id,
                        'endTimeSec',
                        Math.max(sec.startTimeSec + 1, parsed)
                      );
                    }}
                    placeholder="00:30"
                    className="w-15 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs font-mono tabular-nums text-slate-200 text-center"
                    title="Formato mm:ss (ej. 01:45)"
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
                      : 'bg-slate-900 border-slate-800 text-slate-400'
                  }`}
                >
                  <Repeat className="w-3 h-3" />
                  <span>Loop</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleRemoveSection(sec.id)}
                  title="Eliminar este marcador de sección"
                  className="p-1.5 rounded bg-slate-900 hover:bg-red-500/20 text-slate-400 hover:text-red-400 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-800">
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
              className="px-3.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-cyan-400 flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Añadir en {formatMmSs(currentTimeSec)}</span>
            </button>

            {sections.length > 0 && (
              <button
                type="button"
                onClick={() => setSections([])}
                className="px-3 py-2 rounded-lg bg-slate-900 hover:bg-red-500/15 border border-slate-800 text-xs font-medium text-slate-400 hover:text-red-300 cursor-pointer"
              >
                Borrar todas
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-2 rounded-lg bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-semibold cursor-pointer"
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
  const lower = fileName.toLowerCase();
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
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#111827] border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/20 text-cyan-400">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold text-slate-100">
                Optimizar para Streaming OPFS
              </h2>
              <p className="text-xs text-slate-400 truncate max-w-xs">{songTitle}</p>
            </div>
          </div>
          {!isComplete && !isCancelled && (
            <button
              type="button"
              onClick={onHide ?? onCancel}
              title={onHide ? 'Ocultar (sigue en segundo plano)' : 'Cancelar'}
              className="text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Status description */}
        <div className="bg-[#0B0F17] border border-slate-800 rounded-xl p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-slate-300 font-semibold truncate max-w-[240px]">
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
            <span className="text-cyan-400 font-bold">{percent}%</span>
          </div>

          {/* Progress bar */}
          <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-200 rounded-full ${
                isComplete
                  ? 'bg-emerald-400'
                  : isCancelled
                  ? 'bg-red-400'
                  : 'bg-gradient-to-r from-cyan-500 to-emerald-400'
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed">
          Guarda cada pista una sola vez en el disco del navegador (OPFS) para reproducirla en streaming sin ocupar RAM. Se procesan varias pistas en paralelo; puedes cerrar esta ventana y seguirá en segundo plano.</p>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          {!isComplete && (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 cursor-pointer transition-colors"
            >
              Cancelar
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

