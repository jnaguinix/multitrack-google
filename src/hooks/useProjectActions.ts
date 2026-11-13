import { SongProject } from '../types/project';
import { WorkspaceView } from '../components/TopBar';
import { audioEngine } from '../audio/audioEngine';
import { isOpfsSupported, isProjectPcmComplete } from '../storage/opfsStorage';
import {
  createEmptyProjectTemplate,
  saveProjectToDb,
  normalizeProjectSectionsToTime,
} from '../storage/projectDb';

interface UseProjectActionsDeps {
  projects: SongProject[];
  projectsRef: React.MutableRefObject<SongProject[]>;
  currentProject: SongProject | null;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  showToast: (msg: string) => void;
  isDesktopApp: boolean;
  queuedOptimizeIdsRef: React.MutableRefObject<Set<string>>;
  ensureSourceAccess: (projectId: string) => Promise<void>;
  runAutoOptimize: (projectId: string) => void;
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
  queuedOptimizeIdsRef,
  ensureSourceAccess,
  runAutoOptimize,
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
    if (!isDesktopApp) {
      if (isOpfsSupported() && queuedOptimizeIdsRef.current.has(projectId)) {
        showToast(`"${found.title}" se está preparando en segundo plano; espera a que termine.`);
        return;
      }
      // Songs already cached in OPFS don't need the original files; others do
      const isOpfsReady = await isProjectPcmComplete(found);
      if (!isOpfsReady) {
        await ensureSourceAccess(projectId);
        runAutoOptimize(projectId);
      }
    }
    await activateProject(found, undefined, autoPlay);
    if (activeView === 'library') {
      handleSelectView('setlist');
    }
    showToast(`Canción montada en consola: ${found.title}`);
  };

  const handleCreateNewProject = async (
    title: string,
    artist: string,
    bpm: number,
    keySignature: string
  ) => {
    const newProj = createEmptyProjectTemplate(title, artist, bpm, keySignature);
    newProj.inSetlist = false;
    newProj.setlistOrder = undefined;
    await activateProject(newProj);
    handleSelectView('library');
    showToast(`Nueva canción creada en biblioteca: ${title}`);
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
    saveProjectToDb(next).catch(() => {});
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

  const handleImportJsonFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SongProject;
      if (!parsed.title || !Array.isArray(parsed.tracks)) {
        showToast('El archivo JSON no tiene un formato de OmniTracks válido');
        return;
      }
      const importedProj: SongProject = normalizeProjectSectionsToTime({
        ...parsed,
        id: `imported-${Date.now()}`,
        folder: 'imported',
        updatedAt: Date.now(),
      });
      await activateProject(importedProj);
      handleSelectView('setlist');
      showToast(`Proyecto importado: ${importedProj.title}`);
    } catch {
      showToast('No se pudo leer el archivo JSON');
    }
  };

  return {
    handleLoadProjectImmediately,
    handleCreateNewProject,
    handleUpdateSongMetadata,
    handleDeleteProject,
    handleExportJson,
    handleImportJsonFile,
  };
}
