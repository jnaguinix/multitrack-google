import React, { useState } from 'react';
import { Plus, Music, Check } from 'lucide-react';
import { FingerprintCandidate } from '../../audio/fingerprint';
import { SongProject } from '../../types/project';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';

/* ============================================================================
 * SONG FINGERPRINT AMBIGUITY / CONFIRMATION MODAL
 * ============================================================================ */

export interface SongFingerprintPromptModalProps {
  candidates: FingerprintCandidate[];
  incomingTrackCount: number;
  sourceLabel: string;
  onConfirmMatch: (candidate: SongProject) => void;
  onImportAsNew: () => void;
  onCancel: () => void;
}

export const SongFingerprintPromptModal: React.FC<SongFingerprintPromptModalProps> = ({
  candidates,
  incomingTrackCount,
  sourceLabel,
  onConfirmMatch,
  onImportAsNew,
  onCancel,
}) => {
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>(
    candidates[0]?.song.id || ''
  );

  if (candidates.length === 0) return null;

  const isSingle = candidates.length === 1;
  const single = candidates[0];
  const selectedCandidate =
    candidates.find((c) => c.song.id === selectedCandidateId) || candidates[0];

  const title = isSingle
    ? `¿Es la misma canción que «${single.song.title}»?`
    : '¿Es la misma canción que alguna de estas?';

  return (
    <Dialog label={title} onClose={onCancel} size="md">
      <DialogHeader
        icon={Music}
        tone="warning"
        title={title}
        description="Coincidencia de huella de pistas (tamaño y duración dentro de ±1 pista)"
        onClose={onCancel}
      />
      <DialogBody>
        <dl className="lt-facts">
          <div>
            <dt>Audio entrante:</dt>
            <dd>
              {sourceLabel} ({incomingTrackCount} pistas)
            </dd>
          </div>
          {isSingle ? (
            <>
              <div className="lt-facts-sep">
                <dt>Canción en biblioteca:</dt>
                <dd>
                  {single.song.title} {single.song.artist ? `· ${single.song.artist}` : ''}
                </dd>
              </div>
              <div>
                <dt>Coincidencia de pistas:</dt>
                <dd className="lt-choice-ratio">
                  {Math.round(single.matchRatio * 100)}% ({single.matchedTrackCount} de {single.totalTracks} pistas)
                </dd>
              </div>
            </>
          ) : null}
        </dl>

        {!isSingle && (
          <fieldset>
            <legend className="lt-dialog-note-small">Selecciona la canción que corresponde:</legend>
            <div className="lt-choices" role="radiogroup" aria-label="Canciones candidatas">
              {candidates.map((cand) => (
                <label key={cand.song.id} className="lt-choice" data-selected={selectedCandidateId === cand.song.id || undefined}>
                  <span className="lt-choice-main">
                    <input
                      type="radio"
                      name="fingerprintCandidate"
                      checked={selectedCandidateId === cand.song.id}
                      onChange={() => setSelectedCandidateId(cand.song.id)}
                    />
                    <span>{cand.song.title}</span>
                    <span>{cand.song.artist}</span>
                  </span>
                  <span className="lt-choice-ratio">
                    {Math.round(cand.matchRatio * 100)}% ({cand.matchedTrackCount}/{cand.totalTracks})
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <p className="lt-dialog-note">
          Si confirmas la actualización, se vincularán las pistas manteniendo tus ediciones de metadatos, secciones y mezcla. Si eliges importar como nueva, se creará una entrada separada en la biblioteca.
        </p>
      </DialogBody>
      <DialogFooter>
        <button type="button" onClick={onCancel} className="lt-control">
          Cancelar importación
        </button>
        <button type="button" onClick={onImportAsNew} className="lt-control">
          <Plus size={14} aria-hidden="true" />
          <span>Importar como canción nueva</span>
        </button>
        <button type="button" data-autofocus onClick={() => onConfirmMatch(selectedCandidate.song)} className="lt-control lt-btn-primary">
          <Check size={14} aria-hidden="true" />
          <span>
            {isSingle
              ? `Sí, actualizar «${single.song.title}»`
              : `Actualizar «${selectedCandidate.song.title}»`}
          </span>
        </button>
      </DialogFooter>
    </Dialog>
  );
};
