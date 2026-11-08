import {
  QuantizeMode,
  SongProject,
  SongSection,
  TrackChannel,
  TrackMeterReading,
  TransportState,
} from '../types/project';
import { extractWaveformPeaks, synthesizeDemoTrackBuffer } from './demoSynthesizer';

interface ActiveTrackNodes {
  source: AudioBufferSourceNode | null;
  gainNode: GainNode;
  panNode: StereoPannerNode;
  analyser: AnalyserNode;
  timeDomainData: Float32Array<ArrayBuffer>;
}

type TransportListener = (state: TransportState) => void;

export class LibreTracksAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGainNode: GainNode | null = null;
  private mainBusGain: GainNode | null = null;
  private mainBusPan: StereoPannerNode | null = null;
  private cueBusGain: GainNode | null = null;
  private cueBusPan: StereoPannerNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private masterTimeData: Float32Array<ArrayBuffer> = new Float32Array(256);

  private project: SongProject | null = null;
  private trackBuffers: Map<string, AudioBuffer> = new Map();
  private trackNodes: Map<string, ActiveTrackNodes> = new Map();

  private isPlaying = false;
  private playStartCtxTime = 0;
  private playStartSongSec = 0;
  private pausedSongSec = 0;

  private activeSectionId: string | null = null;
  private queuedSectionId: string | null = null;
  private queuedTargetBar: number | null = null;
  private isVamping = false;
  private lastCueMessage: string | null = null;

  private lastScheduledSubStep = -1;
  private lastAnnouncedTargetBar = -1;
  private rafId: number | null = null;
  private listeners: Set<TransportListener> = new Set();

  public ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();

      this.masterGainNode = this.ctx.createGain();
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 256;
      this.masterTimeData = new Float32Array(this.masterAnalyser.fftSize);

      this.mainBusGain = this.ctx.createGain();
      this.mainBusPan = this.ctx.createStereoPanner();

      this.cueBusGain = this.ctx.createGain();
      this.cueBusPan = this.ctx.createStereoPanner();

      this.mainBusGain.connect(this.mainBusPan);
      this.mainBusPan.connect(this.masterGainNode);

      this.cueBusGain.connect(this.cueBusPan);
      this.cueBusPan.connect(this.masterGainNode);

      this.masterGainNode.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    return this.ctx;
  }

  public subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    listener(this.getTransportState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitTransport() {
    const state = this.getTransportState();
    this.listeners.forEach((cb) => cb(state));
  }

  public async decodeStemBuffer(
    rawBuffer: ArrayBuffer
  ): Promise<{ audioBuffer: AudioBuffer; peaks: number[]; durationSec: number }> {
    const ctx = this.ensureContext();
    const copy = rawBuffer.slice(0);
    const decoded = await ctx.decodeAudioData(copy);
    const peaks = extractWaveformPeaks(decoded, 320);
    return {
      audioBuffer: decoded,
      peaks,
      durationSec: decoded.duration,
    };
  }

  public async loadProject(
    project: SongProject,
    customStems?: Map<string, ArrayBuffer>,
    predecodedBuffers?: Map<string, AudioBuffer>
  ): Promise<Map<string, number[]>> {
    this.stop();
    const ctx = this.ensureContext();
    this.project = project;

    // Tear down old track nodes
    this.trackNodes.forEach((node) => {
      try {
        node.source?.stop();
        node.source?.disconnect();
        node.gainNode.disconnect();
        node.panNode.disconnect();
        node.analyser.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    });
    this.trackNodes.clear();
    this.trackBuffers.clear();

    const updatedPeaks = new Map<string, number[]>();

    for (const track of project.tracks) {
      let audioBuffer: AudioBuffer | null = predecodedBuffers?.get(track.id) || null;
      const rawCustom = customStems?.get(track.id);

      if (!audioBuffer && rawCustom) {
        try {
          // Copy slice because decodeAudioData detaches ArrayBuffer
          const copy = rawCustom.slice(0);
          audioBuffer = await ctx.decodeAudioData(copy);
        } catch (err) {
          console.error(`Failed decoding stem ${track.name}:`, err);
        }
      }

      if (!audioBuffer) {
        audioBuffer = synthesizeDemoTrackBuffer(ctx, project, track);
      }

      this.trackBuffers.set(track.id, audioBuffer);
      const peaks =
        track.peaks && track.peaks.length >= 64
          ? track.peaks
          : extractWaveformPeaks(audioBuffer, 320);
      updatedPeaks.set(track.id, peaks);

      // Build persistent mixer strip nodes for this track
      const gainNode = ctx.createGain();
      const panNode = ctx.createStereoPanner();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;

      gainNode.connect(panNode);
      panNode.connect(analyser);

      this.trackNodes.set(track.id, {
        source: null,
        gainNode,
        panNode,
        analyser,
        timeDomainData: new Float32Array(analyser.fftSize),
      });
    }

    this.applyMixerRouting();
    this.pausedSongSec = 0;
    const firstSec = project.sections[0] || null;
    this.activeSectionId = firstSec ? firstSec.id : null;
    this.isVamping = Boolean(firstSec?.vampByDefault);
    this.lastCueMessage = firstSec ? `LISTO: ${firstSec.name.toUpperCase()}` : null;
    this.emitTransport();

    return updatedPeaks;
  }

  public updateProjectConfig(project: SongProject) {
    const prevPitch = this.project?.pitchSemitones ?? 0;
    this.project = project;
    this.applyMixerRouting();

    if (prevPitch !== project.pitchSemitones && this.isPlaying) {
      this.trackNodes.forEach((node) => {
        if (node.source) {
          node.source.detune.value = project.pitchSemitones * 100;
        }
      });
    }
    this.emitTransport();
  }

  public mountDecodedTrack(track: TrackChannel, decoded: AudioBuffer): { peaks: number[]; durationSec: number } {
    const ctx = this.ensureContext();
    this.trackBuffers.set(track.id, decoded);

    const peaks =
      track.peaks && track.peaks.length >= 64
        ? track.peaks
        : extractWaveformPeaks(decoded, 320);

    const gainNode = ctx.createGain();
    const panNode = ctx.createStereoPanner();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    gainNode.connect(panNode);
    panNode.connect(analyser);

    this.trackNodes.set(track.id, {
      source: null,
      gainNode,
      panNode,
      analyser,
      timeDomainData: new Float32Array(analyser.fftSize),
    });

    if (this.project) {
      this.applyMixerRouting();
      if (this.isPlaying) {
        const currentSec = this.getCurrentSongSec();
        this.startSourceForTrack(track.id, currentSec);
      }
    }

    return { peaks, durationSec: decoded.duration };
  }

  public async addDecodedTrack(track: TrackChannel, arrayBuffer: ArrayBuffer): Promise<number[]> {
    const { audioBuffer } = await this.decodeStemBuffer(arrayBuffer);
    const { peaks } = this.mountDecodedTrack(track, audioBuffer);
    return peaks;
  }

  public removeTrack(trackId: string) {
    const nodes = this.trackNodes.get(trackId);
    if (nodes) {
      try {
        nodes.source?.stop();
        nodes.source?.disconnect();
        nodes.gainNode.disconnect();
        nodes.panNode.disconnect();
        nodes.analyser.disconnect();
      } catch {
        // ignore
      }
      this.trackNodes.delete(trackId);
    }
    this.trackBuffers.delete(trackId);
  }

  private applyMixerRouting() {
    if (!this.project || !this.ctx || !this.masterGainNode || !this.mainBusPan || !this.cueBusPan) {
      return;
    }

    this.masterGainNode.gain.setTargetAtTime(this.project.masterGain, this.ctx.currentTime, 0.015);

    // Split-Mono stage mode routes Click/Cue strictly Left (-1) and Main Tracks strictly Right (+1)
    if (this.project.splitRoutingMode === 'split-mono') {
      this.cueBusPan.pan.setValueAtTime(-1.0, this.ctx.currentTime);
      this.mainBusPan.pan.setValueAtTime(1.0, this.ctx.currentTime);
    } else {
      this.cueBusPan.pan.setValueAtTime(0.0, this.ctx.currentTime);
      this.mainBusPan.pan.setValueAtTime(0.0, this.ctx.currentTime);
    }

    const anySolo = this.project.tracks.some((t) => t.soloed);

    for (const track of this.project.tracks) {
      const node = this.trackNodes.get(track.id);
      if (!node || !this.mainBusGain || !this.cueBusGain) continue;

      const isAudible = anySolo ? track.soloed && !track.muted : !track.muted;
      const effectiveGain = isAudible ? track.gain : 0;

      node.gainNode.gain.setTargetAtTime(effectiveGain, this.ctx.currentTime, 0.015);
      node.panNode.pan.setTargetAtTime(
        this.project.splitRoutingMode === 'split-mono' ? 0 : track.pan,
        this.ctx.currentTime,
        0.015
      );

      // Reconnect analyser output to appropriate bus
      try {
        node.analyser.disconnect();
      } catch {
        // ignore
      }

      if (track.bus === 'main') {
        node.analyser.connect(this.mainBusGain);
      } else if (track.bus === 'cue-click') {
        node.analyser.connect(this.cueBusGain);
      } else {
        node.analyser.connect(this.mainBusGain);
        node.analyser.connect(this.cueBusGain);
      }
    }
  }

  private startSourceForTrack(trackId: string, offsetSec: number) {
    if (!this.ctx || !this.project) return;
    const buffer = this.trackBuffers.get(trackId);
    const node = this.trackNodes.get(trackId);
    if (!buffer || !node) return;

    if (node.source) {
      try {
        node.source.stop();
        node.source.disconnect();
      } catch {
        // ignore
      }
      node.source = null;
    }

    if (offsetSec >= buffer.duration) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.detune.value = (this.project.pitchSemitones || 0) * 100;
    source.connect(node.gainNode);
    source.start(0, Math.max(0, offsetSec));
    node.source = source;
  }

  private startAllTrackSources(offsetSec: number) {
    if (!this.project) return;
    for (const track of this.project.tracks) {
      this.startSourceForTrack(track.id, offsetSec);
    }
  }

  private stopAllTrackSources() {
    this.trackNodes.forEach((node) => {
      if (node.source) {
        try {
          node.source.stop();
          node.source.disconnect();
        } catch {
          // ignore
        }
        node.source = null;
      }
    });
  }

  public play() {
    if (!this.project) return;
    const ctx = this.ensureContext();
    if (this.isPlaying) return;

    this.isPlaying = true;
    this.playStartCtxTime = ctx.currentTime;
    this.playStartSongSec = this.pausedSongSec;
    this.lastScheduledSubStep = -1;
    this.lastAnnouncedTargetBar = -1;

    this.startAllTrackSources(this.playStartSongSec);
    this.startLoop();
    this.emitTransport();
  }

  public pause() {
    if (!this.isPlaying) return;
    this.pausedSongSec = this.getCurrentSongSec();
    this.isPlaying = false;
    this.stopAllTrackSources();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.emitTransport();
  }

  public togglePlayPause() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  public stop() {
    this.isPlaying = false;
    this.pausedSongSec = 0;
    this.queuedSectionId = null;
    this.queuedTargetBar = null;
    this.lastScheduledSubStep = -1;
    this.lastAnnouncedTargetBar = -1;
    this.stopAllTrackSources();

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.project && this.project.sections.length > 0) {
      const first = this.project.sections[0];
      this.activeSectionId = first.id;
      this.isVamping = Boolean(first.vampByDefault);
      this.lastCueMessage = `LISTO: ${first.name.toUpperCase()}`;
    }

    this.emitTransport();
  }

  public seekToBar(barNumber: number) {
    if (!this.project) return;
    const clampedBar = Math.max(1, Math.min(this.project.totalBars, barNumber));
    const secPerBar = (60 / this.project.bpm) * this.project.beatsPerBar;
    const targetSec = (clampedBar - 1) * secPerBar;

    const matchingSec = this.findSectionAtBar(clampedBar);
    if (matchingSec) {
      this.activeSectionId = matchingSec.id;
      this.isVamping = Boolean(matchingSec.vampByDefault);
      this.lastCueMessage = `SECCIÓN: ${matchingSec.name.toUpperCase()}`;
    }

    this.queuedSectionId = null;
    this.queuedTargetBar = null;

    if (this.isPlaying && this.ctx) {
      this.playStartCtxTime = this.ctx.currentTime;
      this.playStartSongSec = targetSec;
      this.lastScheduledSubStep = -1;
      this.startAllTrackSources(targetSec);
    } else {
      this.pausedSongSec = targetSec;
    }

    this.emitTransport();
  }

  public seekToSeconds(seconds: number) {
    if (!this.project) return;
    const secPerBar = (60 / this.project.bpm) * this.project.beatsPerBar;
    const totalSec = this.project.totalBars * secPerBar;
    const clampedSec = Math.max(0, Math.min(totalSec - 0.01, seconds));
    const currentBar = Math.floor(clampedSec / secPerBar) + 1;

    const matchingSec = this.findSectionAtBar(currentBar);
    if (matchingSec) {
      this.activeSectionId = matchingSec.id;
    }

    if (this.isPlaying && this.ctx) {
      this.playStartCtxTime = this.ctx.currentTime;
      this.playStartSongSec = clampedSec;
      this.lastScheduledSubStep = -1;
      this.startAllTrackSources(clampedSec);
    } else {
      this.pausedSongSec = clampedSec;
    }
    this.emitTransport();
  }

  public queueSectionJump(sectionId: string) {
    if (!this.project) return;
    const targetSection = this.project.sections.find((s) => s.id === sectionId);
    if (!targetSection) return;

    // If transport is stopped, jump immediately to the start of that section
    if (!this.isPlaying) {
      this.seekToBar(targetSection.startBar);
      return;
    }

    // If user clicks the already queued section again, cancel the queued jump
    if (this.queuedSectionId === sectionId) {
      this.queuedSectionId = null;
      this.queuedTargetBar = null;
      this.lastCueMessage = 'SALTO CANCELADO';
      this.emitTransport();
      return;
    }

    const { currentBar } = this.getMusicalPosition(this.getCurrentSongSec());
    const mode: QuantizeMode = this.project.quantizeMode;

    if (mode === 'immediate') {
      this.seekToBar(targetSection.startBar);
      this.TriggerGuideCue(targetSection.cueName || targetSection.name, true);
      return;
    }

    let transitionBar = currentBar + 1;
    if (mode === '2-bars') {
      transitionBar = currentBar + 2;
    } else if (mode === 'section-end') {
      const currentSec = this.findSectionAtBar(currentBar);
      if (currentSec) {
        transitionBar = currentSec.startBar + currentSec.lengthBars;
      }
    }

    this.queuedSectionId = targetSection.id;
    this.queuedTargetBar = transitionBar;
    this.isVamping = false; // Queueing a jump releases active vamp
    this.lastCueMessage = `EN COLA → ${targetSection.name.toUpperCase()}`;
    this.emitTransport();
  }

  public toggleVamp() {
    this.isVamping = !this.isVamping;
    if (this.isVamping) {
      this.queuedSectionId = null;
      this.queuedTargetBar = null;
      this.lastCueMessage = 'VAMP ACTIVO (LOOP SECCIÓN)';
      this.TriggerGuideCue('Vamp On', false);
    } else {
      this.lastCueMessage = 'VAMP LIBERADO';
      this.TriggerGuideCue('Vamp Off', false);
    }
    this.emitTransport();
  }

  private findSectionAtBar(bar: number): SongSection | undefined {
    if (!this.project) return undefined;
    return this.project.sections.find(
      (s) => bar >= s.startBar && bar < s.startBar + s.lengthBars
    );
  }

  private getCurrentSongSec(): number {
    if (!this.isPlaying || !this.ctx) {
      return this.pausedSongSec;
    }
    return this.playStartSongSec + (this.ctx.currentTime - this.playStartCtxTime);
  }

  private getMusicalPosition(songSec: number) {
    if (!this.project) {
      return { currentBar: 1, currentBeat: 1, beatProgress: 0, totalBeatsElapsed: 0 };
    }
    const secPerBeat = 60 / this.project.bpm;
    const totalBeatsElapsed = Math.max(0, songSec / secPerBeat);
    const wholeBeatIndex = Math.floor(totalBeatsElapsed);
    const beatProgress = totalBeatsElapsed - wholeBeatIndex;
    const currentBar = Math.floor(wholeBeatIndex / this.project.beatsPerBar) + 1;
    const currentBeat = (wholeBeatIndex % this.project.beatsPerBar) + 1;

    return {
      currentBar,
      currentBeat,
      beatProgress,
      totalBeatsElapsed,
    };
  }

  private startLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }

    const tick = () => {
      if (!this.isPlaying || !this.project || !this.ctx) return;

      const songSec = this.getCurrentSongSec();
      const secPerBeat = 60 / this.project.bpm;
      const secPerBar = secPerBeat * this.project.beatsPerBar;
      const totalSongSec = this.project.totalBars * secPerBar;

      const { currentBar, totalBeatsElapsed } = this.getMusicalPosition(songSec);

      // 1. Check if we reached a queued section jump bar boundary
      if (
        this.queuedSectionId &&
        this.queuedTargetBar !== null &&
        currentBar >= this.queuedTargetBar
      ) {
        const targetSecObj = this.project.sections.find((s) => s.id === this.queuedSectionId);
        this.queuedSectionId = null;
        this.queuedTargetBar = null;

        if (targetSecObj) {
          this.seekToBar(targetSecObj.startBar);
          this.lastCueMessage = `EN VIVO: ${targetSecObj.name.toUpperCase()}`;
          this.rafId = requestAnimationFrame(tick);
          return;
        }
      }

      // 2. Check if active section reached its end while Vamping is enabled
      const currentActiveSec = this.project.sections.find((s) => s.id === this.activeSectionId);
      if (this.isVamping && currentActiveSec && !this.queuedSectionId) {
        const sectionEndBar = currentActiveSec.startBar + currentActiveSec.lengthBars;
        if (currentBar >= sectionEndBar) {
          // Loop seamlessly back to the start of the vamped section
          this.seekToBar(currentActiveSec.startBar);
          this.isVamping = true;
          this.lastCueMessage = `VAMP LOOP: ${currentActiveSec.name.toUpperCase()}`;
          this.rafId = requestAnimationFrame(tick);
          return;
        }
      }

      // 3. Update active section when crossing naturally into a new section
      const naturalSec = this.findSectionAtBar(currentBar);
      if (naturalSec && naturalSec.id !== this.activeSectionId) {
        this.activeSectionId = naturalSec.id;
        if (!this.queuedSectionId && naturalSec.vampByDefault) {
          this.isVamping = true;
          this.lastCueMessage = `AUTO-VAMP: ${naturalSec.name.toUpperCase()}`;
        } else {
          this.lastCueMessage = `SECCIÓN: ${naturalSec.name.toUpperCase()}`;
        }
      }

      // 4. Trigger Metronome Click & Guide Cue on each subdivision step
      const subdiv = this.project.clickSubdivision || 1;
      const currentSubStep = Math.floor(totalBeatsElapsed * subdiv);
      if (currentSubStep > this.lastScheduledSubStep) {
        this.lastScheduledSubStep = currentSubStep;
        const isMainBeat = currentSubStep % subdiv === 0;
        const beatInBar = (Math.floor(currentSubStep / subdiv) % this.project.beatsPerBar) + 1;

        if (this.project.clickEnabled) {
          this.triggerMetronomeClick(beatInBar === 1 && isMainBeat, isMainBeat);
        }

        // Check if 4 beats (1 bar) ahead of a queued jump or next section to announce Guide Cue
        if (isMainBeat && beatInBar === 1 && this.project.guideCuesEnabled) {
          const nextBar = currentBar + 1;
          if (this.queuedSectionId && this.queuedTargetBar === nextBar) {
            const qSec = this.project.sections.find((s) => s.id === this.queuedSectionId);
            if (qSec && this.lastAnnouncedTargetBar !== nextBar) {
              this.lastAnnouncedTargetBar = nextBar;
              this.TriggerGuideCue(`${qSec.cueName || qSec.name} in 2, 3, 4`, true);
            }
          } else if (!this.isVamping && !this.queuedSectionId) {
            const upcomingSec = this.project.sections.find((s) => s.startBar === nextBar);
            if (upcomingSec && this.lastAnnouncedTargetBar !== nextBar) {
              this.lastAnnouncedTargetBar = nextBar;
              this.TriggerGuideCue(`${upcomingSec.cueName || upcomingSec.name}`, true);
            }
          }
        }
      }

      // 5. Stop at end of song if not vamping or jumping
      if (songSec >= totalSongSec) {
        this.stop();
        return;
      }

      this.emitTransport();
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private triggerMetronomeClick(isDownbeat: boolean, isQuarterBeat: boolean) {
    if (!this.ctx || !this.cueBusGain || !this.project) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const clickEnv = this.ctx.createGain();

    // Classic studio UREI / Ableton style high-clarity click frequencies
    osc.type = isDownbeat ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(isDownbeat ? 1680 : isQuarterBeat ? 1120 : 840, now);
    osc.frequency.exponentialRampToValueAtTime(isDownbeat ? 820 : 540, now + 0.035);

    const level =
      this.project.clickGain * (isDownbeat ? 0.55 : isQuarterBeat ? 0.36 : 0.18);
    clickEnv.gain.setValueAtTime(0.0001, now);
    clickEnv.gain.linearRampToValueAtTime(level, now + 0.002);
    clickEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.042);

    osc.connect(clickEnv);
    clickEnv.connect(this.cueBusGain);

    osc.start(now);
    osc.stop(now + 0.045);
  }

  private TriggerGuideCue(cueText: string, playChime: boolean) {
    if (!this.project || !this.project.guideCuesEnabled) return;

    // 1. Audible Studio Guide Chime on the Cue Bus (always works 100% deterministically in Web Audio)
    if (playChime && this.ctx && this.cueBusGain) {
      const now = this.ctx.currentTime;
      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const env = this.ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'triangle';
      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.setValueAtTime(880.0, now + 0.07); // A5
      osc2.frequency.setValueAtTime(293.66, now);

      const level = this.project.guideGain * 0.25;
      env.gain.setValueAtTime(0.0001, now);
      env.gain.linearRampToValueAtTime(level, now + 0.01);
      env.gain.exponentialRampToValueAtTime(0.0001, now + 0.19);

      osc1.connect(env);
      osc2.connect(env);
      env.connect(this.cueBusGain);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.2);
      osc2.stop(now + 0.2);
    }

    // 2. Spoken Voice Guide Cue (if enabled and SpeechSynthesis is available)
    if (this.project.guideVoiceReadout && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(cueText);
        utter.rate = 1.25;
        utter.pitch = 1.0;
        utter.volume = Math.min(1, this.project.guideGain);
        window.speechSynthesis.speak(utter);
      } catch {
        // Ignore speech synthesis restrictions
      }
    }
  }

  public getTransportState(): TransportState {
    const songSec = this.getCurrentSongSec();
    const { currentBar, currentBeat, beatProgress, totalBeatsElapsed } =
      this.getMusicalPosition(songSec);

    let countdownBeats = 0;
    if (this.queuedTargetBar !== null && this.project) {
      const targetTotalBeats = (this.queuedTargetBar - 1) * this.project.beatsPerBar;
      countdownBeats = Math.max(1, Math.ceil(targetTotalBeats - totalBeatsElapsed));
    }

    return {
      isPlaying: this.isPlaying,
      currentTimeSec: songSec,
      currentBar,
      currentBeat,
      beatProgress,
      activeSectionId: this.activeSectionId,
      queuedSectionId: this.queuedSectionId,
      queuedTargetBar: this.queuedTargetBar,
      countdownBeats,
      isVamping: this.isVamping,
      lastCueMessage: this.lastCueMessage,
    };
  }

  public getTrackMeters(): {
    tracks: Record<string, TrackMeterReading>;
    master: TrackMeterReading;
  } {
    const tracks: Record<string, TrackMeterReading> = {};

    this.trackNodes.forEach((node, trackId) => {
      if (!this.isPlaying) {
        tracks[trackId] = { rms: 0, peak: 0, clipping: false };
        return;
      }
      node.analyser.getFloatTimeDomainData(node.timeDomainData);
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < node.timeDomainData.length; i++) {
        const v = Math.abs(node.timeDomainData[i]);
        sumSq += v * v;
        if (v > peak) peak = v;
      }
      const rms = Math.sqrt(sumSq / node.timeDomainData.length);
      tracks[trackId] = {
        rms: Math.min(1, rms * 1.8),
        peak: Math.min(1, peak),
        clipping: peak >= 0.98,
      };
    });

    let masterReading: TrackMeterReading = { rms: 0, peak: 0, clipping: false };
    if (this.isPlaying && this.masterAnalyser) {
      this.masterAnalyser.getFloatTimeDomainData(this.masterTimeData);
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < this.masterTimeData.length; i++) {
        const v = Math.abs(this.masterTimeData[i]);
        sumSq += v * v;
        if (v > peak) peak = v;
      }
      const rms = Math.sqrt(sumSq / this.masterTimeData.length);
      masterReading = {
        rms: Math.min(1, rms * 1.8),
        peak: Math.min(1, peak),
        clipping: peak >= 0.99,
      };
    }

    return { tracks, master: masterReading };
  }
}

export const audioEngine = new LibreTracksAudioEngine();
