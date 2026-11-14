import React from 'react';
import { Trash2, X, Music, ListMusic, Play } from 'lucide-react';
import { SongProject } from '../../types/project';
import { formatMmSs } from '../TransportDeck';

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
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-studio-panel border border-neutral-800 rounded-2xl max-w-xl w-full p-6 space-y-5 shadow-2xl">
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

        <div className="lt-confirm-actions">
          <button
            type="button"
            onClick={() => {
              onConfirmLoadInDaw(song.id);
              onClose();
            }}
            className="lt-control lt-confirm-primary"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
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
              <Trash2 className="w-3.5 h-3.5" />
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
              <ListMusic className="w-3.5 h-3.5" />
              <span>Añadir al Setlist</span>
            </button>
          )}

          <button type="button" onClick={onClose} className="lt-control">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
};
