import React, { useState } from 'react';
import { Check, FolderOpen, Layers, Trash2, Upload } from 'lucide-react';
import { pickNativeFolder, isDesktopApp } from '../../utils/nativeDialog';
import { formatPackNotesSummary, type PadPackInfo } from '../../utils/padPacks';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';

interface PadPackManagerModalProps {
  isOpen: boolean;
  packs: PadPackInfo[];
  activePackId: string | null;
  isImporting: boolean;
  onSelectPack: (packId: string | null) => void;
  onImportFolder: (name: string, folderPath: string) => Promise<PadPackInfo>;
  onDeletePack: (packId: string) => Promise<void>;
  onClose: () => void;
}

function folderBaseName(folderPath: string): string {
  const parts = folderPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'Mi pack de pads';
}

/**
 * Diálogo para elegir entre el sintetizador interno o packs reales en carpeta (12 notas C..B en bucle),
 * importar nuevos packs desde WAV/FLAC/MP3/OGG/M4A o eliminar packs guardados.
 */
export const PadPackManagerModal: React.FC<PadPackManagerModalProps> = ({
  isOpen,
  packs,
  activePackId,
  isImporting,
  onSelectPack,
  onImportFolder,
  onDeletePack,
  onClose,
}) => {
  const [selectedFolder, setSelectedFolder] = useState('');
  const [packName, setPackName] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [busyDeleteId, setBusyDeleteId] = useState<string | null>(null);

  if (!isOpen) return null;

  const handlePickFolder = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    if (!isDesktopApp()) {
      setSelectedFolder('Vista previa / Warm Pad Pack');
      if (!packName.trim()) setPackName('Warm Pad Demo');
      return;
    }
    const folder = await pickNativeFolder();
    if (!folder) return;
    setSelectedFolder(folder);
    setPackName((prev) => (prev.trim() ? prev : folderBaseName(folder)));
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFolder.trim() || isImporting) return;
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const created = await onImportFolder(packName.trim() || folderBaseName(selectedFolder), selectedFolder);
      setStatusMsg(`Pack «${created.name}» listo (${created.availableNotes.length}/12 notas).`);
      setSelectedFolder('');
      setPackName('');
      onSelectPack(created.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (pack: PadPackInfo) => {
    if (busyDeleteId) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyDeleteId(pack.id);
    try {
      await onDeletePack(pack.id);
      if (activePackId === pack.id) {
        onSelectPack(null);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyDeleteId(null);
    }
  };

  return (
    <Dialog label="Packs de pads en audio" onClose={onClose} size="md" dismissOnBackdrop>
      <DialogHeader
        icon={Layers}
        title="Packs de pads en audio"
        description="Carga tus propios pads (C..B en WAV, FLAC, MP3, OGG o M4A) en bucle continuo sin costuras, o usa el sintetizador interno."
        onClose={onClose}
      />

      <DialogBody>
        <div className="lt-pack-list" role="radiogroup" aria-label="Fuente de sonido del pad">
          <button
            type="button"
            className="lt-pack-item"
            data-active={!activePackId || undefined}
            aria-checked={!activePackId}
            role="radio"
            onClick={() => onSelectPack(null)}
          >
            <div className="lt-pack-info">
              <strong>Sintetizador interno (constante)</strong>
              <span>Colchón analógico integrado en las 12 notas · Abierto, Mayor o Menor · Cero espera</span>
            </div>
            <span className="lt-pack-badge">
              {!activePackId && <Check size={14} aria-hidden="true" />}
              <span>{!activePackId ? 'En uso' : 'Usar'}</span>
            </span>
          </button>

          {packs.map((pack) => {
            const isSelected = activePackId === pack.id;
            return (
              <div key={pack.id} className="lt-pack-row" data-active={isSelected || undefined}>
                <button
                  type="button"
                  className="lt-pack-select"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => onSelectPack(pack.id)}
                >
                  <div className="lt-pack-info">
                    <strong>{pack.name}</strong>
                    <span>
                      {formatPackNotesSummary(pack.availableNotes)} · bucle ~{Math.max(1, Math.round(pack.durationSec))} s
                    </span>
                  </div>
                  <span className="lt-pack-badge">
                    {isSelected && <Check size={14} aria-hidden="true" />}
                    <span>{isSelected ? 'En uso' : 'Usar'}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="lt-control lt-icon-control lt-pack-delete"
                  aria-label={`Eliminar pack ${pack.name}`}
                  title="Eliminar pack de este equipo"
                  disabled={busyDeleteId === pack.id}
                  onClick={() => void handleDelete(pack)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>

        <form onSubmit={handleImport} className="lt-pack-import">
          <div className="lt-field">
            <span>Importar carpeta de pads (nombres con nota: C, Eb, F#m, Sol, Sib...)</span>
            <div className="lt-pack-folder-row">
              <button type="button" className="lt-control" onClick={() => void handlePickFolder()} disabled={isImporting}>
                <FolderOpen size={15} />
                <span>{selectedFolder ? 'Cambiar carpeta' : 'Elegir carpeta...'}</span>
              </button>
              <input
                type="text"
                value={selectedFolder}
                readOnly
                placeholder="Ninguna carpeta elegida"
                aria-label="Carpeta del pack"
              />
            </div>
          </div>

          <div className="lt-pack-import-actions">
            <label className="lt-field flex-1">
              <span>Nombre del pack</span>
              <input
                type="text"
                value={packName}
                onChange={(e) => setPackName(e.target.value)}
                placeholder="Ej. Warm Worship, BigSky Ambient..."
                disabled={isImporting}
              />
            </label>
            <button
              type="submit"
              className="lt-control lt-btn-primary"
              disabled={!selectedFolder.trim() || isImporting}
            >
              <Upload size={15} />
              <span>{isImporting ? 'Convirtiendo bucle...' : 'Importar pack'}</span>
            </button>
          </div>

          {errorMsg && (
            <p className="lt-pack-feedback" data-tone="error" role="alert">
              {errorMsg}
            </p>
          )}
          {statusMsg && (
            <p className="lt-pack-feedback" data-tone="ok" role="status">
              {statusMsg}
            </p>
          )}
        </form>
      </DialogBody>

      <DialogFooter>
        <button type="button" onClick={onClose} className="lt-control">
          Cerrar
        </button>
      </DialogFooter>
    </Dialog>
  );
};
