import React, { useEffect, useRef } from 'react';
import { AlertTriangle, FolderOpen, Trash2 } from 'lucide-react';
import { SongProject } from '../types/project';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from './ui/Dialog';

/** Confirmación al quitar una canción de la biblioteca (no toca los archivos de audio originales). */
export const DeleteFromLibraryDialog: React.FC<{
  song: SongProject;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ song, onCancel, onConfirm }) => (
  <Dialog label="Eliminar de la biblioteca" onClose={onCancel} size="sm">
    <DialogHeader icon={Trash2} tone="danger" title="¿Eliminar de la biblioteca?" onClose={onCancel} />
    <DialogBody>
      <p className="lt-dialog-note">
        Se eliminará <strong>"{song.title}"</strong> del índice permanente y se liberará su espacio de caché.
      </p>
      <p className="lt-dialog-note-small">Tus archivos de audio originales en disco nunca se tocarán ni modificarán.</p>
    </DialogBody>
    <DialogFooter>
      {/* Lo destructivo no tiene el foco de inicio: un Enter sin querer no elimina nada. */}
      <button type="button" data-autofocus onClick={onCancel} className="lt-control">
        Cancelar
      </button>
      <button type="button" onClick={onConfirm} className="lt-control lt-btn-danger">
        Eliminar de la biblioteca
      </button>
    </DialogFooter>
  </Dialog>
);

/** Aviso de que no se encuentran los archivos de una canción, con opción de ubicar la carpeta. */
export const MissingFolderDialog: React.FC<{
  song: SongProject;
  onCancel: () => void;
  onRelink: (song: SongProject) => void;
}> = ({ song, onCancel, onRelink }) => (
  <Dialog label="No se encuentran los archivos" onClose={onCancel} size="sm">
    <DialogHeader icon={AlertTriangle} tone="warning" title="No se encuentran los archivos" onClose={onCancel} />
    <DialogBody>
      <p className="lt-dialog-note">
        No se encontraron las pistas de audio para <strong>"{song.title}"</strong> en la ruta guardada.
      </p>
      <p className="lt-dialog-note-small">
        Es posible que la carpeta haya sido movida, renombrada o esté en una unidad desconectada.
      </p>
    </DialogBody>
    <DialogFooter>
      <button type="button" onClick={onCancel} className="lt-control">
        Cancelar
      </button>
      <button type="button" data-autofocus onClick={() => onRelink(song)} className="lt-control lt-btn-primary">
        <FolderOpen size={15} aria-hidden="true" />
        <span>Ubicar carpeta</span>
      </button>
    </DialogFooter>
  </Dialog>
);

/**
 * Mensaje breve de confirmación en la esquina inferior derecha. Se muestra como popover manual, en la capa superior
 * del navegador: un diálogo abierto no lo tapa. Cada mensaje nuevo se vuelve a mostrar para quedar por encima.
 */
export const ActionToast: React.FC<{ message: string }> = ({ message }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const toast = ref.current;
    if (!toast) return;
    if (toast.matches(':popover-open')) toast.hidePopover();
    toast.showPopover();
    return () => {
      if (toast.matches(':popover-open')) toast.hidePopover();
    };
  }, [message]);
  return (
    <div ref={ref} popover="manual" role="status" className="lt-toast">
      {message}
    </div>
  );
};
