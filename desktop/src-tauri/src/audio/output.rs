use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    pub host: String,
    pub device_name: Option<String>,
    pub sample_rate: Option<u32>,
    pub buffer_size: Option<u32>,
    pub test_channel: Option<u16>,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            host: "WASAPI".to_string(),
            device_name: None,
            sample_rate: None,
            buffer_size: None,
            test_channel: Some(0),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub host: String,
    pub is_default: bool,
    pub channels: u16,
    pub default_sample_rate: u32,
    pub supported_sample_rates: Vec<u32>,
    pub min_buffer_size: Option<u32>,
    pub max_buffer_size: Option<u32>,
    pub sample_format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestToneResult {
    pub success: bool,
    pub channel: u16,
    pub channels: u16,
    pub sample_rate: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Default)]
pub struct AudioStreamStats {
    pub underruns: AtomicU64,
    pub callbacks: AtomicU64,
    pub max_callback_duration_us: AtomicU64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamStatsSnapshot {
    pub underruns: u64,
    pub callbacks: u64,
    pub max_callback_duration_us: u64,
}

pub struct AudioEngineState {
    pub active_test_stream: Arc<Mutex<Option<cpal::Stream>>>,
    pub settings_path: PathBuf,
    pub current_settings: Mutex<AudioSettings>,
    pub stats: Arc<AudioStreamStats>,
    pub import_cancellation: Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
}

impl AudioEngineState {
    pub fn new(settings_path: PathBuf) -> Self {
        let initial_settings = load_settings_from_disk(&settings_path).unwrap_or_default();
        Self {
            active_test_stream: Arc::new(Mutex::new(None)),
            settings_path,
            current_settings: Mutex::new(initial_settings),
            stats: Arc::new(AudioStreamStats::default()),
            import_cancellation: Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub async fn create_import_cancel_flag(&self, project_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut map = self.import_cancellation.lock().await;
        map.insert(project_id.to_string(), Arc::clone(&flag));
        flag
    }

    pub async fn cancel_import(&self, project_id: &str) {
        let map = self.import_cancellation.lock().await;
        if let Some(flag) = map.get(project_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub async fn clear_import_cancel_flag(&self, project_id: &str) {
        let mut map = self.import_cancellation.lock().await;
        map.remove(project_id);
    }

    pub fn get_stats(&self) -> AudioStreamStatsSnapshot {
        AudioStreamStatsSnapshot {
            underruns: self.stats.underruns.load(Ordering::Relaxed),
            callbacks: self.stats.callbacks.load(Ordering::Relaxed),
            max_callback_duration_us: self.stats.max_callback_duration_us.load(Ordering::Relaxed),
        }
    }
}

pub fn load_settings_from_disk(path: &Path) -> Result<AudioSettings, String> {
    if !path.exists() {
        return Ok(AudioSettings::default());
    }
    let data = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

pub fn save_settings_to_disk(path: &Path, settings: &AudioSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("tmp");
    std::fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn get_device_name<D: DeviceTrait>(device: &D) -> String {
    device
        .description()
        .map(|desc| desc.name().to_string())
        .unwrap_or_else(|_| device.to_string())
}

pub fn list_hosts() -> Vec<String> {
    let mut hosts = Vec::new();
    for host_id in cpal::available_hosts() {
        hosts.push(host_id.name().to_string());
    }
    if hosts.is_empty() {
        hosts.push("WASAPI".to_string());
    }
    hosts
}

pub fn list_devices(host_name: Option<&str>) -> Result<Vec<AudioDeviceInfo>, String> {
    let host = if let Some(name) = host_name {
        let host_id = cpal::available_hosts()
            .into_iter()
            .find(|h| h.name().eq_ignore_ascii_case(name))
            .ok_or_else(|| format!("Host de audio '{name}' no disponible"))?;
        cpal::host_from_id(host_id).map_err(|e| e.to_string())?
    } else {
        cpal::default_host()
    };

    let default_device_name = host.default_output_device().map(|d| get_device_name(&d));
    let devices = host.output_devices().map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for dev in devices {
        let name = get_device_name(&dev);
        let is_default = default_device_name.as_deref() == Some(&name);

        let default_config = match dev.default_output_config() {
            Ok(c) => c,
            Err(_) => continue,
        };

        let channels = default_config.channels();
        let default_sample_rate = default_config.sample_rate();
        let sample_format = match default_config.sample_format() {
            cpal::SampleFormat::F32 => "f32".to_string(),
            cpal::SampleFormat::I16 => "i16".to_string(),
            cpal::SampleFormat::U16 => "u16".to_string(),
            other => format!("{other:?}"),
        };

        let mut rates = Vec::new();
        if let Ok(supported) = dev.supported_output_configs() {
            for range in supported {
                let min_r = range.min_sample_rate();
                let max_r = range.max_sample_rate();
                if min_r == max_r {
                    if !rates.contains(&min_r) {
                        rates.push(min_r);
                    }
                } else {
                    for &std_rate in &[44100, 48000, 88200, 96000, 176400, 192000] {
                        if std_rate >= min_r && std_rate <= max_r && !rates.contains(&std_rate) {
                            rates.push(std_rate);
                        }
                    }
                }
            }
        }
        if rates.is_empty() {
            rates.push(default_sample_rate);
        }
        rates.sort_unstable();

        let (min_buf, max_buf) = match default_config.buffer_size() {
            cpal::SupportedBufferSize::Range { min, max } => (Some(*min), Some(*max)),
            cpal::SupportedBufferSize::Unknown => (None, None),
        };

        result.push(AudioDeviceInfo {
            id: name.clone(),
            name,
            host: host.id().name().to_string(),
            is_default,
            channels,
            default_sample_rate,
            supported_sample_rates: rates,
            min_buffer_size: min_buf,
            max_buffer_size: max_buf,
            sample_format,
        });
    }

    Ok(result)
}

pub fn play_test_tone(
    device_name: Option<&str>,
    channel: u16,
    frequency: f32,
    duration_ms: u64,
    stats: Option<Arc<AudioStreamStats>>,
) -> Result<(cpal::Stream, TestToneResult), String> {
    let host = cpal::default_host();
    let device = if let Some(name) = device_name {
        host.output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| get_device_name(d) == name)
            .ok_or_else(|| format!("Dispositivo de salida '{name}' no encontrado"))?
    } else {
        host.default_output_device()
            .ok_or_else(|| "No hay dispositivo de salida predeterminado en Windows".to_string())?
    };

    let supported_config = device.default_output_config().map_err(|e| e.to_string())?;
    let sample_rate = supported_config.sample_rate();
    let channels = supported_config.channels();
    let target_channel = channel as usize;

    if target_channel >= channels as usize {
        return Err(format!(
            "Canal {} fuera de rango (el dispositivo sólo dispone de {} salidas)",
            channel + 1,
            channels
        ));
    }

    let total_samples = ((duration_ms as f64 / 1000.0) * (sample_rate as f64)) as u64;
    let fade_samples = ((0.010 * sample_rate as f32) as u64).max(1); // 10 ms suave anti-clic

    let samples_rendered = Arc::new(AtomicU64::new(0));
    let samples_rendered_clone = Arc::clone(&samples_rendered);

    let mut config: cpal::StreamConfig = supported_config.into();
    config.buffer_size = cpal::BufferSize::Fixed(512);
    let sample_format = device.default_output_config().map_err(|e| e.to_string())?.sample_format();
    let num_channels = channels as usize;

    let err_fn = |err| {
        tracing::error!("CPAL test tone stream error: {}", err);
    };

    let stats_f32 = stats.clone();
    let stats_i16 = stats.clone();

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let mut phase: f32 = 0.0;
            let phase_inc = 2.0 * std::f32::consts::PI * frequency / (sample_rate as f32);

            device.build_output_stream(
                config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    let start_time = std::time::Instant::now();
                    if let Some(ref st) = stats_f32 {
                        st.callbacks.fetch_add(1, Ordering::Relaxed);
                    }

                    let mut idx = 0;
                    while idx < data.len() {
                        let current_sample_idx = samples_rendered_clone.fetch_add(1, Ordering::Relaxed);
                        if current_sample_idx >= total_samples {
                            for c in 0..num_channels {
                                if idx + c < data.len() {
                                    data[idx + c] = 0.0;
                                }
                            }
                        } else {
                            let env = if current_sample_idx < fade_samples {
                                current_sample_idx as f32 / fade_samples as f32
                            } else if current_sample_idx + fade_samples >= total_samples {
                                (total_samples - current_sample_idx) as f32 / fade_samples as f32
                            } else {
                                1.0
                            };

                            let sample_val = (phase.sin() * 0.28) * env; // -11 dBFS seguro
                            phase += phase_inc;
                            if phase > 2.0 * std::f32::consts::PI {
                                phase -= 2.0 * std::f32::consts::PI;
                            }

                            for c in 0..num_channels {
                                if idx + c < data.len() {
                                    data[idx + c] = if c == target_channel { sample_val } else { 0.0 };
                                }
                            }
                        }
                        idx += num_channels;
                    }

                    if let Some(ref st) = stats_f32 {
                        let elapsed_us = start_time.elapsed().as_micros() as u64;
                        let mut current_max = st.max_callback_duration_us.load(Ordering::Relaxed);
                        while elapsed_us > current_max {
                            match st.max_callback_duration_us.compare_exchange_weak(
                                current_max,
                                elapsed_us,
                                Ordering::Relaxed,
                                Ordering::Relaxed,
                            ) {
                                Ok(_) => break,
                                Err(actual) => current_max = actual,
                            }
                        }
                    }
                },
                err_fn,
                None,
            ).map_err(|e| e.to_string())?
        }
        cpal::SampleFormat::I16 => {
            let mut phase: f32 = 0.0;
            let phase_inc = 2.0 * std::f32::consts::PI * frequency / (sample_rate as f32);

            device.build_output_stream(
                config,
                move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                    let start_time = std::time::Instant::now();
                    if let Some(ref st) = stats_i16 {
                        st.callbacks.fetch_add(1, Ordering::Relaxed);
                    }

                    let mut idx = 0;
                    while idx < data.len() {
                        let current_sample_idx = samples_rendered_clone.fetch_add(1, Ordering::Relaxed);
                        if current_sample_idx >= total_samples {
                            for c in 0..num_channels {
                                if idx + c < data.len() {
                                    data[idx + c] = 0;
                                }
                            }
                        } else {
                            let env = if current_sample_idx < fade_samples {
                                current_sample_idx as f32 / fade_samples as f32
                            } else if current_sample_idx + fade_samples >= total_samples {
                                (total_samples - current_sample_idx) as f32 / fade_samples as f32
                            } else {
                                1.0
                            };

                            let sample_val = (phase.sin() * 0.28 * 32767.0 * env) as i16;
                            phase += phase_inc;
                            if phase > 2.0 * std::f32::consts::PI {
                                phase -= 2.0 * std::f32::consts::PI;
                            }

                            for c in 0..num_channels {
                                if idx + c < data.len() {
                                    data[idx + c] = if c == target_channel { sample_val } else { 0 };
                                }
                            }
                        }
                        idx += num_channels;
                    }

                    if let Some(ref st) = stats_i16 {
                        let elapsed_us = start_time.elapsed().as_micros() as u64;
                        let mut current_max = st.max_callback_duration_us.load(Ordering::Relaxed);
                        while elapsed_us > current_max {
                            match st.max_callback_duration_us.compare_exchange_weak(
                                current_max,
                                elapsed_us,
                                Ordering::Relaxed,
                                Ordering::Relaxed,
                            ) {
                                Ok(_) => break,
                                Err(actual) => current_max = actual,
                            }
                        }
                    }
                },
                err_fn,
                None,
            ).map_err(|e| e.to_string())?
        }
        other => return Err(format!("Formato de muestra '{other:?}' no soportado para tono de prueba")),
    };

    stream.play().map_err(|e| e.to_string())?;

    Ok((
        stream,
        TestToneResult {
            success: true,
            channel,
            channels,
            sample_rate,
            duration_ms,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audio_settings_default_and_serialization() {
        let settings = AudioSettings::default();
        assert_eq!(settings.host, "WASAPI");
        assert_eq!(settings.device_name, None);
        assert_eq!(settings.test_channel, Some(0));

        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: AudioSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(settings, deserialized);
    }

    #[test]
    fn test_save_and_load_settings() {
        let temp_dir = std::env::temp_dir().join(format!("omnitracks_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let file_path = temp_dir.join("audio_settings.json");

        let mut settings = AudioSettings::default();
        settings.device_name = Some("Test Audio Device".to_string());
        settings.sample_rate = Some(48000);
        settings.test_channel = Some(2);

        save_settings_to_disk(&file_path, &settings).unwrap();
        let loaded = load_settings_from_disk(&file_path).unwrap();
        assert_eq!(settings, loaded);

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_list_hosts_contains_wasapi() {
        let hosts = list_hosts();
        assert!(!hosts.is_empty());
        assert!(hosts.iter().any(|h| h.eq_ignore_ascii_case("wasapi")));
    }

    #[test]
    fn test_audio_engine_state_and_stats() {
        let temp_dir = std::env::temp_dir().join(format!("omnitracks_test_stats_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let file_path = temp_dir.join("audio_settings.json");
        let state = AudioEngineState::new(file_path);

        let initial_stats = state.get_stats();
        assert_eq!(initial_stats.callbacks, 0);
        assert_eq!(initial_stats.underruns, 0);
        assert_eq!(initial_stats.max_callback_duration_us, 0);

        state.stats.callbacks.fetch_add(42, Ordering::Relaxed);
        state.stats.underruns.fetch_add(1, Ordering::Relaxed);
        state.stats.max_callback_duration_us.store(150, Ordering::Relaxed);

        let updated_stats = state.get_stats();
        assert_eq!(updated_stats.callbacks, 42);
        assert_eq!(updated_stats.underruns, 1);
        assert_eq!(updated_stats.max_callback_duration_us, 150);

        let _ = std::fs::remove_dir_all(temp_dir);
    }
}
