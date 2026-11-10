use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub const CACHE_FORMAT_VERSION: u32 = 1;
pub const WAVEFORM_PEAKS_COUNT: usize = 320;
pub const MONO_SIDE_THRESHOLD_DB: f64 = -40.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackPcmMetadata {
    pub format_version: u32,
    pub track_id: String,
    pub target_sample_rate: u32,
    pub original_sample_rate: u32,
    pub original_channels: u16,
    pub channels: u16,
    pub is_effectively_mono: bool,
    pub frame_count: u64,
    pub duration_sec: f64,
    pub peaks: Vec<f32>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCacheStatus {
    pub project_id: String,
    pub sample_rate: u32,
    pub is_ready: bool,
    pub cached_tracks_count: usize,
    pub total_tracks_count: usize,
    pub tracks: Vec<TrackPcmMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgressEvent {
    pub project_id: String,
    pub track_index: usize,
    pub total_tracks: usize,
    pub track_name: String,
    pub percent: f32,
    pub completed: bool,
}

/// Computes whether a stereo channel pair carries practically identical signals.
/// Matches `src/audio/monoDetect.ts` using side-vs-mid energy in dB:
/// 10 * log10(side / mid) < -40 dB
pub fn is_effectively_mono(left: &[f32], right: &[f32]) -> bool {
    if left.len() != right.len() || left.is_empty() {
        return false;
    }
    let mut mid: f64 = 0.0;
    let mut side: f64 = 0.0;
    for (&l, &r) in left.iter().zip(right.iter()) {
        let lf = l as f64;
        let rf = r as f64;
        let m = lf + rf;
        let s = lf - rf;
        mid += m * m;
        side += s * s;
    }
    if side == 0.0 {
        return true;
    }
    if mid == 0.0 {
        return false; // pure out-of-phase signal: keep stereo
    }
    let ratio_db = 10.0 * (side / mid).log10();
    ratio_db < MONO_SIDE_THRESHOLD_DB
}

/// Extracts normalized peak values from single-channel audio data.
/// Matches `src/audio/demoSynthesizer.ts:extractWaveformPeaks`.
pub fn extract_waveform_peaks(channel_data: &[f32], num_buckets: usize) -> Vec<f32> {
    let total_samples = channel_data.len();
    if total_samples == 0 || num_buckets == 0 {
        return vec![0.0; num_buckets];
    }
    let samples_per_bucket = (total_samples / num_buckets).max(1);
    let mut peaks = Vec::with_capacity(num_buckets);

    for i in 0..num_buckets {
        let start = i * samples_per_bucket;
        let end = (start + samples_per_bucket).min(total_samples);
        let mut max_abs: f32 = 0.0;
        let step = ((end - start) / 64).max(1);
        let mut j = start;
        while j < end {
            let val = channel_data[j].abs();
            if val > max_abs {
                max_abs = val;
            }
            j += step;
        }
        let rounded = ((max_abs * 1000.0).round() / 1000.0).min(1.0);
        peaks.push(rounded);
    }

    peaks
}

/// Returns the cache directory for a given project and sample rate:
/// `{base_dir}/pcm/{project_id}/{sample_rate}`
pub fn get_project_cache_dir(base_dir: &Path, project_id: &str, sample_rate: u32) -> PathBuf {
    base_dir.join("pcm").join(project_id).join(sample_rate.to_string())
}

/// Returns the raw PCM file path:
/// `{base_dir}/pcm/{project_id}/{sample_rate}/{track_id}.pcm`
pub fn get_track_pcm_path(base_dir: &Path, project_id: &str, sample_rate: u32, track_id: &str) -> PathBuf {
    get_project_cache_dir(base_dir, project_id, sample_rate).join(format!("{track_id}.pcm"))
}

/// Returns the track metadata JSON path:
/// `{base_dir}/pcm/{project_id}/{sample_rate}/{track_id}.json`
pub fn get_track_json_path(base_dir: &Path, project_id: &str, sample_rate: u32, track_id: &str) -> PathBuf {
    get_project_cache_dir(base_dir, project_id, sample_rate).join(format!("{track_id}.json"))
}

/// Atomically writes PCM samples (`i16` little-endian) and metadata JSON to disk.
pub fn write_track_pcm_and_metadata(
    base_dir: &Path,
    project_id: &str,
    metadata: &TrackPcmMetadata,
    pcm_samples: &[i16],
) -> Result<(), String> {
    let cache_dir = get_project_cache_dir(base_dir, project_id, metadata.target_sample_rate);
    fs::create_dir_all(&cache_dir).map_err(|e| format!("No se pudo crear carpeta de caché: {e}"))?;

    let pcm_path = get_track_pcm_path(base_dir, project_id, metadata.target_sample_rate, &metadata.track_id);
    let json_path = get_track_json_path(base_dir, project_id, metadata.target_sample_rate, &metadata.track_id);

    let tmp_pcm = pcm_path.with_extension("pcm.tmp");
    let tmp_json = json_path.with_extension("json.tmp");

    // 1. Write PCM file via buffer
    {
        let file = File::create(&tmp_pcm).map_err(|e| format!("Error creando archivo PCM temporal: {e}"))?;
        let mut writer = BufWriter::new(file);
        for &sample in pcm_samples {
            writer
                .write_all(&sample.to_le_bytes())
                .map_err(|e| format!("Error escribiendo PCM: {e}"))?;
        }
        writer.flush().map_err(|e| format!("Error en flush de PCM: {e}"))?;
    }

    // 2. Write JSON metadata
    {
        let json_str = serde_json::to_string_pretty(metadata)
            .map_err(|e| format!("Error serializando metadatos JSON: {e}"))?;
        fs::write(&tmp_json, json_str).map_err(|e| format!("Error escribiendo JSON temporal: {e}"))?;
    }

    // 3. Atomic rename
    fs::rename(&tmp_pcm, &pcm_path).map_err(|e| format!("Error al renombrar archivo PCM definitivo: {e}"))?;
    fs::rename(&tmp_json, &json_path).map_err(|e| format!("Error al renombrar archivo JSON definitivo: {e}"))?;

    Ok(())
}

/// Reads the metadata JSON for a track from disk.
pub fn read_track_metadata(
    base_dir: &Path,
    project_id: &str,
    sample_rate: u32,
    track_id: &str,
) -> Result<TrackPcmMetadata, String> {
    let json_path = get_track_json_path(base_dir, project_id, sample_rate, track_id);
    if !json_path.exists() {
        return Err(format!("Metadatos no encontrados: {:?}", json_path));
    }
    let data = fs::read_to_string(&json_path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("JSON corrupto en {:?}: {e}", json_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_effectively_mono_identical() {
        let left = vec![0.1, 0.5, -0.3, 0.8, -0.2];
        let right = left.clone();
        assert!(is_effectively_mono(&left, &right));
    }

    #[test]
    fn test_is_effectively_mono_true_stereo() {
        let left = vec![0.5, 0.4, 0.6, 0.5, 0.5];
        let right = vec![-0.5, -0.4, -0.6, -0.5, -0.5]; // completely out of phase
        assert!(!is_effectively_mono(&left, &right));
    }

    #[test]
    fn test_extract_waveform_peaks_buckets() {
        let data: Vec<f32> = (0..3200).map(|i| (i as f32 / 3200.0) * 0.9).collect();
        let peaks = extract_waveform_peaks(&data, 320);
        assert_eq!(peaks.len(), 320);
        assert!(peaks[0] <= peaks[319]);
        assert!(peaks[319] <= 1.0);
    }

    #[test]
    fn test_pcm_and_metadata_write_and_read() {
        let temp_dir = std::env::temp_dir().join(format!("omnitracks_cache_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let project_id = "proj_test_1";
        let track_id = "track_drums";
        let sample_rate = 48000;

        let meta = TrackPcmMetadata {
            format_version: CACHE_FORMAT_VERSION,
            track_id: track_id.to_string(),
            target_sample_rate: sample_rate,
            original_sample_rate: 44100,
            original_channels: 2,
            channels: 1,
            is_effectively_mono: true,
            frame_count: 4800,
            duration_sec: 0.1,
            peaks: vec![0.5; 320],
            created_at: "2026-11-10T16:00:00Z".to_string(),
        };

        let samples: Vec<i16> = (0..4800).map(|i| (i % 3000) as i16).collect();

        write_track_pcm_and_metadata(&temp_dir, project_id, &meta, &samples).unwrap();
        let loaded = read_track_metadata(&temp_dir, project_id, sample_rate, track_id).unwrap();

        assert_eq!(meta, loaded);

        let pcm_path = get_track_pcm_path(&temp_dir, project_id, sample_rate, track_id);
        assert!(pcm_path.exists());
        assert_eq!(pcm_path.metadata().unwrap().len(), (4800 * 2) as u64);

        let _ = fs::remove_dir_all(temp_dir);
    }
}
