use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

/// Wrapper around rubato's SincFixedIn resampler with group delay reporting and delay compensation.
pub struct TrackResampler {
    resampler: SincFixedIn<f32>,
    pub chunk_size: usize,
    channels: usize,
    output_delay_frames: usize,
}

impl TrackResampler {
    pub fn new(
        source_rate: u32,
        target_rate: u32,
        pitch_semitones: i32,
        chunk_size: usize,
        channels: usize,
    ) -> Result<Self, String> {
        let pitch_ratio = 2.0f64.powf(pitch_semitones as f64 / 12.0);
        let resample_ratio = (target_rate as f64 / source_rate as f64) * pitch_ratio;

        let params = SincInterpolationParameters {
            sinc_len: 64,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128,
            window: WindowFunction::BlackmanHarris2,
        };

        // Allow up to +/- 12 semitones variation (ratio 0.5 to 2.0)
        let max_resample_ratio_relative = 2.5;

        let resampler = SincFixedIn::<f32>::new(
            resample_ratio,
            max_resample_ratio_relative,
            params,
            chunk_size,
            channels,
        )
        .map_err(|e| format!("Error creando resampler rubato: {e}"))?;

        let output_delay_frames = resampler.output_delay();

        Ok(Self {
            resampler,
            chunk_size,
            channels,
            output_delay_frames,
        })
    }

    pub fn output_delay(&self) -> usize {
        self.output_delay_frames
    }

    pub fn input_frames_next(&self) -> usize {
        self.resampler.input_frames_next()
    }

    pub fn nbr_channels(&self) -> usize {
        self.channels
    }

    /// Resamples a chunk of multi-channel audio data.
    /// input: Vec of channels, where each channel has `input_frames_next()` samples.
    pub fn process(
        &mut self,
        input: &[Vec<f32>],
    ) -> Result<Vec<Vec<f32>>, String> {
        self.resampler
            .process(input, None)
            .map_err(|e| format!("Error en rubato::process: {e}"))
    }

    pub fn reset(&mut self) {
        self.resampler.reset();
    }
}
