/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from './audio/audioEngine';
import { useStudioShortcuts } from './hooks/useStudioShortcuts';
import { ActionToast, DeleteFromLibraryDialog, MissingFolderDialog } from './components/AppDialogs';
import { useOptimization } from './hooks/useOptimization';
import { useProjectActions } from './hooks/useProjectActions';
import { useSetlist } from './hooks/useSetlist';
import { useImportFlow } from './hooks/useImportFlow';
import { useMixerActions } from './hooks/useMixerActions';
import { useDawDragDrop } from './hooks/useDawDragDrop';
import { useToast } from './hooks/useToast';
import { useNativeCacheBanner } from './hooks/useNativeCacheBanner';
import { useSetlistCaching } from './hooks/useSetlistCaching';
import { useLoudnessAnalysis } from './hooks/useLoudnessAnalysis';
import { useProjectActivation } from './hooks/useProjectActivation';
import { useAlwaysMountedSong } from './hooks/useAlwaysMountedSong';
import { useProjectPersistence } from './hooks/useProjectPersistence';
import { useTrackInstruments } from './hooks/useTrackInstruments';
import { useSongEditing } from './hooks/useSongEditing';
import { useRelinkProject } from './hooks/useRelinkProject';
import { useLibraryDeletion } from './hooks/useLibraryDeletion';
import { syncProjectSidecarNow } from './storage/projectDb';
import { SetlistTransitionMode, SongProject, TransportState } from './types/project';
import { TopBar, WorkspaceView } from './components/TopBar';
import { TransportDeck } from './components/TransportDeck';
import { SetlistPageView } from './components/SetlistPageView';
import { LiveSetView } from './components/LiveSetView';
import { TimelineArranger } from './components/TimelineArranger';
import { MultitrackMixer } from './components/MultitrackMixer';
import { LibraryView } from './components/LibraryView';
import { ConfirmSongActionModal } from './components/modals/ConfirmSongActionModal';
import { SectionEditorModal } from './components/modals/SectionEditorModal';
import { SongFingerprintPromptModal } from './components/modals/SongFingerprintPromptModal';
import { StemImporterModal } from './components/modals/StemImporterModal';
import {
  ImportWizardModal,
  type ImportWizardMode,
  type WizardFile,
  type WizardMeta,
  type WizardResult,
} from './components/modals/ImportWizardModal';
import { DeviceDisconnectedBanner, LibraryLoadErrorBanner, MissingCacheBanner } from './components/app/StatusBanners';
import { DebugBadge } from './components/app/DebugBadge';
import { ArrangerEmpty, DropOverlay, MixerEmpty } from './components/app/WorkspacePlaceholders';
import { DockedMixerDialog, type MixerHandlers } from './components/app/DockedMixerDialog';
import { EditTracksWizard, TrackInstrumentPicker } from './components/app/TrackEditDialogs';
import { FingerprintCandidate } from './audio/fingerprint';

const DesktopRemoteBridge = (import.meta.env.VITE_OMNITRACKS_DESKTOP === '1' || import.meta.env.DEV)
  ? React.lazy(() => import('../desktop/frontend/RemoteConnectionBridge'))
  : null;

const DesktopAudioSettings = (import.meta.env.VITE_OMNITRACKS_DESKTOP === '1' || import.meta.env.DEV)
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

