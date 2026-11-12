use super::cache::{
    delete_track_cache, extract_waveform_peaks, is_effectively_mono,
    read_track_metadata, should_reconvert_track, write_track_pcm_and_metadata,
    CACHE_FORMAT_VERSION,
};
pub use super::cache::{ImportProgressEvent, ProjectCacheStatus, TrackPcmMetadata};
use rubato::{FftFixedInOut, Resampler};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTrackFile {
    pub file_path: String,
    pub track_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub tracks: Vec<TrackPcmMetadata>,
    pub errors: Vec<String>,
}

/// Fases por las que pasa cada pista durante la generación de la caché. Cada una cuenta como una
/// «unidad» de progreso, así el porcentaje avanza 4 veces por pista en vez de saltar por pista.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportPhase {
    Decoded,
    Resampled,
    Quantized,
    Written,
}

impl ImportPhase {
    pub const ALL: [ImportPhase; 4] = [
        ImportPhase::Decoded,
        ImportPhase::Resampled,
        ImportPhase::Quantized,
        ImportPhase::Written,
    ];
}

/// Contador de progreso compartido entre los hilos de importación (sin dependencias de Tauri).
/// El porcentaje nunca llega a 100: ese valor lo marca el evento final de «completado».
pub struct ImportProgressTracker {
    total_units: usize,
    units: std::sync::atomic::AtomicUsize,
    finished_tracks: std::sync::atomic::AtomicUsize,
}

impl ImportProgressTracker {
    pub const UNITS_PER_TRACK: usize = ImportPhase::ALL.len();
    /// Tope mientras queden pistas por terminar.
    pub const MAX_PERCENT_BEFORE_DONE: f32 = 99.0;

    pub fn new(total_tracks: usize) -> Self {
        Self {
            total_units: total_tracks * Self::UNITS_PER_TRACK,
            units: std::sync::atomic::AtomicUsize::new(0),
            finished_tracks: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Registra una fase terminada. Devuelve `(porcentaje, pistas_terminadas)` tras contarla.
    pub fn advance(&self, phase: ImportPhase) -> (f32, usize) {
        let units = self.units.fetch_add(1, Ordering::SeqCst) + 1;
        let finished = if phase == ImportPhase::Written {
            self.finished_tracks.fetch_add(1, Ordering::SeqCst) + 1
        } else {
            self.finished_tracks.load(Ordering::SeqCst)
        };
        let percent = if self.total_units == 0 {
            0.0
        } else {
            (units as f32 / self.total_units as f32 * 100.0).min(Self::MAX_PERCENT_BEFORE_DONE)
        };
        (percent, finished)
    }
}

/// Fast pseudo-random number generator for TPDF dither (xorshift64star).
pub struct TpdfDitherRng(u64);

impl TpdfDitherRng {
    pub fn new(seed: u64) -> Self {
        Self(if seed == 0 { 0x9e3779b97f4a7c15 } else { seed })
    }

    #[inline]
    fn next_u32(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
        (self.0 >> 32) as u32
    }

    #[inline]
    fn next_f32(&mut self) -> f32 {
        (self.next_u32() as f32) / (u32::MAX as f32)
    }

    /// Generates Triangular Probability Density Function (TPDF) dither noise
    /// in the range (-1.0, 1.0) LSB for 16-bit PCM quantization (-96 dBFS noise floor).
    #[inline]
    pub fn dither_16(&mut self) -> f32 {
        (self.next_f32() - self.next_f32()) / 32768.0
    }
}

#[inline]
pub fn quantize_f32_to_i16_with_dither(sample: f32, rng: &mut TpdfDitherRng) -> i16 {
    let dithered = sample + rng.dither_16();
    let clamped = dithered.clamp(-1.0, 1.0);
    if clamped >= 1.0 {
        32767
    } else if clamped <= -1.0 {
        -32768
    } else {
        (clamped * 32767.0).round() as i16
    }
}

#[inline]
pub fn quantize_f32_to_i16_exact(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    if clamped >= 1.0 {
        32767
    } else if clamped <= -1.0 {
        -32768
    } else if clamped >= 0.0 {
        (clamped * 32768.0).min(32767.0).round() as i16
    } else {
        (clamped * 32768.0).max(-32768.0).round() as i16
    }
}

/// Resamples multiple channels of audio from `from_rate` to `to_rate` using sinc interpolation (`rubato`).
pub fn resample_channels(
    channels: &[Vec<f32>],
    from_rate: usize,
    to_rate: usize,
) -> Result<Vec<Vec<f32>>, String> {
    if from_rate == to_rate || channels.is_empty() || channels[0].is_empty() {
        return Ok(channels.to_vec());
    }

    let n_channels = channels.len();
    let chunk_size = 1024;
    let mut resampler = FftFixedInOut::<f32>::new(from_rate, to_rate, chunk_size, n_channels)
        .map_err(|e| format!("Error creando resampler: {e}"))?;

    let in_frames = channels[0].len();
    let mut out_channels: Vec<Vec<f32>> = vec![Vec::new(); n_channels];

    let mut pos = 0;
    while pos < in_frames {
        let needed = resampler.input_frames_next();
        let mut in_chunk = vec![vec![0.0f32; needed]; n_channels];
        let remaining = in_frames - pos;
        let take = remaining.min(needed);

        for ch in 0..n_channels {
            for i in 0..take {
                in_chunk[ch][i] = channels[ch][pos + i];
            }
        }

        let out_chunk = resampler
            .process(&in_chunk, None)
            .map_err(|e| format!("Error en remuestreo: {e}"))?;

        let expected_out = ((take as f64) * (to_rate as f64) / (from_rate as f64)).round() as usize;
        let actual_chunk_len = out_chunk[0].len();
        let copy_len = expected_out.min(actual_chunk_len);

        for ch in 0..n_channels {
            out_channels[ch].extend_from_slice(&out_chunk[ch][..copy_len]);
        }

        pos += take;
    }

    Ok(out_channels)
}

pub struct DecodedAudioInfo {
    pub channels: Vec<Vec<f32>>,
    pub sample_rate: u32,
    pub original_channels: u16,
    pub bits_per_sample: Option<u32>,
}

/// Decodes an audio stream from any `MediaSourceStream` using `symphonia`.
/// Supports cooperative cancellation via `cancel_flag`.
pub fn decode_audio_stream(
    mss: symphonia::core::io::MediaSourceStream,
    hint_ext: Option<&str>,
    file_label: &str,
    cancel_flag: Option<&AtomicBool>,
) -> Result<DecodedAudioInfo, String> {
    let mut hint = symphonia::core::probe::Hint::new();
    if let Some(ext) = hint_ext {
        hint.with_extension(ext);
    }

    let meta_opts: symphonia::core::meta::MetadataOptions = Default::default();
    let fmt_opts: symphonia::core::formats::FormatOptions = Default::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &meta_opts)
        .map_err(|e| format!("Formato de archivo no soportado para '{file_label}': {e}"))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| format!("No se encontró pista de audio válida en '{file_label}'"))?;

