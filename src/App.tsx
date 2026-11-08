/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { audioEngine } from './audio/audioEngine';
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

export default function App() {
  const [activeView, setActiveView] = useState<WorkspaceView>(getInitialViewFromHash);
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
  const [isImportingStems, setIsImportingStems] = useState(false);
  const [isSectionEditorOpen, setIsSectionEditorOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const channelRef = useRef<BroadcastChannel | null>(null);
  const currentProjectRef = useRef<SongProject>(currentProject);
  currentProjectRef.current = currentProject;

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3200);
  }, []);

  // Load projects from IndexedDB on initial mount and initialize audio engine
  const activateProject = useCallback(
    async (projectToLoad: SongProject) => {
      try {
        const storedStems = await loadProjectStemsFromDb(projectToLoad.id);
        const customMap = new Map<string, ArrayBuffer>();
        for (const s of storedStems) {
          customMap.set(s.trackId, s.arrayBuffer);
        }

        const calculatedPeaks = await audioEngine.loadProject(projectToLoad, customMap);
        const enrichedTracks = projectToLoad.tracks.map((t) => ({
          ...t,
          peaks: calculatedPeaks.get(t.id) || t.peaks || [],
        }));

        const updatedProject: SongProject = {
          ...projectToLoad,
          tracks: enrichedTracks,
        };

        setCurrentProject(updatedProject);
        await saveProjectToDb(updatedProject);
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
            await saveProjectToDb(demo);
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

  // Handlers for Transport & Mixer
  const handlePlayPause = () => audioEngine.togglePlayPause();
  const handleStop = () => audioEngine.stop();
  const handleToggleVamp = () => audioEngine.toggleVamp();
  const handleJumpSection = (sectionId: string) => audioEngine.queueSectionJump(sectionId);
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

  // Stem Importer Handler
  const handleImportStemFiles = async (files: FileList, defaultBus: OutputBus) => {
    setIsImportingStems(true);
    try {
      const addedTracks: TrackChannel[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const arrayBuf = await file.arrayBuffer();
        const cleanName = file.name.replace(/\.[^/.]+$/, '');
        const inferred = inferTrackRoleAndColor(
          cleanName,
          currentProject.tracks.length + i
        );

        const newTrack: TrackChannel = {
          id: `stem-${Date.now()}-${i}`,
          name: cleanName,
          role: inferred.role,
          color: inferred.color,
          gain: 0.85,
          pan: 0,
          muted: false,
          soloed: false,
          bus: inferred.bus === 'cue-click' ? 'cue-click' : defaultBus,
          peaks: [],
          isCustomAudio: true,
          fileName: file.name,
        };

        await saveStemAudioToDb({
          key: `${currentProject.id}:${newTrack.id}`,
          projectId: currentProject.id,
          trackId: newTrack.id,
          arrayBuffer: arrayBuf,
          mimeType: file.type || 'audio/wav',
          fileName: file.name,
        });

        const peaks = await audioEngine.addDecodedTrack(newTrack, arrayBuf);
        newTrack.peaks = peaks;
        addedTracks.push(newTrack);
      }

      if (addedTracks.length > 0) {
        updateCurrentProject((p) => ({
          ...p,
          tracks: [...p.tracks, ...addedTracks],
        }));
        showToast(`${addedTracks.length} stem(s) importados y guardados en IndexedDB`);
      }
    } catch (err) {
      console.error('Error importing stems:', err);
      showToast('Error al decodificar uno de los archivos de audio');
    } finally {
      setIsImportingStems(false);
    }
  };

  // Section Arrangement Save Handler
  const handleSaveSections = (sections: SongSection[], totalBars: number) => {
    const nextProject: SongProject = {
      ...currentProject,
      sections,
      totalBars,
    };
    activateProject(nextProject);
    showToast('Estructura de secciones actualizada');
  };

  // Library Handlers
  const handleSelectProjectFromLibrary = async (projectId: string) => {
    const found = projects.find((p) => p.id === projectId);
    if (!found) return;
    await activateProject(found);
    handleSelectView('arranger');
    showToast(`Proyecto cargado: ${found.title}`);
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
      bpm,
      keySignature,
      updatedAt: Date.now(),
    };
    await activateProject(newProj);
    handleSelectView('arranger');
    showToast(`Nuevo proyecto creado: ${title}`);
  };

  const handleDeleteProject = async (projectId: string) => {
    if (projects.length <= 1) return;
    await deleteProjectFromDb(projectId);
    const remaining = projects.filter((p) => p.id !== projectId);
    setProjects(remaining);
    if (currentProject.id === projectId && remaining[0]) {
      await activateProject(remaining[0]);
    }
    showToast('Proyecto eliminado de la biblioteca');
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
        updatedAt: Date.now(),
      };
      await activateProject(importedProj);
      handleSelectView('arranger');
      showToast(`Proyecto importado: ${importedProj.title}`);
    } catch {
      showToast('No se pudo leer el archivo JSON');
    }
  };

  return (
    <div className="min-h-screen h-screen flex flex-col bg-[#0B0F17] text-slate-100 overflow-hidden">
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
        onPlayPause={handlePlayPause}
        onStop={handleStop}
        onToggleVamp={handleToggleVamp}
        onChangeBpm={handleChangeBpm}
        onChangePitch={handleChangePitch}
        onChangeQuantize={handleChangeQuantize}
        onToggleClick={handleToggleClick}
        onToggleGuide={handleToggleGuide}
        onToggleSplitRouting={handleToggleSplitRouting}
        onOpenSectionEditor={() => setIsSectionEditorOpen(true)}
      />

      {/* Main Workspace Viewport */}
      {activeView === 'arranger' && (
        <TimelineArranger
          project={currentProject}
          transport={transport}
          meters={meters.tracks}
          onJumpSection={handleJumpSection}
          onSeekSeconds={handleSeekSeconds}
          onToggleTrackMute={handleToggleTrackMute}
          onToggleTrackSolo={handleToggleTrackSolo}
          onChangeTrackGain={handleChangeTrackGain}
          onChangeTrackPan={handleChangeTrackPan}
          onChangeTrackBus={handleChangeTrackBus}
          onDeleteTrack={handleDeleteTrack}
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

      {/* Modals */}
      <StemImporterModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImportFiles={handleImportStemFiles}
        isImporting={isImportingStems}
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
          className="fixed bottom-5 right-5 z-50 bg-slate-900 border border-cyan-500/50 text-slate-100 px-4 py-2.5 rounded-xl text-xs font-medium shadow-lg"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
