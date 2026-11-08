/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Music, FolderOpen } from 'lucide-react';
import { audioEngine } from './audio/audioEngine';
import { inferSongMetadataFromFiles } from './audio/smartAnalyzer';
import {
  createEmptyProjectTemplate,
  deleteProjectFromDb,
  loadAllProjectsFromDb,
  loadProjectStemsFromDb,
  normalizeProjectSectionsToTime,
  saveProjectToDb,
  saveStemAudioToDb,
} from './storage/projectDb';
import {
  OutputBus,
  QuantizeMode,
  RemoteSyncMessage,
  SetlistTransitionMode,
  SongProject,
  SongSection,
  TrackChannel,
  TrackMeterReading,
  TransportState,
} from './types/project';
import { TopBar, WorkspaceView } from './components/TopBar';
import { formatMmSs, TransportDeck } from './components/TransportDeck';
import { RepertoireTreeSidebar } from './components/RepertoireTreeSidebar';
import { SetlistPageView } from './components/SetlistPageView';
import { TimelineArranger } from './components/TimelineArranger';
import { MultitrackMixer } from './components/MultitrackMixer';
import { StageRemoteView } from './components/StageRemoteView';
import {
  ConfirmSongActionModal,
  inferTrackRoleAndColor,
  LibraryView,
  SectionEditorModal,
  StemImporterModal,
} from './components/LibraryAndModals';

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
};

function getInitialViewFromHash(): WorkspaceView {
  const hash = window.location.hash.replace('#', '').toLowerCase();
  if (
    hash === 'setlist' ||
    hash === 'arranger' ||
    hash === 'mixer' ||
    hash === 'remote' ||
    hash === 'library'
  ) {
    return hash;
  }
  return 'setlist';
}

