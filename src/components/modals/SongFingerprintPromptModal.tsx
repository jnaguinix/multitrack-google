import React, { useState } from 'react';
import { Plus, X, Music, Check } from 'lucide-react';
import { FingerprintCandidate } from '../../audio/fingerprint';
import { SongProject } from '../../types/project';

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

  return (
    <div className="fixed inset-0 z-[80] bg-black/75 flex items-center justify-center p-4">
      <div className="bg-studio-panel border border-neutral-700 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
              <Music className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-base font-bold text-neutral-100">
                {isSingle
                  ? `¿Es la misma canción que «${single.song.title}»?`
                  : '¿Es la misma canción que alguna de estas?'}
              </h2>
              <p className="text-xs text-neutral-400">
                Coincidencia de huella de pistas (tamaño y duración dentro de ±1 pista)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-neutral-400 hover:text-white p-1 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="bg-studio-ground border border-neutral-800 rounded-xl p-3.5 space-y-2 text-xs">
          <div className="text-neutral-400 flex items-center justify-between">
            <span>Audio entrante:</span>
            <span className="font-semibold text-neutral-200">
              {sourceLabel} ({incomingTrackCount} pistas)
            </span>
          </div>

          {isSingle ? (
            <div className="pt-2 border-t border-neutral-800/80 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-neutral-400">Canción en biblioteca:</span>
                <span className="font-bold text-studio-ink">
                  {single.song.title} {single.song.artist ? `· ${single.song.artist}` : ''}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-neutral-400">Coincidencia de pistas:</span>
                <span className="font-bold text-amber-400">
                  {Math.round(single.matchRatio * 100)}% ({single.matchedTrackCount} de {single.totalTracks} pistas)
                </span>
              </div>
            </div>
          ) : (
            <div className="pt-2 border-t border-neutral-800/80 space-y-2">
              <p className="text-neutral-400">Selecciona la canción que corresponde:</p>
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {candidates.map((cand) => (
                  <label
                    key={cand.song.id}
                    onClick={() => setSelectedCandidateId(cand.song.id)}
                    className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-colors ${
                      selectedCandidateId === cand.song.id
                        ? 'border-amber-500/60 bg-amber-500/10 text-white'
                        : 'border-neutral-800 bg-neutral-900/50 text-neutral-300 hover:border-neutral-700'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="fingerprintCandidate"
                        checked={selectedCandidateId === cand.song.id}
                        onChange={() => setSelectedCandidateId(cand.song.id)}
                        className="text-amber-500 focus:ring-0"
                      />
                      <span className="font-semibold text-xs">{cand.song.title}</span>
                      <span className="text-neutral-500 text-xs">{cand.song.artist}</span>
                    </div>
                    <span className="text-xs font-bold text-amber-400">
                      {Math.round(cand.matchRatio * 100)}% ({cand.matchedTrackCount}/{cand.totalTracks})
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <p className="text-xs text-neutral-400 leading-relaxed">
          Si confirmas la actualización, se vincularán las pistas manteniendo tus ediciones de metadatos, secciones y mezcla. Si eliges importar como nueva, se creará una entrada separada en la biblioteca.
        </p>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
          <button
            type="button"
            onClick={() => onConfirmMatch(selectedCandidate.song)}
            className="flex-1 py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-neutral-950 font-bold text-xs flex items-center justify-center gap-2 cursor-pointer transition-colors shadow-lg shadow-amber-500/10"
          >
            <Check className="w-3.5 h-3.5" />
            <span>
              {isSingle
                ? `Sí, actualizar «${single.song.title}»`
                : `Actualizar «${selectedCandidate.song.title}»`}
            </span>
          </button>

          <button
            type="button"
            onClick={onImportAsNew}
            className="flex-1 py-2.5 px-4 rounded-xl border border-neutral-700 hover:bg-neutral-800 text-neutral-200 font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Importar como canción nueva</span>
          </button>
        </div>

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer"
          >
            Cancelar importación
          </button>
        </div>
      </div>
    </div>
  );
};
