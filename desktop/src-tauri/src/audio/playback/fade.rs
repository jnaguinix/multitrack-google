pub const FADE_MS: f32 = 8.0;

/// Envelope for applying micro-fades only when starting/stopping/seeking,
/// ensuring that contiguous blocks ALWAYS receive 1.0 gain (no dips).
#[derive(Debug, Clone)]
pub struct FadeEnvelope {
    pub fade_type: FadeType,
    pub fade_frames: usize,
    pub current_frame: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FadeType {
    None,
    FadeIn,
    FadeOut,
}

impl FadeEnvelope {
    pub fn new(fade_ms: f32, sample_rate: u32) -> Self {
        let fade_frames = ((fade_ms / 1000.0) * sample_rate as f32).round().max(1.0) as usize;
        Self {
            fade_type: FadeType::None,
            fade_frames,
            current_frame: 0,
        }
    }

    pub fn start_fade_in(&mut self) {
        self.fade_type = FadeType::FadeIn;
        self.current_frame = 0;
    }

    pub fn start_fade_out(&mut self) {
        self.fade_type = FadeType::FadeOut;
        self.current_frame = 0;
    }

    pub fn is_fading_out(&self) -> bool {
        self.fade_type == FadeType::FadeOut
    }

    pub fn is_fade_out_complete(&self) -> bool {
        self.fade_type == FadeType::FadeOut && self.current_frame >= self.fade_frames
    }

    /// Advances one frame and returns the gain multiplier.
    /// In normal continuous playback (FadeType::None), this returns EXACTLY 1.0.
    pub fn next_gain(&mut self) -> f32 {
        match self.fade_type {
            FadeType::None => 1.0,
            FadeType::FadeIn => {
                let g = (self.current_frame as f32 / self.fade_frames as f32).min(1.0);
                self.current_frame += 1;
                if self.current_frame >= self.fade_frames {
                    self.fade_type = FadeType::None;
                }
                g
            }
            FadeType::FadeOut => {
                let g = (1.0 - (self.current_frame as f32 / self.fade_frames as f32)).max(0.0);
                self.current_frame += 1;
                g
            }
        }
    }
}
