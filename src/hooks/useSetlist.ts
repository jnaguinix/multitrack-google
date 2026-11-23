import { logAsyncError } from '../utils/asyncErrors';
import { SongProject, TransportState } from '../types/project';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';
import { audioEngine } from '../audio/audioEngine';
import { projectSaves } from '../storage/projectSaves';
import { deleteProjectNativeCache } from '../utils/nativeDialog';
import {
  clearDesktopSetlist,
  loadDesktopSongPeaks,
  removeSongFromDesktopSetlist,
  reorderDesktopSetlist,
} from '../storage/desktopLibrary';
import { songLacksPeaks, withSongPeaks } from '../utils/songPeaks';

interface UseSetlistDeps {
  projectsRef: React.MutableRefObject<SongProject[]>;
  currentProject: SongProject | null;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  showToast: (msg: string) => void;
  isDesktopApp: boolean;
  setMissingNativeCache: React.Dispatch<React.SetStateAction<boolean>>;
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

    // Pide a Rust los picos de la canción (su archivo de picos o, si no existe, la caché PCM) y los une a la canción en
    // la lista y, si es la montada, a la montada. Se llama al añadirla y otra vez cuando termina de generarse su caché:
    // una canción recién importada no tiene archivo de picos hasta que la caché existe, y sin esto su onda salía plana.
    const refreshPeaks = () => {
      loadDesktopSongPeaks(projectId)
        .then((peaks) => {
          if (Object.keys(peaks).length === 0) return;
          setProjects((prev) => prev.map((p) => (p.id === projectId ? withSongPeaks(p, peaks) : p)));
          const mounted = currentProjectRef.current;
          if (mounted?.id === projectId && songLacksPeaks(mounted)) setCurrentProject(withSongPeaks(mounted, peaks));
        })
        .catch(logAsyncError('leer los picos de la canción'));
    };

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
                refreshPeaks();
              } else {
                showToast(`No se pudo generar la caché de "${song.title}". Revisa que los archivos originales existan.`);
              }
            })
            .catch((err: any) => {
              console.error('[Cache] Error generando caché al añadir al setlist:', err);
              showToast(`Error al generar la caché de "${song.title}": ${err?.message || err}`);
            });
        }
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
          void projectSaves.saveNow(updated);
          if (currentProject?.id === projectId) {
            setCurrentProject(updated);
          }
          showToast(`"${p.title}" añadida al Setlist`);
          return updated;
        });
      });

      // La biblioteca solo trae los picos de las canciones que ya estaban en el setlist: la ficha de esta necesita
      // los suyos para dibujar su mini onda sin tener que abrirla.
      if (isDesktopApp && songLacksPeaks(song)) refreshPeaks();
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

  // El cambio del setlist ya se ve en pantalla; si Rust no lo pudo guardar, el del disco quedaría distinto del que se
  // ve (al reabrir volvería el anterior): se registra con su contexto y se avisa.
  const warnSetlistNotSaved = (context: string) => (error: unknown) => {
    logAsyncError(context)(error);
    showToast('No se pudo guardar el cambio del Setlist en la biblioteca. Al reabrir la app puede volver el anterior.');
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

    // 3. Mark inSetlist = false (remains in library intact!). En escritorio lo guarda Rust (solo pertenencia y orden);
    // en el navegador se guarda la canción como siempre.
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const updated: SongProject = { ...p, inSetlist: false, setlistOrder: undefined };
        if (!isDesktopApp) void projectSaves.saveNow(updated);
        return updated;
      })
    );
    if (isDesktopApp) {
      // Antes se guarda lo pendiente de esa canción (un fader movido hace un instante): un guardado diferido que llegara
      // después la volvería a marcar como parte del setlist.
      projectSaves
        .flush(projectId)
        .then(() => removeSongFromDesktopSetlist(projectId))
        .catch(warnSetlistNotSaved('quitar la canción del setlist en la biblioteca'));
    }

    if (currentProjectRef.current?.id === projectId) {
      const remaining = setlistQueue.filter((s) => s.id !== projectId);
      if (remaining.length > 0) {
        handleLoadProjectImmediately(remaining[0].id, false);
      } else {
        setCurrentProject(null);
      }
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
        deleteProjectNativeCache(song.id).catch(logAsyncError('borrar la caché nativa de la canción'));
      }
    }

    // 3. Mark inSetlist = false across projects
    const idSet = new Set(queue.map((s) => s.id));
    setProjects((prev) =>
      prev.map((p) => {
        if (!idSet.has(p.id)) return p;
        const updated: SongProject = { ...p, inSetlist: false, setlistOrder: undefined };
        if (!isDesktopApp) void projectSaves.saveNow(updated);
        return updated;
      })
    );

    setCurrentProject(null);

    // 4. En escritorio, Rust vacía el setlist en la biblioteca del disco (solo pertenencia y orden).
    if (isDesktopApp) {
      try {
        // Lo pendiente de esas canciones se guarda antes: un guardado diferido posterior las volvería a marcar.
        await Promise.all(queue.map((s) => projectSaves.flush(s.id)));
        await clearDesktopSetlist();
      } catch (err) {
        warnSetlistNotSaved('vaciar el setlist en la biblioteca')(err);
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
        if (!isDesktopApp) void projectSaves.saveNow(updated);
        return updated;
      })
    );
    // La canción montada tiene su propia copia (`currentProject`): si conserva el número de orden viejo, el siguiente
    // cambio de mezcla la guardaría con él y desordenaría el setlist.
    const mounted = currentProjectRef.current;
    const mountedOrder = mounted ? orderMap.get(mounted.id) : undefined;
    if (mounted && mountedOrder !== undefined && mounted.setlistOrder !== mountedOrder) {
      setCurrentProject({ ...mounted, setlistOrder: mountedOrder });
    }
    // En escritorio, una sola orden a Rust con el orden nuevo (antes se reescribía la biblioteca una vez por canción).
    if (isDesktopApp) {
      // Lo pendiente de esas canciones se guarda ANTES (un fader movido justo antes tiene un guardado diferido que
      // llevaría el orden viejo y lo dejaría así en esa canción).
      Promise.all(queue.map((item) => projectSaves.flush(item.id)))
        .then(() => reorderDesktopSetlist(queue.map((item) => item.id)))
        .catch(warnSetlistNotSaved('reordenar el setlist en la biblioteca'));
    }
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
