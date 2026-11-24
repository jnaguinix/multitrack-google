import React, { useState } from 'react';
import { Disc3 } from 'lucide-react';
import { PadHarmony, PadStyle, SongProject } from '../../types/project';
import {
  CLICK_SUBDIVISION_OPTIONS,
  createPadOnlySong,
  PAD_HARMONY_OPTIONS,
  PAD_NOTES,
  PAD_STYLE_OPTIONS,
  TIME_SIGNATURE_OPTIONS,
} from '../../utils/padSong';
import type { PadPackInfo } from '../../utils/padPacks';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';

interface CreatePadSongModalProps {
  isOpen: boolean;
  nextSetlistOrder: number;
  packs?: PadPackInfo[];
  onClose: () => void;
  onCreate: (song: SongProject) => void;
}

/** Ventana para crear una canción sin secuencia (pad sintetizado + click) directa en el Setlist. */
export const CreatePadSongModal: React.FC<CreatePadSongModalProps> = ({
  isOpen,
  nextSetlistOrder,
  packs = [],
  onClose,
  onCreate,
}) => {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [keySignature, setKeySignature] = useState('C');
  const [bpm, setBpm] = useState(72);
  const [timeSig, setTimeSig] = useState('4/4');
  const [subdivision, setSubdivision] = useState<1 | 2 | 4>(1);
  const [harmony, setHarmony] = useState<PadHarmony>('open');
  const [style, setStyle] = useState<PadStyle>('warm');
  const [padPackId, setPadPackId] = useState<string>('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    const [bpbStr, unitStr] = timeSig.split('/');
    const song = createPadOnlySong({
      title: cleanTitle,
      artist: artist.trim() || undefined,
      keySignature,
      bpm,
      beatsPerBar: Number(bpbStr) || 4,
      beatUnit: Number(unitStr) || 4,
      clickSubdivision: subdivision,
      padHarmony: harmony,
      padStyle: style,
      padPackId: padPackId || null,
      setlistOrder: nextSetlistOrder,
    });
    onCreate(song);
    setTitle('');
    setArtist('');
    onClose();
  };

  return (
    <Dialog label="Nueva canción sin secuencia" onClose={onClose} size="md">
      <DialogHeader
        icon={Disc3}
        title="Canción sin secuencia"
        description="Se añade solo al Setlist actual con un pad continuo en las 12 notas y metrónomo."
        onClose={onClose}
      />
      <form onSubmit={handleSubmit} className="lt-dialog-form">
        <DialogBody>
          <label className="lt-field">
            <span>Nombre de la canción</span>
            <input
              type="text"
              data-autofocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej. Momento de adoración, Digno..."
              required
            />
          </label>

          <label className="lt-field">
            <span>Nota o detalle (opcional)</span>
            <input
              type="text"
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              placeholder="Ej. Piano y voces"
            />
          </label>

          <div className="lt-field">
            <span>Tono del pad</span>
            <div className="lt-pad-note-picker" role="group" aria-label="Tono del pad">
              {PAD_NOTES.map((n) => (
                <button
                  key={n.keySignature}
                  type="button"
                  className="lt-control"
                  aria-pressed={keySignature === n.keySignature}
                  onClick={() => setKeySignature(n.keySignature)}
                >
                  {n.label}
                </button>
              ))}
            </div>
          </div>

          <div className="lt-field-row">
            <label className="lt-field">
              <span>BPM</span>
              <input
                type="number"
                min={40}
                max={240}
                value={bpm}
                onChange={(e) => setBpm(Number(e.target.value) || 72)}
              />
            </label>
            <label className="lt-field">
              <span>Compás</span>
              <select value={timeSig} onChange={(e) => setTimeSig(e.target.value)}>
                {TIME_SIGNATURE_OPTIONS.map((opt) => (
                  <option key={opt.label} value={opt.label}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="lt-field">
              <span>Click</span>
              <div className="lt-segmented" role="group" aria-label="Velocidad del metrónomo">
                {CLICK_SUBDIVISION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className="lt-control"
                    aria-pressed={subdivision === opt.value}
                    title={opt.hint}
                    onClick={() => setSubdivision(opt.value)}
                  >
                    {opt.badge}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="lt-pad-options-row">
            <div className="lt-field">
              <span>Carácter</span>
              <div className="lt-segmented" role="group" aria-label="Carácter armónico del pad">
                {PAD_HARMONY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className="lt-control"
                    aria-pressed={harmony === opt.value}
                    title={opt.hint}
                    onClick={() => setHarmony(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="lt-field">
              <span>Timbre</span>
              <div className="lt-segmented" role="group" aria-label="Timbre del pad">
                {PAD_STYLE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className="lt-control"
                    aria-pressed={style === opt.value}
                    title={opt.hint}
                    onClick={() => setStyle(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {packs.length > 0 && (
            <label className="lt-field">
              <span>Fuente del pad</span>
              <select value={padPackId} onChange={(e) => setPadPackId(e.target.value)}>
                <option value="">Sintetizador interno (constante)</option>
                {packs.map((p) => (
                  <option key={p.id} value={p.id}>
                    Pack: {p.name} ({p.availableNotes.length}/12 notas)
                  </option>
                ))}
              </select>
            </label>
          )}
        </DialogBody>
        <DialogFooter>
          <button type="button" onClick={onClose} className="lt-control">
            Cancelar
          </button>
          <button type="submit" className="lt-control lt-btn-primary">
            Añadir al Setlist
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
};