export default function App() {
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  const [activeView, setActiveView] = useState<WorkspaceView>(getInitialViewFromHash);
  // En vivo: los saltos de sección arrancan bloqueados y se vuelven a bloquear al salir de la página.
  const [liveJumpsEnabled, setLiveJumpsEnabled] = useState(false);
  const liveJumpsLockedRef = useRef(true);
  liveJumpsLockedRef.current = activeView === 'live' && !liveJumpsEnabled;
  useEffect(() => {
    if (activeView !== 'live') setLiveJumpsEnabled(false);
  }, [activeView]);
  const [isDockedMixerOpen, setIsDockedMixerOpen] = useState<boolean>(false);
  const [projects, setProjects] = useState<SongProject[]>([]);
  const [currentProject, setCurrentProject] = useState<SongProject | null>(null);
  const [remoteTriggerHost, setRemoteTriggerHost] = useState<HTMLSpanElement | null>(null);
  const [audioTriggerHost, setAudioTriggerHost] = useState<HTMLSpanElement | null>(null);
  const [transport, setTransport] = useState<TransportState>(INITIAL_TRANSPORT);
  // Default transition mode is 'cue-next' (mounts at 00:00 in pause) so songs never start playing on their own unexpectedly
  const [setlistTransitionMode, setSetlistTransitionMode] =
    useState<SetlistTransitionMode>('cue-next');
  const [confirmSongCandidate, setConfirmSongCandidate] = useState<SongProject | null>(
    null
  );

  const [missingFolderSong, setMissingFolderSong] = useState<SongProject | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importWizard, setImportWizard] = useState<{
    mode: ImportWizardMode;
    initialMeta: WizardMeta;
    files: WizardFile[];
    resolve: (result: WizardResult | null) => void;
  } | null>(null);
  const requestImportWizard = useCallback(
    (request: { mode: ImportWizardMode; initialMeta: WizardMeta; files: WizardFile[] }) =>
      new Promise<WizardResult | null>((resolve) => setImportWizard({ ...request, resolve })),
    []
  );
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
  const [isEditTracksOpen, setIsEditTracksOpen] = useState(false);
  const [instrumentPickerTrackId, setInstrumentPickerTrackId] = useState<string | null>(null);
  const { toastMessage, showToast } = useToast();

  const currentProjectRef = useRef<SongProject | null>(currentProject);
  currentProjectRef.current = currentProject;
  const projectsRef = useRef<SongProject[]>([]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const isDesktopApp = typeof window !== 'undefined' && Boolean((window as any).__TAURI__);
  const {
    isDeviceDisconnected,
    missingNativeCache,
    setMissingNativeCache,
    isGeneratingNativeCache,
    setIsGeneratingNativeCache,
    nativeCacheProgress,
    setNativeCacheProgress,
    generateMissingCache,
  } = useNativeCacheBanner({ currentProject, isDesktopApp, showToast });

  // Derived ordered Setlist Queue
  const setlistQueue = useMemo(() => {
    return projects
      .filter((p) => p.inSetlist)
      .sort((a, b) => (a.setlistOrder ?? 999) - (b.setlistOrder ?? 999));
  }, [projects]);

  const { activateProject, activationCountRef, isActivatingProject, handleNextSetlistSong, handlePrevSetlistSong } =
    useProjectActivation({
      currentProjectRef,
      setCurrentProject,
      setProjects,
      setlistQueue,
      setlistTransitionMode,
      isDesktopApp,
      showToast,
    });

  // El DAW nunca se queda vacío: monta una canción al abrir, al importar la primera o al borrar la actual.
  useAlwaysMountedSong({
    projects,
    currentProject,
    setlistQueue,
    busy: isActivatingProject || importStatusText !== null || importWizard !== null,
    activateProject,
  });

  const ramCacheVersion = useSetlistCaching({
    setlistQueue,
    currentProjectId: currentProject?.id,
    isActivatingProject,
    isDesktopApp,
  });

  useLoudnessAnalysis({
    isDesktopApp,
    setlistKey: setlistQueue.map((s) => s.id).join('|'),
    setProjects,
    setCurrentProject,
  });

  // Surface engine notices (play blocked, still loading...) instead of failing silently
  useEffect(() => {
    audioEngine.setOnNotice(showToast);
    return () => audioEngine.setOnNotice(null);
  }, [showToast]);

  // The manual "Optimizar" button and the automatic background cache are ONE job:
  // pressing the button while the song is already being prepared just shows its progress.
  const { handleStartOptimizeProject } = useOptimization({
    showToast,
    currentProjectRef,
    setIsGeneratingNativeCache,
    setNativeCacheProgress,
    setMissingNativeCache,
  });

  const handleRelinkProject = useRelinkProject({
    isDesktopApp,
    currentProjectRef,
    setProjects,
    setCurrentProject,
    showToast,
  });

  // Estado de transporte del motor (ya limitado a ~20 fps por audioEngine)
  useEffect(() => {
    const unsubscribe = audioEngine.subscribe((newTransport) => {
      setTransport(newTransport);
    });

    return unsubscribe;
  }, []);

  const { updateCurrentProject, libraryLoadError, libraryLoading, retryLoadLibrary } = useProjectPersistence({
    projects,
    projectsRef,
    currentProjectRef,
    setProjects,
    setCurrentProject,
    showToast,
  });

  const { handleSaveTrackMapping, handleChangeTrackInstrument } = useTrackInstruments({
    currentProjectRef,
    updateCurrentProject,
    showToast,
  });

  // Atajos globales de teclado (Espacio, V, 1-9)
  useStudioShortcuts(currentProjectRef, liveJumpsLockedRef);

  const handleSelectView = (view: WorkspaceView) => {
    setActiveView(view);
    window.history.replaceState(null, '', `#${view}`);
  };

  const { handleUpdateSongNotes, handleSetSongTransition, handleAddSectionTemplate, handleAddMarkerAtPlayhead } =
    useSongEditing({
      currentProject,
      currentProjectRef,
      projectsRef,
      transport,
      setProjects,
      setCurrentProject,
      updateCurrentProject,
      showToast,
    });

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
    requestImportWizard,
  });

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
    handleToggleTrackMute,
    handleToggleTrackSolo,
    handleToggleTrackMonitor,
    handleChangeMonitorGain,
    handleChangeTrackCueGain,
    handleToggleTrackCueMute,
    handleChangeTrackGain,
    handleChangeTrackPan,
    handleDeleteTrack,
    handleResetMixer,
    handleSaveSections,
  } = useMixerActions({
    audioEngine,
    updateCurrentProject,
    showToast,
    syncProjectSidecarNow,
  });

  // Las mismas acciones de consola para Mezcla, el Setlist y la consola flotante del Arreglo.
  const mixerHandlers: MixerHandlers = {
    onToggleTrackMute: handleToggleTrackMute,
    onToggleTrackSolo: handleToggleTrackSolo,
    onChangeTrackGain: handleChangeTrackGain,
    onChangeTrackPan: handleChangeTrackPan,
    onChangeClickGain: (gain) => updateCurrentProject((p) => ({ ...p, clickGain: gain })),
    onToggleClick: handleToggleClick,
    onChangeMasterGain: (gain) => updateCurrentProject((p) => ({ ...p, masterGain: gain })),
    onResetMixer: handleResetMixer,
    onToggleTrackMonitor: handleToggleTrackMonitor,
    onChangeMonitorGain: handleChangeMonitorGain,
    onChangeTrackCueGain: handleChangeTrackCueGain,
    onToggleTrackCueMute: handleToggleTrackCueMute,
    onPickInstrument: setInstrumentPickerTrackId,
  };

  const { songToDeleteFromLibrary, setSongToDeleteFromLibrary, confirmDeleteFromLibrary } = useLibraryDeletion({
    projects,
    currentProject,
    currentProjectRef,
    transport,
    isDesktopApp,
    setProjects,
    setCurrentProject,
    showToast,
  });

  const {
    handleLoadProjectImmediately,
    handleUpdateSongMetadata,
    handleDeleteProject,
    handleExportJson,
  } = useProjectActions({
    projects,
    projectsRef,
    currentProject,
    currentProjectRef,
    setProjects,
    setCurrentProject,
    showToast,
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
    setMissingFolderSong,
    transport,
    setlistQueue,
    handleLoadProjectImmediately,
  });

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
  const remoteTriggerRef = DesktopRemoteBridge && (window.location.origin === 'https://tauri.localhost' || import.meta.env.DEV)
    ? setRemoteTriggerHost : undefined;
  const audioTriggerRef = DesktopAudioSettings && (window.location.origin === 'https://tauri.localhost' || import.meta.env.DEV)
    ? setAudioTriggerHost : undefined;

  return (
    <div className="app-shell min-h-screen h-dvh flex flex-col bg-studio-ground text-neutral-100 overflow-hidden relative">
      {/* Top Navigation Bar */}
      <TopBar
        activeView={activeView}
        setlistCount={setlistQueue.length}
        remoteTriggerRef={remoteTriggerRef}
        audioTriggerRef={audioTriggerRef}
        onSelectView={handleSelectView}
        onOpenImportModal={() => setIsImportModalOpen(true)}
      />

      {libraryLoadError && (
        <LibraryLoadErrorBanner message={libraryLoadError} isRetrying={libraryLoading} onRetry={() => void retryLoadLibrary()} />
      )}

      {isDeviceDisconnected && <DeviceDisconnectedBanner currentTimeSec={transport.currentTimeSec} />}

      {missingNativeCache && (
        <MissingCacheBanner
          project={currentProject}
          isGenerating={isGeneratingNativeCache}
          progress={nativeCacheProgress}
          onGenerate={() => void generateMissingCache(currentProject)}
        />
      )}

      {/* Studio Transport Deck (Shown when a song is loaded; the Live page has its own) */}
      {transportProject && (
        <TransportDeck
          project={transportProject}
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
          onAddMarkerAtPlayhead={handleAddMarkerAtPlayhead}
          onOpenSectionEditor={() => setIsSectionEditorOpen(true)}
          onCancelQueuedJump={handleCancelQueuedJump}
        />
      )}

      {/* Main Body: Active Workspace */}
      <div className="relative flex-1 flex overflow-hidden min-h-0">

        {/* Active Workspace Drop Zone */}
        <div
          onDragOver={handleDragOverDaw}
          onDragLeave={handleDragLeaveDaw}
          onDrop={handleDropOnDaw}
          className="lt-workspace flex-1 flex flex-col overflow-hidden relative"
        >
          {/* Visual Drop Overlay when dragging a Repertoire Song or Audio Files */}
          {dragOverlayMode && <DropOverlay mode={dragOverlayMode} />}

          {/* 1. DEDICATED SETLIST PAGE VIEW */}
          {activeView === 'setlist' && (
            <SetlistPageView
              project={currentProject}
              allProjects={projects}
              setlistQueue={setlistQueue}
              transport={transport}
              ramCacheVersion={ramCacheVersion}
              setlistTransitionMode={setlistTransitionMode}
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
              onEditTracks={() => setIsEditTracksOpen(true)}
              onQuickImportNewSongFiles={(files) =>
                handleInstantImportFiles(files, 'main', 'new-song')
              }
              onQuickImportNativeFolder={(folder) =>
                handleImportNative({ folderPath: folder }, 'main', 'new-song')
              }
              onQuickImportNativeFiles={(paths) =>
                handleImportNative({ filePaths: paths }, 'main', 'new-song')
              }
              {...mixerHandlers}
            />
          )}

          {/* LIVE SET: performance page */}
          {activeView === 'live' && (
            <LiveSetView
              project={currentProject}
              transport={transport}
              setlistQueue={setlistQueue}
              setlistTransitionMode={setlistTransitionMode}
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
              jumpsEnabled={liveJumpsEnabled}
              onToggleJumps={setLiveJumpsEnabled}
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
                  isDarkMode={true}
                  isDockedMixerOpen={isDockedMixerOpen}
                  onToggleDockedMixer={() => setIsDockedMixerOpen((prev) => !prev)}
                  onJumpSection={handleJumpSection}
                  onSeekSeconds={handleSeekSeconds}
                  onToggleTrackMute={handleToggleTrackMute}
                  onToggleTrackSolo={handleToggleTrackSolo}
                  onChangeTrackGain={handleChangeTrackGain}
                  onChangeTrackPan={handleChangeTrackPan}
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
                  onEditTracks={() => setIsEditTracksOpen(true)}
                  onPickInstrument={setInstrumentPickerTrackId}
                />

                {isDockedMixerOpen && (
                  <DockedMixerDialog
                    project={currentProject}
                    transport={transport}
                    mixer={mixerHandlers}
                    onClose={() => setIsDockedMixerOpen(false)}
                  />
                )}
              </div>
            ) : (
              <ArrangerEmpty onGoToSetlist={() => handleSelectView('setlist')} onOpenImport={() => setIsImportModalOpen(true)} />
            ))}

          {/* 3. FULL MIXER VIEW */}
          {activeView === 'mixer' &&
            (currentProject ? (
              <MultitrackMixer
                project={currentProject}
                transport={transport}
                docked={false}
                {...mixerHandlers}
                onEditTracks={() => setIsEditTracksOpen(true)}
                onSeekSeconds={handleSeekSeconds}
                onJumpSection={handleJumpSection}
              />
            ) : (
              <MixerEmpty onGoToSetlist={() => handleSelectView('setlist')} />
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
              onDeleteProject={handleDeleteProject}
              onExportJson={handleExportJson}
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

      {instrumentPickerTrackId && currentProject && (
        <TrackInstrumentPicker
          project={currentProject}
          trackId={instrumentPickerTrackId}
          onPick={(trackId, instrumentId) => {
            setInstrumentPickerTrackId(null);
            handleChangeTrackInstrument(trackId, instrumentId);
          }}
          onClose={() => setInstrumentPickerTrackId(null)}
        />
      )}

      {isEditTracksOpen && currentProject && (
        <EditTracksWizard
          project={currentProject}
          onConfirm={(result) => {
            setIsEditTracksOpen(false);
            handleSaveTrackMapping(result);
          }}
          onCancel={() => setIsEditTracksOpen(false)}
        />
      )}

      {importWizard && (
        <ImportWizardModal
          mode={importWizard.mode}
          initialMeta={importWizard.initialMeta}
          files={importWizard.files}
          onConfirm={(result) => {
            const done = importWizard.resolve;
            setImportWizard(null);
            done(result);
          }}
          onCancel={() => {
            const done = importWizard.resolve;
            setImportWizard(null);
            done(null);
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

      {/* Delete From Library Confirmation Modal */}
      {songToDeleteFromLibrary && (
        <DeleteFromLibraryDialog
          song={songToDeleteFromLibrary}
          onCancel={() => setSongToDeleteFromLibrary(null)}
          onConfirm={confirmDeleteFromLibrary}
        />
      )}

      {/* Missing Folder Notice Modal */}
      {missingFolderSong && (
        <MissingFolderDialog
          song={missingFolderSong}
          onCancel={() => setMissingFolderSong(null)}
          onRelink={(target) => {
            setMissingFolderSong(null);
            handleRelinkProject(target);
          }}
        />
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

      {/* Non-intrusive Action Feedback Toast */}
      {toastMessage && <ActionToast message={toastMessage} />}
      <DebugBadge />
    </div>
  );
}
