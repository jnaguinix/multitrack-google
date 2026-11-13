use super::NativeSongSection;

pub struct GuideCueEngine {
    pub enabled: bool,
    pub gain: f32, // default 1.0 (level = guide_gain * 0.25)
    pub active_chime_sample: Option<usize>, // current progress in samples (0..total_chime_samples)
    pub last_announced_section_id: Option<String>,
}

impl GuideCueEngine {
    pub fn new() -> Self {
        Self {
            enabled: true,
            gain: 1.0,
            active_chime_sample: None,
            last_announced_section_id: None,
        }
    }

    pub fn trigger_chime(&mut self) {
        self.active_chime_sample = Some(0);
    }

    pub fn render_block(
        &mut self,
        cur_song_frame: u64,
        frames: usize,
        sample_rate: u32,
        sections: &[NativeSongSection],
        out: &mut [f32],
    ) {
        out.fill(0.0);
        if !self.enabled {
            return;
        }

        let sr = sample_rate as f32;
        let cur_sec = cur_song_frame as f64 / sr as f64;

        // Check if an upcoming section starts within 2.0s
        for sec in sections {
            if sec.start_sec > cur_sec && (sec.start_sec - cur_sec) <= 2.0 {
                if self.last_announced_section_id.as_deref() != Some(&sec.id) {
                    self.last_announced_section_id = Some(sec.id.clone());
                    self.trigger_chime();
                }
                break;
            }
        }

        if let Some(mut sample_idx) = self.active_chime_sample {
            let total_dur_sec = 0.19f32;
            let total_samples = (total_dur_sec * sr) as usize;
            let split_sample = (0.07f32 * sr) as usize;
            let attack_samples = (0.01f32 * sr) as usize;
            let level = (self.gain * 0.25).clamp(0.0, 1.0);

            for f in 0..frames {
                if sample_idx >= total_samples {
                    self.active_chime_sample = None;
                    break;
                }

                let t = sample_idx as f32 / sr;
                // osc1: 587.33 Hz first 0.07s, 880 Hz afterwards
                let freq1 = if sample_idx < split_sample { 587.33f32 } else { 880.0f32 };
                let phase1 = 2.0 * std::f32::consts::PI * freq1 * t;
                let s_osc1 = phase1.sin();

                // osc2: 293.66 Hz triangle wave
                let freq2 = 293.66f32;
                let phase2 = (freq2 * t).fract();
                let s_osc2 = 2.0 * (2.0 * phase2 - 1.0).abs() - 1.0;

                // Envelope: linear ramp 0..0.01s to level, exponential ramp 0.01..0.19s
                let env = if sample_idx < attack_samples {
                    (sample_idx as f32 / attack_samples as f32) * level
                } else {
                    let decay_prog = (sample_idx - attack_samples) as f32 / (total_samples - attack_samples) as f32;
                    level * (-3.0 * decay_prog).exp()
                };

                out[f] = (s_osc1 * 0.7 + s_osc2 * 0.3) * env;
                sample_idx += 1;
            }

            if self.active_chime_sample.is_some() {
                self.active_chime_sample = Some(sample_idx);
            }
        }
    }
}
