import { SongProject, SongSection, TrackChannel } from '../types/project';

/**
 * Extracts normalized peak envelope values from an AudioBuffer for fast, crisp canvas rendering.
 */
export function extractWaveformPeaks(buffer: AudioBuffer, numBuckets = 320): number[] {
  const channelData = buffer.getChannelData(0);
  const totalSamples = channelData.length;
  const samplesPerBucket = Math.max(1, Math.floor(totalSamples / numBuckets));
  const peaks: number[] = [];

  for (let i = 0; i < numBuckets; i++) {
    const start = i * samplesPerBucket;
    const end = Math.min(totalSamples, start + samplesPerBucket);
    let maxAbs = 0;
    // Step by 8 samples for speed on long stems
    const step = Math.max(1, Math.floor((end - start) / 64));
    for (let j = start; j < end; j += step) {
      const val = Math.abs(channelData[j]);
      if (val > maxAbs) maxAbs = val;
    }
    peaks.push(Math.min(1, Number(maxAbs.toFixed(3))));
  }

  return peaks;
}

function findSectionForBar(sections: SongSection[], bar: number): SongSection | undefined {
  return sections.find((s) => bar >= s.startBar && bar < s.startBar + s.lengthBars);
}

/**
 * Generates realistic, musically synchronized multitrack AudioBuffers for demo songs
 * so users can immediately test playback, beat-quantized section jumping, vamping,
 * solo/mute, and waveform scrubbing out of the box.
 */
