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
  Wand2,
} from 'lucide-react';
import { OutputBus, SongProject, SongSection, TrackChannel } from '../types/project';

interface LibraryViewProps {
  projects: SongProject[];
  currentProjectId: string;
  onSelectProject: (projectId: string) => void;
  onCreateNewProject: (title: string, artist: string, bpm: number, keySig: string) => void;
  onDeleteProject: (projectId: string) => void;
  onExportJson: (project: SongProject) => void;
  onImportJsonFile: (file: File) => void;
  onOpenStemImporter: () => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  projects,
  currentProjectId,
  onSelectProject,
  onCreateNewProject,
  onDeleteProject,
  onExportJson,
  onImportJsonFile,
  onOpenStemImporter,
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
    <div className="flex-1 bg-slate-50 dark:bg-[#0B0F17] p-6 overflow-y-auto">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header & JSON Project Import/Export */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
              Gestión de Repertorio y Copias de Seguridad
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Todas tus canciones también están accesibles desde el árbol de repertorio lateral izquierdo.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <label className="px-4 py-2 rounded-lg bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-2 cursor-pointer transition-colors">
              <Upload className="w-4 h-4 text-sky-600 dark:text-cyan-400" />
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
              className="px-4 py-2 rounded-lg bg-sky-600 dark:bg-cyan-400 hover:bg-sky-500 dark:hover:bg-cyan-300 text-white dark:text-slate-950 text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors"
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
            <h2 className="font-display text-base font-semibold text-slate-800 dark:text-slate-200">
              Canciones en tu Biblioteca ({projects.length})
            </h2>

