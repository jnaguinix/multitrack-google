import { useCallback } from 'react';
import type { WizardResult } from '../components/modals/ImportWizardModal';
import { effectiveBus, getInstrument, instrumentIdFromName, numberedNames } from '../utils/instrumentCatalog';
import { rememberTrackMapping } from '../utils/trackMapMemory';
import type { SongProject } from '../types/project';

interface Deps {
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  updateCurrentProject: (updater: (prev: SongProject) => SongProject) => void;
  showToast: (msg: string) => void;
}

/** «Editar pistas» (todas a la vez) y «Cambiar instrumento» (una pista) de la canción actual. */
export function useTrackInstruments({ currentProjectRef, updateCurrentProject, showToast }: Deps) {
  // «Editar pistas»: reasigna el instrumento de cada pista de la canción actual (nombre, rol, color y bus).
  const handleSaveTrackMapping = useCallback(
    (result: WizardResult) => {
      const picked = new Map(result.rows.map((r) => [r.id, r.instrumentId] as const));
      updateCurrentProject((p) => {
        const names = numberedNames(p.tracks.map((tr) => picked.get(tr.id) ?? null));
        return {
          ...p,
          tracks: p.tracks.map((tr, i) => {
            const def = getInstrument(picked.get(tr.id));
            const name = names[i];
            if (!def || !name) return tr;
            return { ...tr, name, role: def.role, color: def.color, splitSequence: Boolean(def.splitSequence), bus: effectiveBus({ name, role: def.role }) };
          }),
          updatedAt: Date.now(),
        };
      });
      const cur = currentProjectRef.current;
      rememberTrackMapping(
        result.rows.map((r) => ({
          fileName: cur?.tracks.find((tr) => tr.id === r.id)?.fileName ?? '',
          instrumentId: r.instrumentId,
        }))
      );
      showToast('Pistas actualizadas.');
    },
    [updateCurrentProject, showToast]
  );

  // «Cambiar instrumento» de una pista: renombra con el catálogo, recalcula la numeración de las demás
  // («Guitarra 1» y «2» pasan a «Guitarra» si una se convierte en otra cosa) y ajusta rol, color y bus.
  const handleChangeTrackInstrument = useCallback(
    (trackId: string, instrumentId: string) => {
      const def = getInstrument(instrumentId);
      if (!def) return;
      const cur = currentProjectRef.current;
      const fileName = cur?.tracks.find((tr) => tr.id === trackId)?.fileName;
      updateCurrentProject((p) => {
        const ids = p.tracks.map((tr) => (tr.id === trackId ? instrumentId : instrumentIdFromName(tr.name)));
        const names = numberedNames(ids);
        return {
          ...p,
          tracks: p.tracks.map((tr, i) => {
            const name = names[i];
            if (tr.id === trackId && name) return { ...tr, name, role: def.role, color: def.color, splitSequence: Boolean(def.splitSequence), bus: effectiveBus({ name, role: def.role }) };
            return name && ids[i] && name !== tr.name ? { ...tr, name } : tr;
          }),
          updatedAt: Date.now(),
        };
      });
      if (fileName) rememberTrackMapping([{ fileName, instrumentId }]);
      showToast(`Pista cambiada a ${def.label}.`);
    },
    [updateCurrentProject, showToast]
  );

  return { handleSaveTrackMapping, handleChangeTrackInstrument };
}