    let track_id = track.id;
    let original_sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let original_channels = track.codec_params.channels.map(|c| c.count() as u16).unwrap_or(2);
    let bits_per_sample = track.codec_params.bits_per_sample;

    let dec_opts: symphonia::core::codecs::DecoderOptions = Default::default();
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &dec_opts)
        .map_err(|e| format!("Códec de audio no soportado en '{file_label}': {e}"))?;

    let mut channels: Vec<Vec<f32>> = vec![Vec::new(); (original_channels as usize).max(1)];
    let mut sample_buf: Option<symphonia::core::audio::SampleBuffer<f32>> = None;

    loop {
        if let Some(flag) = cancel_flag {
            if flag.load(Ordering::Relaxed) {
                return Err("Importación cancelada por el usuario".to_string());
            }
        }

        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(symphonia::core::errors::Error::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                let spec = *audio_buf.spec();
                let duration = audio_buf.capacity() as u64;

                let sbuf = sample_buf.get_or_insert_with(|| {
                    symphonia::core::audio::SampleBuffer::new(duration, spec)
                });
                sbuf.copy_interleaved_ref(audio_buf);

                let samples = sbuf.samples();
                let actual_channels = spec.channels.count();

                if actual_channels == 1 {
                    channels[0].extend_from_slice(samples);
                } else if actual_channels >= 2 {
                    if channels.len() < 2 {
                        channels.resize(2, Vec::new());
                    }
                    for chunk in samples.chunks_exact(actual_channels) {
                        channels[0].push(chunk[0]);
                        channels[1].push(chunk[1]);
                    }
                }
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => {
                tracing::warn!("Error al decodificar paquete en {file_label}: {e}");
                break;
            }
        }
    }

    Ok(DecodedAudioInfo {
        channels,
        sample_rate: original_sample_rate,
        original_channels,
        bits_per_sample,
    })
}

/// Decodes any audio file (WAV, FLAC, MP3, OGG, AAC/M4A) into `Vec<Vec<f32>>` using `symphonia`.
/// Supports cooperative cancellation via `cancel_flag`.
pub fn decode_audio_file(
    file_path: &Path,
    cancel_flag: Option<&AtomicBool>,
) -> Result<DecodedAudioInfo, String> {
    let file = File::open(file_path).map_err(|e| format!("No se pudo abrir el archivo {:?}: {e}", file_path))?;
    let mss = symphonia::core::io::MediaSourceStream::new(Box::new(file), Default::default());
    let ext = file_path.extension().and_then(|e| e.to_str());
    decode_audio_stream(mss, ext, &file_path.to_string_lossy(), cancel_flag)
}

/// Decodes any in-memory audio byte buffer (WAV, MP3, FLAC, OGG, AAC/M4A) into `Vec<Vec<f32>>` using `symphonia`.
pub fn decode_audio_bytes(
    bytes: Vec<u8>,
    file_name: &str,
    cancel_flag: Option<&AtomicBool>,
) -> Result<DecodedAudioInfo, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mss = symphonia::core::io::MediaSourceStream::new(Box::new(cursor), Default::default());
    let ext = Path::new(file_name).extension().and_then(|e| e.to_str());
    decode_audio_stream(mss, ext, file_name, cancel_flag)
}

/// Decodes an audio file, detects mono/effectively-mono, resamples to `target_sample_rate`,
/// extracts 320 peaks, applies TPDF dither, and writes PCM + JSON atomically to disk.
/// Respects `cancel_flag` and reuses cache if source file size/mtime match.
pub fn decode_and_cache_track(
    base_dir: &Path,
    project_id: &str,
    track_id: &str,
    input_file_path: &Path,
    target_sample_rate: u32,
    cancel_flag: Option<&AtomicBool>,
) -> Result<TrackPcmMetadata, String> {
    decode_and_cache_track_with_progress(
        base_dir,
        project_id,
        track_id,
        input_file_path,
        target_sample_rate,
        cancel_flag,
        &|_| {},
    )
}

