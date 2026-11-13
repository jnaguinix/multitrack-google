/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Music, FolderOpen, AlertTriangle, Trash2 } from 'lucide-react';
import { audioEngine } from './audio/audioEngine';
import { nativeAudioEngine } from './audio/nativeAudioEngine';
import { useOptimization } from './hooks/useOptimization';
import { useProjectActions } from './hooks/useProjectActions';
import { useSetlist } from './hooks/useSetlist';
import { useImportFlow } from './hooks/useImportFlow';
import { useMixerActions } from './hooks/useMixerActions';
import { useDawDragDrop } from './hooks/useDawDragDrop';
import {
  deleteProjectFromDb,
  loadAllProjectsFromDb,
  relinkProjectSources,
  normalizeProjectSectionsToTime,
  saveProjectToDb,
  StoredAudioStem,
  syncProjectSidecarNow,
} from './storage/projectDb';
import {
  AudioEngineMode,
  MetersSnapshot,
  OutputBus,
  QuantizeMode,
  RemoteSyncMessage,
  SetlistTransitionMode,
  SongProject,
  SongSection,
  TrackChannel,
  TransportState,
} from './types/project';
import { TopBar, WorkspaceView } from './components/TopBar';
import { formatTimecode, TransportDeck } from './components/TransportDeck';
import { resolveTransition } from './utils/setlistTransition';
import { SECTION_TEMPLATES, insertTemplateSection } from './utils/sectionTemplates';
import { RepertoireTreeSidebar } from './components/RepertoireTreeSidebar';
import { SetlistPageView } from './components/SetlistPageView';
import { LiveSetView } from './components/LiveSetView';
import { TimelineArranger } from './components/TimelineArranger';
import { MultitrackMixer } from './components/MultitrackMixer';
import {
  scanNativeFolder,
  deleteProjectNativeCache,
  pickNativeFolder,
} from './utils/nativeDialog';
import {
  updateDesktopSongFolder,
} from './storage/desktopLibrary';
import {
  cleanOrphanPcmDirectories,
  isOpfsSupported,
  isProjectPcmComplete,
} from './storage/opfsStorage';
import {
  getRegisteredHandle,
  isFsAccessSupported,
} from './storage/sourceFiles';
import {
  PcmOptimizationProgress,
} from './storage/pcmOptimizer';
import {
  ConfirmSongActionModal,
  inferTrackRoleAndColor,
  LibraryView,
  OptimizationProgressModal,
  SectionEditorModal,
  SongFingerprintPromptModal,
  SongMetadataEditModal,
  StemImporterModal,
} from './components/LibraryAndModals';
import {
  FingerprintCandidate,
} from './audio/fingerprint';

const DesktopRemoteBridge = import.meta.env.VITE_OMNITRACKS_DESKTOP === '1'
  ? React.lazy(() => import('../desktop/frontend/RemoteConnectionBridge'))
  : null;

const DesktopAudioSettings = import.meta.env.VITE_OMNITRACKS_DESKTOP === '1'
  ? React.lazy(() => import('../desktop/frontend/DesktopAudioSettings'))
  : null;

const INITIAL_TRANSPORT: TransportState = {
  isPlaying: false,
  currentTimeSec: 0,
  totalDurationSec: 0,
  currentBar: 1,
  currentBeat: 1,
  beatProgress: 0,
  activeSectionId: null,
  queuedSectionId: null,
  queuedTargetBar: null,
  countdownBeats: 0,
  isVamping: false,
  lastCueMessage: null,
  isMountingSong: false,
  mountingProgressText: null,
};

function getInitialViewFromHash(): WorkspaceView {
  const hash = window.location.hash.replace('#', '').toLowerCase();
  if (
    hash === 'setlist' ||
    hash === 'live' ||
    hash === 'arranger' ||
    hash === 'mixer' ||
    hash === 'library'
  ) {
    return hash;
  }
  return 'setlist';
}

const MARKER_PALETTE = [
  '#06B6D4',
  '#3B82F6',
  '#10B981',
  '#F59E0B',
  '#8B5CF6',
  '#EC4899',
  '#EF4444',
];