function isAudioFileCandidate(file: File): boolean {
  if (file.type && file.type.startsWith('audio/')) return true;
  return /\.(wav|mp3|ogg|flac|m4a|aac|webm|opus|aiff|wma)$/i.test(file.name);
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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false);
  const [isDockedMixerOpen, setIsDockedMixerOpen] = useState<boolean>(false);
  const [projects, setProjects] = useState<SongProject[]>([]);
  const [currentProject, setCurrentProject] = useState<SongProject | null>(null);
  const [transport, setTransport] = useState<TransportState>(INITIAL_TRANSPORT);
  const [setlistTransitionMode, setSetlistTransitionMode] =
    useState<SetlistTransitionMode>('auto-play');
  const [confirmSongCandidate, setConfirmSongCandidate] = useState<SongProject | null>(
    null
  );

  const [meters, setMeters] = useState<{
    tracks: Record<string, TrackMeterReading>;
    master: TrackMeterReading;
  }>({
    tracks: {},
    master: { rms: 0, peak: 0, clipping: false },
  });

  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importStatusText, setImportStatusText] = useState<string | null>(null);
  const [dragOverlayMode, setDragOverlayMode] = useState<'files' | 'repertoire-song' | null>(
    null
  );
  const [isSectionEditorOpen, setIsSectionEditorOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const channelRef = useRef<BroadcastChannel | null>(null);
  const currentProjectRef = useRef<SongProject | null>(currentProject);
  currentProjectRef.current = currentProject;

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3400);
  }, []);

  // Derived ordered Setlist Queue
  const setlistQueue = useMemo(() => {
    return projects
      .filter((p) => p.inSetlist)
      .sort((a, b) => (a.setlistOrder ?? 999) - (b.setlistOrder ?? 999));
  }, [projects]);

  // Activate a project in the audio engine ONLY when explicitly requested by user
  const activateProject = useCallback(
    async (
      projectToLoad: SongProject,
      predecodedBuffers?: Map<string, AudioBuffer>,
      autoPlayAfterLoad = false
    ) => {
      try {
        const normalizedProj = normalizeProjectSectionsToTime(projectToLoad);
        let customMap: Map<string, ArrayBuffer> | undefined;
        if (!predecodedBuffers) {
          const storedStems = await loadProjectStemsFromDb(normalizedProj.id);
          customMap = new Map<string, ArrayBuffer>();
          for (const s of storedStems) {
            customMap.set(s.trackId, s.arrayBuffer);
          }
        }

        const calculatedPeaks = await audioEngine.loadProject(
          normalizedProj,
          customMap,
          predecodedBuffers
        );
        const realDurationSec = audioEngine.getTotalDurationSec();
        const enrichedTracks = normalizedProj.tracks.map((t) => ({
          ...t,
          peaks: calculatedPeaks.get(t.id) || t.peaks || [],
        }));

        const updatedProject: SongProject = {
          ...normalizedProj,
          durationSec: realDurationSec,
          tracks: enrichedTracks,
        };

        setCurrentProject(updatedProject);
        saveProjectToDb(updatedProject).catch(() => {});
        setProjects((prev) => {
          const exists = prev.some((p) => p.id === updatedProject.id);
          if (!exists) return [updatedProject, ...prev];
          return prev.map((p) => (p.id === updatedProject.id ? updatedProject : p));
        });

        if (autoPlayAfterLoad) {
          audioEngine.play();
        }
      } catch (err) {
        console.error('Error loading project into engine:', err);
      }
    },
    []
  );

  // Initial load from IndexedDB: ONLY loads the Repertoire list, NEVER auto-loads a song into the DAW
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const saved = await loadAllProjectsFromDb();
        if (!mounted) return;
        setProjects(saved);
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

      await activateProject(nextSong, undefined, autoPlay);
      showToast(
        autoPlay
          ? `Reproduciendo siguiente en Setlist: ${nextSong.title}`
          : `Siguiente canción lista en consola: ${nextSong.title}`
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
      showToast(`Canción anterior cargada: ${prevSong.title}`);
    }
  }, [activateProject, setlistQueue, showToast]);

  // Connect Setlist End-of-Song Transition Callback
  useEffect(() => {
    audioEngine.setOnSongEnded(() => {
      if (setlistTransitionMode === 'cue-next') {
        handleNextSetlistSong(false);
      } else if (setlistTransitionMode === 'auto-play') {
        handleNextSetlistSong(true);
      }
    });
    return () => audioEngine.setOnSongEnded(null);
  }, [handleNextSetlistSong, setlistTransitionMode]);

  // Subscribe to transport updates and BroadcastChannel sync
  useEffect(() => {
    const unsubscribe = audioEngine.subscribe((newTransport) => {
      setTransport(newTransport);

      if (channelRef.current && currentProjectRef.current) {
        const p = currentProjectRef.current;
        const msg: RemoteSyncMessage = {
          type: 'STATE_SYNC',
          project: {
            ...p,
            tracks: p.tracks.map(({ peaks: _peaks, ...rest }) => rest),
          },
          transport: newTransport,
        };
        channelRef.current.postMessage(msg);
      }
    });

    return unsubscribe;
  }, []);

  // Poll 60fps real-time track & master VU meters while playing
  useEffect(() => {
    if (!transport.isPlaying) {
      setMeters({ tracks: {}, master: { rms: 0, peak: 0, clipping: false } });
      return;
    }

    let animId: number;
    const updateMeters = () => {
      setMeters(audioEngine.getTrackMeters());
      animId = requestAnimationFrame(updateMeters);
    };
    animId = requestAnimationFrame(updateMeters);

    return () => cancelAnimationFrame(animId);
  }, [transport.isPlaying]);

  // Mutate and persist current project helper
  const updateCurrentProject = useCallback(
    (updater: (prev: SongProject) => SongProject) => {
      setCurrentProject((prev) => {
        if (!prev) return null;
        const next = updater(prev);
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
    const bc = new BroadcastChannel('libretracks_remote_sync');
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

  /**
   * INSTANT NON-BLOCKING STEM & FOLDER IMPORT PIPELINE
   */
  const handleInstantImportFiles = useCallback(
    async (
      fileList: FileList | File[],
      defaultBus: OutputBus = 'main',
      importMode: 'new-song' | 'current-song' = 'new-song'
    ) => {
      const rawArray = Array.from(fileList);
      const validFiles = rawArray.filter(isAudioFileCandidate);

      if (validFiles.length === 0) {
        showToast('No se encontraron archivos de audio compatibles (.wav, .mp3, .ogg, .flac, .m4a)');
        return;
      }

      const effectiveMode =
        importMode === 'current-song' && currentProjectRef.current
          ? 'current-song'
          : 'new-song';

      const targetProjectId =
        effectiveMode === 'new-song'
          ? `song-${Date.now()}`
          : currentProjectRef.current!.id;

      const { songTitle, detectedBpm, detectedKey, cleanTrackNames } =
        inferSongMetadataFromFiles(validFiles);

      const bpm =
        effectiveMode === 'new-song'
          ? detectedBpm || 120
          : currentProjectRef.current!.bpm;
      const beatsPerBar =
        effectiveMode === 'new-song' ? 4 : currentProjectRef.current!.beatsPerBar;
      const secPerBar = (60 / bpm) * beatsPerBar;

      setImportStatusText(`Importando 0/${validFiles.length} pistas...`);

      const decodedTracks: TrackChannel[] = [];
      const decodedAudioBuffers = new Map<string, AudioBuffer>();
      let maxDurationSec = 0;
      let completedCount = 0;

      await Promise.allSettled(
        validFiles.map(async (file, idx) => {
          const trackId = `stem-${Date.now()}-${idx}`;
          const trackLabel = cleanTrackNames[idx] || file.name.replace(/\.[^/.]+$/, '');
          const inferred = inferTrackRoleAndColor(trackLabel, idx);

          const rawBuf = await file.arrayBuffer();
          const { audioBuffer, peaks, durationSec } = await audioEngine.decodeStemBuffer(rawBuf);

          completedCount++;
          setImportStatusText(`Decodificando ${completedCount}/${validFiles.length}: ${trackLabel}`);

          if (durationSec > maxDurationSec) {
            maxDurationSec = durationSec;
          }

          const newTrack: TrackChannel = {
            id: trackId,
            name: trackLabel,
            role: inferred.role,
            color: inferred.color,
            gain: 1.0,
            pan: 0,
            muted: false,
            soloed: false,
            bus: inferred.bus === 'cue-click' ? 'cue-click' : defaultBus,
            peaks,
            isCustomAudio: true,
            fileName: file.name,
            durationSec,
          };

          decodedTracks.push(newTrack);
          decodedAudioBuffers.set(trackId, audioBuffer);

          saveStemAudioToDb({
            key: `${targetProjectId}:${trackId}`,
            projectId: targetProjectId,
            trackId,
            arrayBuffer: rawBuf,
            mimeType: file.type || 'audio/wav',
            fileName: file.name,
          }).catch((err) => console.warn('Background IndexedDB stem save warning:', err));
        })
      );

      setImportStatusText(null);

      if (decodedTracks.length === 0) {
        showToast('No se pudo decodificar el audio seleccionado');
        return;
      }

      decodedTracks.sort((a, b) => a.id.localeCompare(b.id));

      const calculatedBars =
        maxDurationSec > 2
          ? Math.max(4, Math.ceil(maxDurationSec / secPerBar))
          : 24;

      if (effectiveMode === 'new-song') {
        const newSongProject: SongProject = {
          id: targetProjectId,
          title: songTitle,
          artist: 'Sesión Importada',
          folder: 'imported',
          inSetlist: true,
          setlistOrder: projects.length,
          bpm,
          beatsPerBar: 4,
          beatUnit: 4,
          keySignature: detectedKey || 'C Major',
          totalBars: calculatedBars,
          durationSec: maxDurationSec,
          quantizeMode: 'immediate',
          splitRoutingMode: 'stereo',
          clickEnabled: false,
          clickGain: 1.0,
          clickSubdivision: 1,
          guideCuesEnabled: true,
          guideVoiceReadout: true,
          guideGain: 1.0,
          masterGain: 1.0,
          cueMasterGain: 1.0,
          pitchSemitones: 0,
          sections: [],
          tracks: decodedTracks,
          updatedAt: Date.now(),
        };

        await activateProject(newSongProject, decodedAudioBuffers);
        showToast(
          `Canción "${songTitle}" importada y montada (${decodedTracks.length} pistas · ${formatMmSs(maxDurationSec)})`
        );
      } else {
        for (const trk of decodedTracks) {
          const buf = decodedAudioBuffers.get(trk.id);
          if (buf) {
            audioEngine.mountDecodedTrack(trk, buf);
          }
        }

        updateCurrentProject((prev) => {
          const combinedTracks = [...prev.tracks, ...decodedTracks];
          const nextTotalBars = Math.max(prev.totalBars, calculatedBars);
          const nextDurationSec = Math.max(prev.durationSec || 0, maxDurationSec);

          return {
            ...prev,
            totalBars: nextTotalBars,
            durationSec: nextDurationSec,
            tracks: combinedTracks,
          };
        });

        showToast(`${decodedTracks.length} stem(s) añadidos a "${currentProjectRef.current?.title}"`);
      }
    },
    [activateProject, projects.length, showToast, updateCurrentProject]
  );

  // Add a Section Marker directly at the current playhead time (mm:ss)
  const handleAddMarkerAtPlayhead = () => {
    if (!currentProject) return;
    const playheadSec = Math.round(transport.currentTimeSec);
    const totalSec = Math.max(
      10,
      Math.round(transport.totalDurationSec || currentProject.durationSec || 60)
    );
    const clampedStart = Math.max(0, Math.min(totalSec - 2, playheadSec));

    updateCurrentProject((prev) => {
      const nextNum = prev.sections.length + 1;
      const newSec: SongSection = {
        id: `sec-${Date.now()}`,
        name: `Sección ${nextNum}`,
        code: `S${nextNum}`,
        color: MARKER_PALETTE[prev.sections.length % MARKER_PALETTE.length],
        startTimeSec: clampedStart,
        endTimeSec: totalSec,
        vampByDefault: false,
        cueName: `Sección ${nextNum}`,
      };

      const combined = [...prev.sections, newSec].sort(
        (a, b) => a.startTimeSec - b.startTimeSec
      );
      const recalculated = combined.map((s, idx) => {
        const nextItem = combined[idx + 1];
        const endSec = nextItem ? nextItem.startTimeSec : totalSec;
        return {
          ...s,
          endTimeSec: Math.max(s.startTimeSec + 1, endSec),
        };
      });

      return {
        ...prev,
        sections: recalculated,
      };
    });

    showToast(`Marcador creado en ${formatMmSs(clampedStart)}`);
  };

  // Transport & Mixer Handlers
  const handlePlayPause = () => audioEngine.togglePlayPause();
  const handleStop = () => audioEngine.stop();
  const handleToggleVamp = () => audioEngine.toggleVamp();
  const handleJumpSection = (sectionId: string) => audioEngine.queueSectionJump(sectionId);
  const handleCancelQueuedJump = () => audioEngine.cancelQueuedJump();
  const handleSeekSeconds = (sec: number) => audioEngine.seekToSeconds(sec);

  const handleChangeBpm = (bpm: number) => {
    updateCurrentProject((p) => ({ ...p, bpm }));
  };

  const handleChangePitch = (pitchSemitones: number) => {
    updateCurrentProject((p) => ({ ...p, pitchSemitones }));
  };

  const handleChangeQuantize = (quantizeMode: QuantizeMode) => {
    updateCurrentProject((p) => ({ ...p, quantizeMode }));
  };

  const handleToggleClick = () => {
    updateCurrentProject((p) => ({ ...p, clickEnabled: !p.clickEnabled }));
  };

  const handleToggleGuide = () => {
    updateCurrentProject((p) => ({ ...p, guideCuesEnabled: !p.guideCuesEnabled }));
  };

  const handleToggleSplitRouting = () => {
    updateCurrentProject((p) => ({
      ...p,
      splitRoutingMode: p.splitRoutingMode === 'stereo' ? 'split-mono' : 'stereo',
    }));
  };

  const handleToggleTrackMute = (trackId: string) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
    }));
  };

  const handleToggleTrackSolo = (trackId: string) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, soloed: !t.soloed } : t)),
    }));
  };

  const handleChangeTrackGain = (trackId: string, gain: number) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, gain } : t)),
    }));
  };

  const handleChangeTrackPan = (trackId: string, pan: number) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, pan } : t)),
    }));
  };

  const handleChangeTrackBus = (trackId: string, bus: OutputBus) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, bus } : t)),
    }));
  };

  const handleDeleteTrack = (trackId: string) => {
    audioEngine.removeTrack(trackId);
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.filter((t) => t.id !== trackId),
    }));
    showToast('Pista eliminada del proyecto');
  };

  const handleResetMixer = () => {
    updateCurrentProject((p) => ({
      ...p,
      clickGain: 1.0,
      guideGain: 1.0,
      masterGain: 1.0,
      cueMasterGain: 1.0,
      tracks: p.tracks.map((t) => ({
        ...t,
        gain: 1.0,
        pan: 0,
        muted: false,
        soloed: false,
      })),
    }));
    showToast('Mezcla restablecida a 0.0 dB');
  };

  // Section Arrangement Save Handler (Time-based mm:ss)
  const handleSaveSections = (sections: SongSection[]) => {
    updateCurrentProject((prev) => ({
      ...prev,
      sections,
    }));
    showToast('Marcadores de sección (mm:ss) guardados');
  };

  // Load Song Immediately into DAW (Used when confirmed in modal, clicked Play on Setlist card, or dragged onto DAW)
  const handleLoadProjectImmediately = async (projectId: string, autoPlay = false) => {
    const found = projects.find((p) => p.id === projectId);
    if (!found) return;
    await activateProject(found, undefined, autoPlay);
    if (activeView === 'library') {
      handleSelectView('setlist');
    }
    showToast(`Canción montada en consola: ${found.title}`);
  };

  // Setlist Management Handlers
  const handleAddToSetlist = (projectId: string) => {
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
          setlistOrder: p.inSetlist ? p.setlistOrder : maxOrder + 1,
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

  const handleRemoveFromSetlist = (projectId: string) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const updated: SongProject = { ...p, inSetlist: false };
        saveProjectToDb(updated).catch(() => {});
        if (currentProject?.id === projectId) {
          setCurrentProject(updated);
        }
        return updated;
      })
    );
    showToast('Canción quitada del Setlist');
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

  const handleMoveInSetlist = (projectId: string, direction: 'up' | 'down') => {
    const idx = setlistQueue.findIndex((s) => s.id === projectId);
    if (idx === -1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= setlistQueue.length) return;
    handleReorderSetlist(idx, targetIdx);
  };

  const handleCreateNewProject = async (
    title: string,
    artist: string,
    bpm: number,
    keySignature: string
  ) => {
    const newProj = createEmptyProjectTemplate(title, artist, bpm, keySignature);
    newProj.inSetlist = true;
    newProj.setlistOrder = projects.length;
    await activateProject(newProj);
    handleSelectView('setlist');
    showToast(`Nueva canción creada: ${title}`);
  };

  const handleDeleteProject = async (projectId: string) => {
    await deleteProjectFromDb(projectId);
    const remaining = projects.filter((p) => p.id !== projectId);
    setProjects(remaining);
    if (currentProject?.id === projectId) {
      audioEngine.stop();
      setCurrentProject(null);
    }
    showToast('Canción quitada de la biblioteca (tus archivos en disco no se modifican)');
  };

  const handleExportJson = (proj: SongProject) => {
    const blob = new Blob([JSON.stringify(proj, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${proj.title.toLowerCase().replace(/\s+/g, '-')}.libretracks.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Archivo .libretracks.json exportado');
  };

  const handleImportJsonFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SongProject;
      if (!parsed.title || !Array.isArray(parsed.tracks)) {
        showToast('El archivo JSON no tiene un formato LibreTracks válido');
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

  // Drag-and-Drop on DAW Workspace (Handles both Repertoire Song Drag & Audio File Drag)
  const handleDragOverDaw = (e: React.DragEvent) => {
    e.preventDefault();
    if (
      e.dataTransfer.types.includes('application/x-libretracks-song-id') &&
      !e.dataTransfer.types.includes('application/x-libretracks-setlist-index')
    ) {
      setDragOverlayMode('repertoire-song');
    } else if (e.dataTransfer.types.includes('Files')) {
      setDragOverlayMode('files');
    }
  };

  const handleDragLeaveDaw = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) {
      setDragOverlayMode(null);
    }
  };

  const handleDropOnDaw = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverlayMode(null);

    const songId = e.dataTransfer.getData('application/x-libretracks-song-id');
    if (songId) {
      handleAddToSetlist(songId);
      handleLoadProjectImmediately(songId, false);
      return;
    }

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleInstantImportFiles(e.dataTransfer.files, 'main', 'new-song');
    }
  };

  return (
    <div className="min-h-screen h-screen flex flex-col bg-[#0B0F17] text-slate-100 overflow-hidden relative">
      {/* Top Navigation Bar */}
      <TopBar
        activeView={activeView}
        setlistCount={setlistQueue.length}
        onSelectView={handleSelectView}
        onOpenImportModal={() => setIsImportModalOpen(true)}
      />

      {/* Studio Transport Deck (Shown when a song is loaded) */}
      {currentProject && (
        <TransportDeck
          project={currentProject}
          transport={transport}
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
        />
      )}

      {/* Main Body: Dockable Left Repertoire Sidebar + Active Workspace */}
      <div className="flex-1 flex overflow-hidden">
        {activeView !== 'remote' && (
          <RepertoireTreeSidebar
            projects={projects}
            setlistQueue={setlistQueue}
            currentProjectId={currentProject?.id || null}
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed((prev) => !prev)}
            onRequestSongAction={(song) => setConfirmSongCandidate(song)}
            onAddToSetlist={handleAddToSetlist}
            onDeleteProject={handleDeleteProject}
            onExportJson={handleExportJson}
            onQuickImportNewSongFiles={(files) =>
              handleInstantImportFiles(files, 'main', 'new-song')
            }
            onOpenNewSongModal={() => handleSelectView('library')}
          />
        )}

        {/* Active Workspace Drop Zone */}
        <div
          onDragOver={handleDragOverDaw}
          onDragLeave={handleDragLeaveDaw}
          onDrop={handleDropOnDaw}
          className="flex-1 flex flex-col overflow-hidden relative"
        >
          {/* Visual Drop Overlay when dragging a Repertoire Song or Audio Files */}
          {dragOverlayMode && (
            <div className="absolute inset-0 z-50 bg-cyan-500/20 backdrop-blur-xs border-4 border-dashed border-cyan-400 flex items-center justify-center p-8 pointer-events-none">
              <div className="bg-[#111827] border border-slate-700 rounded-2xl p-8 text-center shadow-2xl max-w-md">
                {dragOverlayMode === 'repertoire-song' ? (
                  <>
                    <Music className="w-12 h-12 text-cyan-400 mx-auto mb-3" />
                    <h2 className="font-display text-xl font-bold text-slate-100">
                      Suelta aquí para montar la canción en consola
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Se cargará en el Setlist y en el DAW inmediatamente.
                    </p>
                  </>
                ) : (
                  <>
                    <Upload className="w-12 h-12 text-cyan-400 mx-auto mb-3" />
                    <h2 className="font-display text-xl font-bold text-slate-100">
                      Suelta tus Stems o Carpeta Aquí
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
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
              setlistTransitionMode={setlistTransitionMode}
              meters={meters}
              onPlayPause={handlePlayPause}
              onStop={handleStop}
              onToggleVamp={handleToggleVamp}
              onLoadAndPlaySong={(songId, autoPlay) =>
                handleLoadProjectImmediately(songId, autoPlay)
              }
              onRequestSongAction={(song) => setConfirmSongCandidate(song)}
              onAddToSetlist={handleAddToSetlist}
              onRemoveFromSetlist={handleRemoveFromSetlist}
              onMoveInSetlist={handleMoveInSetlist}
              onReorderSetlist={handleReorderSetlist}
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
              onToggleTrackMute={handleToggleTrackMute}
              onToggleTrackSolo={handleToggleTrackSolo}
              onChangeTrackGain={handleChangeTrackGain}
              onChangeTrackPan={handleChangeTrackPan}
              onChangeTrackBus={handleChangeTrackBus}
              onChangeClickGain={(gain) =>
                updateCurrentProject((p) => ({ ...p, clickGain: gain }))
              }
              onToggleClick={handleToggleClick}
              onChangeGuideGain={(gain) =>
                updateCurrentProject((p) => ({ ...p, guideGain: gain }))
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

          {/* 2. ARRANGER (DAW) VIEW */}
          {activeView === 'arranger' &&
            (currentProject ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <TimelineArranger
                  project={currentProject}
                  transport={transport}
                  meters={meters.tracks}
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
                  onAddMarkerAtPlayhead={handleAddMarkerAtPlayhead}
                  onOpenImportModal={() => setIsImportModalOpen(true)}
                  onOpenSectionEditor={() => setIsSectionEditorOpen(true)}
                />

                {isDockedMixerOpen && (
                  <MultitrackMixer
                    project={currentProject}
                    transport={transport}
                    meters={meters}
                    docked={true}
                    onToggleTrackMute={handleToggleTrackMute}
                    onToggleTrackSolo={handleToggleTrackSolo}
                    onChangeTrackGain={handleChangeTrackGain}
                    onChangeTrackPan={handleChangeTrackPan}
                    onChangeTrackBus={handleChangeTrackBus}
                    onChangeClickGain={(gain) =>
                      updateCurrentProject((p) => ({ ...p, clickGain: gain }))
                    }
                    onToggleClick={handleToggleClick}
                    onChangeGuideGain={(gain) =>
                      updateCurrentProject((p) => ({ ...p, guideGain: gain }))
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
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
                <FolderOpen className="w-12 h-12 text-cyan-400 mb-3 opacity-80" />
                <h2 className="font-display text-lg font-bold text-slate-100">
                  El DAW está listo (Ninguna canción cargada por defecto)
                </h2>
                <p className="text-xs text-slate-400 max-w-md mt-1 mb-5">
                  Haz clic en una canción de tu <strong>Repertorio</strong> a la izquierda para confirmar su carga, arrástrala hacia aquí, o importa nuevos stems.
                </p>
                <button
                  type="button"
                  onClick={() => setIsImportModalOpen(true)}
                  className="px-4 py-2 rounded-lg bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-bold cursor-pointer"
                >
                  Importar Stems o Carpeta
                </button>
              </div>
            ))}

          {/* 3. FULL MIXER VIEW */}
          {activeView === 'mixer' &&
            (currentProject ? (
              <MultitrackMixer
                project={currentProject}
                transport={transport}
                meters={meters}
                docked={false}
                onToggleTrackMute={handleToggleTrackMute}
                onToggleTrackSolo={handleToggleTrackSolo}
                onChangeTrackGain={handleChangeTrackGain}
                onChangeTrackPan={handleChangeTrackPan}
                onChangeTrackBus={handleChangeTrackBus}
                onChangeClickGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, clickGain: gain }))
                }
                onToggleClick={handleToggleClick}
                onChangeGuideGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, guideGain: gain }))
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
              <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
                <Music className="w-10 h-10 text-cyan-400 mb-3 opacity-80" />
                <h2 className="font-display text-base font-bold text-slate-100">
                  Ninguna canción cargada en la Consola Mixer
                </h2>
                <p className="text-xs text-slate-400 max-w-md mt-1">
                  Selecciona o arrastra una canción desde tu Repertorio para mezclar sus canales.
                </p>
              </div>
            ))}

          {/* 4. STAGE REMOTE VIEW */}
          {activeView === 'remote' &&
            (currentProject ? (
              <StageRemoteView
                project={currentProject}
                transport={transport}
                setlistQueue={setlistQueue}
                onPlayPause={handlePlayPause}
                onStop={handleStop}
                onPrevSetlistSong={handlePrevSetlistSong}
                onNextSetlistSong={() => handleNextSetlistSong(false)}
                onJumpSection={handleJumpSection}
                onToggleVamp={handleToggleVamp}
                onToggleClick={handleToggleClick}
                onToggleGuide={handleToggleGuide}
                onChangeQuantize={handleChangeQuantize}
                onChangeClickGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, clickGain: gain }))
                }
                onChangeGuideGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, guideGain: gain }))
                }
                onChangeMasterGain={(gain) =>
                  updateCurrentProject((p) => ({ ...p, masterGain: gain }))
                }
                onToggleTrackMute={handleToggleTrackMute}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
                <Music className="w-10 h-10 text-cyan-400 mb-3 opacity-80" />
                <h2 className="font-display text-base font-bold text-slate-100">
                  Sin canción activa para Stage Remote
                </h2>
                <p className="text-xs text-slate-400 max-w-md mt-1 mb-4">
                  Primero carga una canción en la vista Setlist o Arranger.
                </p>
                <button
                  type="button"
                  onClick={() => handleSelectView('setlist')}
                  className="px-4 py-2 rounded-lg bg-cyan-400 text-slate-950 text-xs font-bold cursor-pointer"
                >
                  Ir a Setlist
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
              onCreateNewProject={handleCreateNewProject}
              onDeleteProject={handleDeleteProject}
              onExportJson={handleExportJson}
              onImportJsonFile={handleImportJsonFile}
              onOpenStemImporter={() => setIsImportModalOpen(true)}
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
      />

      {/* Stem Importer Modal */}
      <StemImporterModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImportFiles={(files, defaultBus, importMode) =>
          handleInstantImportFiles(files, defaultBus, importMode)
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

      {/* Non-intrusive Action Feedback Toast */}
      {toastMessage && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 bg-slate-800 border border-cyan-500/50 text-white px-4 py-2.5 rounded-xl text-xs font-medium shadow-lg"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