/// Igual que [`decode_and_cache_track`], pero avisa con `on_phase` cada vez que termina una fase.
/// Un acierto de caché emite las cuatro fases de golpe.
pub fn decode_and_cache_track_with_progress(
    base_dir: &Path,
    project_id: &str,
    track_id: &str,
    input_file_path: &Path,
    target_sample_rate: u32,
    cancel_flag: Option<&AtomicBool>,
    on_phase: &dyn Fn(ImportPhase),
) -> Result<TrackPcmMetadata, String> {
    let t_total_start = std::time::Instant::now();

    // 0. Cache hit check: if file is already converted and original file hasn't changed, reuse!
    if !should_reconvert_track(base_dir, project_id, target_sample_rate, track_id, input_file_path) {
        if let Ok(cached_meta) = read_track_metadata(base_dir, project_id, target_sample_rate, track_id) {
            tracing::info!(
                "[Import Perf] Pista '{}' ({}): CACHE HIT en {:.2?}",
                track_id,
                input_file_path.file_name().unwrap_or_default().to_string_lossy(),
                t_total_start.elapsed()
            );
            for phase in ImportPhase::ALL {
                on_phase(phase);
            }
            return Ok(cached_meta);
        }
    }

    let t_read_start = std::time::Instant::now();
    let fs_meta = std::fs::metadata(input_file_path)
        .map_err(|e| format!("No se pudo leer metadatos de archivo fuente {:?}: {e}", input_file_path))?;
    let original_file_size = fs_meta.len();
    let original_modified_ms = fs_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let original_path = input_file_path.to_string_lossy().to_string();
    let dur_read = t_read_start.elapsed();

    let t_decode_start = std::time::Instant::now();
    let decoded_info = decode_audio_file(input_file_path, cancel_flag)?;
    let dur_decode = t_decode_start.elapsed();
    let decoded_channels = decoded_info.channels;
    let original_sample_rate = decoded_info.sample_rate;
    let original_channels = decoded_info.original_channels;
    let bits_per_sample = decoded_info.bits_per_sample.unwrap_or(16);

    if decoded_channels.is_empty() || decoded_channels[0].is_empty() {
        return Err(format!("El archivo de audio {:?} no contiene muestras audibles", input_file_path));
    }
    on_phase(ImportPhase::Decoded);

    if let Some(flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            delete_track_cache(base_dir, project_id, target_sample_rate, track_id);
            return Err("Importación cancelada por el usuario".to_string());
        }
    }

    let t_resample_start = std::time::Instant::now();
    // 1. Mono / Effectively-Mono detection
    let (is_eff_mono, working_channels) = if decoded_channels.len() >= 2 {
        let eff_mono = is_effectively_mono(&decoded_channels[0], &decoded_channels[1]);
        if eff_mono {
            // Mix L + R into single mono channel
            let len = decoded_channels[0].len().min(decoded_channels[1].len());
            let mut mono = Vec::with_capacity(len);
            for i in 0..len {
                mono.push((decoded_channels[0][i] + decoded_channels[1][i]) * 0.5);
            }
            (true, vec![mono])
        } else {
            (false, decoded_channels)
        }
    } else {
        (true, decoded_channels)
    };

    let dur_mono = t_resample_start.elapsed();

    // 2. Resampling to target_sample_rate (if different)
    let resampled = if original_sample_rate != target_sample_rate {
        resample_channels(
            &working_channels,
            original_sample_rate as usize,
            target_sample_rate as usize,
        )?
    } else {
        working_channels
    };
    let dur_resample = t_resample_start.elapsed();
    on_phase(ImportPhase::Resampled);

    if let Some(flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            delete_track_cache(base_dir, project_id, target_sample_rate, track_id);
            return Err("Importación cancelada por el usuario".to_string());
        }
    }

    let t_write_start = std::time::Instant::now();
    let channels_count = resampled.len() as u16;
    let frame_count = resampled[0].len() as u64;
    let duration_sec = frame_count as f64 / target_sample_rate as f64;

    // 3. Extract 320 waveform peaks
    let peaks = extract_waveform_peaks(&resampled[0], 320);
    let dur_peaks = t_write_start.elapsed();

    // 4. Quantize to i16 (exact copy if source is 16-bit and sample rates match, else TPDF dither)
    let is_exact_16bit = bits_per_sample <= 16 && original_sample_rate == target_sample_rate;
    let mut rng = TpdfDitherRng::new(frame_count ^ (target_sample_rate as u64));
    let mut pcm_samples = Vec::with_capacity((frame_count as usize) * (channels_count as usize));

    if channels_count == 1 {
        for &s in &resampled[0] {
            let sample_i16 = if is_exact_16bit {
                quantize_f32_to_i16_exact(s)
            } else {
                quantize_f32_to_i16_with_dither(s, &mut rng)
            };
            pcm_samples.push(sample_i16);
        }
    } else {
        let len = resampled[0].len().min(resampled[1].len());
        for i in 0..len {
            let s0 = if is_exact_16bit {
                quantize_f32_to_i16_exact(resampled[0][i])
            } else {
                quantize_f32_to_i16_with_dither(resampled[0][i], &mut rng)
            };
            let s1 = if is_exact_16bit {
                quantize_f32_to_i16_exact(resampled[1][i])
            } else {
                quantize_f32_to_i16_with_dither(resampled[1][i], &mut rng)
            };
            pcm_samples.push(s0);
            pcm_samples.push(s1);
        }
    }

    if let Some(flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            delete_track_cache(base_dir, project_id, target_sample_rate, track_id);
            return Err("Importación cancelada por el usuario".to_string());
        }
    }

    on_phase(ImportPhase::Quantized);

    let now_iso = {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        format!("{now}")
    };

    let metadata = TrackPcmMetadata {
        format_version: CACHE_FORMAT_VERSION,
        track_id: track_id.to_string(),
        target_sample_rate,
        original_sample_rate,
        original_channels,
        original_path,
        original_file_size,
        original_modified_ms,
        channels: channels_count,
        is_effectively_mono: is_eff_mono,
        frame_count,
        duration_sec,
        peaks,
        created_at: now_iso,
    };

    // 5. Atomic write to disk
    let dur_quant_end = t_write_start.elapsed();
    write_track_pcm_and_metadata(base_dir, project_id, &metadata, &pcm_samples)?;
    let dur_write = t_write_start.elapsed();
    let dur_total = t_total_start.elapsed();
    on_phase(ImportPhase::Written);

    tracing::info!(
        "[Import Perf] Pista '{}' ({}): lectura={:?}, decodificación={:?}, remuestreo={:?}, escritura={:?}, total={:?}",
        track_id,
        input_file_path.file_name().unwrap_or_default().to_string_lossy(),
        dur_read,
        dur_decode,
        dur_resample,
        dur_write,
        dur_total
    );
    log_phase_breakdown(
        track_id,
        original_sample_rate,
        target_sample_rate,
        channels_count,
        frame_count,
        dur_mono,
        dur_resample,
        dur_peaks,
        dur_quant_end,
        dur_write,
    );

    Ok(metadata)
}

