use std::f32::consts::PI;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetronomeConfig {
    pub enabled: bool,
    pub bpm: f32,
    pub beats_per_bar: u32,
    pub subdivision: u32, // 1 = quarter note, 2 = eighth note
    pub gain: f32,        // 0.0 to 2.0
    pub split_mono: bool,
}

impl Default for MetronomeConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            bpm: 120.0,
            beats_per_bar: 4,
            subdivision: 1,
            gain: 0.8,
            split_mono: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActiveClickPulse {
    pub is_downbeat: bool,
    pub is_quarter: bool,
    pub start_delay_frames: usize,
    pub current_sample: usize,
    pub total_samples: usize,
    pub phase: f32,
    pub f0: f32,
    pub f1: f32,
    pub peak_gain: f32,
    pub attack_samples: usize,
    pub decay_k: f32,
}

impl ActiveClickPulse {
    pub fn new(is_downbeat: bool, is_quarter: bool, gain: f32, sample_rate: u32) -> Self {
        Self::new_with_delay(is_downbeat, is_quarter, gain, sample_rate, 0)
    }

    pub fn new_with_delay(
        is_downbeat: bool,
        is_quarter: bool,
        gain: f32,
        sample_rate: u32,
        start_delay_frames: usize,
    ) -> Self {
        let sr = sample_rate as f32;
        let total_samples = (0.045 * sr).round() as usize; // 45 ms
        let attack_samples = (0.002 * sr).round().max(1.0) as usize; // 2 ms
        let decay_time = 0.040f32; // 40 ms decay to silence
        let decay_k = (10000.0f32).ln() / decay_time; // exponential rate

        let (f0, f1, level_factor) = if is_downbeat {
            (1680.0, 820.0, 0.55)
        } else if is_quarter {
            (1120.0, 540.0, 0.36)
        } else {
            (840.0, 540.0, 0.18)
        };

        Self {
            is_downbeat,
            is_quarter,
            start_delay_frames,
            current_sample: 0,
            total_samples,
            phase: 0.0,
            f0,
            f1,
            peak_gain: gain * level_factor,
            attack_samples,
            decay_k,
        }
    }

    pub fn next_sample(&mut self, sample_rate: u32) -> Option<f32> {
        if self.start_delay_frames > 0 {
            self.start_delay_frames -= 1;
            return Some(0.0);
        }

        if self.current_sample >= self.total_samples {
            return None;
        }

        let sr = sample_rate as f32;
        let t = self.current_sample as f32 / sr;

        // Frequency sweep over first 35 ms
        let freq = if t < 0.035 {
            let sweep_progress = t / 0.035;
            self.f0 * (self.f1 / self.f0).powf(sweep_progress)
        } else {
            self.f1
        };

        // Phase accumulation
        let delta_phase = 2.0 * PI * freq / sr;
        self.phase = (self.phase + delta_phase) % (2.0 * PI);

        // Oscillator shape
        let osc = if self.is_downbeat {
            // Triangle wave
            let theta = self.phase / (2.0 * PI);
            if theta < 0.25 {
                4.0 * theta
            } else if theta < 0.75 {
                2.0 - 4.0 * theta
            } else {
                4.0 * theta - 4.0
            }
        } else {
            // Sine wave
            self.phase.sin()
        };

        // Envelope
        let env = if self.current_sample < self.attack_samples {
            self.peak_gain * (self.current_sample as f32 / self.attack_samples as f32)
        } else {
            let decay_t = (self.current_sample - self.attack_samples) as f32 / sr;
            self.peak_gain * (-self.decay_k * decay_t).exp()
        };

        self.current_sample += 1;
        Some(osc * env)
    }
}

pub struct MetronomeEngine {
    pub config: MetronomeConfig,
    active_pulses: Vec<ActiveClickPulse>,
    last_substep: i64,
}

impl MetronomeEngine {
    pub fn new(config: MetronomeConfig) -> Self {
        Self {
            config,
            active_pulses: Vec::new(),
            last_substep: -1,
        }
    }

    pub fn reset(&mut self) {
        self.active_pulses.clear();
        self.last_substep = -1;
    }

