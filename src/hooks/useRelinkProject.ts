import { useCallback } from 'react';
import { projectSaves } from '../storage/projectSaves';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';
import { updateDesktopSongFolder } from '../storage/desktopLibrary';
import { pickNativeFolder, scanNativeFolder } from '../utils/nativeDialog';
import type { SongProject } from '../types/project';

interface Deps {
  isDesktopApp: boolean;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  showToast: (msg: string) => void;
}

/** «Reubicar carpeta»: elige la carpeta nueva de una canción, vuelve a enlazar sus pistas y regenera su caché. */
export function useRelinkProject({ isDesktopApp, currentProjectRef, setProjects, setCurrentProject, showToast }: Deps) {
  return useCallback(
    async (proj: SongProject) => {
      if (isDesktopApp) {
        try {
          const folder = await pickNativeFolder();
          if (!folder) return;
          const scanned = await scanNativeFolder(folder);
          if (scanned.files.length === 0) {
            showToast(`No se encontraron pistas de audio compatibles en "${folder}".`);
            return;
          }
          await updateDesktopSongFolder(proj.id, folder);
          const updatedTracks = proj.tracks.map((t) => {
            const match = scanned.files.find(
              (f) =>
                f.trackName.toLowerCase() === t.name.toLowerCase() ||
                f.fileName.toLowerCase() === (t.fileName || '').toLowerCase()
            );
            if (match) {
              return {
                ...t,
                filePath: match.filePath,
                fileName: match.fileName,
              };
            }
            return t;
          });

          const updatedProj: SongProject = {
            ...proj,
            folderPath: folder,
            tracks: updatedTracks,
            updatedAt: Date.now(),
          };

          setProjects((prev) => prev.map((p) => (p.id === proj.id ? updatedProj : p)));
          if (currentProjectRef.current?.id === proj.id) {
            setCurrentProject(updatedProj);
          }
          await projectSaves.saveNow(updatedProj);
          showToast(`Carpeta reubicada para "${proj.title}".`);

          if (updatedProj.inSetlist) {
            nativeAudioEngine
              .generateNativeCacheForProject(updatedProj)
              .then((ok) => {
                if (!ok) showToast(`No se pudo regenerar la caché de "${updatedProj.title}".`);
              })
              .catch((err: any) => {
                console.error('[Relink] Error regenerando caché:', err);
                showToast(`Error al regenerar la caché de "${updatedProj.title}": ${err?.message || err}`);
              });
          }
        } catch (err) {
          console.error('[Relink] Error reubicando carpeta en escritorio:', err);
          showToast(`Error al reubicar carpeta: ${err}`);
        }
        return;
      }

      showToast('Reubicar carpetas solo está disponible en la app de escritorio.');
    },
    [isDesktopApp, showToast]
  );
}