/// Decodes in-memory audio bytes, resamples to `target_sample_rate`, detects mono,
/// extracts peaks, applies TPDF dither, and writes PCM + JSON atomically to disk.
pub fn decode_and_cache_track_bytes(
    base_dir: &Path,
    project_id: &str,
    track_id: &str,
    file_name: &str,
    bytes: Vec<u8>,
    target_sample_rate: u32,
    cancel_flag: Option<&AtomicBool>,
) -> Result<TrackPcmMetadata, String> {
    let t_total_start = std::time::Instant::now();
    let original_file_size = bytes.len() as u64;
    let original_path = format!("memory://{file_name}");
    let original_modified_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let t_decode_start = std::time::Instant::now();
    let decoded_info = decode_audio_bytes(bytes, file_name, cancel_flag)?;
    let dur_decode = t_decode_start.elapsed();
    let decoded_channels = decoded_info.channels;
    let original_sample_rate = decoded_info.sample_rate;
    let original_channels = decoded_info.original_channels;
    let bits_per_sample = decoded_info.bits_per_sample.unwrap_or(16);

    if decoded_channels.is_empty() || decoded_channels[0].is_empty() {
        return Err(format!("El audio '{file_name}' no contiene muestras audibles"));
    }

    if let Some(flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            delete_track_cache(base_dir, project_id, target_sample_rate, track_id);
            return Err("Importación cancelada por el usuario".to_string());
        }
    }

    let t_resample_start = std::time::Instant::now();
    // 1. Mono / Effectively-Mono detection
    let (is_eff_mono, working_channels) = if decoded_channels.len() >= 2 {
        let eff_mono = is_effectively_mono(&decoded_channels[0], &decoded_channels[1]);
        if eff_mono {
            let len = decoded_channels[0].len().min(decoded_channels[1].len());
            let mut mono = Vec::with_capacity(len);
            for i in 0..len {
                mono.push((decoded_channels[0][i] + decoded_channels[1][i]) * 0.5);
            }
            (true, vec![mono])
        } else {
            (false, decoded_channels)
        }
    } else {
        (true, decoded_channels)
    };

    let dur_mono = t_resample_start.elapsed();

    // 2. Resampling to target_sample_rate (if different)
    let resampled = if original_sample_rate != target_sample_rate {
        resample_channels(
            &working_channels,
            original_sample_rate as usize,
            target_sample_rate as usize,
        )?
    } else {
        working_channels
    };

    let dur_resample = t_resample_start.elapsed();

    if let Some(flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            delete_track_cache(base_dir, project_id, target_sample_rate, track_id);
            return Err("Importación cancelada por el usuario".to_string());
        }
    }

    let t_write_start = std::time::Instant::now();
    let channels_count = resampled.len() as u16;
    let frame_count = resampled[0].len() as u64;
    let duration_sec = frame_count as f64 / target_sample_rate as f64;

    // 3. Extract 320 waveform peaks
    let peaks = extract_waveform_peaks(&resampled[0], 320);
    let dur_peaks = t_write_start.elapsed();

    // 4. Quantize to i16 (exact copy if source is 16-bit and sample rates match, else TPDF dither)
    let is_exact_16bit = bits_per_sample <= 16 && original_sample_rate == target_sample_rate;
    let mut rng = TpdfDitherRng::new(frame_count ^ (target_sample_rate as u64));
    let mut pcm_samples = Vec::with_capacity((frame_count as usize) * (channels_count as usize));

    if channels_count == 1 {
        for &s in &resampled[0] {
            let sample_i16 = if is_exact_16bit {
                quantize_f32_to_i16_exact(s)
            } else {
                quantize_f32_to_i16_with_dither(s, &mut rng)
            };
            pcm_samples.push(sample_i16);
        }
    } else {
        for i in 0..(frame_count as usize) {
            let s0 = if is_exact_16bit {
                quantize_f32_to_i16_exact(resampled[0][i])
            } else {
                quantize_f32_to_i16_with_dither(resampled[0][i], &mut rng)
            };
            let s1 = if is_exact_16bit {
                quantize_f32_to_i16_exact(resampled[1][i])
            } else {
                quantize_f32_to_i16_with_dither(resampled[1][i], &mut rng)
            };
            pcm_samples.push(s0);
            pcm_samples.push(s1);
        }
    }

    if let Some(flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
            delete_track_cache(base_dir, project_id, target_sample_rate, track_id);
            return Err("Importación cancelada por el usuario".to_string());
        }
    }

    let now_iso = {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        format!("{now}")
    };

    let metadata = TrackPcmMetadata {
        format_version: CACHE_FORMAT_VERSION,
        track_id: track_id.to_string(),
        target_sample_rate,
        original_sample_rate,
        original_channels,
        original_path,
        original_file_size,
        original_modified_ms,
        channels: channels_count,
        is_effectively_mono: is_eff_mono,
        frame_count,
        duration_sec,
        peaks,
        created_at: now_iso,
    };

    // 5. Atomic write to disk
    let dur_quant_end = t_write_start.elapsed();
    write_track_pcm_and_metadata(base_dir, project_id, &metadata, &pcm_samples)?;
    let dur_write = t_write_start.elapsed();
    let dur_total = t_total_start.elapsed();

    tracing::info!(
        "[Import Perf] Pista bytes '{}' ({}): lectura=0ms, decodificación={:?}, remuestreo={:?}, escritura={:?}, total={:?}",
        track_id,
        file_name,
        dur_decode,
        dur_resample,
        dur_write,
        dur_total
    );
    log_phase_breakdown(
        track_id,
        original_sample_rate,
        target_sample_rate,
        channels_count,
        frame_count,
        dur_mono,
        dur_resample,
        dur_peaks,
        dur_quant_end,
        dur_write,
    );

    Ok(metadata)
}

