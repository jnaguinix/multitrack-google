import { audioEngine as defaultAudioEngine } from '../audio/audioEngine';
import { SongProject, QuantizeMode, OutputBus, SongSection } from '../types/project';

interface UseMixerActionsDeps {
  audioEngine?: typeof defaultAudioEngine;
  updateCurrentProject: (updater: (prev: SongProject) => SongProject) => void;
  showToast: (msg: string) => void;
  syncProjectSidecarNow: (project: SongProject, force?: boolean) => Promise<boolean>;
}

export function useMixerActions({
  audioEngine = defaultAudioEngine,
  updateCurrentProject,
  showToast,
  syncProjectSidecarNow,
}: UseMixerActionsDeps) {
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
      clickPan: 0,
      guideGain: 1.0,
      guidePan: 0,
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
    updateCurrentProject((prev) => {
      const next: SongProject = {
        ...prev,
        sections,
      };
      syncProjectSidecarNow(next, true).catch(() => {});
      return next;
    });
    showToast('Marcadores de sección (mm:ss) guardados en canción y carpeta');
  };

  return {
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
  };
}