export default function App() {
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  const [activeView, setActiveView] = useState<WorkspaceView>(getInitialViewFromHash);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < 1280
  );
  useEffect(() => {
    const narrowWorkspace = window.matchMedia('(max-width: 720px)');
    const collapseOnNarrowWorkspace = (event: MediaQueryListEvent) => {
      if (event.matches) setIsSidebarCollapsed(true);
    };
    narrowWorkspace.addEventListener('change', collapseOnNarrowWorkspace);
    return () => narrowWorkspace.removeEventListener('change', collapseOnNarrowWorkspace);
  }, []);
  const [isDockedMixerOpen, setIsDockedMixerOpen] = useState<boolean>(false);
  const [projects, setProjects] = useState<SongProject[]>([]);
  const [currentProject, setCurrentProject] = useState<SongProject | null>(null);
  const [remoteTriggerHost, setRemoteTriggerHost] = useState<HTMLSpanElement | null>(null);
  const [audioTriggerHost, setAudioTriggerHost] = useState<HTMLSpanElement | null>(null);
  const [transport, setTransport] = useState<TransportState>(INITIAL_TRANSPORT);
  const [ramCacheVersion, setRamCacheVersion] = useState<number>(0);
  const [engineMode, setEngineModeState] = useState<AudioEngineMode>(() =>
    audioEngine.getEngineMode()
  );
  const [ramBudgetMB, setRamBudgetMBState] = useState<number>(() =>
    audioEngine.getRamBudgetMB()
  );
  // Default transition mode is 'cue-next' (mounts at 00:00 in pause) so songs never start playing on their own unexpectedly
  const [setlistTransitionMode, setSetlistTransitionMode] =
    useState<SetlistTransitionMode>('cue-next');
  const [confirmSongCandidate, setConfirmSongCandidate] = useState<SongProject | null>(
    null
  );
  const [optimizingProject, setOptimizingProject] = useState<SongProject | null>(null);
  const [optimizationProgress, setOptimizationProgress] =
    useState<PcmOptimizationProgress | null>(null);
  // Counts in-flight activateProject() calls so next-song preload waits for the active song to finish decoding
  const activationCountRef = useRef(0);
  const runAutoOptimizeRef = useRef<(projectId: string) => void>(() => {});
  const applyPruneRef = useRef<() => void>(() => {});
  const activateProjectRef = useRef<(p: SongProject) => void>(() => {});
  const modalProjectIdRef = useRef<string | null>(null);
  const queuedOptimizeIdsRef = useRef<Set<string>>(new Set());
  // Same set as state so the UI can show which songs are being prepared
  const [preparingIds, setPreparingIds] = useState<Set<string>>(new Set());
  const [isActivatingProject, setIsActivatingProject] = useState(false);

  // 5. Medidores en un ref (no en el estado de App) para no recargar el hilo principal
  const metersRef = useRef<MetersSnapshot>({
    tracks: {},
    master: { rms: 0, peak: 0, clipping: false },
  });

  const [songToDeleteFromLibrary, setSongToDeleteFromLibrary] = useState<SongProject | null>(null);
  const [missingFolderSong, setMissingFolderSong] = useState<SongProject | null>(null);
  const [editingMetadataSong, setEditingMetadataSong] = useState<SongProject | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importStatusText, setImportStatusText] = useState<string | null>(null);
  const [fingerprintPrompt, setFingerprintPrompt] = useState<{
    candidates: FingerprintCandidate[];
    incomingTrackCount: number;
    sourceLabel: string;
    resolve: (choice: SongProject | null | 'cancel') => void;
  } | null>(null);
  const [dragOverlayMode, setDragOverlayMode] = useState<'files' | 'repertoire-song' | null>(
    null
  );
  const [isSectionEditorOpen, setIsSectionEditorOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const channelRef = useRef<BroadcastChannel | null>(null);
  const lastBroadcastTransportMsRef = useRef<number>(0);
  const currentProjectRef = useRef<SongProject | null>(currentProject);
  currentProjectRef.current = currentProject;
  const projectsRef = useRef<SongProject[]>([]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  const transportRef = useRef<TransportState>(transport);
  transportRef.current = transport;

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3400);
  }, []);

  const isDesktopApp = typeof window !== 'undefined' && Boolean((window as any).__TAURI__);
  const [isDeviceDisconnected, setIsDeviceDisconnected] = useState(false);
  const [missingNativeCache, setMissingNativeCache] = useState(false);
  const [isGeneratingNativeCache, setIsGeneratingNativeCache] = useState(false);
  const [nativeCacheProgress, setNativeCacheProgress] = useState<{ percent: number; text: string }>({ percent: 0, text: '' });

  useEffect(() => {
    if (isDesktopApp) {
      nativeAudioEngine.setOnDeviceDisconnected((disconnected) => {
        setIsDeviceDisconnected(disconnected);
      });
    }
  }, [isDesktopApp]);

  useEffect(() => {
    if (isDesktopApp && currentProject && currentProject.tracks.length > 0) {
      if (nativeAudioEngine.isProjectImporting(currentProject.id)) {
        setMissingNativeCache(false);
        return;
      }
      nativeAudioEngine.checkProjectCacheStatus(currentProject).then((st) => {
        if (!nativeAudioEngine.isProjectImporting(currentProject.id)) {
          setMissingNativeCache(!st.isReady);
        }
      });
    } else {
      setMissingNativeCache(false);
    }
  }, [currentProject?.id, isDesktopApp]);

  // Derived ordered Setlist Queue
  const setlistQueue = useMemo(() => {
    return projects
      .filter((p) => p.inSetlist)
      .sort((a, b) => (a.setlistOrder ?? 999) - (b.setlistOrder ?? 999));
  }, [projects]);

  // Subscribe to RAM cache status updates to refresh Setlist card badges
  useEffect(() => {
    const unsubscribeCache = audioEngine.subscribeCache(() => {
      setRamCacheVersion((v) => v + 1);
    });
    return unsubscribeCache;
  }, []);

  // Escritorio: la caché PCM nativa avisa por nativeAudioEngine (no por audioEngine). Sin esta
  // suscripción las tarjetas del setlist y de En vivo no se redibujan al avanzar/terminar la generación.
  useEffect(() => {
    if (!isDesktopApp) return;
    return nativeAudioEngine.subscribeCache(() => {
      setRamCacheVersion((v) => v + 1);
    });
  }, [isDesktopApp]);

  // Escritorio: consultar el estado real de la caché de cada canción del setlist al abrir la app
  // y cada vez que cambia el conjunto de canciones/pistas.
  const setlistCacheKey = setlistQueue.map((s) => `${s.id}:${s.tracks.length}`).join('|');
  useEffect(() => {
    if (!isDesktopApp || setlistQueue.length === 0) return;
    nativeAudioEngine.refreshCacheStatuses(setlistQueue).catch((err) => {
      console.error('[Cache] Error consultando el estado de la caché del setlist:', err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktopApp, setlistCacheKey]);

  // 2. CACHÉ Y PRECARGA DE LA SIGUIENTE CANCIÓN:
  // Cuando una canción del setlist queda activa o el setlist cambia, recalcula cuál es la siguiente
  // y llama a preloadProject(nextSong) en segundo plano (manteniendo máx. 2 canciones en caché: actual + siguiente).
  useEffect(() => {
    if (setlistQueue.length === 0) return;
    // Wait until loadProject() has finished: avoids competing for decodeAudioData / eviction
    if (isActivatingProject) return;

    const activeId = currentProject?.id;
    const activeIdx = activeId
      ? setlistQueue.findIndex((s) => s.id === activeId)
      : -1;

    const nextSong =
      activeIdx >= 0 && activeIdx < setlistQueue.length - 1
        ? setlistQueue[activeIdx + 1]
        : activeIdx === -1 && setlistQueue.length > 0
        ? setlistQueue[0]
        : null;

    if (!nextSong || nextSong.id === activeId) return;
    // Don't decode the next song into RAM while it is still being converted into the OPFS cache
    if (isOpfsSupported() && queuedOptimizeIdsRef.current.has(nextSong.id)) return;

    const timerId = window.setTimeout(() => {
      audioEngine.preloadProject(nextSong).catch((err) => {
        console.error('Error preloading next setlist song:', err);
      });
    }, 100);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [setlistQueue, currentProject?.id, ramBudgetMB, isActivatingProject]);

  // Surface engine notices (play blocked, still loading...) instead of failing silently
  useEffect(() => {
    audioEngine.setOnNotice(showToast);
    return () => audioEngine.setOnNotice(null);
  }, [showToast]);

  // Keep the active song + the next setlist song as eviction-protected (priority) in RAM.
  // With nothing active yet, the first two songs of the setlist are the priority pair.
  useEffect(() => {
    const activeIdx = currentProject
      ? setlistQueue.findIndex((s) => s.id === currentProject.id)
      : -1;
    const ids: string[] = [];
    if (currentProject) ids.push(currentProject.id);
    const nextIdx = activeIdx >= 0 ? activeIdx + 1 : 0;
    if (setlistQueue[nextIdx]) ids.push(setlistQueue[nextIdx].id);
    if (!currentProject && setlistQueue[1]) ids.push(setlistQueue[1].id);
    audioEngine.setPriorityProjectIds(ids);
  }, [setlistQueue, currentProject?.id]);

  // The manual "Optimizar" button and the automatic background cache are ONE job:
  // pressing the button while the song is already being prepared just shows its progress.
  const {
    handleStartOptimizeProject,
    handleCancelOptimization,
    applyPrune,
    runAutoOptimize,
    ensureSourceAccess,
  } = useOptimization({
    isDesktopApp,
    showToast,
    projectsRef,
    currentProjectRef,
    activateProjectRef,
    setProjects,
    setCurrentProject,
    setIsGeneratingNativeCache,
    setNativeCacheProgress,
    setMissingNativeCache,
    setOptimizingProject,
    setOptimizationProgress,
    setPreparingIds,
    setImportStatusText,
    runAutoOptimizeRef,
    applyPruneRef,
    queuedOptimizeIdsRef,
    modalProjectIdRef,
  });

  useEffect(() => {
    applyPruneRef.current = applyPrune;
  }, [applyPrune]);

  useEffect(() => {
    runAutoOptimizeRef.current = runAutoOptimize;
  }, [runAutoOptimize]);

  const handleRelinkProject = useCallback(
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

          setProjects((prev) =>
            prev.map((p) => (p.id === proj.id ? updatedProj : p))
          );
          if (currentProjectRef.current?.id === proj.id) {
            setCurrentProject(updatedProj);
          }
          await saveProjectToDb(updatedProj);
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

      if (!isFsAccessSupported()) {
        showToast('Tu navegador no permite reubicar carpetas (usa Chrome o Edge).');
        return;
      }
      try {
        let dir: any;
        try {
          dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') throw err;
          dir = await (window as any).showDirectoryPicker({ mode: 'read' });
        }
        const { relinked, total } = await relinkProjectSources(proj.id, dir);
        if (relinked === 0) {
          showToast(`No se encontró ningún stem de "${proj.title}" en esa carpeta.`);
          return;
        }
        syncProjectSidecarNow(proj, true).catch(() => {});
        showToast(`Reubicados ${relinked}/${total} stems de "${proj.title}"`);
        runAutoOptimize(proj.id);
      } catch (err) {
        if ((err as { name?: string })?.name !== 'AbortError') {
          console.warn('[Relink] Error reubicando archivos:', err);
          showToast('No se pudo reubicar la carpeta');
        }
      }
    },
    [isDesktopApp, runAutoOptimize, showToast]
  );

  const handleChangeEngineMode = useCallback(
    (mode: AudioEngineMode) => {
      audioEngine.setEngineMode(mode);
      setEngineModeState(audioEngine.getEngineMode());
      showToast(
        mode === 'stream'
          ? 'Modo Stream seleccionado (usa Buffer como respaldo si la canción aún no tiene PCM)'
          : 'Modo Buffer seleccionado (AudioBuffer completo en RAM con presupuesto)'
      );
    },
    [showToast]
  );

  const handleChangeRamBudgetMB = useCallback(
    (mb: number) => {
      audioEngine.setRamBudgetMB(mb);
      setRamBudgetMBState(audioEngine.getRamBudgetMB());
      showToast(`Presupuesto de caché RAM ajustado a ${audioEngine.getRamBudgetMB()} MB`);
    },
    [showToast]
  );

  // 2 & 6. Activate a project using cached AudioBuffers if available and log console.info metrics
  const activateProject = useCallback(
    async (
      projectToLoad: SongProject,
      predecodedBuffers?: Map<string, AudioBuffer>,
      explicitPlayIfAlreadyInRam = false
    ) => {
      const t0 = performance.now();
      activationCountRef.current++;
      setIsActivatingProject(true);
      try {
        const normalizedProj = normalizeProjectSectionsToTime(projectToLoad);
        const wasReadyBeforeLoad = audioEngine.getSongRamCacheInfo(normalizedProj).isReady;
        const cachedBuffers =
          predecodedBuffers ??
          (audioEngine.hasFullProjectInCache(normalizedProj)
            ? audioEngine.getCachedProjectBuffers(normalizedProj.id)
            : undefined);
        const cameFromCache = Boolean(cachedBuffers) || wasReadyBeforeLoad;

        // Show project UI immediately while stems mount
        setCurrentProject(normalizedProj);

        const { peaksMap, wasCancelled } = await audioEngine.loadProject(
          normalizedProj,
          cachedBuffers
        );

        // If user switched to another song while this one was still decoding, abort
        if (wasCancelled) return;

        if (normalizedProj.tracks.length > 0 && !audioEngine.hasPlayableAudio()) {
          showToast(
            `No se pudo cargar el audio de "${normalizedProj.title}". Revisa que los archivos originales existan y estén permitidos (Biblioteca → Reubicar archivos).`
          );
        }

        const elapsedMs = performance.now() - t0;
        console.info(
          `[AudioEngine][activateProject] "${normalizedProj.title}" (${normalizedProj.id}) activada en ${elapsedMs.toFixed(1)} ms | Origen: ${cameFromCache ? 'CACHÉ RAM (HIT)' : 'INDEXEDDB (MISS)'}`
        );

        const realDurationSec = audioEngine.getTotalDurationSec();
        const latestBase =
          currentProjectRef.current?.id === normalizedProj.id
            ? currentProjectRef.current
            : normalizedProj;
        const enrichedTracks = latestBase.tracks.map((t) => ({
          ...t,
          peaks: peaksMap.get(t.id) || t.peaks || [],
        }));

        const updatedProject: SongProject = {
          ...latestBase,
          durationSec: realDurationSec,
          tracks: enrichedTracks,
        };

        setCurrentProject(updatedProject);
        audioEngine.updateProjectConfig(updatedProject);
        saveProjectToDb(updatedProject).catch(() => {});
        setProjects((prev) => {
          const exists = prev.some((p) => p.id === updatedProject.id);
          if (!exists) return [updatedProject, ...prev];
          return prev.map((p) => (p.id === updatedProject.id ? updatedProject : p));
        });

        // Never start spontaneous playback after a slow disk load;
        // only play if explicitly requested AND the song was already 100% ready in RAM / staged streaming
        if (explicitPlayIfAlreadyInRam && (cameFromCache || isDesktopApp) && audioEngine.hasPlayableAudio()) {
          audioEngine.play();
        }
      } catch (err) {
        console.error('Error loading project into engine:', err);
      } finally {
        activationCountRef.current = Math.max(0, activationCountRef.current - 1);
        if (activationCountRef.current === 0) setIsActivatingProject(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    activateProjectRef.current = (p) => {
      activateProject(p);
    };
  }, [activateProject]);

  // Initial load from IndexedDB: ONLY loads the Repertoire list, NEVER auto-loads a song into the DAW
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const saved = await loadAllProjectsFromDb();
        if (!mounted) return;
        setProjects(saved);
        // Clean up orphan OPFS directories from projects that were previously deleted
        const validIds = new Set(saved.map((p) => p.id));
        cleanOrphanPcmDirectories(validIds).catch(() => {});
        projectsRef.current = saved;
        applyPruneRef.current();
      } catch {
        // Keep empty repertoire if IndexedDB unavailable
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  // Setlist Prev / Next Song Handlers
  const handleNextSetlistSong = useCallback(
    async (autoPlay = false) => {
      const activeId = currentProjectRef.current?.id;
      const idx = setlistQueue.findIndex((s) => s.id === activeId);
      const nextSong =
        idx >= 0 && idx < setlistQueue.length - 1
          ? setlistQueue[idx + 1]
          : idx === -1 && setlistQueue.length > 0
          ? setlistQueue[0]
          : null;

      if (!nextSong) {
        showToast('Fin del Setlist alcanzado');
        return;
      }

      const isReadyInRam = audioEngine.getSongRamCacheInfo(nextSong).isReady;
      await activateProject(nextSong, undefined, autoPlay && isReadyInRam);
      showToast(
        autoPlay && isReadyInRam
          ? `Reproduciendo siguiente en Setlist: ${nextSong.title}`
          : `Siguiente canción lista en 00:00: ${nextSong.title}`
      );
    },
    [activateProject, setlistQueue, showToast]
  );

  const handlePrevSetlistSong = useCallback(async () => {
    const activeId = currentProjectRef.current?.id;
    const idx = setlistQueue.findIndex((s) => s.id === activeId);
    if (idx > 0) {
      const prevSong = setlistQueue[idx - 1];
      await activateProject(prevSong, undefined, false);
      showToast(`Canción anterior cargada en 00:00: ${prevSong.title}`);
    }
  }, [activateProject, setlistQueue, showToast]);

  // Connect Setlist End-of-Song Transition Callback
  useEffect(() => {
    audioEngine.setOnSongEnded(() => {
      // La flecha de la propia canción manda; sin ella, el ajuste general.
      const mode = resolveTransition(currentProjectRef.current, setlistTransitionMode);
      if (mode === 'cue-next') {
        handleNextSetlistSong(false);
      } else if (mode === 'auto-play') {
        handleNextSetlistSong(true);
      }
    });
    return () => audioEngine.setOnSongEnded(null);
  }, [handleNextSetlistSong, setlistTransitionMode]);

  // 5. BroadcastChannel: send full project ONLY when currentProject changes
  useEffect(() => {
    if (!channelRef.current || !currentProject) return;
    const msg: RemoteSyncMessage = {
      type: 'STATE_SYNC',
      project: {
        ...currentProject,
        tracks: currentProject.tracks.map(({ peaks: _peaks, ...rest }) => rest),
      },
      transport: transportRef.current,
    };
    channelRef.current.postMessage(msg);
  }, [currentProject]);

  // 5. Subscribe to transport updates (already throttled to ~20fps by audioEngine)
  // and send transport-only BroadcastChannel updates throttled to ~10fps (100ms)
  useEffect(() => {
    const unsubscribe = audioEngine.subscribe((newTransport) => {
      setTransport(newTransport);

      if (channelRef.current && currentProjectRef.current) {
        const nowMs = performance.now();
        if (nowMs - lastBroadcastTransportMsRef.current >= 100) {
          lastBroadcastTransportMsRef.current = nowMs;
          const msg: RemoteSyncMessage = {
            type: 'TRANSPORT_SYNC',
            transport: newTransport,
          };
          channelRef.current.postMessage(msg);
        }
      }
    });

    return unsubscribe;
  }, []);

  // Mutate and persist current project helper
  const updateCurrentProject = useCallback(
    (updater: (prev: SongProject) => SongProject) => {
      setCurrentProject((prev) => {
        if (!prev) return null;
        const next = updater(prev);
        if (next === prev) return prev;
        audioEngine.updateProjectConfig(next);
        saveProjectToDb(next).catch(() => {});
        setProjects((list) => list.map((item) => (item.id === next.id ? next : item)));
        return next;
      });
    },
    []
  );

  // Setup BroadcastChannel for multi-tab / tablet Stage Remote control
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel('omnitracks_remote_sync');
    channelRef.current = bc;

    bc.onmessage = (ev: MessageEvent<RemoteSyncMessage>) => {
      const data = ev.data;
      if (!data) return;

      switch (data.type) {
        case 'CMD_PLAY_PAUSE':
          audioEngine.togglePlayPause();
          break;
        case 'CMD_STOP':
          audioEngine.stop();
          break;
        case 'CMD_JUMP_SECTION':
          audioEngine.queueSectionJump(data.sectionId);
          break;
        case 'CMD_TOGGLE_VAMP':
          audioEngine.toggleVamp();
          break;
        case 'CMD_TOGGLE_CLICK':
          updateCurrentProject((p) => ({ ...p, clickEnabled: !p.clickEnabled }));
          break;
        case 'CMD_TOGGLE_GUIDE':
          updateCurrentProject((p) => ({ ...p, guideCuesEnabled: !p.guideCuesEnabled }));
          break;
        case 'CMD_SET_QUANTIZE':
          updateCurrentProject((p) => ({ ...p, quantizeMode: data.mode }));
          break;
        case 'CMD_SET_TRACK_MUTE':
          updateCurrentProject((p) => ({
            ...p,
            tracks: p.tracks.map((t) =>
              t.id === data.trackId ? { ...t, muted: data.muted } : t
            ),
          }));
          break;
        case 'CMD_SET_CLICK_GAIN':
          updateCurrentProject((p) => ({ ...p, clickGain: data.gain }));
          break;
        case 'CMD_SET_GUIDE_GAIN':
          updateCurrentProject((p) => ({ ...p, guideGain: data.gain }));
          break;
        case 'CMD_SET_MASTER_GAIN':
          updateCurrentProject((p) => ({ ...p, masterGain: data.gain }));
          break;
        case 'CMD_NEXT_SONG':
          handleNextSetlistSong(false);
          break;
        case 'CMD_PREV_SONG':
          handlePrevSetlistSong();
          break;
        default:
          break;
      }
    };

    return () => {
      bc.close();
      channelRef.current = null;
    };
  }, [handleNextSetlistSong, handlePrevSetlistSong, updateCurrentProject]);

  // Global Studio Keyboard Shortcuts (Space = Play/Pause, V = Vamp, 1-9 = Section Jumps)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (!currentProjectRef.current) return;

      if (e.code === 'Space') {
        e.preventDefault();
        audioEngine.togglePlayPause();
      } else if (e.key.toLowerCase() === 'v') {
        e.preventDefault();
        audioEngine.toggleVamp();
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        const sec = currentProjectRef.current.sections[idx];
        if (sec) {
          e.preventDefault();
          audioEngine.queueSectionJump(sec.id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSelectView = (view: WorkspaceView) => {
    setActiveView(view);
    window.history.replaceState(null, '', `#${view}`);
  };

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

  // «Iniciar en vivo»: monta la primera canción del setlist (sin reproducirla) y abre En vivo.
  const handleStartLive = () => {
    const first = setlistQueue[0];
    if (!first) return;
    handleSelectView('live');
    if (currentProjectRef.current?.id !== first.id) {
      handleLoadProjectImmediately(first.id, false);
    }
  };

  const { handleInstantImportFiles, handleImportNative } = useImportFlow({
    projects,
    projectsRef,
    currentProjectRef,
    setProjects,
    setCurrentProject,
    showToast,
    setImportStatusText,
    setFingerprintPrompt,
    setMissingNativeCache,
    runAutoOptimizeRef,
  });


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
      const sortedExisting = [...prev.sections].sort(
        (a, b) => a.startTimeSec - b.startTimeSec
      );
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

      const combined = [...prev.sections, newSec].sort(
        (a, b) => a.startTimeSec - b.startTimeSec
      );
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
      syncProjectSidecarNow(next, true).catch(() => {});
      return next;
    });

    showToast(`Marcador creado en ${formatTimecode(clampedStart)}`);
  };

  const {
    handlePlayPause,
    handleStop,
    handleToggleVamp,
    handleJumpSection,
    handleCancelQueuedJump,
    handleSeekSeconds,
    handleChangeBpm,
    handleChangePitch,
    handleChangeQuantize,
    handleToggleClick,
    handleToggleGuide,
    handleToggleSplitRouting,
    handleToggleTrackMute,
    handleToggleTrackSolo,
    handleChangeTrackGain,
    handleChangeTrackPan,
    handleChangeTrackBus,
    handleDeleteTrack,
    handleResetMixer,
    handleSaveSections,
  } = useMixerActions({
    audioEngine,
    updateCurrentProject,
    showToast,
    syncProjectSidecarNow,
  });

  const {
    handleLoadProjectImmediately,
    handleCreateNewProject,
    handleUpdateSongMetadata,
    handleDeleteProject,
    handleExportJson,
    handleImportJsonFile,
  } = useProjectActions({
    projects,
    projectsRef,
    currentProject,
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
  });

  const {
    handleAddToSetlist,
    handleRemoveFromSetlist,
    handleClearSetlist,
    handleReorderSetlist,
    handleSetAsNextSong,
    handleMoveInSetlist,
  } = useSetlist({
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
  });

  const confirmDeleteFromLibrary = async () => {
    if (!songToDeleteFromLibrary) return;
    const song = songToDeleteFromLibrary;
    setSongToDeleteFromLibrary(null);

    if (currentProjectRef.current?.id === song.id && transport.isPlaying) {
      audioEngine.stop();
    }

    audioEngine.evictSongFromRamCache(song.id);
    await deleteProjectFromDb(song.id);
    if (isDesktopApp) {
      deleteProjectNativeCache(song.id).catch((err: any) => {
        console.error('[Cache] Error al eliminar carpeta de caché nativa:', err);
      });
    }

    const remaining = projects.filter((p) => p.id !== song.id);
    setProjects(remaining);
    if (currentProject?.id === song.id) {
      setCurrentProject(null);
    }
    showToast(`"${song.title}" eliminada de la biblioteca (archivos originales intactos)`);
  };

  const {
    handleDragOverDaw,
    handleDragLeaveDaw,
    handleDropOnDaw,
  } = useDawDragDrop({
    setDragOverlayMode,
    handleAddToSetlist,
    handleLoadProjectImmediately,
    isDesktopApp,
    handleImportNative,
    handleInstantImportFiles,
    showToast,
  });

  const transportProject = activeView === 'live' ? null : currentProject;
  const remoteTriggerRef = DesktopRemoteBridge && window.location.origin === 'https://tauri.localhost'
    ? setRemoteTriggerHost : undefined;
  const audioTriggerRef = DesktopAudioSettings && window.location.origin === 'https://tauri.localhost'
    ? setAudioTriggerHost : undefined;

  return (
    <div className="app-shell min-h-screen h-dvh flex flex-col bg-studio-ground text-neutral-100 overflow-hidden relative">
      {/* Top Navigation Bar */}
      <TopBar
        activeView={activeView}
        setlistCount={setlistQueue.length}
        engineMode={engineMode}
        ramBudgetMB={ramBudgetMB}
        cachedRamMB={audioEngine.getTotalCachedMB()}
        remoteTriggerRef={transportProject ? undefined : remoteTriggerRef}
        audioTriggerRef={audioTriggerRef}
        onChangeEngineMode={handleChangeEngineMode}
        onChangeRamBudgetMB={handleChangeRamBudgetMB}
        onSelectView={handleSelectView}
        onOpenImportModal={() => setIsImportModalOpen(true)}
      />

      {/* Banner de alerta: Desconexión de interfaz de audio en caliente */}
      {isDeviceDisconnected && (
        <div className="bg-rose-950/95 border-b border-rose-800 text-rose-200 px-4 py-2 flex items-center justify-between text-xs z-50 shadow-lg">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>
              <strong>Dispositivo de audio desconectado.</strong> La reproducción se ha pausado y la posición se conserva en{' '}
              <strong className="font-mono text-white">
                {Math.floor(transport.currentTimeSec / 60)}:{String(Math.floor(transport.currentTimeSec % 60)).padStart(2, '0')}.{Math.floor((transport.currentTimeSec % 1) * 10)}
              </strong>. Conéctalo de nuevo y pulsa Reabrir.
            </span>
          </div>
          <button
            type="button"
            onClick={() => void nativeAudioEngine.reopenDevice()}
            className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded font-medium cursor-pointer transition-colors shrink-0"
          >
            Reabrir dispositivo
          </button>
        </div>
      )}

      {/* Banner de aviso: Canción sin caché nativa a la frecuencia del dispositivo */}
      {missingNativeCache && (() => {
        // Avance REAL por pista (evento audio://import-progress), no los saltos 5/15/100 %.
        const liveProgress = currentProject ? nativeAudioEngine.formatImportProgress(currentProject.id) : null;
        const isBusy = isGeneratingNativeCache || Boolean(liveProgress);
        return (
        <div className="bg-amber-950/90 border-b border-amber-800/80 text-amber-200 px-4 py-2 flex items-center justify-between text-xs z-50 shadow-md">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              La canción actual <strong>"{currentProject?.title}"</strong> no dispone de caché PCM nativa para este dispositivo.
              {liveProgress
                ? ` (${liveProgress})`
                : isGeneratingNativeCache
                ? ` (${nativeCacheProgress.percent}% - ${nativeCacheProgress.text})`
                : ''}
            </span>
          </div>
          <button
            type="button"
            disabled={isBusy}
            onClick={async () => {
              if (!currentProject) return;
              if (nativeAudioEngine.isProjectImporting(currentProject.id)) {
                showToast(`"${currentProject.title}": la caché ya se está generando.`);
                return;
              }
              setIsGeneratingNativeCache(true);
              setNativeCacheProgress({ percent: 5, text: 'Iniciando verificación...' });
              try {
                const ok = await nativeAudioEngine.generateNativeCacheForProject(currentProject, (percent, text) => {
                  setNativeCacheProgress({ percent, text });
                });
                if (ok) {
                  setMissingNativeCache(false);
                  await nativeAudioEngine.loadProject(currentProject);
                  showToast(`Caché nativa lista para "${currentProject.title}".`);
                } else {
                  showToast(`No se pudo generar la caché nativa para "${currentProject.title}".`);
                }
              } catch (err: any) {
                console.error('[Banner] Error generando caché nativa:', err);
                showToast(`Error al generar caché nativa: ${err?.message || err}`);
              } finally {
                setIsGeneratingNativeCache(false);
              }
            }}
            className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded cursor-pointer transition-colors disabled:opacity-50 shrink-0"
          >
            {isBusy ? 'Generando...' : 'Generar caché nativa'}
          </button>
        </div>
        );
      })()}

      {/* Studio Transport Deck (Shown when a song is loaded; the Live page has its own) */}
      {transportProject && (
        <TransportDeck
          project={transportProject}
          transport={transport}
          remoteTriggerRef={remoteTriggerRef}
          setlistQueue={setlistQueue}
          setlistTransitionMode={setlistTransitionMode}
          importStatusText={importStatusText}
          onPlayPause={handlePlayPause}
          onStop={handleStop}
          onToggleVamp={handleToggleVamp}
          onPrevSetlistSong={handlePrevSetlistSong}
          onNextSetlistSong={() => handleNextSetlistSong(false)}
          onChangeSetlistTransitionMode={setSetlistTransitionMode}
          onChangeBpm={handleChangeBpm}
          onChangePitch={handleChangePitch}
          onChangeQuantize={handleChangeQuantize}
          onToggleClick={handleToggleClick}
          onToggleGuide={handleToggleGuide}
          onToggleSplitRouting={handleToggleSplitRouting}
          onAddMarkerAtPlayhead={handleAddMarkerAtPlayhead}
          onOpenSectionEditor={() => setIsSectionEditorOpen(true)}
          onCancelQueuedJump={handleCancelQueuedJump}
        />
      )}

      {/* Main Body: Dockable Left Repertoire Sidebar + Active Workspace */}
      <div className="relative flex-1 flex overflow-hidden min-h-0">
        {activeView === 'library' && (
          <RepertoireTreeSidebar
            projects={projects}
            setlistQueue={setlistQueue}
            currentProjectId={currentProject?.id || null}
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed((prev) => !prev)}
            onRequestSongAction={(song) => setConfirmSongCandidate(song)}
            onAddToSetlist={handleAddToSetlist}
            onRemoveFromSetlist={handleRemoveFromSetlist}
            onClearSetlist={handleClearSetlist}
            onEditMetadata={(song) => setEditingMetadataSong(song)}
            onDeleteProject={handleDeleteProject}
            onExportJson={handleExportJson}
            onQuickImportNewSongFiles={(files) =>
              handleInstantImportFiles(files, 'main', 'new-song')
            }
            onQuickImportNativeFolder={(folder) =>
              handleImportNative({ folderPath: folder }, 'main', 'new-song')
            }
            onQuickImportNativeFiles={(paths) =>
              handleImportNative({ filePaths: paths }, 'main', 'new-song')
            }
            onOpenNewSongModal={() => handleSelectView('library')}
          />
        )}

        {/* Active Workspace Drop Zone */}
        <div
          onDragOver={handleDragOverDaw}
          onDragLeave={handleDragLeaveDaw}
          onDrop={handleDropOnDaw}
          className="lt-workspace flex-1 flex flex-col overflow-hidden relative"
        >
          {/* Visual Drop Overlay when dragging a Repertoire Song or Audio Files */}
          {dragOverlayMode && (
            <div className="absolute inset-0 z-50 bg-studio-ground/90 border-2 border-dashed border-studio-line flex items-center justify-center p-8 pointer-events-none">
              <div className="bg-studio-panel border border-neutral-700 rounded-2xl p-8 text-center shadow-2xl max-w-md">
                {dragOverlayMode === 'repertoire-song' ? (
                  <>
                    <Music className="w-12 h-12 text-studio-ink mx-auto mb-3" />
                    <h2 className="text-xl font-bold text-neutral-100">
                      Suelta aquí para montar la canción en consola
                    </h2>
                    <p className="text-xs text-neutral-400 mt-1">
                      Se cargará en el Setlist y en el DAW inmediatamente.
                    </p>
                  </>
                ) : (
                  <>
                    <Upload className="w-12 h-12 text-studio-ink mx-auto mb-3" />
                    <h2 className="text-xl font-bold text-neutral-100">
                      Suelta tus Stems o Carpeta Aquí
                    </h2>
                    <p className="text-xs text-neutral-400 mt-1">
                      Se guardará como una sola canción en tu repertorio con su duración real en minutos y segundos.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* 1. DEDICATED SETLIST PAGE VIEW */}
          {activeView === 'setlist' && (
            <SetlistPageView
              project={currentProject}
              allProjects={projects}
              setlistQueue={setlistQueue}
              transport={transport}
              ramCacheVersion={ramCacheVersion}
              setlistTransitionMode={setlistTransitionMode}
              metersRef={metersRef}
              onUpdateSongNotes={handleUpdateSongNotes}
              onSetSongTransition={handleSetSongTransition}
              onAddSectionTemplate={handleAddSectionTemplate}
              onStartLive={handleStartLive}
              onPlayPause={handlePlayPause}
              onStop={handleStop}
              onToggleVamp={handleToggleVamp}
              onLoadAndPlaySong={(songId, autoPlay) =>
                handleLoadProjectImmediately(songId, autoPlay)
              }
              onRequestSongAction={(song) => setConfirmSongCandidate(song)}
              onAddToSetlist={handleAddToSetlist}
              onRemoveFromSetlist={handleRemoveFromSetlist}
              onClearSetlist={handleClearSetlist}
              onMoveInSetlist={handleMoveInSetlist}
              onReorderSetlist={handleReorderSetlist}
              onOptimizeProject={handleStartOptimizeProject}
              onChangeSetlistTransitionMode={setSetlistTransitionMode}
              onChangeQuantize={handleChangeQuantize}
              onChangePitch={handleChangePitch}
              onChangeBpm={handleChangeBpm}
              onSeekSeconds={handleSeekSeconds}
              onJumpSection={handleJumpSection}
              onCancelQueuedJump={handleCancelQueuedJump}
              onAddMarkerAtPlayhead={handleAddMarkerAtPlayhead}
              onOpenSectionEditor={() => setIsSectionEditorOpen(true)}
              onAddStemsToCurrentSong={(files) =>
                handleInstantImportFiles(files, 'main', 'current-song')
              }
              onQuickImportNewSongFiles={(files) =>
                handleInstantImportFiles(files, 'main', 'new-song')
              }
              onQuickImportNativeFolder={(folder) =>
                handleImportNative({ folderPath: folder }, 'main', 'new-song')
              }
              onQuickImportNativeFiles={(paths) =>
                handleImportNative({ filePaths: paths }, 'main', 'new-song')
              }
              onToggleTrackMute={handleToggleTrackMute}
              onToggleTrackSolo={handleToggleTrackSolo}
              onChangeTrackGain={handleChangeTrackGain}
              onChangeTrackPan={handleChangeTrackPan}
              onChangeTrackBus={handleChangeTrackBus}
              onChangeClickGain={(gain) =>
                updateCurrentProject((p) => ({ ...p, clickGain: gain }))
              }
              onChangeClickPan={(pan) =>
                updateCurrentProject((p) => ({ ...p, clickPan: pan }))
              }
              onToggleClick={handleToggleClick}
              onChangeGuideGain={(gain) =>
                updateCurrentProject((p) => ({ ...p, guideGain: gain }))
              }
              onChangeGuidePan={(pan) =>
                updateCurrentProject((p) => ({ ...p, guidePan: pan }))
              }
              onToggleGuide={handleToggleGuide}
              onChangeMasterGain={(gain) =>
                updateCurrentProject((p) => ({ ...p, masterGain: gain }))
              }
              onChangeCueMasterGain={(gain) =>
                updateCurrentProject((p) => ({ ...p, cueMasterGain: gain }))
              }
              onResetMixer={handleResetMixer}
            />
          )}

          {/* LIVE SET: performance page */}
          {activeView === 'live' && (
            <LiveSetView
              project={currentProject}
              transport={transport}
              setlistQueue={setlistQueue}
              setlistTransitionMode={setlistTransitionMode}
              preparingIds={preparingIds}
              onPlayPause={handlePlayPause}
              onStop={handleStop}
              onPrevSong={handlePrevSetlistSong}
              onNextSong={() => handleNextSetlistSong(false)}
              onLoadSong={(songId) => handleLoadProjectImmediately(songId, false)}
              onSetAsNext={handleSetAsNextSong}
              onJumpSection={handleJumpSection}
              onCancelQueuedJump={handleCancelQueuedJump}
              onToggleVamp={handleToggleVamp}
              onChangeQuantize={handleChangeQuantize}
              onChangeTransitionMode={setSetlistTransitionMode}
              onGoToSetlist={() => handleSelectView('setlist')}
            />
          )}

          {/* 2. ARRANGER (DAW) VIEW */}
          {activeView === 'arranger' &&
            (currentProject ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <TimelineArranger
                  project={currentProject}
                  transport={transport}
                  metersRef={metersRef}
                  isDarkMode={true}
                  isDockedMixerOpen={isDockedMixerOpen}
                  onToggleDockedMixer={() => setIsDockedMixerOpen((prev) => !prev)}
                  onJumpSection={handleJumpSection}
                  onSeekSeconds={handleSeekSeconds}
                  onToggleTrackMute={handleToggleTrackMute}
                  onToggleTrackSolo={handleToggleTrackSolo}
                  onChangeTrackGain={handleChangeTrackGain}
                  onChangeTrackPan={handleChangeTrackPan}
                  onChangeTrackBus={handleChangeTrackBus}
                  onDeleteTrack={handleDeleteTrack}
                  onAddStemsToCurrentSong={(files) =>
                    handleInstantImportFiles(files, 'main', 'current-song')
                  }
                  onAddNativeStemsToCurrentSong={(paths) =>
                    handleImportNative({ filePaths: paths }, 'main', 'current-song')
                  }
                  onAddMarkerAtPlayhead={handleAddMarkerAtPlayhead}
                  onOpenImportModal={() => setIsImportModalOpen(true)}
                  onOpenSectionEditor={() => setIsSectionEditorOpen(true)}
                />

                {isDockedMixerOpen && (
                  <div
                    onClick={() => setIsDockedMixerOpen(false)}
                    className="fixed inset-0 z-50 bg-black/60 flex items-end justify-center p-3 sm:p-5"
                  >
                    <div
                      role="dialog"
                      aria-modal="true"
                      aria-label="Consola Mixer Flotante"
                      onClick={(e) => e.stopPropagation()}
                      className="w-full max-w-[1440px] bg-studio-panel border-2 border-studio-line rounded-2xl shadow-[0_24px_70px_rgba(0,0,0,0.9)] overflow-hidden flex flex-col max-h-[86vh]"
                    >
                      <div className="px-5 py-3 bg-studio-panel border-b border-studio-line flex items-center justify-between gap-4 shrink-0">
                        <div>
                          <h2 className="text-base font-bold text-white">
                            Consola Mixer — {currentProject.title}
                          </h2>
                          <p className="text-xs text-neutral-400">
                            Doble clic en fader = 0.0 dB · Doble clic en knob = Centrar (C) · Clic fuera para cerrar
                          </p>
                        </div>
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={handleResetMixer}
                            className="h-9 px-3.5 rounded-lg bg-studio-strip hover:bg-neutral-800 border border-studio-line text-xs font-semibold text-neutral-200 cursor-pointer"
                          >
                            Restablecer 0 dB
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsDockedMixerOpen(false)}
                            className="lt-control"
                          >
                            Cerrar mezcla
                          </button>
                        </div>
                      </div>
                      <div className="overflow-y-auto">
                        <MultitrackMixer
                          project={currentProject}
                          transport={transport}
                          metersRef={metersRef}
                          docked={true}
                          onToggleTrackMute={handleToggleTrackMute}
                          onToggleTrackSolo={handleToggleTrackSolo}
                          onChangeTrackGain={handleChangeTrackGain}
                          onChangeTrackPan={handleChangeTrackPan}
                          onChangeTrackBus={handleChangeTrackBus}
                          onChangeClickGain={(gain) =>
                            updateCurrentProject((p) => ({ ...p, clickGain: gain }))
                          }
                          onChangeClickPan={(pan) =>
                            updateCurrentProject((p) => ({ ...p, clickPan: pan }))
                          }
                          onToggleClick={handleToggleClick}
                          onChangeGuideGain={(gain) =>
                            updateCurrentProject((p) => ({ ...p, guideGain: gain }))
                          }
                          onChangeGuidePan={(pan) =>
                            updateCurrentProject((p) => ({ ...p, guidePan: pan }))
                          }
                          onToggleGuide={handleToggleGuide}
                          onChangeMasterGain={(gain) =>
                            updateCurrentProject((p) => ({ ...p, masterGain: gain }))
                          }
                          onChangeCueMasterGain={(gain) =>
                            updateCurrentProject((p) => ({ ...p, cueMasterGain: gain }))
                          }
                          onResetMixer={handleResetMixer}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-5 text-center">
                <FolderOpen className="w-12 h-12 text-studio-ink mb-3 opacity-80" />
                <h2 className="text-lg font-bold text-neutral-100">
                  Arreglo
                </h2>
                <p className="text-xs text-neutral-400 max-w-md mt-1 mb-5">
                  Abre una canción desde el Setlist o importa pistas para ver su forma de onda.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  <button type="button" onClick={() => handleSelectView('setlist')} className="lt-control">
                    Ir al Setlist
                  </button>
                  <button type="button" onClick={() => setIsImportModalOpen(true)} className="lt-primary">
                    Importar pistas
                  </button>
                </div>
              </div>
            ))}

          {/* 3. FULL MIXER VIEW */}
          {activeView === 'mixer' &&
            (currentProject ? (
              <MultitrackMixer
                project={currentProject}
                transport={transport}
                metersRef={metersRef}
                docked={false}
                onToggleTrackMute={handleToggleTrackMute}
                onToggleTrackSolo={handleToggleTrackSolo}
                onChangeTrackGain={handleChangeTrackGain}
                onChangeTrackPan={handleChangeTrackPan}
                onChangeTrackBus={handleChangeTrackBus}
                onChangeClickGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, clickGain: gain }))
                }
                onChangeClickPan={(pan) =>
                  updateCurrentProject((p) => ({ ...p, clickPan: pan }))
                }
                onToggleClick={handleToggleClick}
                onChangeGuideGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, guideGain: gain }))
                }
                onChangeGuidePan={(pan) =>
                  updateCurrentProject((p) => ({ ...p, guidePan: pan }))
                }
                onToggleGuide={handleToggleGuide}
                onChangeMasterGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, masterGain: gain }))
                }
                onChangeCueMasterGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, cueMasterGain: gain }))
                }
                onResetMixer={handleResetMixer}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-5 text-center">
                <Music className="w-10 h-10 text-studio-ink mb-3 opacity-80" />
                <h2 className="text-base font-bold text-neutral-100">
                  Mezcla
                </h2>
                <p className="text-xs text-neutral-400 max-w-md mt-1">
                  Abre una canción desde el Setlist para mezclar sus pistas.
                </p>
                <button type="button" onClick={() => handleSelectView('setlist')} className="lt-control mt-3">
                  Ir al Setlist
                </button>
              </div>
            ))}

          {/* 5. LIBRARY VIEW */}
          {activeView === 'library' && (
            <LibraryView
              projects={projects}
              currentProjectId={currentProject?.id || null}
              onSelectProject={(projectId) => {
                const found = projects.find((p) => p.id === projectId);
                if (found) setConfirmSongCandidate(found);
              }}
              onAddToSetlist={handleAddToSetlist}
              onRemoveFromSetlist={handleRemoveFromSetlist}
              onCreateNewProject={handleCreateNewProject}
              onDeleteProject={handleDeleteProject}
              onExportJson={handleExportJson}
              onImportJsonFile={handleImportJsonFile}
              onOpenStemImporter={() => setIsImportModalOpen(true)}
              onOptimizeProject={handleStartOptimizeProject}
              onRelinkProject={handleRelinkProject}
              onUpdateSongMetadata={handleUpdateSongMetadata}
            />
          )}
        </div>
      </div>

      {/* Repertoire Click Confirmation Modal */}
      <ConfirmSongActionModal
        song={confirmSongCandidate}
        currentSongId={currentProject?.id || null}
        isInSetlist={
          confirmSongCandidate
            ? setlistQueue.some((s) => s.id === confirmSongCandidate.id)
            : false
        }
        onClose={() => setConfirmSongCandidate(null)}
        onConfirmLoadInDaw={(songId) => {
          handleAddToSetlist(songId);
          handleLoadProjectImmediately(songId, false);
        }}
        onConfirmAddToSetlist={(songId) => handleAddToSetlist(songId)}
        onConfirmRemoveFromSetlist={(songId) => handleRemoveFromSetlist(songId)}
      />

      {/* Song Fingerprint Ambiguity / Confirmation Modal */}
      {fingerprintPrompt && (
        <SongFingerprintPromptModal
          candidates={fingerprintPrompt.candidates}
          incomingTrackCount={fingerprintPrompt.incomingTrackCount}
          sourceLabel={fingerprintPrompt.sourceLabel}
          onConfirmMatch={(chosenSong) => {
            const cb = fingerprintPrompt.resolve;
            setFingerprintPrompt(null);
            cb(chosenSong);
          }}
          onImportAsNew={() => {
            const cb = fingerprintPrompt.resolve;
            setFingerprintPrompt(null);
            cb(null);
          }}
          onCancel={() => {
            const cb = fingerprintPrompt.resolve;
            setFingerprintPrompt(null);
            cb('cancel');
          }}
        />
      )}

      {/* Stem Importer Modal */}
      <StemImporterModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImportFiles={(files, defaultBus, importMode) =>
          handleInstantImportFiles(files, defaultBus, importMode)
        }
        onImportNativeFolder={(folder, defaultBus, importMode) =>
          handleImportNative({ folderPath: folder }, defaultBus, importMode)
        }
        onImportNativeFiles={(paths, defaultBus, importMode) =>
          handleImportNative({ filePaths: paths }, defaultBus, importMode)
        }
      />

      {/* Time-Based (MM:SS) Section Editor Modal */}
      {isSectionEditorOpen && currentProject && (
        <SectionEditorModal
          isOpen={isSectionEditorOpen}
          project={currentProject}
          currentTimeSec={transport.currentTimeSec}
          totalDurationSec={transport.totalDurationSec}
          onClose={() => setIsSectionEditorOpen(false)}
          onSaveSections={handleSaveSections}
        />
      )}

      {/* OPFS Streaming PCM Optimization Progress Modal */}
      <OptimizationProgressModal
        isOpen={Boolean(optimizingProject)}
        songTitle={optimizingProject?.title || ''}
        progress={optimizationProgress}
        onCancel={handleCancelOptimization}
        onHide={() => {
          modalProjectIdRef.current = null;
          setOptimizingProject(null);
          setOptimizationProgress(null);
        }}
      />

      {/* Delete From Library Confirmation Modal */}
      {songToDeleteFromLibrary && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        >
          <div className="bg-neutral-900 border border-neutral-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-bold text-neutral-100">
                  ¿Eliminar de la biblioteca?
                </h2>
                <p className="text-sm text-neutral-300">
                  Se eliminará <strong className="text-white">"{songToDeleteFromLibrary.title}"</strong> del índice permanente y se liberará su espacio de caché.
                </p>
                <p className="text-xs text-neutral-400">
                  Tus archivos de audio originales en disco nunca se tocarán ni modificarán.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setSongToDeleteFromLibrary(null)}
                className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm font-semibold text-neutral-200 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDeleteFromLibrary}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-sm font-semibold text-white cursor-pointer"
              >
                Eliminar de la biblioteca
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Missing Folder Notice Modal */}
      {missingFolderSong && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        >
          <div className="bg-neutral-900 border border-neutral-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-bold text-neutral-100">
                  No se encuentran los archivos
                </h2>
                <p className="text-sm text-neutral-300">
                  No se encontraron las pistas de audio para <strong className="text-white">"{missingFolderSong.title}"</strong> en la ruta guardada.
                </p>
                <p className="text-xs text-neutral-400">
                  Es posible que la carpeta haya sido movida, renombrada o esté en una unidad desconectada.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setMissingFolderSong(null)}
                className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm font-semibold text-neutral-200 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = missingFolderSong;
                  setMissingFolderSong(null);
                  handleRelinkProject(target);
                }}
                className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-sm font-semibold text-white cursor-pointer flex items-center gap-1.5"
              >
                <FolderOpen className="w-4 h-4" />
                <span>Ubicar carpeta</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {DesktopRemoteBridge && remoteTriggerRef && (
        <React.Suspense fallback={null}>
          <DesktopRemoteBridge
            project={currentProject}
            setlist={setlistQueue}
            activationCount={activationCountRef}
            updateProject={updateCurrentProject}
            triggerHost={remoteTriggerHost}
          />
        </React.Suspense>
      )}

      {DesktopAudioSettings && audioTriggerRef && (
        <React.Suspense fallback={null}>
          <DesktopAudioSettings triggerHost={audioTriggerHost} />
        </React.Suspense>
      )}

      {/* Edit Song Metadata Modal */}
      <SongMetadataEditModal
        song={editingMetadataSong}
        isOpen={Boolean(editingMetadataSong)}
        onClose={() => setEditingMetadataSong(null)}
        onSave={(updated) => {
          handleUpdateSongMetadata(updated);
          setEditingMetadataSong(null);
        }}
      />

      {/* Non-intrusive Action Feedback Toast */}
      {toastMessage && (
        <div
          role="status"
          className="fixed bottom-3 right-3 z-50 bg-neutral-800 border border-studio-line text-white px-4 py-2.5 rounded-xl text-xs font-medium shadow-lg"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