export function synthesizeDemoTrackBuffer(
  ctx: BaseAudioContext,
  project: SongProject,
  track: TrackChannel
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const secondsPerBeat = 60 / project.bpm;
  const secondsPerBar = secondsPerBeat * project.beatsPerBar;
  const totalDuration = Math.max(4, project.totalBars * secondsPerBar);
  const totalFrames = Math.ceil(totalDuration * sampleRate);

  const buffer = ctx.createBuffer(2, totalFrames, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  const isMinor = project.keySignature.toLowerCase().includes('minor');
  // Root frequencies: C minor (C3 = 130.81Hz) or G major (G2 = 98.00Hz)
  const rootFreq = isMinor ? 130.81 : 98.0;

  // Chord progression ratios per bar within a 4-bar section
  // Minor: i - VI - III - VII | Major: I - V - vi - IV
  const chordRoots = isMinor
    ? [1.0, 0.8, 1.2, 0.9] // Cm - Ab - Eb - Bb approx harmonic ratios
    : [1.0, 1.5, 1.6818, 1.3348]; // G - D - Em - C

  for (let bar = 1; bar <= project.totalBars; bar++) {
    const sec = findSectionForBar(project.sections, bar);
    const sectionIndex = sec ? project.sections.indexOf(sec) : 0;
    // Intensity factor based on section name/position
    const isIntro = sec?.code === 'IN';
    const isChorus = sec?.code === 'CH' || sec?.code === 'C2';
    const isBridge = sec?.code === 'BR' || sec?.code === 'VP';
    const isOutro = sec?.code === 'OU';

    const energy = isChorus ? 1.0 : isBridge ? 0.85 : isIntro ? 0.45 : isOutro ? 0.55 : 0.72;
    const barZero = bar - 1;
    const barStartSec = barZero * secondsPerBar;
    const chordRatio = chordRoots[barZero % chordRoots.length];
    const barBaseFreq = rootFreq * chordRatio;

    if (track.role === 'drums') {
      for (let beat = 0; beat < project.beatsPerBar; beat++) {
        const beatSec = barStartSec + beat * secondsPerBeat;

        // Kick on beats 0 and 2 (plus syncopation in chorus)
        const triggerKick =
          beat === 0 ||
          (beat === 2 && !isIntro) ||
          (isChorus && beat === 1);
        if (triggerKick) {
          renderKick(left, right, sampleRate, beatSec, 0.85 * energy);
        }
        if (isChorus && beat === 2) {
          renderKick(left, right, sampleRate, beatSec + secondsPerBeat * 0.5, 0.65 * energy);
        }

        // Snare on beats 1 and 3
        if ((beat === 1 || beat === 3) && (!isIntro || bar > 2)) {
          renderSnare(left, right, sampleRate, beatSec, 0.75 * energy);
        }

        // Hi-hats on 8th notes
        const subdiv = isChorus || isBridge ? 4 : 2;
        for (let sub = 0; sub < subdiv; sub++) {
          const hatSec = beatSec + ( sub / subdiv ) * secondsPerBeat;
          const hatGain = (sub === 0 ? 0.35 : 0.18) * energy;
          renderHiHat(left, right, sampleRate, hatSec, hatGain);
        }
      }
    } else if (track.role === 'perc') {
      // 16th-note shaker groove
      const steps = project.beatsPerBar * 4;
      for (let step = 0; step < steps; step++) {
        const stepSec = barStartSec + (step / 4) * secondsPerBeat;
        const accent = step % 4 === 0 ? 0.42 : step % 2 === 0 ? 0.26 : 0.15;
        renderHiHat(left, right, sampleRate, stepSec, accent * energy, true);
      }
    } else if (track.role === 'bass') {
      if (isIntro && bar <= 2) continue;
      // 8th-note pulsing synth/sub bass
      const notesPerBar = project.beatsPerBar * 2;
      const noteDur = secondsPerBar / notesPerBar;
      for (let n = 0; n < notesPerBar; n++) {
        const noteStart = barStartSec + n * noteDur;
        const octaveJump = isChorus && n % 2 === 1 ? 2.0 : 1.0;
        renderBassNote(
          left,
          right,
          sampleRate,
          noteStart,
          noteDur * 0.88,
          (barBaseFreq * 0.5) * octaveJump,
          0.72 * energy
        );
      }
    } else if (track.role === 'keys') {
      // Sustained warm electric piano / analog chord stabs
      const thirdRatio = isMinor ? 1.1892 : 1.2599;
      const fifthRatio = 1.4983;
      const octaveRatio = 2.0;
      const chordFreqs = [
        barBaseFreq * 2,
        barBaseFreq * 2 * thirdRatio,
        barBaseFreq * 2 * fifthRatio,
        barBaseFreq * 2 * octaveRatio,
      ];
      const hits = isChorus ? 2 : 1;
      for (let h = 0; h < hits; h++) {
        const startSec = barStartSec + h * (secondsPerBar / hits);
        const durSec = (secondsPerBar / hits) * 0.94;
        renderChordPad(left, right, sampleRate, startSec, durSec, chordFreqs, 0.55 * energy, false);
      }
    } else if (track.role === 'guitar') {
      // Dotted 8th / 16th arpeggiated delay guitar plucks
      const thirdRatio = isMinor ? 1.1892 : 1.2599;
      const fifthRatio = 1.4983;
      const arpScale = [
        barBaseFreq * 2,
        barBaseFreq * 2 * fifthRatio,
        barBaseFreq * 4,
        barBaseFreq * 2 * thirdRatio,
      ];
      const totalPlucks = project.beatsPerBar * 2;
      const pluckSpacing = secondsPerBar / totalPlucks;
      for (let p = 0; p < totalPlucks; p++) {
        const noteFreq = arpScale[(p + sectionIndex) % arpScale.length];
        const pluckStart = barStartSec + p * pluckSpacing;
        renderGuitarPluck(left, right, sampleRate, pluckStart, pluckSpacing * 1.4, noteFreq, 0.58 * energy);
      }
    } else {
      // Shimmer pad / ambient strings
      const fifthRatio = 1.4983;
      const ninthRatio = 2.2449;
      const padFreqs = [
        barBaseFreq * 2,
        barBaseFreq * 2 * fifthRatio,
        barBaseFreq * 2 * ninthRatio,
      ];
      renderChordPad(left, right, sampleRate, barStartSec, secondsPerBar, padFreqs, 0.48 * energy, true);
    }
  }

  return buffer;
}

function renderKick(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  startSec: number,
  gain: number
) {
  const dur = 0.22;
  const startFrame = Math.floor(startSec * sampleRate);
  const length = Math.floor(dur * sampleRate);
  let phase = 0;

  for (let i = 0; i < length; i++) {
    const idx = startFrame + i;
    if (idx >= left.length) break;
    const t = i / sampleRate;
    const freq = 48 + 115 * Math.exp(-t * 32);
    phase += (2 * Math.PI * freq) / sampleRate;
    const env = Math.exp(-t * 14);
    const sample = Math.sin(phase) * env * gain;
    left[idx] = Math.max(-0.98, Math.min(0.98, left[idx] + sample));
    right[idx] = Math.max(-0.98, Math.min(0.98, right[idx] + sample));
  }
}

function renderSnare(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  startSec: number,
  gain: number
) {
  const dur = 0.18;
  const startFrame = Math.floor(startSec * sampleRate);
  const length = Math.floor(dur * sampleRate);

  for (let i = 0; i < length; i++) {
    const idx = startFrame + i;
    if (idx >= left.length) break;
    const t = i / sampleRate;
    const body = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 24);
    // Deterministic pseudo-noise from index for consistent waveform rendering
    const noise = (Math.sin(idx * 12.9898) * 43758.5453 % 1) * 2 - 1;
    const snap = noise * Math.exp(-t * 19);
    const sample = (body * 0.45 + snap * 0.55) * gain;
    left[idx] = Math.max(-0.98, Math.min(0.98, left[idx] + sample));
    right[idx] = Math.max(-0.98, Math.min(0.98, right[idx] + sample * 0.96));
  }
}

