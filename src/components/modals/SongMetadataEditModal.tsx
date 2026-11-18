import React, { useEffect, useState } from 'react';
import { Edit3 } from 'lucide-react';
import { SongProject } from '../../types/project';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';

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
    <Dialog label="Editar metadatos de la canción" onClose={onClose} size="sm">
      <DialogHeader icon={Edit3} title="Editar metadatos de la canción" onClose={onClose} />
      <form onSubmit={handleSubmit} className="lt-dialog-form">
        <DialogBody>
          <label className="lt-field">
            <span>Título</span>
            <input type="text" data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>

          <label className="lt-field">
            <span>Artista</span>
            <input type="text" value={artist} onChange={(e) => setArtist(e.target.value)} />
          </label>

          <div className="lt-field-row">
            <label className="lt-field">
              <span>Tono</span>
              <input type="text" value={keySignature} onChange={(e) => setKeySignature(e.target.value)} placeholder="G Major, Bb..." />
            </label>
            <label className="lt-field">
              <span>BPM</span>
              <input type="number" min="40" max="260" value={bpm} onChange={(e) => setBpm(Number(e.target.value))} />
            </label>
            <label className="lt-field">
              <span>Compás</span>
              <input type="number" min="2" max="12" value={beatsPerBar} onChange={(e) => setBeatsPerBar(Number(e.target.value))} />
            </label>
          </div>

          <p className="lt-dialog-note-small">
            Los cambios se guardan en library.json y en el archivo omnitracks.project.json de la carpeta. No renombra archivos en disco.
          </p>
        </DialogBody>
        <DialogFooter>
          <button type="button" onClick={onClose} className="lt-control">
            Cancelar
          </button>
          <button type="submit" className="lt-control lt-btn-primary">
            Guardar metadatos
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
};
