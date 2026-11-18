import React from 'react';
import { Trash2, Music, ListMusic, Play } from 'lucide-react';
import { SongProject } from '../../types/project';
import { formatMmSs } from '../TransportDeck';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';

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
  onConfirmRemoveFromSetlist?: (songId: string) => void;
}

export const ConfirmSongActionModal: React.FC<ConfirmSongActionModalProps> = ({
  song,
  currentSongId,
  isInSetlist,
  onClose,
  onConfirmLoadInDaw,
  onConfirmAddToSetlist,
  onConfirmRemoveFromSetlist,
}) => {
  if (!song) return null;

  const isAlreadyInDaw = song.id === currentSongId;
  const durSec =
    song.durationSec || ((song.totalBars || 24) * 4 * 60) / (song.bpm || 120);

  return (
    <Dialog label={`Montar «${song.title}»`} onClose={onClose} size="md">
      <DialogHeader
        icon={Music}
        title={song.title}
        description={`${song.artist} · ${formatMmSs(durSec)} · ${song.bpm} BPM · ${song.keySignature}`}
        onClose={onClose}
      />
      <DialogBody>
        <dl className="lt-facts">
          <div>
            <dt>Pistas multipista incluidas:</dt>
            <dd>{song.tracks.length} stems</dd>
          </div>
          <div>
            <dt>Marcadores de sección:</dt>
            <dd>{song.sections.length}</dd>
          </div>
        </dl>
        <p className="lt-dialog-note">
          ¿Confirmas que deseas montar esta canción en el DAW ahora, o prefieres enviarla a la cola del Modo Setlist?
        </p>
      </DialogBody>
      <DialogFooter className="lt-confirm-actions">
        <button
          type="button"
          data-autofocus
          onClick={() => {
            onConfirmLoadInDaw(song.id);
            onClose();
          }}
          className="lt-control lt-btn-primary"
        >
          <Play size={14} className="fill-current" aria-hidden="true" />
          <span>{isAlreadyInDaw ? 'Reiniciar' : 'DAW'}</span>
        </button>

        {isInSetlist && onConfirmRemoveFromSetlist ? (
          <button
            type="button"
            onClick={() => {
              onConfirmRemoveFromSetlist(song.id);
              onClose();
            }}
            className="lt-control lt-confirm-danger"
          >
            <Trash2 size={14} aria-hidden="true" />
            <span>Quitar de la sesión</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              onConfirmAddToSetlist(song.id);
              onClose();
            }}
            className="lt-control"
          >
            <ListMusic size={14} aria-hidden="true" />
            <span>Añadir al Setlist</span>
          </button>
        )}

        <button type="button" onClick={onClose} className="lt-control">
          Cancelar
        </button>
      </DialogFooter>
    </Dialog>
  );
};