function renderHiHat(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  startSec: number,
  gain: number,
  isShaker = false
) {
  const dur = isShaker ? 0.085 : 0.055;
  const startFrame = Math.floor(startSec * sampleRate);
  const length = Math.floor(dur * sampleRate);

  for (let i = 0; i < length; i++) {
    const idx = startFrame + i;
    if (idx >= left.length) break;
    const t = i / sampleRate;
    const env = isShaker
      ? Math.sin((t / dur) * Math.PI) * Math.exp(-t * 22)
      : Math.exp(-t * 50);
    const highMetallic =
      Math.sin(2 * Math.PI * 6420 * t) * 0.4 +
      Math.sin(2 * Math.PI * 9130 * t) * 0.35 +
      ((Math.sin(idx * 78.233) * 43758.5453) % 1) * 0.5;
    const sample = highMetallic * env * gain;
    left[idx] = Math.max(-0.98, Math.min(0.98, left[idx] + sample * 0.9));
    right[idx] = Math.max(-0.98, Math.min(0.98, right[idx] + sample * 1.05));
  }
}

function renderBassNote(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  startSec: number,
  durSec: number,
  freq: number,
  gain: number
) {
  const startFrame = Math.floor(startSec * sampleRate);
  const length = Math.floor(durSec * sampleRate);

  for (let i = 0; i < length; i++) {
    const idx = startFrame + i;
    if (idx >= left.length) break;
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.012);
    const release = Math.exp(-t * 4.5);
    const fundamental = Math.sin(2 * Math.PI * freq * t);
    const harmonic = Math.sin(2 * Math.PI * freq * 2 * t) * 0.35 * Math.exp(-t * 9);
    const sub = Math.tanh((fundamental + harmonic) * 1.4) * attack * release * gain;
    left[idx] = Math.max(-0.98, Math.min(0.98, left[idx] + sub));
    right[idx] = Math.max(-0.98, Math.min(0.98, right[idx] + sub));
  }
}

function renderChordPad(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  startSec: number,
  durSec: number,
  freqs: number[],
  gain: number,
  slowAttack: boolean
) {
  const startFrame = Math.floor(startSec * sampleRate);
  const length = Math.floor(durSec * sampleRate);
  const attackTime = slowAttack ? Math.min(0.35, durSec * 0.3) : 0.025;

  for (let i = 0; i < length; i++) {
    const idx = startFrame + i;
    if (idx >= left.length) break;
    const t = i / sampleRate;
    const attack = Math.min(1, t / attackTime);
    const release = slowAttack
      ? Math.sin(Math.min(1, t / durSec) * Math.PI)
      : Math.exp(-t * 1.6);

    let sumL = 0;
    let sumR = 0;
    for (let fIdx = 0; fIdx < freqs.length; fIdx++) {
      const f = freqs[fIdx];
      const chorusL = Math.sin(2 * Math.PI * (f * 1.002) * t);
      const chorusR = Math.sin(2 * Math.PI * (f * 0.998) * t);
      sumL += chorusL;
      sumR += chorusR;
    }
    const norm = gain / Math.max(1, freqs.length);
    left[idx] = Math.max(-0.98, Math.min(0.98, left[idx] + sumL * attack * release * norm));
    right[idx] = Math.max(-0.98, Math.min(0.98, right[idx] + sumR * attack * release * norm));
  }
}

function renderGuitarPluck(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  startSec: number,
  durSec: number,
  freq: number,
  gain: number
) {
  const startFrame = Math.floor(startSec * sampleRate);
  const length = Math.floor(durSec * sampleRate);

  for (let i = 0; i < length; i++) {
    const idx = startFrame + i;
    if (idx >= left.length) break;
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.006);
    const env = attack * Math.exp(-t * 6.5);
    const sig =
      (Math.sin(2 * Math.PI * freq * t) +
        0.45 * Math.sin(2 * Math.PI * freq * 2 * t) * Math.exp(-t * 12) +
        0.2 * Math.sin(2 * Math.PI * freq * 3 * t) * Math.exp(-t * 18)) *
      env *
      gain;
    left[idx] = Math.max(-0.98, Math.min(0.98, left[idx] + sig * 0.85));
    right[idx] = Math.max(-0.98, Math.min(0.98, right[idx] + sig * 1.0));
  }
}
