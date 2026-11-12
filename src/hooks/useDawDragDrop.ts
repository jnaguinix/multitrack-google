import React from 'react';
import { extractAudioFilesWithHandlesFromDataTransfer } from '../storage/sourceFiles';
import { extractAudioFilesFromDataTransfer } from '../utils/fileImportHelper';
import { OutputBus } from '../types/project';

interface UseDawDragDropDeps {
  setDragOverlayMode: (mode: 'files' | 'repertoire-song' | null) => void;
  handleAddToSetlist: (songId: string) => void;
  handleLoadProjectImmediately: (songId: string, autoPlay?: boolean) => void;
  isDesktopApp: boolean;
  handleImportNative: (
    source: { folderPath?: string; filePaths?: string[] },
    defaultBus?: OutputBus,
    importMode?: 'new-song' | 'current-song'
  ) => Promise<void>;
  handleInstantImportFiles: (
    fileList: FileList | File[],
    defaultBus?: OutputBus,
    importMode?: 'new-song' | 'current-song'
  ) => Promise<void>;
  showToast: (msg: string) => void;
}

export function useDawDragDrop({
  setDragOverlayMode,
  handleAddToSetlist,
  handleLoadProjectImmediately,
  isDesktopApp,
  handleImportNative,
  handleInstantImportFiles,
  showToast,
}: UseDawDragDropDeps) {
  // Drag-and-Drop on DAW Workspace (Handles both Repertoire Song Drag & Audio File Drag)
  const handleDragOverDaw = (e: React.DragEvent) => {
    e.preventDefault();
    if (
      e.dataTransfer.types.includes('application/x-omnitracks-song-id') &&
      !e.dataTransfer.types.includes('application/x-omnitracks-setlist-index')
    ) {
      setDragOverlayMode('repertoire-song');
    } else if (e.dataTransfer.types.includes('Files')) {
      setDragOverlayMode('files');
    }
  };

  const handleDragLeaveDaw = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) {
      setDragOverlayMode(null);
    }
  };

  const handleDropOnDaw = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverlayMode(null);

    const songId = e.dataTransfer.getData('application/x-omnitracks-song-id');
    if (songId) {
      handleAddToSetlist(songId);
      handleLoadProjectImmediately(songId, false);
      return;
    }

    // Start both extractors synchronously (DataTransfer is only valid during the event)
    const withHandles = extractAudioFilesWithHandlesFromDataTransfer(e.dataTransfer);
    const classic = extractAudioFilesFromDataTransfer(e.dataTransfer);
    const handleFiles = await withHandles;
    const audioFiles = handleFiles.length > 0 ? handleFiles : await classic;
    if (audioFiles.length > 0) {
      const hasPaths = audioFiles.some((f) => Boolean((f as any).path));
      if (isDesktopApp && hasPaths) {
        const filePaths = audioFiles.map((f) => (f as any).path as string).filter(Boolean);
        if (filePaths.length > 0) {
          handleImportNative({ filePaths }, 'main', 'new-song');
          return;
        }
      }
      handleInstantImportFiles(audioFiles, 'main', 'new-song');
    } else {
      showToast('No se encontraron archivos de audio compatibles (.wav, .mp3, .ogg, .flac, .m4a)');
    }
  };

  return {
    handleDragOverDaw,
    handleDragLeaveDaw,
    handleDropOnDaw,
  };
}
