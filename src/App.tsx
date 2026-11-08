/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { audioEngine } from './audio/audioEngine';
import {
  autoDetectSectionsFromTracks,
  inferSongMetadataFromFiles,
} from './audio/smartAnalyzer';
import {
  DEFAULT_DEMO_PROJECTS,
  deleteProjectFromDb,
  loadAllProjectsFromDb,
  loadProjectStemsFromDb,
  saveProjectToDb,
  saveStemAudioToDb,
} from './storage/projectDb';
import {
  OutputBus,
  QuantizeMode,
  RemoteSyncMessage,
  SongProject,
  SongSection,
  TrackChannel,
  TrackMeterReading,
  TransportState,
} from './types/project';
import { TopBar, WorkspaceView } from './components/TopBar';
import { TransportDeck } from './components/TransportDeck';
import { RepertoireTreeSidebar } from './components/RepertoireTreeSidebar';
import { TimelineArranger } from './components/TimelineArranger';
import { MultitrackMixer } from './components/MultitrackMixer';
import { StageRemoteView } from './components/StageRemoteView';
import {
  inferTrackRoleAndColor,
  LibraryView,
  SectionEditorModal,
  StemImporterModal,
} from './components/LibraryAndModals';

const INITIAL_TRANSPORT: TransportState = {
  isPlaying: false,
  currentTimeSec: 0,
  currentBar: 1,
  currentBeat: 1,
  beatProgress: 0,
  activeSectionId: DEFAULT_DEMO_PROJECTS[0].sections[0].id,
  queuedSectionId: null,
  queuedTargetBar: null,
  countdownBeats: 0,
  isVamping: false,
  lastCueMessage: null,
};

function getInitialViewFromHash(): WorkspaceView {
  const hash = window.location.hash.replace('#', '').toLowerCase();
  if (hash === 'mixer' || hash === 'remote' || hash === 'library') {
    return hash;
  }
  return 'arranger';
}

function isAudioFileCandidate(file: File): boolean {
  if (file.type && file.type.startsWith('audio/')) return true;
  return /\.(wav|mp3|ogg|flac|m4a|aac|webm|opus|aiff|wma)$/i.test(file.name);
}

