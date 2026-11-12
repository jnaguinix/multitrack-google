import { SongProject, TransportState } from '../types/project';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';
import { audioEngine } from '../audio/audioEngine';
import { isProjectPcmComplete } from '../storage/opfsStorage';
import { saveProjectToDb } from '../storage/projectDb';
import { deleteProjectNativeCache } from '../utils/nativeDialog';
import { loadDesktopLibrary, saveDesktopLibrary } from '../storage/desktopLibrary';

interface UseSetlistDeps {
  projectsRef: React.MutableRefObject<SongProject[]>;
  currentProject: SongProject | null;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  showToast: (msg: string) => void;
  isDesktopApp: boolean;
  setMissingNativeCache: React.Dispatch<React.SetStateAction<boolean>>;
  ensureSourceAccess: (projectId: string) => Promise<void>;
  runAutoOptimize: (projectId: string) => void;
  setMissingFolderSong: React.Dispatch<React.SetStateAction<SongProject | null>>;
  transport: TransportState;
  setlistQueue: SongProject[];
  handleLoadProjectImmediately: (projectId: string, autoPlay?: boolean) => Promise<void>;
}

export function useSetlist({
  projectsRef,
  currentProject,
  currentProjectRef,
  setProjects,
  setCurrentProject,
  showToast,
  isDesktopApp,
  setMissingNativeCache,
  ensureSourceAccess,
  runAutoOptimize,
  setMissingFolderSong,
  transport,
  setlistQueue,
  handleLoadProjectImmediately,
}: UseSetlistDeps) {
  const handleAddToSetlist = (projectId: string) => {
    const song = projectsRef.current.find((x) => x.id === projectId);
    if (!song) return;

    if (song.inSetlist) {
      showToast(`"${song.title}" ya está en el Setlist`);
      return;
    }

    const doAdd = () => {
      // In desktop, ensure native PCM cache is generated for this song
      if (isDesktopApp) {
        if (nativeAudioEngine.isProjectImporting(song.id)) {
          showToast(`"${song.title}": la caché ya se está generando (${nativeAudioEngine.formatImportProgress(song.id) ?? '...'}).`);
        } else {
          nativeAudioEngine
            .checkProjectCacheStatus(song)
            .then(async (status) => {
              if (status.isReady) return;
              if (song.tracks.length === 0) return;
              showToast(`Generando caché para "${song.title}"...`);
              const ok = await nativeAudioEngine.generateNativeCacheForProject(song);
              if (ok) {
                if (currentProjectRef.current?.id === song.id) setMissingNativeCache(false);
                showToast(`"${song.title}": lista para sonar.`);
              } else {
                showToast(`No se pudo generar la caché de "${song.title}". Revisa que los archivos originales existan.`);
              }
            })
            .catch((err: any) => {
              console.error('[Cache] Error generando caché al añadir al setlist:', err);
              showToast(`Error al generar la caché de "${song.title}": ${err?.message || err}`);
            });
        }
      } else {
        isProjectPcmComplete(song).then((complete) => {
          if (!complete) {
            ensureSourceAccess(projectId).then(() => runAutoOptimize(projectId));
          }
        });
      }

      setProjects((prev) => {
        const maxOrder = prev.reduce(
          (max, item) =>
            item.inSetlist ? Math.max(max, item.setlistOrder ?? 0) : max,
          -1
        );
        return prev.map((p) => {
          if (p.id !== projectId) return p;
          const updated: SongProject = {
            ...p,
            inSetlist: true,
            setlistOrder: maxOrder + 1,
          };
          saveProjectToDb(updated).catch(() => {});
          if (currentProject?.id === projectId) {
            setCurrentProject(updated);
          }
          showToast(`"${p.title}" añadida al Setlist`);
          return updated;
        });
      });
    };

    if (isDesktopApp && song.folderPath) {
      const invoke = (window as any).__TAURI__?.core?.invoke;
      const filePaths = song.tracks.filter((t) => t.filePath).map((t) => t.filePath!);
      if (invoke && filePaths.length > 0) {
        invoke('audio_check_files_exist', { paths: filePaths })
          .then((results: boolean[]) => {
            const allExist = results.every(Boolean);
            if (!allExist) {
              setMissingFolderSong(song);
            } else {
              doAdd();
            }
          })
          .catch(() => doAdd());
        return;
      }
    }

    doAdd();
  };

  const handleRemoveFromSetlist = (projectId: string) => {
    const song = projectsRef.current.find((x) => x.id === projectId);

    // 1. If currently playing this song, stop playback first
    if (currentProjectRef.current?.id === projectId && transport.isPlaying) {
      audioEngine.stop();
    }

    // 2. Clear native cache and RAM cache
    audioEngine.evictSongFromRamCache(projectId);
    if (isDesktopApp) {
      deleteProjectNativeCache(projectId).catch((err: any) => {
        console.warn('[Cache] Error eliminando caché al quitar del setlist:', err);
      });
    }

    // 3. Mark inSetlist = false (remains in library intact!)
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const updated: SongProject = { ...p, inSetlist: false, setlistOrder: undefined };
        saveProjectToDb(updated).catch(() => {});
        return updated;
      })
    );

    if (currentProjectRef.current?.id === projectId) {
      const remaining = setlistQueue.filter((s) => s.id !== projectId);
      if (remaining.length > 0) {
        handleLoadProjectImmediately(remaining[0].id, false);
      } else {
        setCurrentProject(null);
      }
    }

    if (isDesktopApp) {
      loadDesktopLibrary().then((lib) => {
        if (lib) {
          lib.activeSetlist = (lib.activeSetlist || []).filter((id) => id !== projectId);
          const s = lib.songs.find((x) => x.id === projectId);
          if (s) {
            s.inSetlist = false;
            s.setlistOrder = undefined;
          }
          saveDesktopLibrary(lib).catch(() => {});
        }
      }).catch(() => {});
    }

    showToast(
      song
        ? `"${song.title}" quitada de la sesión (conservada en biblioteca)`
        : 'Canción quitada de la sesión'
    );
  };

  const handleClearSetlist = async () => {
    // 1. If playing, stop playback first
    if (transport.isPlaying) {
      audioEngine.stop();
    }

    const queue = [...setlistQueue];
    if (queue.length === 0) return;

    // 2. Evict RAM cache and PCM cache for setlist songs on desktop
    for (const song of queue) {
      audioEngine.evictSongFromRamCache(song.id);
      if (isDesktopApp) {
        deleteProjectNativeCache(song.id).catch(() => {});
      }
    }

    // 3. Mark inSetlist = false across projects
    const idSet = new Set(queue.map((s) => s.id));
    setProjects((prev) =>
      prev.map((p) => {
        if (!idSet.has(p.id)) return p;
        const updated: SongProject = { ...p, inSetlist: false, setlistOrder: undefined };
        saveProjectToDb(updated).catch(() => {});
        return updated;
      })
    );

    setCurrentProject(null);

    // 4. Update desktop library file if on desktop
    if (isDesktopApp) {
      try {
        const lib = await loadDesktopLibrary();
        if (lib) {
          lib.activeSetlist = [];
          for (const s of lib.songs) {
            if (idSet.has(s.id)) {
              s.inSetlist = false;
              s.setlistOrder = undefined;
            }
          }
          await saveDesktopLibrary(lib);
        }
      } catch (err) {
        console.warn('[Library] Error limpiando setlist en library.json:', err);
      }
    }

    showToast(
      `Sesión vaciada (${queue.length} ${queue.length === 1 ? 'canción quitada' : 'canciones quitadas'} del Setlist)`
    );
  };

  const handleReorderSetlist = (fromIndex: number, toIndex: number) => {
    const queue = [...setlistQueue];
    const [moved] = queue.splice(fromIndex, 1);
    if (!moved) return;
    queue.splice(toIndex, 0, moved);

    const orderMap = new Map<string, number>();
    queue.forEach((item, idx) => orderMap.set(item.id, idx));

    setProjects((prev) =>
      prev.map((p) => {
        if (!orderMap.has(p.id)) return p;
        const updated = { ...p, setlistOrder: orderMap.get(p.id)! };
        saveProjectToDb(updated).catch(() => {});
        return updated;
      })
    );
  };

  // Live page: make a song the one that plays after the current one
  const handleSetAsNextSong = (projectId: string) => {
    const cur = setlistQueue.findIndex((s) => s.id === currentProjectRef.current?.id);
    const from = setlistQueue.findIndex((s) => s.id === projectId);
    if (from === -1 || from === cur) return;
    const to = cur === -1 ? 0 : from > cur ? cur + 1 : cur;
    if (from !== to) handleReorderSetlist(from, to);
    showToast(`"${setlistQueue[from].title}" sonará a continuación`);
  };

  const handleMoveInSetlist = (projectId: string, direction: 'up' | 'down') => {
    const idx = setlistQueue.findIndex((s) => s.id === projectId);
    if (idx === -1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= setlistQueue.length) return;
    handleReorderSetlist(idx, targetIdx);
  };

  return {
    handleAddToSetlist,
    handleRemoveFromSetlist,
    handleClearSetlist,
    handleReorderSetlist,
    handleSetAsNextSong,
    handleMoveInSetlist,
  };
}