/// Diagnóstico: desglosa las fases agregadas de `[Import Perf]` (remuestreo incluye detección
/// mono; escritura incluye picos + cuantización + disco). Solo registra, no cambia comportamiento.
#[allow(clippy::too_many_arguments)]
fn log_phase_breakdown(
    track_id: &str,
    original_sample_rate: u32,
    target_sample_rate: u32,
    channels: u16,
    frames: u64,
    dur_mono: std::time::Duration,
    dur_mono_plus_resample: std::time::Duration,
    dur_peaks: std::time::Duration,
    dur_peaks_plus_quant: std::time::Duration,
    dur_write_total: std::time::Duration,
) {
    tracing::info!(
        "[Import Perf Fases] Pista '{}': {} Hz -> {} Hz, canales={}, frames={}, mono={:?}, remuestreo_puro={:?}, picos={:?}, cuantización={:?}, disco={:?}",
        track_id,
        original_sample_rate,
        target_sample_rate,
        channels,
        frames,
        dur_mono,
        dur_mono_plus_resample.saturating_sub(dur_mono),
        dur_peaks,
        dur_peaks_plus_quant.saturating_sub(dur_peaks),
        dur_write_total.saturating_sub(dur_peaks_plus_quant),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::cache;

    fn write_test_wav_16bit(path: &Path, sample_rate: u32, channels: u16, samples_per_channel: &[i16]) {
        use std::io::Write;
        let mut f = File::create(path).unwrap();
        let bytes_per_sample = 2u16;
        let block_align = channels * bytes_per_sample;
        let byte_rate = sample_rate * block_align as u32;
        let frames = samples_per_channel.len();
        let data_len = frames as u32 * block_align as u32;
        let total_len = 36 + data_len;

        f.write_all(b"RIFF").unwrap();
        f.write_all(&(total_len.to_le_bytes())).unwrap();
        f.write_all(b"WAVE").unwrap();

        f.write_all(b"fmt ").unwrap();
        f.write_all(&(16u32.to_le_bytes())).unwrap();
        f.write_all(&(1u16.to_le_bytes())).unwrap();
        f.write_all(&(channels.to_le_bytes())).unwrap();
        f.write_all(&(sample_rate.to_le_bytes())).unwrap();
        f.write_all(&(byte_rate.to_le_bytes())).unwrap();
        f.write_all(&(block_align.to_le_bytes())).unwrap();
        f.write_all(&(16u16.to_le_bytes())).unwrap();

        f.write_all(b"data").unwrap();
        f.write_all(&(data_len.to_le_bytes())).unwrap();

        for &val in samples_per_channel {
            for _ in 0..channels {
                f.write_all(&val.to_le_bytes()).unwrap();
            }
        }
    }

    fn write_test_wav_24bit(path: &Path, sample_rate: u32, channels: u16, frames: usize) {
        use std::io::Write;
        let mut f = File::create(path).unwrap();
        let bytes_per_sample = 3u16;
        let block_align = channels * bytes_per_sample;
        let byte_rate = sample_rate * block_align as u32;
        let data_len = frames as u32 * block_align as u32;
        let total_len = 36 + data_len;

        f.write_all(b"RIFF").unwrap();
        f.write_all(&(total_len.to_le_bytes())).unwrap();
        f.write_all(b"WAVE").unwrap();

        f.write_all(b"fmt ").unwrap();
        f.write_all(&(16u32.to_le_bytes())).unwrap();
        f.write_all(&(1u16.to_le_bytes())).unwrap();
        f.write_all(&(channels.to_le_bytes())).unwrap();
        f.write_all(&(sample_rate.to_le_bytes())).unwrap();
        f.write_all(&(byte_rate.to_le_bytes())).unwrap();
        f.write_all(&(block_align.to_le_bytes())).unwrap();
        f.write_all(&(24u16.to_le_bytes())).unwrap();

        f.write_all(b"data").unwrap();
        f.write_all(&(data_len.to_le_bytes())).unwrap();

        for i in 0..frames {
            let t = i as f32 / sample_rate as f32;
            let val = ((2.0 * std::f32::consts::PI * 440.0 * t).sin() * 8000000.0) as i32;
            let bytes = val.to_le_bytes(); // 24-bit PCM takes first 3 bytes little-endian
            for _ in 0..channels {
                f.write_all(&bytes[0..3]).unwrap();
            }
        }
    }

    #[test]
    fn test_wav_16bit_exact_copy_no_dither() {
        let temp_dir = std::env::temp_dir().join(format!("omnitracks_exact_16_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let wav_path = temp_dir.join("test_exact_16.wav");
        let test_samples: Vec<i16> = vec![0, 1000, -2000, 15000, -32000, 32767, -32768, 555, -999];
        // Mono 16-bit at 48000 Hz, matching device 48000 Hz
        write_test_wav_16bit(&wav_path, 48000, 1, &test_samples);

        let meta = decode_and_cache_track(&temp_dir, "test_proj", "stem_exact", &wav_path, 48000, None).unwrap();
        assert_eq!(meta.frame_count, test_samples.len() as u64);

        let pcm_path = cache::get_track_pcm_path(&temp_dir, "test_proj", 48000, "stem_exact");
        let pcm_bytes = std::fs::read(&pcm_path).unwrap();
        let mut loaded_samples = Vec::new();
        for chunk in pcm_bytes.chunks_exact(2) {
            loaded_samples.push(i16::from_le_bytes([chunk[0], chunk[1]]));
        }

        // Compare sample by sample: must be 100% exact identical
        for (i, (&orig, &loaded)) in test_samples.iter().zip(loaded_samples.iter()).enumerate() {
            assert_eq!(orig, loaded, "Muestra diferenció en índice {i}: original {orig} vs cargada {loaded}");
        }

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_wav_24bit_dither_and_duration() {
        let temp_dir = std::env::temp_dir().join(format!("omnitracks_dither_24_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let wav_path = temp_dir.join("test_24bit.wav");
        let frames = 48000; // 1 second
        write_test_wav_24bit(&wav_path, 48000, 2, frames);

        let meta = decode_and_cache_track(&temp_dir, "test_proj", "stem_24", &wav_path, 48000, None).unwrap();
        assert_eq!(meta.frame_count, frames as u64);
        assert!((meta.duration_sec - 1.0).abs() < 0.001);

        let pcm_path = cache::get_track_pcm_path(&temp_dir, "test_proj", 48000, "stem_24");
        assert!(pcm_path.exists());
        // Since L/R are identical, is_effectively_mono reduces to 1 channel:
        assert_eq!(meta.channels, 1);
        assert_eq!(pcm_path.metadata().unwrap().len(), (frames * 2) as u64);

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_cancelled_import_leaves_no_files() {
        let temp_dir = std::env::temp_dir().join(format!("omnitracks_cancel_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let wav_path = temp_dir.join("test_cancel.wav");
        write_test_wav_16bit(&wav_path, 48000, 1, &[100, 200, 300, 400]);

        let cancel_flag = AtomicBool::new(true); // cancelled immediately
        let res = decode_and_cache_track(&temp_dir, "test_proj", "stem_cancel", &wav_path, 48000, Some(&cancel_flag));
        assert!(res.is_err());

        let pcm_path = cache::get_track_pcm_path(&temp_dir, "test_proj", 48000, "stem_cancel");
        let json_path = cache::get_track_json_path(&temp_dir, "test_proj", 48000, "stem_cancel");
        assert!(!pcm_path.exists());
        assert!(!json_path.exists());

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_decode_and_cache_track_wav() {
        let temp_dir = std::env::temp_dir().join(format!("omnitracks_import_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let wav_path = temp_dir.join("test_stem.wav");
        let samples: Vec<i16> = (0..44100).map(|i| ((i % 1000) as i16) * 10).collect();
        write_test_wav_16bit(&wav_path, 44100, 2, &samples);

        let meta = decode_and_cache_track(&temp_dir, "test_proj", "stem_01", &wav_path, 48000, None).unwrap();

        assert_eq!(meta.track_id, "stem_01");
        assert_eq!(meta.original_sample_rate, 44100);
        assert_eq!(meta.target_sample_rate, 48000);
        assert_eq!(meta.original_channels, 2);
        assert!(meta.is_effectively_mono);
        assert_eq!(meta.channels, 1);
        assert_eq!(meta.peaks.len(), 320);
        assert!((meta.duration_sec - 1.0).abs() < 0.05);

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_decode_and_cache_track_bytes() {
        let temp_dir = std::env::temp_dir().join(format!("omnitracks_bytes_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let wav_path = temp_dir.join("test_stem_bytes.wav");
        let samples: Vec<i16> = (0..48000).map(|i| ((i % 500) as i16) * 20).collect();
        write_test_wav_16bit(&wav_path, 48000, 1, &samples);
        let wav_bytes = std::fs::read(&wav_path).unwrap();

        let meta = decode_and_cache_track_bytes(&temp_dir, "test_proj_bytes", "stem_bytes_01", "test_stem_bytes.wav", wav_bytes, 48000, None).unwrap();

        assert_eq!(meta.track_id, "stem_bytes_01");
        assert_eq!(meta.original_sample_rate, 48000);
        assert_eq!(meta.target_sample_rate, 48000);
        assert_eq!(meta.frame_count, 48000);
        assert_eq!(meta.peaks.len(), 320);

        let pcm_path = cache::get_track_pcm_path(&temp_dir, "test_proj_bytes", 48000, "stem_bytes_01");
        assert!(pcm_path.exists());
        assert_eq!(pcm_path.metadata().unwrap().len(), 48000 * 2);

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_mp3_decoding_and_load_if_downloaded() {
        let mp3_path = std::path::PathBuf::from(r"C:\Users\jpuerta\Downloads\Multitrack _ERES BENDITO_ ORIGINAL Jaime Murrel-G major-108bpm-440hz\Multitrack _ERES BENDITO_ ORIGINAL Jaime Murrel-Guitars-G major-108bpm-440hz.mp3");
        if mp3_path.exists() {
            let temp_dir = std::env::temp_dir().join(format!("omnitracks_mp3_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            std::fs::create_dir_all(&temp_dir).unwrap();

            let meta = decode_and_cache_track(&temp_dir, "test_mp3_proj", "stem_guitars", &mp3_path, 48000, None).expect("Debe decodificar MP3 real sin errores");
            assert_eq!(meta.track_id, "stem_guitars");
            assert_eq!(meta.target_sample_rate, 48000);
            assert!(meta.frame_count > 0);
            assert!(meta.duration_sec > 10.0);
            assert_eq!(meta.peaks.len(), 320);

            let pcm_path = cache::get_track_pcm_path(&temp_dir, "test_mp3_proj", 48000, "stem_guitars");
            assert!(pcm_path.exists());
            assert!(pcm_path.metadata().unwrap().len() > 0);

            let _ = std::fs::remove_dir_all(temp_dir);
        }
    }


    // ---- Huellas del PCM generado (red de seguridad para las optimizaciones de rendimiento) ----

    /// FNV-1a de 64 bits, igual que el de `examples/medir_cache.rs`.
    fn fnv1a64(bytes: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for &b in bytes {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }

    /// Escribe un WAV PCM entero (16 o 24 bit) con canales distintos. `frames[i]` es la lista de
    /// canales del frame i, en el rango del tipo (±32767 para 16 bit, ±8388607 para 24 bit).
    fn write_test_wav_interleaved(path: &Path, sample_rate: u32, bits: u16, frames: &[Vec<i32>]) {
        use std::io::Write;
        let channels = frames[0].len() as u16;
        let bytes_per_sample = bits / 8;
        let block_align = channels * bytes_per_sample;
        let data_len = frames.len() as u32 * block_align as u32;
        let mut f = File::create(path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + data_len).to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&channels.to_le_bytes()).unwrap();
        f.write_all(&sample_rate.to_le_bytes()).unwrap();
        f.write_all(&(sample_rate * block_align as u32).to_le_bytes()).unwrap();
        f.write_all(&block_align.to_le_bytes()).unwrap();
        f.write_all(&bits.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_len.to_le_bytes()).unwrap();
        for frame in frames {
            for &v in frame {
                f.write_all(&v.to_le_bytes()[..bytes_per_sample as usize]).unwrap();
            }
        }
    }

    /// Señal determinista sin funciones trigonométricas: dos ondas triangulares más ruido de un LCG.
    fn synth_frames(n: usize, amp: i32, same_channels: bool) -> Vec<Vec<i32>> {
        let mut state: u64 = 0x1234_5678_9abc_def0;
        let mut noise = move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((state >> 40) as i32 & 0xff) - 128
        };
        let tri = |i: usize, period: usize| -> i32 {
            let ph = (i % period) as i64;
            let half = (period / 2) as i64;
            let v = if ph < half { ph } else { period as i64 - ph };
            (((v * 2 - half) * amp as i64) / (half.max(1) * 2)) as i32
        };
        (0..n)
            .map(|i| {
                let l = tri(i, 109) + tri(i, 37) / 3 + noise() * amp / 32768;
                let r = if same_channels { l } else { tri(i, 151) + tri(i, 53) / 3 + noise() * amp / 32768 };
                vec![l.clamp(-amp, amp), r.clamp(-amp, amp)]
            })
            .collect()
    }

    fn pcm_fingerprint(case: &str, sample_rate: u32, bits: u16, frames: &[Vec<i32>]) -> (u64, u16, u64) {
        let temp_dir = std::env::temp_dir().join(format!(
            "omnitracks_golden_{case}_{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let wav_path = temp_dir.join("in.wav");
        write_test_wav_interleaved(&wav_path, sample_rate, bits, frames);
        let meta = decode_and_cache_track(&temp_dir, "golden", "stem", &wav_path, 48000, None).unwrap();
        let pcm = std::fs::read(cache::get_track_pcm_path(&temp_dir, "golden", 48000, "stem")).unwrap();
        let _ = std::fs::remove_dir_all(&temp_dir);
        (fnv1a64(&pcm), meta.channels, meta.frame_count)
    }

    /// Fija byte a byte el PCM que producen las rutas de importación. Si una optimización cambia
    /// UN solo byte (dither, redondeo, remuestreo, mezcla mono), esta prueba falla.
    /// Las constantes se capturaron sobre el código sin optimizar (ver docs/PLAN_TIEMPO_CACHE.md).
    #[test]
    fn test_pcm_golden_hashes() {
        // (nombre, hz, bits, frames, canales iguales, amplitud, huella, canales esperados, frames esperados)
        let cases: Vec<(&str, u32, u16, usize, bool, i32, u64, u16, u64)> = vec![
            ("44k_estereo_16", 44100, 16, 44100, false, 20000, 0x75cd1937dc5c6ca0, 2, 48000),
            ("44k_estereo_24", 44100, 24, 44100, false, 6_000_000, 0x3b55a46f3f1731e9, 2, 48000),
            ("48k_estereo_16_exacto", 48000, 16, 48000, false, 20000, 0xdc25187a43e76cd7, 2, 48000),
            ("44k_mono_efectivo", 44100, 16, 44100, true, 20000, 0xf27d628291716e12, 1, 48000),
            ("44k_recorte", 44100, 16, 44100, false, 32767, 0x64ea83df63b7ba86, 2, 48000),
        ];
        let mut fallos = Vec::new();
        for (name, hz, bits, n, same, amp, want_hash, want_ch, want_frames) in cases {
            let frames = synth_frames(n, amp, same);
            let (hash, ch, fc) = pcm_fingerprint(name, hz, bits, &frames);
            println!("GOLDEN {name}: hash={hash:#018x} canales={ch} frames={fc}");
            if hash != want_hash || ch != want_ch || fc != want_frames {
                fallos.push(format!("{name}: obtenido hash={hash:#018x} canales={ch} frames={fc}"));
            }
        }
        assert!(fallos.is_empty(), "El PCM cambió:
{}", fallos.join("
"));
    }


    #[test]
    fn test_progress_tracker_monotono_y_40_pasos_para_10_pistas() {
        let t = ImportProgressTracker::new(10);
        let mut last = 0.0f32;
        let mut pasos = 0;
        for _ in 0..10 {
            for phase in ImportPhase::ALL {
                let (p, _) = t.advance(phase);
                assert!(p >= last, "el porcentaje retrocedió: {last} -> {p}");
                last = p;
                pasos += 1;
            }
        }
        assert_eq!(pasos, 40);
        assert_eq!(last, ImportProgressTracker::MAX_PERCENT_BEFORE_DONE);
    }

    #[test]
    fn test_progress_tracker_tope_en_99_y_pistas_terminadas() {
        let t = ImportProgressTracker::new(2);
        let mut ultimo = (0.0, 0);
        for _ in 0..2 {
            for phase in ImportPhase::ALL {
                ultimo = t.advance(phase);
                assert!(ultimo.0 <= 99.0);
            }
        }
        assert_eq!(ultimo, (99.0, 2));
        // Pasarse de unidades tampoco supera el tope.
        assert_eq!(t.advance(ImportPhase::Decoded).0, 99.0);
    }

    #[test]
    fn test_progress_tracker_sin_pistas_no_divide_por_cero() {
        let t = ImportProgressTracker::new(0);
        let (p, f) = t.advance(ImportPhase::Decoded);
        assert_eq!((p, f), (0.0, 0));
    }

    #[test]
    fn test_progress_tracker_desde_varios_hilos() {
        let t = std::sync::Arc::new(ImportProgressTracker::new(8));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let t = std::sync::Arc::clone(&t);
                std::thread::spawn(move || {
                    for _ in 0..2 {
                        for phase in ImportPhase::ALL {
                            t.advance(phase);
                        }
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let (_, finished) = t.advance(ImportPhase::Decoded);
        assert_eq!(finished, 8);
    }

    #[test]
    fn test_with_progress_emite_las_cuatro_fases_en_orden() {
        let temp_dir = std::env::temp_dir().join(format!("omnitracks_phase_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let wav_path = temp_dir.join("fases.wav");
        let samples: Vec<i16> = (0..4410).map(|i| ((i % 300) as i16) * 30).collect();
        write_test_wav_16bit(&wav_path, 44100, 2, &samples);

        let vistas = std::cell::RefCell::new(Vec::new());
        decode_and_cache_track_with_progress(&temp_dir, "p", "t", &wav_path, 48000, None, &|f| vistas.borrow_mut().push(f)).unwrap();
        assert_eq!(*vistas.borrow(), ImportPhase::ALL.to_vec());

        // Segunda vez: acierto de caché, también emite las cuatro.
        vistas.borrow_mut().clear();
        decode_and_cache_track_with_progress(&temp_dir, "p", "t", &wav_path, 48000, None, &|f| vistas.borrow_mut().push(f)).unwrap();
        assert_eq!(*vistas.borrow(), ImportPhase::ALL.to_vec());

        let _ = std::fs::remove_dir_all(temp_dir);
    }
}