export default function App() {
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  const [activeView, setActiveView] = useState<WorkspaceView>(getInitialViewFromHash);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false);
  const [projects, setProjects] = useState<SongProject[]>(DEFAULT_DEMO_PROJECTS);
  const [currentProject, setCurrentProject] = useState<SongProject>(DEFAULT_DEMO_PROJECTS[0]);
  const [transport, setTransport] = useState<TransportState>(INITIAL_TRANSPORT);
  const [meters, setMeters] = useState<{
    tracks: Record<string, TrackMeterReading>;
    master: TrackMeterReading;
  }>({
    tracks: {},
    master: { rms: 0, peak: 0, clipping: false },
  });

  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importStatusText, setImportStatusText] = useState<string | null>(null);
  const [isDraggingOverWindow, setIsDraggingOverWindow] = useState(false);
  const [isSectionEditorOpen, setIsSectionEditorOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const channelRef = useRef<BroadcastChannel | null>(null);
  const currentProjectRef = useRef<SongProject>(currentProject);
  currentProjectRef.current = currentProject;

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3400);
  }, []);

  // Activate a project in the audio engine
  const activateProject = useCallback(
    async (
      projectToLoad: SongProject,
      predecodedBuffers?: Map<string, AudioBuffer>
    ) => {
      try {
        let customMap: Map<string, ArrayBuffer> | undefined;
        if (!predecodedBuffers) {
          const storedStems = await loadProjectStemsFromDb(projectToLoad.id);
          customMap = new Map<string, ArrayBuffer>();
          for (const s of storedStems) {
            customMap.set(s.trackId, s.arrayBuffer);
          }
        }

        const calculatedPeaks = await audioEngine.loadProject(
          projectToLoad,
          customMap,
          predecodedBuffers
        );
        const enrichedTracks = projectToLoad.tracks.map((t) => ({
          ...t,
          peaks: calculatedPeaks.get(t.id) || t.peaks || [],
        }));

        const updatedProject: SongProject = {
          ...projectToLoad,
          tracks: enrichedTracks,
        };

        setCurrentProject(updatedProject);
        saveProjectToDb(updatedProject).catch(() => {});
        setProjects((prev) => {
          const exists = prev.some((p) => p.id === updatedProject.id);
          if (!exists) return [updatedProject, ...prev];
          return prev.map((p) => (p.id === updatedProject.id ? updatedProject : p));
        });
      } catch (err) {
        console.error('Error loading project into engine:', err);
      }
    },
    []
  );

  // Initial load from IndexedDB
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const saved = await loadAllProjectsFromDb();
        if (!mounted) return;
        if (saved.length > 0) {
          setProjects(saved);
          await activateProject(saved[0]);
        } else {
          for (const demo of DEFAULT_DEMO_PROJECTS) {
            saveProjectToDb(demo).catch(() => {});
          }
          setProjects(DEFAULT_DEMO_PROJECTS);
          await activateProject(DEFAULT_DEMO_PROJECTS[0]);
        }
      } catch {
        await activateProject(DEFAULT_DEMO_PROJECTS[0]);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [activateProject]);

  // Subscribe to transport updates and BroadcastChannel sync
  useEffect(() => {
    const unsubscribe = audioEngine.subscribe((newTransport) => {
      setTransport(newTransport);

      if (channelRef.current) {
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
        default:
          break;
      }
    };

    return () => {
      bc.close();
      channelRef.current = null;
    };
  }, [updateCurrentProject]);

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
   * - Creates a new song automatically (with inferred title, BPM, Key, real duration in bars, and auto-detected sections)
   *   OR adds stems to the current song if requested.
   * - Persists audio blobs to IndexedDB asynchronously in the background so the UI never freezes.
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

      const targetProjectId =
        importMode === 'new-song'
          ? `song-${Date.now()}`
          : currentProjectRef.current.id;

      const { songTitle, detectedBpm, detectedKey, cleanTrackNames } =
        inferSongMetadataFromFiles(validFiles);

      const bpm =
        importMode === 'new-song'
          ? detectedBpm || 120
          : currentProjectRef.current.bpm;
      const beatsPerBar =
        importMode === 'new-song' ? 4 : currentProjectRef.current.beatsPerBar;
      const secPerBar = (60 / bpm) * beatsPerBar;

      // 1. If creating a new song, immediately switch to Arranger view and show progress
      if (importMode === 'new-song') {
        setActiveView('arranger');
      }
      setImportStatusText(`Importando 0/${validFiles.length} pistas...`);

      const decodedTracks: TrackChannel[] = [];
      const decodedAudioBuffers = new Map<string, AudioBuffer>();
      let maxDurationSec = 0;
      let completedCount = 0;

      // 2. Decode all stems in parallel without blocking IndexedDB
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
            gain: 0.88,
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

          // Save to IndexedDB asynchronously in background (non-blocking)
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

      // Preserve original file order
      decodedTracks.sort((a, b) => a.id.localeCompare(b.id));

      // 3. Calculate exact totalBars from real audio duration and auto-detect sections!
      const calculatedBars =
        maxDurationSec > 2
          ? Math.max(4, Math.ceil(maxDurationSec / secPerBar))
          : 24;

      if (importMode === 'new-song') {
        const autoSections = autoDetectSectionsFromTracks(decodedTracks, calculatedBars);

        const newSongProject: SongProject = {
          id: targetProjectId,
          title: songTitle,
          artist: 'Sesión Importada',
          folder: 'imported',
          inSetlist: true,
          bpm,
          beatsPerBar: 4,
          beatUnit: 4,
          keySignature: detectedKey || 'C Major',
          totalBars: calculatedBars,
          durationSec: maxDurationSec,
          quantizeMode: '1-bar',
          splitRoutingMode: 'stereo',
          clickEnabled: true,
          clickGain: 0.75,
          clickSubdivision: 1,
          guideCuesEnabled: true,
          guideVoiceReadout: true,
          guideGain: 0.85,
          masterGain: 0.95,
          pitchSemitones: 0,
          sections: autoSections,
          tracks: decodedTracks,
          updatedAt: Date.now(),
        };

        await activateProject(newSongProject, decodedAudioBuffers);
        showToast(
          `Canción "${songTitle}" creada (${decodedTracks.length} pistas · ${calculatedBars} compases · ${autoSections.length} secciones auto-detectadas)`
        );
      } else {
        // Adding stems to current project
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
          const autoSections = autoDetectSectionsFromTracks(combinedTracks, nextTotalBars);

          return {
            ...prev,
            totalBars: nextTotalBars,
            durationSec: nextDurationSec,
            sections: prev.tracks.length === 0 ? autoSections : prev.sections,
            tracks: combinedTracks,
          };
        });

        showToast(`${decodedTracks.length} stem(s) añadidos a "${currentProjectRef.current.title}"`);
      }
    },
    [activateProject, showToast, updateCurrentProject]
  );

  // Auto-Detect Sections on current song on-demand
  const handleAutoDetectSectionsNow = () => {
    updateCurrentProject((prev) => {
      const detected = autoDetectSectionsFromTracks(prev.tracks, prev.totalBars);
      return {
        ...prev,
        sections: detected,
      };
    });
    showToast('Secciones recalculadas automáticamente según la energía del audio');
  };

  // Transport & Mixer Handlers
  const handlePlayPause = () => audioEngine.togglePlayPause();
  const handleStop = () => audioEngine.stop();
  const handleToggleVamp = () => audioEngine.toggleVamp();
  const handleJumpSection = (sectionId: string) => audioEngine.queueSectionJump(sectionId);
  const handleSeekSeconds = (sec: number) => audioEngine.seekToSeconds(sec);

  const handleChangeBpm = (bpm: number) => {
    updateCurrentProject((p) => {
      if (p.durationSec && p.durationSec > 2) {
        const secPerBar = (60 / bpm) * p.beatsPerBar;
        const nextBars = Math.max(4, Math.ceil(p.durationSec / secPerBar));
        const nextSections = autoDetectSectionsFromTracks(p.tracks, nextBars);
        return { ...p, bpm, totalBars: nextBars, sections: nextSections };
      }
      return { ...p, bpm };
    });
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

  const handleToggleGuideVoice = () => {
    updateCurrentProject((p) => ({ ...p, guideVoiceReadout: !p.guideVoiceReadout }));
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
      clickGain: 0.75,
      guideGain: 0.85,
      masterGain: 0.95,
      tracks: p.tracks.map((t) => ({
        ...t,
        gain: 0.85,
        pan: 0,
        muted: false,
        soloed: false,
      })),
    }));
    showToast('Mezcla restablecida a valores nominales');
  };

  // Section Arrangement Save Handler
  const handleSaveSections = (sections: SongSection[], totalBars: number) => {
    updateCurrentProject((prev) => ({
      ...prev,
      sections,
      totalBars,
    }));
    showToast('Estructura de secciones actualizada');
  };

  // Library & Tree Sidebar Handlers
  const handleSelectProjectFromLibrary = async (projectId: string) => {
    if (projectId === currentProject.id) return;
    const found = projects.find((p) => p.id === projectId);
    if (!found) return;
    await activateProject(found);
    if (activeView === 'library') {
      handleSelectView('arranger');
    }
    showToast(`Canción activa: ${found.title}`);
  };

  const handleToggleSetlistStar = (projectId: string) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const updated = { ...p, inSetlist: !p.inSetlist };
        saveProjectToDb(updated).catch(() => {});
        if (currentProject.id === projectId) {
          setCurrentProject(updated);
        }
        return updated;
      })
    );
  };

  const handleCreateNewProject = async (
    title: string,
    artist: string,
    bpm: number,
    keySignature: string
  ) => {
    const newProj: SongProject = {
      ...DEFAULT_DEMO_PROJECTS[0],
      id: `proj-${Date.now()}`,
      title,
      artist,
      folder: 'imported',
      inSetlist: true,
      bpm,
      keySignature,
      tracks: [],
      updatedAt: Date.now(),
    };
    await activateProject(newProj);
    handleSelectView('arranger');
    showToast(`Nueva canción creada: ${title}`);
  };

  const handleDeleteProject = async (projectId: string) => {
    if (projects.length <= 1) return;
    await deleteProjectFromDb(projectId);
    const remaining = projects.filter((p) => p.id !== projectId);
    setProjects(remaining);
    if (currentProject.id === projectId && remaining[0]) {
      await activateProject(remaining[0]);
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
      if (!parsed.title || !Array.isArray(parsed.sections) || !Array.isArray(parsed.tracks)) {
        showToast('El archivo JSON no tiene un formato LibreTracks válido');
        return;
      }
      const importedProj: SongProject = {
        ...parsed,
        id: `imported-${Date.now()}`,
        folder: 'imported',
        updatedAt: Date.now(),
      };
      await activateProject(importedProj);
      handleSelectView('arranger');
      showToast(`Proyecto importado: ${importedProj.title}`);
    } catch {
      showToast('No se pudo leer el archivo JSON');
    }
  };

  // Global Window Drag-and-Drop Handlers for Instant Song Creation
  const handleDragOverWindow = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOverWindow(true);
    }
  };

  const handleDragLeaveWindow = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) {
      setIsDraggingOverWindow(false);
    }
  };

  const handleDropOnWindow = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOverWindow(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleInstantImportFiles(e.dataTransfer.files, 'main', 'new-song');
    }
  };

  return (
    <div
      onDragOver={handleDragOverWindow}
      onDragLeave={handleDragLeaveWindow}
      onDrop={handleDropOnWindow}
      className="min-h-screen h-screen flex flex-col bg-[#0B0F17] text-slate-100 overflow-hidden relative"
    >
      {/* Global Drag-and-Drop Overlay */}
      {isDraggingOverWindow && (
        <div className="fixed inset-0 z-50 bg-cyan-500/20 backdrop-blur-xs border-4 border-dashed border-cyan-400 flex items-center justify-center p-8 pointer-events-none">
          <div className="bg-[#111827] border border-slate-800 rounded-2xl p-8 text-center shadow-2xl max-w-md">
            <Upload className="w-12 h-12 text-cyan-400 mx-auto mb-3" />
            <h2 className="font-display text-xl font-bold text-slate-100">
              Suelta tus Stems o Carpeta Aquí
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Se guardará como una sola canción en tu repertorio con todas sus pistas listas.
            </p>
          </div>
        </div>
      )}

      {/* Top 3-Zone Navigation Bar */}
      <TopBar
        activeView={activeView}
        onSelectView={handleSelectView}
        onOpenImportModal={() => setIsImportModalOpen(true)}
      />

      {/* Studio Transport & Bar:Beat Telemetry Deck */}
      <TransportDeck
        project={currentProject}
        transport={transport}
        importStatusText={importStatusText}
        onPlayPause={handlePlayPause}
        onStop={handleStop}
        onToggleVamp={handleToggleVamp}
        onChangeBpm={handleChangeBpm}
        onChangePitch={handleChangePitch}
        onChangeQuantize={handleChangeQuantize}
        onToggleClick={handleToggleClick}
        onToggleGuide={handleToggleGuide}
        onToggleSplitRouting={handleToggleSplitRouting}
        onAutoDetectSections={handleAutoDetectSectionsNow}
        onOpenSectionEditor={() => setIsSectionEditorOpen(true)}
      />

      {/* Main Body: Dockable Left Repertoire Tree Sidebar + Active Workspace Viewport */}
      <div className="flex-1 flex overflow-hidden">
        {activeView !== 'remote' && (
          <RepertoireTreeSidebar
            projects={projects}
            currentProjectId={currentProject.id}
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed((prev) => !prev)}
            onSelectProject={handleSelectProjectFromLibrary}
            onToggleSetlistStar={handleToggleSetlistStar}
            onDeleteProject={handleDeleteProject}
            onExportJson={handleExportJson}
            onQuickImportNewSongFiles={(files) =>
              handleInstantImportFiles(files, 'main', 'new-song')
            }
            onOpenNewSongModal={() => handleSelectView('library')}
          />
        )}

        {activeView === 'arranger' && (
          <TimelineArranger
            project={currentProject}
            transport={transport}
            meters={meters.tracks}
            isDarkMode={true}
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
            onAutoDetectSections={handleAutoDetectSectionsNow}
            onOpenImportModal={() => setIsImportModalOpen(true)}
            onOpenSectionEditor={() => setIsSectionEditorOpen(true)}
          />
        )}

        {activeView === 'mixer' && (
          <MultitrackMixer
            project={currentProject}
            meters={meters}
            onToggleTrackMute={handleToggleTrackMute}
            onToggleTrackSolo={handleToggleTrackSolo}
            onChangeTrackGain={handleChangeTrackGain}
            onChangeTrackPan={handleChangeTrackPan}
            onChangeTrackBus={handleChangeTrackBus}
            onChangeClickGain={(gain) =>
              updateCurrentProject((p) => ({ ...p, clickGain: gain }))
            }
            onChangeClickSubdivision={(clickSubdivision) =>
              updateCurrentProject((p) => ({ ...p, clickSubdivision }))
            }
            onToggleClick={handleToggleClick}
            onChangeGuideGain={(gain) =>
              updateCurrentProject((p) => ({ ...p, guideGain: gain }))
            }
            onToggleGuide={handleToggleGuide}
            onToggleGuideVoice={handleToggleGuideVoice}
            onChangeMasterGain={(gain) =>
              updateCurrentProject((p) => ({ ...p, masterGain: gain }))
            }
            onResetMixer={handleResetMixer}
          />
        )}

        {activeView === 'remote' && (
          <StageRemoteView
            project={currentProject}
            transport={transport}
            onPlayPause={handlePlayPause}
            onStop={handleStop}
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
        )}

        {activeView === 'library' && (
          <LibraryView
            projects={projects}
            currentProjectId={currentProject.id}
            onSelectProject={handleSelectProjectFromLibrary}
            onCreateNewProject={handleCreateNewProject}
            onDeleteProject={handleDeleteProject}
            onExportJson={handleExportJson}
            onImportJsonFile={handleImportJsonFile}
            onOpenStemImporter={() => setIsImportModalOpen(true)}
          />
        )}
      </div>

      {/* Modals */}
      <StemImporterModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImportFiles={(files, defaultBus, importMode) =>
          handleInstantImportFiles(files, defaultBus, importMode)
        }
      />

      {isSectionEditorOpen && (
        <SectionEditorModal
          isOpen={isSectionEditorOpen}
          project={currentProject}
          onClose={() => setIsSectionEditorOpen(false)}
          onSaveSections={handleSaveSections}
        />
      )}

      {/* Non-intrusive Action Feedback Toast */}
      {toastMessage && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 bg-slate-900 dark:bg-slate-800 border border-sky-500/40 dark:border-cyan-500/50 text-white px-4 py-2.5 rounded-xl text-xs font-medium shadow-lg"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
