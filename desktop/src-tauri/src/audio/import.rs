use super::cache::{
    extract_waveform_peaks, is_effectively_mono, write_track_pcm_and_metadata,
    CACHE_FORMAT_VERSION,
};
pub use super::cache::{ImportProgressEvent, ProjectCacheStatus, TrackPcmMetadata};
use rubato::{FftFixedInOut, Resampler};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::Path;

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

/// Decodes any audio file (WAV, FLAC, MP3, OGG, AAC/M4A) into `Vec<Vec<f32>>` using `symphonia`.
pub fn decode_audio_file(file_path: &Path) -> Result<(Vec<Vec<f32>>, u32, u16), String> {
    let file = File::open(file_path).map_err(|e| format!("No se pudo abrir el archivo {:?}: {e}", file_path))?;
    let mss = symphonia::core::io::MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = symphonia::core::probe::Hint::new();
    if let Some(ext) = file_path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let meta_opts: symphonia::core::meta::MetadataOptions = Default::default();
    let fmt_opts: symphonia::core::formats::FormatOptions = Default::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &meta_opts)
        .map_err(|e| format!("Formato de archivo no soportado para {:?}: {e}", file_path))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| format!("No se encontró pista de audio válida en {:?}", file_path))?;

    let track_id = track.id;
    let original_sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let original_channels = track.codec_params.channels.map(|c| c.count() as u16).unwrap_or(2);

    let dec_opts: symphonia::core::codecs::DecoderOptions = Default::default();
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &dec_opts)
        .map_err(|e| format!("Códec de audio no soportado: {e}"))?;

    let mut channels: Vec<Vec<f32>> = vec![Vec::new(); (original_channels as usize).max(1)];
    let mut sample_buf: Option<symphonia::core::audio::SampleBuffer<f32>> = None;

    loop {
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
                tracing::warn!("Error al decodificar paquete en {:?}: {e}", file_path);
                break;
            }
        }
    }

    Ok((channels, original_sample_rate, original_channels))
}

/// Decodes an audio file, detects mono/effectively-mono, resamples to `target_sample_rate`,
/// extracts 320 peaks, applies TPDF dither, and writes PCM + JSON atomically to disk.
pub fn decode_and_cache_track(
    base_dir: &Path,
    project_id: &str,
    track_id: &str,
    input_file_path: &Path,
    target_sample_rate: u32,
) -> Result<TrackPcmMetadata, String> {
    let (decoded_channels, original_sample_rate, original_channels) =
        decode_audio_file(input_file_path)?;

    if decoded_channels.is_empty() || decoded_channels[0].is_empty() {
        return Err(format!("El archivo de audio {:?} no contiene muestras audibles", input_file_path));
    }

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

    let channels_count = resampled.len() as u16;
    let frame_count = resampled[0].len() as u64;
    let duration_sec = frame_count as f64 / target_sample_rate as f64;

    // 3. Extract 320 waveform peaks
    let peaks = extract_waveform_peaks(&resampled[0], 320);

    // 4. Quantize to i16 with TPDF dither (interleaved if stereo)
    let mut rng = TpdfDitherRng::new(frame_count ^ (target_sample_rate as u64));
    let mut pcm_samples = Vec::with_capacity((frame_count as usize) * (channels_count as usize));

    if channels_count == 1 {
        for &s in &resampled[0] {
            pcm_samples.push(quantize_f32_to_i16_with_dither(s, &mut rng));
        }
    } else {
        let len = resampled[0].len().min(resampled[1].len());
        for i in 0..len {
            pcm_samples.push(quantize_f32_to_i16_with_dither(resampled[0][i], &mut rng));
            pcm_samples.push(quantize_f32_to_i16_with_dither(resampled[1][i], &mut rng));
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
        channels: channels_count,
        is_effectively_mono: is_eff_mono,
        frame_count,
        duration_sec,
        peaks,
        created_at: now_iso,
    };

    // 5. Atomic write to disk
    write_track_pcm_and_metadata(base_dir, project_id, &metadata, &pcm_samples)?;

    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_wav(path: &Path, sample_rate: u32, channels: u16, frames: usize) {
        use std::io::Write;
        let mut f = File::create(path).unwrap();
        let bytes_per_sample = 2u16;
        let block_align = channels * bytes_per_sample;
        let byte_rate = sample_rate * block_align as u32;
        let data_len = frames as u32 * block_align as u32;
        let total_len = 36 + data_len;

        // RIFF header
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(total_len.to_le_bytes())).unwrap();
        f.write_all(b"WAVE").unwrap();

        // fmt chunk
        f.write_all(b"fmt ").unwrap();
        f.write_all(&(16u32.to_le_bytes())).unwrap(); // chunk size
        f.write_all(&(1u16.to_le_bytes())).unwrap();  // PCM
        f.write_all(&(channels.to_le_bytes())).unwrap();
        f.write_all(&(sample_rate.to_le_bytes())).unwrap();
        f.write_all(&(byte_rate.to_le_bytes())).unwrap();
        f.write_all(&(block_align.to_le_bytes())).unwrap();
        f.write_all(&(16u16.to_le_bytes())).unwrap(); // bits per sample

        // data chunk
        f.write_all(b"data").unwrap();
        f.write_all(&(data_len.to_le_bytes())).unwrap();

        for i in 0..frames {
            let t = i as f32 / sample_rate as f32;
            let val = ((2.0 * std::f32::consts::PI * 440.0 * t).sin() * 16000.0) as i16;
            for _ in 0..channels {
                f.write_all(&val.to_le_bytes()).unwrap();
            }
        }
    }

    #[test]
    fn test_decode_and_cache_track_wav() {
        let temp_dir = std::env::temp_dir().join(format!("omnitracks_import_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let wav_path = temp_dir.join("test_stem.wav");
        write_test_wav(&wav_path, 44100, 2, 44100); // 1 second 44.1kHz stereo with identical L/R

        let meta = decode_and_cache_track(&temp_dir, "test_proj", "stem_01", &wav_path, 48000).unwrap();

        assert_eq!(meta.track_id, "stem_01");
        assert_eq!(meta.original_sample_rate, 44100);
        assert_eq!(meta.target_sample_rate, 48000);
        assert_eq!(meta.original_channels, 2);
        assert!(meta.is_effectively_mono); // Identical channels -> effectively mono!
        assert_eq!(meta.channels, 1);
        assert_eq!(meta.peaks.len(), 320);
        assert!((meta.duration_sec - 1.0).abs() < 0.05);

        let _ = std::fs::remove_dir_all(temp_dir);
    }
}
