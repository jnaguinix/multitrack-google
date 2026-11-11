use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

/// Wrapper around rubato's SincFixedIn resampler with dynamic ratio adjustment and delay reporting.
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
        initial_pitch_semitones: i32,
        chunk_size: usize,
        channels: usize,
    ) -> Result<Self, String> {
        let base_ratio = target_rate as f64 / source_rate as f64;
        let max_resample_ratio_relative = 2.5;

        let params = SincInterpolationParameters {
            sinc_len: 64,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128,
            window: WindowFunction::BlackmanHarris2,
        };

        let mut resampler = SincFixedIn::<f32>::new(
            base_ratio,
            max_resample_ratio_relative,
            params,
            chunk_size,
            channels,
        )
        .map_err(|e| format!("Error creando resampler rubato: {e}"))?;

        if initial_pitch_semitones != 0 {
            let pitch_factor = 2.0f64.powf(-(initial_pitch_semitones as f64) / 12.0);
            resampler
                .set_resample_ratio(base_ratio * pitch_factor, false)
                .map_err(|e| format!("Error estableciendo tono inicial: {e}"))?;
        }

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

    pub fn output_frames_max(&self) -> usize {
        self.resampler.output_frames_max()
    }

    pub fn nbr_channels(&self) -> usize {
        self.channels
    }

    /// Update pitch in semitones (-12 to +12) in real time with smooth ramping across the next chunk.
    pub fn set_pitch(&mut self, semitones: i32, ramp: bool) -> Result<(), String> {
        let pitch_factor = 2.0f64.powf(-(semitones as f64) / 12.0);
        self.resampler
            .set_resample_ratio_relative(pitch_factor, ramp)
            .map_err(|e| format!("Error cambiando ratio relativo en rubato: {e}"))
    }

    /// Resamples a chunk of multi-channel audio data.
    /// input: Slice of channels, where each channel has `input_frames_next()` samples.
    pub fn process<V: AsRef<[f32]>>(
        &mut self,
        input: &[V],
    ) -> Result<Vec<Vec<f32>>, String> {
        self.resampler
            .process(input, None)
            .map_err(|e| format!("Error en rubato::process: {e}"))
    }

    /// Flushes final frames at the end of a track.
    pub fn process_partial<V: AsRef<[f32]>>(
        &mut self,
        input: Option<&[V]>,
    ) -> Result<Vec<Vec<f32>>, String> {
        self.resampler
            .process_partial(input, None)
            .map_err(|e| format!("Error en rubato::process_partial: {e}"))
    }

    pub fn reset(&mut self) {
        self.resampler.reset();
    }
}
