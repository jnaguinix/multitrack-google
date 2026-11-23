use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

/// Envoltorio del remuestreador `SincFixedIn` de rubato (conversión de frecuencia de muestreo) que informa su retardo.
///
/// El tono NO se cambia aquí: variar la relación de remuestreo acelera o frena la canción (como un disco de vinilo).
/// El cambio de tono sin tocar la velocidad lo hace `pitch::PitchShifter`.
pub struct TrackResampler {
    resampler: SincFixedIn<f32>,
    pub chunk_size: usize,
    output_delay_frames: usize,
    /// Relación salida/entrada: frecuencia de destino / frecuencia de origen.
    ratio: f64,
}

impl TrackResampler {
    pub fn new(
        source_rate: u32,
        target_rate: u32,
        chunk_size: usize,
        channels: usize,
    ) -> Result<Self, String> {
        let ratio = target_rate as f64 / source_rate as f64;
        // La relación no cambia nunca después de crear el remuestreador.
        let max_resample_ratio_relative = 1.0;

        let params = SincInterpolationParameters {
            sinc_len: 64,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 128,
            window: WindowFunction::BlackmanHarris2,
        };

        let resampler = SincFixedIn::<f32>::new(
            ratio,
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
            output_delay_frames,
            ratio,
        })
    }

    /// Relación salida/entrada: fotogramas de salida por cada fotograma de entrada.
    pub fn resample_ratio(&self) -> f64 {
        self.ratio
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
