import React from 'react';
import { ImportWizardModal, type WizardResult } from '../modals/ImportWizardModal';
import { InstrumentPickerModal } from '../modals/InstrumentPickerModal';
import { instrumentIdFromName, orderTracksForDisplay } from '../../utils/instrumentCatalog';
import { loadTrackMapMemory, memoryKey } from '../../utils/trackMapMemory';
import type { SongProject } from '../../types/project';

/** «Cambiar instrumento» de una sola pista de la canción actual. */
export const TrackInstrumentPicker: React.FC<{
  project: SongProject;
  trackId: string;
  onPick: (trackId: string, instrumentId: string) => void;
  onClose: () => void;
}> = ({ project, trackId, onPick, onClose }) => {
  const trk = project.tracks.find((tr) => tr.id === trackId);
  if (!trk) return null;
  return (
    <InstrumentPickerModal
      trackName={trk.name}
      fileName={trk.fileName}
      currentInstrumentId={instrumentIdFromName(trk.name)}
      onPick={(id) => onPick(trk.id, id)}
      onClose={onClose}
    />
  );
};

/** «Editar pistas»: el paso 2 del asistente de importación para una canción ya importada. */
export const EditTracksWizard: React.FC<{
  project: SongProject;
  onConfirm: (result: WizardResult) => void;
  onCancel: () => void;
}> = ({ project, onConfirm, onCancel }) => (
  <ImportWizardModal
    mode="edit-tracks"
    initialMeta={{
      title: project.title,
      artist: project.artist,
      key: project.keySignature,
      bpm: project.bpm,
      beatsPerBar: project.beatsPerBar,
    }}
    files={orderTracksForDisplay(project.tracks).map((tr) => {
      const own = instrumentIdFromName(tr.name);
      const rememberedId = tr.fileName ? loadTrackMapMemory()[memoryKey(tr.fileName)] ?? null : null;
      return {
        id: tr.id,
        fileName: tr.fileName || tr.name,
        durationSec: tr.durationSec ?? null,
        instrumentId: own ?? rememberedId,
        remembered: !own && Boolean(rememberedId),
      };
    })}
    onConfirm={onConfirm}
    onCancel={onCancel}
  />
);
