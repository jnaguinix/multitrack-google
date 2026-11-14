import React, { useRef, useState } from 'react';
import { Upload, Plus, X, Music, FolderPlus } from 'lucide-react';
import { OutputBus } from '../../types/project';
import { isFsAccessSupported, pickAudioSources } from '../../storage/sourceFiles';
import { isDesktopApp, pickNativeFiles, pickNativeFolder } from '../../utils/nativeDialog';

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
            <span className="text-xs text-neutral-400 mt-1">
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
            <span className="text-xs text-neutral-400 mt-1">
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
