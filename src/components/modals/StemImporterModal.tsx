import React, { useRef, useState } from 'react';
import { Upload, Plus, Music, FolderPlus } from 'lucide-react';
import { OutputBus } from '../../types/project';
import { isFsAccessSupported, pickAudioSources } from '../../storage/sourceFiles';
import { isDesktopApp, pickNativeFiles, pickNativeFolder } from '../../utils/nativeDialog';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';

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
  // Los instrumentos van siempre a Main; solo Click y Guía van a Cue (lo decide el asistente por el instrumento).
  const defaultBus: OutputBus = 'main';
  const [importMode, setImportMode] = useState<'new-song' | 'current-song'>('new-song');
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  return (
    <Dialog label="Importación instantánea de canción o stems" onClose={onClose} size="md">
      <DialogHeader title="Importación instantánea de canción o stems" onClose={onClose} />
      <DialogBody>
        {/* Crear una canción nueva o añadir a la actual */}
        <div className="lt-segmented" role="group" aria-label="Destino de la importación">
          <button type="button" className="lt-control" aria-pressed={importMode === 'new-song'} onClick={() => setImportMode('new-song')}>
            <Music size={15} aria-hidden="true" />
            <span>Crear canción nueva</span>
          </button>
          <button type="button" className="lt-control" aria-pressed={importMode === 'current-song'} onClick={() => setImportMode('current-song')}>
            <Plus size={15} aria-hidden="true" />
            <span>Añadir a canción actual</span>
          </button>
        </div>

        <p className="lt-dialog-note">
          Selecciona tus pistas (<code>.wav</code>, <code>.mp3</code>, <code>.ogg</code>, <code>.flac</code>, <code>.m4a</code>). La canción se cargará limpia con su duración real en minutos y segundos.
        </p>

        <div className="lt-dropzones">
          {/* Selector de archivos */}
          <label
            className="lt-dropzone"
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
          >
            <Upload size={26} aria-hidden="true" />
            <strong>Elegir archivos de audio</strong>
            <span>Selección múltiple (.wav, .mp3...)</span>
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

          {/* Selector de carpeta */}
          <button
            type="button"
            data-autofocus
            className="lt-dropzone"
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
          >
            <FolderPlus size={26} aria-hidden="true" />
            <strong>Importar carpeta completa</strong>
            <span>Detecta título y todos los stems</span>
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
      </DialogBody>
      <DialogFooter>
        <button type="button" onClick={onClose} className="lt-control">
          Cerrar
        </button>
      </DialogFooter>
    </Dialog>
  );
};