            <div className="space-y-3">
              {projects.map((proj) => {
                const isCurrent = proj.id === currentProjectId;
                return (
                  <div
                    key={proj.id}
                    className={`p-4 rounded-xl border transition-colors flex flex-wrap items-center justify-between gap-4 ${
                      isCurrent
                        ? 'bg-white dark:bg-[#111827] border-sky-500 dark:border-cyan-500/60'
                        : 'bg-white/80 dark:bg-[#111827]/70 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-display text-base font-bold text-slate-900 dark:text-slate-100 truncate">
                          {proj.title}
                        </h3>
                        {isCurrent && (
                          <span className="text-xs font-medium text-sky-600 dark:text-cyan-400 flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Activo
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mt-1">
                        <span>{proj.artist}</span>
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
                          {proj.sections.length} secciones ({proj.totalBars} comp.)
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onSelectProject(proj.id)}
                        className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors ${
                          isCurrent
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40'
                            : 'bg-sky-600 dark:bg-cyan-400 text-white dark:text-slate-950 hover:bg-sky-500'
                        }`}
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                        <span>{isCurrent ? 'Abierto en Consola' : 'Cargar Canción'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => onExportJson(proj)}
                        title="Exportar configuración del proyecto en JSON"
                        className="p-2 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-800 cursor-pointer"
                      >
                        <Download className="w-4 h-4" />
                      </button>

                      {projects.length > 1 && (
                        <button
                          type="button"
                          onClick={() => onDeleteProject(proj.id)}
                          title="Eliminar proyecto"
                          className="p-2 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-red-100 dark:hover:bg-red-500/20 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 border border-slate-200 dark:border-slate-800 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Create New Song Project Card (4 cols) */}
          <form
            onSubmit={handleCreate}
            className="lg:col-span-4 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
          >
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-slate-100">
              Crear Nueva Canción Multipista
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Inicia una sesión con estructura base o suelta directamente tus archivos de audio para crearla automáticamente.
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Título de la Canción
              </label>
              <input
                type="text"
                required
                placeholder="Ej. Amanecer Eléctrico (Live)"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="w-full bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Artista / Ensamble
              </label>
              <input
                type="text"
                placeholder="Ej. Banda Principal"
                value={newArtist}
                onChange={(e) => setNewArtist(e.target.value)}
                className="w-full bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Tempo (BPM)
                </label>
                <input
                  type="number"
                  min={50}
                  max={220}
                  value={newBpm}
                  onChange={(e) => setNewBpm(Number(e.target.value))}
                  className="w-full bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Tonalidad
                </label>
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-sky-600 dark:bg-cyan-400 hover:bg-sky-500 dark:hover:bg-cyan-300 text-white dark:text-slate-950 font-semibold text-xs rounded-lg flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
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
 * INSTANT STEM & FOLDER IMPORTER MODAL
 * ============================================================================ */

interface StemImporterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportFiles: (
    files: FileList,
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
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-slate-100">
            Importación Instantánea de Canción o Stems
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-800 dark:hover:text-white p-1 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Selection: Create New Song Automatically (Default) vs Add to Current */}
        <div className="grid grid-cols-2 gap-2 bg-slate-100 dark:bg-[#0B0F17] p-1 rounded-xl border border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={() => setImportMode('new-song')}
            className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
              importMode === 'new-song'
                ? 'bg-white dark:bg-slate-800 text-sky-700 dark:text-cyan-300 shadow-2xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Wand2 className="w-3.5 h-3.5" />
            <span>Crear Canción Nueva (Auto)</span>
          </button>
          <button
            type="button"
            onClick={() => setImportMode('current-song')}
            className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
              importMode === 'current-song'
                ? 'bg-white dark:bg-slate-800 text-sky-700 dark:text-cyan-300 shadow-2xs'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Añadir a Canción Actual</span>
          </button>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          Selecciona tus pistas (<code className="text-slate-800 dark:text-slate-200">.wav</code>,{' '}
          <code className="text-slate-800 dark:text-slate-200">.mp3</code>,{' '}
          <code className="text-slate-800 dark:text-slate-200">.ogg</code>,{' '}
          <code className="text-slate-800 dark:text-slate-200">.flac</code>,{' '}
          <code className="text-slate-800 dark:text-slate-200">.m4a</code>). La canción se abrirá{' '}
          <strong className="text-slate-800 dark:text-slate-200">de inmediato</strong> calculando automáticamente los compases y las secciones musicales.
        </p>

        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
            Bus de Salida Predeterminado
          </label>
          <select
            value={defaultBus}
            onChange={(e) => setDefaultBus(e.target.value as OutputBus)}
            className="w-full bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500"
          >
            <option value="main">Main L/R (Pistas Click/Guide van a Cue automáticamente)</option>
            <option value="cue-click">Click / Cue Bus (Solo Monitoreo)</option>
            <option value="both">Ambos Buses (Main + Cue)</option>
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Multi-file Picker */}
          <label className="border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-sky-500 dark:hover:border-cyan-400 rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors bg-slate-50 dark:bg-[#0B0F17]/60">
            <Upload className="w-7 h-7 text-sky-600 dark:text-cyan-400 mb-2" />
            <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
              Elegir Archivos de Audio
            </span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              Selección múltiple (.wav, .mp3...)
            </span>
            <input
              type="file"
              multiple
              accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  const selected = e.target.files;
                  onClose();
                  onImportFiles(selected, defaultBus, importMode);
                }
              }}
            />
          </label>

          {/* Directory / Folder Picker */}
          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            className="border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-sky-500 dark:hover:border-cyan-400 rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors bg-slate-50 dark:bg-[#0B0F17]/60"
          >
            <FolderPlus className="w-7 h-7 text-emerald-600 dark:text-emerald-400 mb-2" />
            <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
              Importar Carpeta Completa
            </span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              Detecta título y todos los stems
            </span>
          </button>

          <input
            ref={folderInputRef}
            type="file"
            multiple
            // @ts-expect-error webkitdirectory is standard for folder selection
            webkitdirectory="true"
            directory="true"
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                const selected = e.target.files;
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
            className="px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * SECTION ARRANGEMENT EDITOR MODAL
 * ============================================================================ */

interface SectionEditorModalProps {
  isOpen: boolean;
  project: SongProject;
  onClose: () => void;
  onSaveSections: (sections: SongSection[], totalBars: number) => void;
}

const SECTION_COLORS = [
  '#0891B2',
  '#2563EB',
  '#059669',
  '#D97706',
  '#7C3AED',
  '#DB2777',
  '#DC2626',
];

export const SectionEditorModal: React.FC<SectionEditorModalProps> = ({
  isOpen,
  project,
  onClose,
  onSaveSections,
}) => {
  const [sections, setSections] = useState<SongSection[]>(project.sections);

  if (!isOpen) return null;

  const recalculateStartBars = (list: SongSection[]) => {
    let runningBar = 1;
    return list.map((sec) => {
      const updated = { ...sec, startBar: runningBar };
      runningBar += Math.max(1, sec.lengthBars);
      return updated;
    });
  };

  const handleAddSection = () => {
    const nextIdx = sections.length + 1;
    const newSec: SongSection = {
      id: `sec-${Date.now()}`,
      name: `Sección ${nextIdx}`,
      code: `S${nextIdx}`,
      color: SECTION_COLORS[sections.length % SECTION_COLORS.length],
      startBar: 1,
      lengthBars: 4,
      vampByDefault: false,
      cueName: `Section ${nextIdx}`,
    };
    setSections(recalculateStartBars([...sections, newSec]));
  };

  const handleUpdateField = (
    id: string,
    field: keyof SongSection,
    value: string | number | boolean
  ) => {
    const updated = sections.map((s) => (s.id === id ? { ...s, [field]: value } : s));
    setSections(recalculateStartBars(updated));
  };

  const handleRemoveSection = (id: string) => {
    if (sections.length <= 1) return;
    setSections(recalculateStartBars(sections.filter((s) => s.id !== id)));
  };

  const handleSave = () => {
    const normalized = recalculateStartBars(sections);
    const last = normalized[normalized.length - 1];
    const totalBars = last ? last.startBar + last.lengthBars - 1 : 16;
    onSaveSections(normalized, totalBars);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full p-6 space-y-5 max-h-[88vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-lg font-bold text-slate-900 dark:text-slate-100">
              Editor de Estructura de Secciones y Vamps
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Define los compases de cada sección y cuáles entran en bucle automático (Vamp).
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-800 dark:hover:text-white p-1 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
          {sections.map((sec) => (
            <div
              key={sec.id}
              className="bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-slate-800 rounded-xl p-3 flex flex-wrap items-center gap-3"
            >
              <input
                type="color"
                value={sec.color}
                onChange={(e) => handleUpdateField(sec.id, 'color', e.target.value)}
                className="w-7 h-7 rounded bg-transparent border-0 cursor-pointer"
              />

              <input
                type="text"
                value={sec.code}
                maxLength={3}
                onChange={(e) => handleUpdateField(sec.id, 'code', e.target.value.toUpperCase())}
                className="w-12 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded px-2 py-1 text-xs font-mono font-bold text-slate-900 dark:text-slate-100 text-center"
                title="Código corto (ej. IN, V1, CH)"
              />

              <input
                type="text"
                value={sec.name}
                onChange={(e) => handleUpdateField(sec.id, 'name', e.target.value)}
                className="flex-1 min-w-[140px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded px-2.5 py-1 text-xs text-slate-900 dark:text-slate-100"
                placeholder="Nombre de sección"
              />

              <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <span>Compases:</span>
                <input
                  type="number"
                  min={1}
                  max={128}
                  value={sec.lengthBars}
                  onChange={(e) =>
                    handleUpdateField(sec.id, 'lengthBars', Math.max(1, Number(e.target.value)))
                  }
                  className="w-14 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded px-2 py-1 text-xs font-mono tabular-nums text-slate-900 dark:text-slate-100 text-right"
                />
              </div>

              <button
                type="button"
                onClick={() => handleUpdateField(sec.id, 'vampByDefault', !sec.vampByDefault)}
                className={`px-2.5 py-1 rounded text-xs font-medium flex items-center gap-1 border cursor-pointer ${
                  sec.vampByDefault
                    ? 'bg-amber-500/20 border-amber-500 text-amber-800 dark:text-amber-300'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400'
                }`}
              >
                <Repeat className="w-3 h-3" />
                <span>Auto-Vamp</span>
              </button>

              <button
                type="button"
                onClick={() => handleRemoveSection(sec.id)}
                disabled={sections.length <= 1}
                className="p-1.5 rounded bg-white dark:bg-slate-900 hover:bg-red-100 dark:hover:bg-red-500/20 text-slate-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-30 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={handleAddSection}
            className="px-3.5 py-2 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-sky-600 dark:text-cyan-400 flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Añadir Sección</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-2 rounded-lg bg-sky-600 dark:bg-cyan-400 hover:bg-sky-500 dark:hover:bg-cyan-300 text-white dark:text-slate-950 text-xs font-semibold cursor-pointer"
            >
              Guardar Estructura
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