    pub fn seek_to_frame(&mut self, song_frame: u64, sample_rate: u32) {
        self.active_pulses.clear();
        let bpm = self.config.bpm.max(10.0);
        let subdiv = self.config.subdivision.max(1);
        let sec_per_substep = 60.0 / (bpm * subdiv as f32);
        let frames_per_substep = (sec_per_substep * sample_rate as f32).max(1.0);
        let cur_substep = song_frame as f64 / frames_per_substep as f64;
        let substep_index = cur_substep.floor() as i64;
        let substep_frame = (substep_index as f64 * frames_per_substep as f64).round() as u64;
        if song_frame <= substep_frame {
            self.last_substep = substep_index - 1;
        } else {
            self.last_substep = substep_index;
        }
    }

    /// Renders click into a buffer of `frames` length, given current start and end song frames.
    /// This handles varispeed automatically because start_song_frame and end_song_frame advance
    /// according to the varispeed playback rate.
    pub fn render_block(
        &mut self,
        start_song_frame: u64,
        end_song_frame: u64,
        frames: usize,
        sample_rate: u32,
        output_click: &mut [f32],
    ) {
        output_click[..frames].fill(0.0);
        if !self.config.enabled || frames == 0 {
            return;
        }

        let bpm = self.config.bpm.max(10.0);
        let subdiv = self.config.subdivision.max(1);
        let bpb = self.config.beats_per_bar.max(1);
        let sec_per_substep = 60.0 / (bpm * subdiv as f32);
        let frames_per_substep = (sec_per_substep * sample_rate as f32).max(1.0);

        let song_frames_span = (end_song_frame as f64 - start_song_frame as f64).max(1.0);

        // Cada bloque cubre el intervalo de frames [inicio, fin). Un pulso que cae exactamente en `fin`
        // pertenece al bloque siguiente, así que NO se da por procesado aquí: `last_substep` solo avanza
        // hasta el último pulso realmente tratado. (Antes se marcaba como procesado el pulso del borde y
        // se perdía; a 120 BPM y 48 kHz todos los pulsos caen en múltiplos de 24 000 frames, o sea, en el
        // borde de bloques de 480 frames.)
        let frame_of = |substep: i64| (substep as f64 * frames_per_substep as f64).round() as i64;
        // Si el metrónomo quedó muy atrás (p. ej. tras un salto de posición sin reposicionarlo), se salta
        // directamente a los pulsos cercanos en vez de recorrer miles de subpasos dentro del callback.
        let first_candidate = (start_song_frame as f64 / frames_per_substep as f64).floor() as i64;
        let mut s = (self.last_substep + 1).max(first_candidate);
        loop {
            let pulse_song_frame = frame_of(s);
            if pulse_song_frame >= end_song_frame as i64 {
                break;
            }
            if pulse_song_frame >= start_song_frame as i64 {
                let frac = (pulse_song_frame - start_song_frame as i64) as f64 / song_frames_span;
                let offset = (frac * frames as f64).round() as usize;
                let offset = offset.min(frames.saturating_sub(1));

                let is_main_beat = (s % subdiv as i64) == 0;
                let beat_in_bar = ((s / subdiv as i64).rem_euclid(bpb as i64)) + 1;
                let is_downbeat = is_main_beat && (beat_in_bar == 1);
                let is_quarter = is_main_beat;

                let pulse = ActiveClickPulse::new_with_delay(
                    is_downbeat,
                    is_quarter,
                    self.config.gain,
                    sample_rate,
                    offset,
                );
                self.active_pulses.push(pulse);
            }
            self.last_substep = s;
            s += 1;
        }

        // Accumulate active pulses
        for f in 0..frames {
            let mut sample_sum = 0.0f32;
            for pulse in &mut self.active_pulses {
                if let Some(s) = pulse.next_sample(sample_rate) {
                    sample_sum += s;
                }
            }
            output_click[f] = sample_sum;
        }

        // Clean up finished pulses
        self.active_pulses.retain(|p| p.current_sample < p.total_samples);
    }
}
