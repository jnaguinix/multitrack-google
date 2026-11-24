import { logAsyncError } from '../utils/asyncErrors';
import { audioEngine as defaultAudioEngine } from '../audio/audioEngine';
import { SongProject, QuantizeMode, SongSection, PadHarmony, PadStyle } from '../types/project';
import { DEFAULT_PAD_GAIN, isPadOnlySong } from '../utils/padSong';

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

  const handleChangeKeySignature = (keySignature: string) => {
    updateCurrentProject((p) => ({ ...p, keySignature }));
  };

  const handleChangeBeatsPerBar = (beatsPerBar: number) => {
    updateCurrentProject((p) => ({
      ...p,
      beatsPerBar,
      ...(p.padOnly ? { beatUnit: beatsPerBar === 6 ? 8 : 4 } : {}),
    }));
  };

  const handleChangeClickSubdivision = (clickSubdivision: 1 | 2 | 4) => {
    updateCurrentProject((p) => ({ ...p, clickSubdivision }));
  };

  const handleTogglePad = () => {
    updateCurrentProject((p) => ({ ...p, padEnabled: p.padEnabled === false }));
  };

  const handleChangePadGain = (padGain: number) => {
    updateCurrentProject((p) => ({ ...p, padGain }));
  };

  const handleTogglePadMonitor = () => {
    updateCurrentProject((p) => ({ ...p, padMonitor: !p.padMonitor }));
  };

  const handleChangePadHarmony = (padHarmony: PadHarmony) => {
    updateCurrentProject((p) => ({ ...p, padHarmony }));
  };

  const handleChangePadStyle = (padStyle: PadStyle) => {
    updateCurrentProject((p) => ({ ...p, padStyle }));
  };

  const handleChangePadPack = (padPackId: string | null) => {
    updateCurrentProject((p) => ({ ...p, padPackId }));
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

  const handleToggleTrackMonitor = (trackId: string) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, monitor: !t.monitor } : t)),
    }));
  };

  // Secuencia dividida: volumen y mute del canal izquierdo (click y guía), en el fader Click.
  const handleChangeTrackCueGain = (trackId: string, gain: number) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, cueGain: gain } : t)),
    }));
  };

  const handleToggleTrackCueMute = (trackId: string) => {
    updateCurrentProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, cueMuted: !t.cueMuted } : t)),
    }));
  };

  const handleChangeMonitorGain = (gain: number) => {
    updateCurrentProject((p) => ({ ...p, monitorGain: gain }));
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
      masterGain: 1.0,
      cueMasterGain: 1.0,
      // El envío a auriculares y el canal de click de una secuencia dividida también vuelven a 0 dB (antes no se tocaban).
      monitorGain: 1.0,
      ...(isPadOnlySong(p) ? { padGain: DEFAULT_PAD_GAIN, padEnabled: true } : {}),
      tracks: p.tracks.map((t) => ({
        ...t,
        gain: 1.0,
        pan: 0,
        muted: false,
        soloed: false,
        ...(t.cueGain !== undefined ? { cueGain: 1.0 } : {}),
        ...(t.cueMuted !== undefined ? { cueMuted: false } : {}),
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
      syncProjectSidecarNow(next, true).catch(logAsyncError('sincronizar el archivo de la canción'));
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
    handleChangeKeySignature,
    handleChangeBeatsPerBar,
    handleChangeClickSubdivision,
    handleTogglePad,
    handleChangePadGain,
    handleTogglePadMonitor,
    handleChangePadHarmony,
    handleChangePadStyle,
    handleChangePadPack,
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
  };
}
