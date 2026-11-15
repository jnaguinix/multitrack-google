import { logAsyncError } from '../utils/asyncErrors';
import { SongProject } from '../types/project';
import { WorkspaceView } from '../components/TopBar';
import { audioEngine } from '../audio/audioEngine';
import { saveProjectToDb } from '../storage/projectDb';

interface UseProjectActionsDeps {
  projects: SongProject[];
  projectsRef: React.MutableRefObject<SongProject[]>;
  currentProject: SongProject | null;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  showToast: (msg: string) => void;
  isDesktopApp: boolean;
  activateProject: (
    projectToLoad: SongProject,
    predecodedBuffers?: Map<string, AudioBuffer>,
    explicitPlayIfAlreadyInRam?: boolean
  ) => Promise<void>;
  activeView: WorkspaceView;
  handleSelectView: (view: WorkspaceView) => void;
  setSongToDeleteFromLibrary: React.Dispatch<React.SetStateAction<SongProject | null>>;
}

export function useProjectActions({
  projects,
  projectsRef,
  currentProjectRef,
  setProjects,
  setCurrentProject,
  showToast,
  isDesktopApp,
  activateProject,
  activeView,
  handleSelectView,
  setSongToDeleteFromLibrary,
}: UseProjectActionsDeps) {
  // Load Song Immediately into DAW (Used when confirmed in modal, clicked Play on Setlist card, or dragged onto DAW)
  const handleLoadProjectImmediately = async (projectId: string, autoPlay = false) => {
    const found =
      projectsRef.current.find((p) => p.id === projectId) ||
      projects.find((p) => p.id === projectId);
    if (!found) return;
    await activateProject(found, undefined, autoPlay);
    if (activeView === 'library') {
      handleSelectView('setlist');
    }
    showToast(`Canción montada en consola: ${found.title}`);
  };

  const handleUpdateSongMetadata = (updated: SongProject) => {
    const next: SongProject = {
      ...updated,
      isTitleCustom: true,
      updatedAt: Date.now(),
    };
    setProjects((prev) => prev.map((p) => (p.id === next.id ? next : p)));
    if (currentProjectRef.current?.id === next.id) {
      setCurrentProject(next);
      audioEngine.updateProjectConfig(next);
    }
    saveProjectToDb(next).catch(logAsyncError('guardar la canción'));
    showToast(`Metadatos actualizados: "${next.title}"`);
  };

  const handleDeleteProject = (projectId: string) => {
    const song = projectsRef.current.find((p) => p.id === projectId);
    if (!song) return;
    setSongToDeleteFromLibrary(song);
  };

  const handleExportJson = (proj: SongProject) => {
    const blob = new Blob([JSON.stringify(proj, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${proj.title.toLowerCase().replace(/\s+/g, '-')}.omnitracks.project.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Archivo omnitracks.project.json exportado');
  };

  return {
    handleLoadProjectImmediately,
    handleUpdateSongMetadata,
    handleDeleteProject,
    handleExportJson,
  };
}
