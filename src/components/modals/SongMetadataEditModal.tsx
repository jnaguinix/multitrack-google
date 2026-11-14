import React, { useEffect, useState } from 'react';
import { X, Edit3 } from 'lucide-react';
import { SongProject } from '../../types/project';

/* ============================================================================
 * SONG METADATA EDIT MODAL (TITLE, ARTIST, KEY, BPM, TIME SIGNATURE)
 * ============================================================================ */

interface SongMetadataEditModalProps {
  song: SongProject | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (updated: SongProject) => void;
}

export const SongMetadataEditModal: React.FC<SongMetadataEditModalProps> = ({
  song,
  isOpen,
  onClose,
  onSave,
}) => {
  const [title, setTitle] = useState(song?.title || '');
  const [artist, setArtist] = useState(song?.artist || '');
  const [bpm, setBpm] = useState(song?.bpm || 120);
  const [keySignature, setKeySignature] = useState(song?.keySignature || 'C Major');
  const [beatsPerBar, setBeatsPerBar] = useState(song?.beatsPerBar || 4);

  useEffect(() => {
    if (song) {
      setTitle(song.title);
      setArtist(song.artist);
      setBpm(song.bpm);
      setKeySignature(song.keySignature);
      setBeatsPerBar(song.beatsPerBar || 4);
    }
  }, [song]);

  if (!isOpen || !song) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSave({
      ...song,
      title: title.trim(),
      artist: artist.trim() || 'Artista Desconocido',
      bpm: Number(bpm) || 120,
      keySignature: keySignature.trim() || 'C Major',
      beatsPerBar: Number(beatsPerBar) || 4,
      isTitleCustom: true,
      updatedAt: Date.now(),
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4 select-none"
    >
      <div className="bg-neutral-900 border border-neutral-700 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <h2 className="text-base font-bold text-neutral-100 flex items-center gap-2">
            <Edit3 className="w-4 h-4 text-studio-ink" />
            <span>Editar metadatos de la canción</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-neutral-300 mb-1">
              Título
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-700 text-sm text-neutral-100 focus:outline-none focus:border-studio-line"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-300 mb-1">
              Artista
            </label>
            <input
              type="text"
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-700 text-sm text-neutral-100 focus:outline-none focus:border-studio-line"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-neutral-300 mb-1">
                Tono
              </label>
              <input
                type="text"
                value={keySignature}
                onChange={(e) => setKeySignature(e.target.value)}
                placeholder="G Major, Bb..."
                className="w-full px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-700 text-sm text-neutral-100 focus:outline-none focus:border-studio-line"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-neutral-300 mb-1">
                BPM
              </label>
              <input
                type="number"
                min="40"
                max="260"
                value={bpm}
                onChange={(e) => setBpm(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-700 text-sm text-neutral-100 focus:outline-none focus:border-studio-line"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-neutral-300 mb-1">
                Compás
              </label>
              <input
                type="number"
                min="2"
                max="12"
                value={beatsPerBar}
                onChange={(e) => setBeatsPerBar(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-700 text-sm text-neutral-100 focus:outline-none focus:border-studio-line"
              />
            </div>
          </div>

          <p className="text-xs text-neutral-400">
            Los cambios se guardan en library.json y en el archivo omnitracks.project.json de la carpeta. No renombra archivos en disco.
          </p>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-xs font-semibold text-neutral-300 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-studio-strip hover:bg-neutral-700 border border-studio-line text-xs font-semibold text-studio-ink cursor-pointer"
            >
              Guardar metadatos
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
