import React from 'react';
import { AlertTriangle, FolderOpen, Trash2 } from 'lucide-react';
import { SongProject } from '../types/project';

/** Confirmación al quitar una canción de la biblioteca (no toca los archivos de audio originales). */
export const DeleteFromLibraryDialog: React.FC<{
  song: SongProject;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ song, onCancel, onConfirm }) => (
  <div
    role="dialog"
    aria-modal="true"
    className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
  >
    <div className="bg-neutral-900 border border-neutral-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center shrink-0">
          <Trash2 className="w-5 h-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-bold text-neutral-100">¿Eliminar de la biblioteca?</h2>
          <p className="text-sm text-neutral-300">
            Se eliminará <strong className="text-white">"{song.title}"</strong> del índice permanente y se liberará su espacio de caché.
          </p>
          <p className="text-xs text-neutral-400">
            Tus archivos de audio originales en disco nunca se tocarán ni modificarán.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm font-semibold text-neutral-200 cursor-pointer"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-sm font-semibold text-white cursor-pointer"
        >
          Eliminar de la biblioteca
        </button>
      </div>
    </div>
  </div>
);

/** Aviso de que no se encuentran los archivos de una canción, con opción de ubicar la carpeta. */
export const MissingFolderDialog: React.FC<{
  song: SongProject;
  onCancel: () => void;
  onRelink: (song: SongProject) => void;
}> = ({ song, onCancel, onRelink }) => (
  <div
    role="dialog"
    aria-modal="true"
    className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
  >
    <div className="bg-neutral-900 border border-neutral-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-5 h-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-bold text-neutral-100">No se encuentran los archivos</h2>
          <p className="text-sm text-neutral-300">
            No se encontraron las pistas de audio para <strong className="text-white">"{song.title}"</strong> en la ruta guardada.
          </p>
          <p className="text-xs text-neutral-400">
            Es posible que la carpeta haya sido movida, renombrada o esté en una unidad desconectada.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm font-semibold text-neutral-200 cursor-pointer"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => onRelink(song)}
          className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-sm font-semibold text-white cursor-pointer flex items-center gap-1.5"
        >
          <FolderOpen className="w-4 h-4" />
          <span>Ubicar carpeta</span>
        </button>
      </div>
    </div>
  </div>
);

/** Mensaje breve de confirmación en la esquina inferior derecha. */
export const ActionToast: React.FC<{ message: string }> = ({ message }) => (
  <div
    role="status"
    className="fixed bottom-3 right-3 z-50 bg-neutral-800 border border-studio-line text-white px-4 py-2.5 rounded-xl text-xs font-medium shadow-lg"
  >
    {message}
  </div>
);
