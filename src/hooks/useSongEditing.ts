import { formatTimecode } from '../components/TransportDeck';
import { saveProjectToDb, syncProjectSidecarNow } from '../storage/projectDb';
import { logAsyncError } from '../utils/asyncErrors';
import { MARKER_PALETTE } from '../utils/markerPalette';
import { SECTION_TEMPLATES, insertTemplateSection } from '../utils/sectionTemplates';
import type { SetlistTransitionMode, SongProject, SongSection, TransportState } from '../types/project';

interface Deps {
  currentProject: SongProject | null;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  projectsRef: React.MutableRefObject<SongProject[]>;
  transport: TransportState;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  updateCurrentProject: (updater: (prev: SongProject) => SongProject) => void;
  showToast: (msg: string) => void;
}

/** Datos de una canción que se editan desde el Setlist y el transporte: notas, transición y secciones nuevas. */
export function useSongEditing({
  currentProject,
  currentProjectRef,
  projectsRef,
  transport,
  setProjects,
  setCurrentProject,
  updateCurrentProject,
  showToast,
}: Deps) {
  // Notas de la canción para el servicio: se guardan con la canción (IndexedDB o library.json).
  const handleUpdateSongNotes = (songId: string, notes: string) => {
    const song = projectsRef.current.find((p) => p.id === songId);
    if (!song) return;
    const updated: SongProject = { ...song, notes };
    setProjects((prev) => prev.map((p) => (p.id === songId ? updated : p)));
    if (currentProjectRef.current?.id === songId) setCurrentProject(updated);
    saveProjectToDb(updated).catch((err) => {
      console.error(`[Setlist] No se pudieron guardar las notas de '${song.title}':`, err);
      showToast(`No se pudieron guardar las notas de "${song.title}"`);
    });
  };

  // Flecha entre fichas: qué hacer al terminar una canción (undefined = ajuste general).
  const handleSetSongTransition = (songId: string, mode: SetlistTransitionMode | undefined) => {
    const song = projectsRef.current.find((p) => p.id === songId);
    if (!song) return;
    const updated: SongProject = { ...song, transitionToNext: mode };
    setProjects((prev) => prev.map((p) => (p.id === songId ? updated : p)));
    if (currentProjectRef.current?.id === songId) setCurrentProject(updated);
    saveProjectToDb(updated).catch((err) => {
      console.error(`[Setlist] No se pudo guardar la transición de '${song.title}':`, err);
      showToast(`No se pudo guardar la transición de "${song.title}"`);
    });
  };

  // Añade una sección de plantilla (Intro, Verso 1, Coro…) en la posición del cursor.
  const handleAddSectionTemplate = (templateKey: string) => {
    const template = SECTION_TEMPLATES.find((t) => t.key === templateKey);
    if (!template || !currentProject) return;
    const totalSec = Math.max(
      10,
      Math.round((transport.totalDurationSec || currentProject.durationSec || 60) * 100) / 100
    );
    const startSec = Math.round(transport.currentTimeSec * 100) / 100;
    updateCurrentProject((prev) => {
      const next: SongProject = {
        ...prev,
        sections: insertTemplateSection(prev.sections, template, startSec, totalSec, `sec-${Date.now()}`),
      };
      syncProjectSidecarNow(next, true).catch((err) => {
        console.error('[Setlist] No se pudo sincronizar el sidecar de la canción:', err);
      });
      return next;
    });
    showToast(`${template.name} añadido en ${formatTimecode(Math.max(0, startSec))}`);
  };

  // Add a Section Marker directly at the current playhead time (mm:ss.d)
  const handleAddMarkerAtPlayhead = () => {
    if (!currentProject) return;
    const playheadSec = Math.round(transport.currentTimeSec * 100) / 100;
    const totalSec = Math.max(
      10,
      Math.round((transport.totalDurationSec || currentProject.durationSec || 60) * 100) / 100
    );
    const clampedStart = Math.max(0, Math.min(totalSec - 0.5, playheadSec));

    updateCurrentProject((prev) => {
      const nextNum = prev.sections.length + 1;
      const sortedExisting = [...prev.sections].sort((a, b) => a.startTimeSec - b.startTimeSec);
      const nextExisting = sortedExisting.find((s) => s.startTimeSec > clampedStart);
      const defaultEnd = nextExisting ? nextExisting.startTimeSec : totalSec;

      const newSec: SongSection = {
        id: `sec-${Date.now()}`,
        name: `Sección ${nextNum}`,
        code: `S${nextNum}`,
        color: MARKER_PALETTE[prev.sections.length % MARKER_PALETTE.length],
        startTimeSec: clampedStart,
        endTimeSec: Math.max(clampedStart + 0.1, defaultEnd),
        vampByDefault: false,
        cueName: `Sección ${nextNum}`,
      };

      const combined = [...prev.sections, newSec].sort((a, b) => a.startTimeSec - b.startTimeSec);
      const recalculated = combined.map((s, idx) => {
        const nextItem = combined[idx + 1];
        const targetEnd = nextItem ? nextItem.startTimeSec : totalSec;
        return {
          ...s,
          startTimeSec: Math.round(s.startTimeSec * 100) / 100,
          endTimeSec: Math.round(Math.max(s.startTimeSec + 0.05, targetEnd) * 100) / 100,
        };
      });

      const next: SongProject = {
        ...prev,
        sections: recalculated,
      };
      syncProjectSidecarNow(next, true).catch(logAsyncError('sincronizar el archivo de la canción'));
      return next;
    });

    showToast(`Marcador creado en ${formatTimecode(clampedStart)}`);
  };

  return { handleUpdateSongNotes, handleSetSongTransition, handleAddSectionTemplate, handleAddMarkerAtPlayhead };
}
