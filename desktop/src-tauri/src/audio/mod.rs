use serde::{Deserialize, Serialize};
pub mod cache;
pub mod import;
pub mod metronome;
pub mod output;
pub mod playback;
pub mod resampler;

use cache::{read_track_metadata, ImportProgressEvent, ProjectCacheStatus};
use import::{ImportResult, ImportTrackFile};
use output::{
    AudioDeviceInfo, AudioEngineState, AudioSettings, AudioStreamStatsSnapshot, TestToneResult,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

#[tauri::command]
pub async fn audio_list_hosts() -> Result<Vec<String>, String> {
    Ok(output::list_hosts())
}

#[tauri::command]
pub async fn audio_list_devices(host: Option<String>) -> Result<Vec<AudioDeviceInfo>, String> {
    output::list_devices(host.as_deref())
}

#[tauri::command]
pub async fn audio_get_config(
    state: State<'_, AudioEngineState>,
) -> Result<AudioSettings, String> {
    let settings = state.current_settings.lock().await;
    Ok(settings.clone())
}

#[tauri::command]
pub async fn audio_set_config(
    state: State<'_, AudioEngineState>,
    settings: AudioSettings,
) -> Result<(), String> {
    output::save_settings_to_disk(&state.settings_path, &settings)?;
    let mut current = state.current_settings.lock().await;
    *current = settings;
    Ok(())
}

#[tauri::command]
pub async fn audio_get_stats(
    state: State<'_, AudioEngineState>,
) -> Result<AudioStreamStatsSnapshot, String> {
    Ok(state.get_stats())
}

#[tauri::command]
pub async fn audio_reset_stats(
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state.reset_stats();
    Ok(())
}

#[tauri::command]
pub async fn audio_test_tone(
    state: State<'_, AudioEngineState>,
    device_name: Option<String>,
    channel: u16,
    frequency: Option<f32>,
    duration_ms: Option<u64>,
) -> Result<TestToneResult, String> {
    let freq = frequency.unwrap_or(440.0);
    let dur = duration_ms.unwrap_or(1200);

    let (stream, result) = output::play_test_tone(
        device_name.as_deref(),
        channel,
        freq,
        dur,
        Some(Arc::clone(&state.stats)),
    )?;

    let active_slot = Arc::clone(&state.active_test_stream);
    {
        let mut active = active_slot.lock().await;
        *active = Some(stream);
    }

    // Clean up stream safely after tone finishes
    let stream_to_cleanup = Arc::clone(&active_slot);
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(dur + 150)).await;
        let mut active = stream_to_cleanup.lock().await;
        *active = None;
    });

    Ok(result)
}

#[tauri::command]
pub async fn audio_cancel_import(
    state: State<'_, AudioEngineState>,
    project_id: String,
) -> Result<(), String> {
    state.cancel_import(&project_id).await;
    Ok(())
}

#[tauri::command]
pub async fn audio_import_tracks(
    app: tauri::AppHandle,
    state: State<'_, AudioEngineState>,
    project_id: String,
    files: Vec<ImportTrackFile>,
    target_sample_rate: Option<u32>,
) -> Result<ImportResult, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let sample_rate = if let Some(r) = target_sample_rate {
        r
    } else {
        let settings = state.current_settings.lock().await;
        settings.sample_rate.unwrap_or(48000)
    };

    // 1. Check free disk space before starting (with 1.2x safety margin)
    let mut total_estimated_needed: u64 = 0;
    for file in &files {
        let size = std::fs::metadata(&file.file_path).map(|m| m.len()).unwrap_or(20 * 1024 * 1024);
        total_estimated_needed += (size * 4).max(10 * 1024 * 1024);
    }
    cache::check_free_disk_space(&local_data, total_estimated_needed)?;

    let start_all = std::time::Instant::now();
    let total_tracks = files.len();
    let cancel_flag = state.create_import_cancel_flag(&project_id).await;

    // Use up to 3-4 concurrent workers on multi-core systems to decode rapidly without starving I/O
    let concurrency = std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(2, 4))
        .unwrap_or(2);
    let semaphore = Arc::new(tokio::sync::Semaphore::new(concurrency));
    let mut tasks = Vec::new();

    for (idx, file) in files.into_iter().enumerate() {
        let sem = Arc::clone(&semaphore);
        let flag = Arc::clone(&cancel_flag);
        let app_clone = app.clone();
        let local_data_clone = local_data.clone();
        let proj_id_clone = project_id.clone();

        tasks.push(tokio::spawn(async move {
            let permit = sem.acquire_owned().await.map_err(|e| e.to_string())?;

            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("Cancelado por el usuario".to_string());
            }

            let input_path = std::path::PathBuf::from(&file.file_path);
            let track_name = input_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Pista")
                .to_string();

            let _ = app_clone.emit(
                "audio://import-progress",
                ImportProgressEvent {
                    project_id: proj_id_clone.clone(),
                    track_index: idx,
                    total_tracks,
                    track_name: track_name.clone(),
                    percent: (idx as f32 / total_tracks.max(1) as f32) * 100.0,
                    completed: false,
                },
            );

            let res = tokio::task::spawn_blocking(move || {
                let _permit_guard = permit;
                import::decode_and_cache_track(
                    &local_data_clone,
                    &proj_id_clone,
                    &file.track_id,
                    &input_path,
                    sample_rate,
                    Some(&flag),
                )
            })
            .await
            .map_err(|e| format!("Fallo en tarea blocking: {e}"))?;

            match res {
                Ok(meta) => Ok(meta),
                Err(e) => Err(format!("{track_name}: {e}")),
            }
        }));
    }

    let mut tracks = Vec::new();
    let mut errors = Vec::new();

    for task in tasks {
        match task.await {
            Ok(Ok(meta)) => tracks.push(meta),
            Ok(Err(e)) => errors.push(e),
            Err(e) => errors.push(e.to_string()),
        }
    }

    state.clear_import_cancel_flag(&project_id).await;

    let total_dur = start_all.elapsed();
    tracing::info!(
        "[Import Perf] Canción '{}' completada: {} pistas procesadas en {:?}",
        project_id,
        tracks.len(),
        total_dur
    );

    let is_cancelled = cancel_flag.load(std::sync::atomic::Ordering::Relaxed);
    if !is_cancelled {
        let _ = app.emit(
            "audio://import-progress",
            ImportProgressEvent {
                project_id: project_id.clone(),
                track_index: total_tracks,
                total_tracks,
                track_name: "Completado".to_string(),
                percent: 100.0,
                completed: true,
            },
        );
    }

    Ok(ImportResult { tracks, errors })
}

#[tauri::command]
pub async fn audio_import_track_bytes(
    app: tauri::AppHandle,
    state: State<'_, AudioEngineState>,
    project_id: String,
    track_id: String,
    file_name: String,
    bytes: Vec<u8>,
    target_sample_rate: Option<u32>,
) -> Result<cache::TrackPcmMetadata, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let sample_rate = if let Some(r) = target_sample_rate {
        r
    } else {
        let settings = state.current_settings.lock().await;
        settings.sample_rate.unwrap_or(48000)
    };

    cache::check_free_disk_space(&local_data, (bytes.len() as u64) * 4)?;

    let cancel_flag = state.create_import_cancel_flag(&project_id).await;
    let cancel_ref = Some(cancel_flag.as_ref());

    import::decode_and_cache_track_bytes(
        &local_data,
        &project_id,
        &track_id,
        &file_name,
        bytes,
        sample_rate,
        cancel_ref,
    )
}

#[tauri::command]
pub async fn audio_import_folder(
    app: tauri::AppHandle,
    state: State<'_, AudioEngineState>,
    project_id: String,
    folder_path: String,
    target_sample_rate: Option<u32>,
) -> Result<ImportResult, String> {
    let _local_data = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let sample_rate = if let Some(r) = target_sample_rate {
        r
    } else {
        let settings = state.current_settings.lock().await;
        settings.sample_rate.unwrap_or(48000)
    };

    let p = Path::new(&folder_path);
    if !p.exists() || !p.is_dir() {
        return Err(format!("La carpeta '{}' no existe en disco", folder_path));
    }

    let entries = std::fs::read_dir(p)
        .map_err(|e| format!("Error leyendo carpeta '{}': {e}", folder_path))?;

    let audio_extensions = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];
    let mut files_to_import = Vec::new();

    // Check if omnitracks.project.json exists in this folder to keep existing track IDs
    let sidecar_path = p.join("omnitracks.project.json");
    let mut sidecar_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if sidecar_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&sidecar_path) {
            if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(tracks_arr) = json_val.get("tracks").and_then(|t| t.as_array()) {
                    for t in tracks_arr {
                        if let (Some(id), Some(name)) = (
                            t.get("id").and_then(|i| i.as_str()),
                            t.get("name").and_then(|n| n.as_str()),
                        ) {
                            sidecar_map.insert(name.to_lowercase(), id.to_string());
                        }
                    }
                }
            }
        }
    }

    let mut idx = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) {
                if audio_extensions.contains(&ext.as_str()) {
                    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
                    let file_stem_lower = file_stem.to_lowercase();
                    
                    // Match track ID from sidecar if possible, else generate stable stem ID
                    let track_id = if let Some(matched_id) = sidecar_map.get(&file_stem_lower) {
                        matched_id.clone()
                    } else {
                        format!("stem-{:02}", idx)
                    };
                    idx += 1;

                    files_to_import.push(ImportTrackFile {
                        file_path: path.to_string_lossy().to_string(),
                        track_id,
                    });
                }
            }
        }
    }

    if files_to_import.is_empty() {
        return Err(format!("No se encontraron archivos de audio compatibles (.mp3, .wav, .flac, .ogg, .m4a) en '{}'", folder_path));
    }

    audio_import_tracks(app, state, project_id, files_to_import, Some(sample_rate)).await
}

#[tauri::command]
pub async fn audio_get_project_cache_status(
    app: tauri::AppHandle,
    state: State<'_, AudioEngineState>,
    project_id: String,
    sample_rate: Option<u32>,
    track_ids: Vec<String>,
) -> Result<ProjectCacheStatus, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let rate = if let Some(r) = sample_rate {
        r
    } else {
        let settings = state.current_settings.lock().await;
        settings.sample_rate.unwrap_or(48000)
    };

    let total_tracks_count = track_ids.len();
    let mut cached_tracks = Vec::new();

    for track_id in &track_ids {
        if let Ok(meta) = read_track_metadata(&local_data, &project_id, rate, track_id) {
            let pcm_path = cache::get_track_pcm_path(&local_data, &project_id, rate, track_id);
            if pcm_path.exists() {
                cached_tracks.push(meta);
            }
        }
    }

    let cached_tracks_count = cached_tracks.len();
    let is_ready = total_tracks_count > 0 && cached_tracks_count == total_tracks_count;

    Ok(ProjectCacheStatus {
        project_id,
        sample_rate: rate,
        is_ready,
        cached_tracks_count,
        total_tracks_count,
        tracks: cached_tracks,
    })
}

#[tauri::command]
pub async fn audio_load_project(
    app: tauri::AppHandle,
    state: State<'_, AudioEngineState>,
    project_id: String,
    bpm: Option<f32>,
    beats_per_bar: Option<u32>,
    sections: Option<Vec<playback::NativeSongSection>>,
    quantize_mode: Option<String>,
) -> Result<playback::ProjectLoadInfo, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    let settings = state.current_settings.lock().await;
    let sr = settings.sample_rate.unwrap_or(48000);

    state
        .playback
        .load_project(
            &local_data,
            &project_id,
            sr,
            bpm,
            beats_per_bar,
            sections,
            quantize_mode,
        )
        .await
}

#[tauri::command]
pub async fn audio_play(state: State<'_, AudioEngineState>) -> Result<(), String> {
    state.playback.play(&state).await
}

#[tauri::command]
pub async fn audio_pause(state: State<'_, AudioEngineState>) -> Result<(), String> {
    state.playback.pause().await;
    Ok(())
}

#[tauri::command]
pub async fn audio_stop(state: State<'_, AudioEngineState>) -> Result<(), String> {
    state.playback.stop().await;
    Ok(())
}

#[tauri::command]
pub async fn audio_seek(
    state: State<'_, AudioEngineState>,
    position_sec: f64,
) -> Result<(), String> {
    state.playback.seek(position_sec).await;
    Ok(())
}

#[tauri::command]
pub async fn audio_get_playback_state(
    state: State<'_, AudioEngineState>,
) -> Result<playback::PlaybackStateSnapshot, String> {
    Ok(state.playback.get_playback_state())
}

#[tauri::command]
pub async fn audio_set_track_controls(
    state: State<'_, AudioEngineState>,
    track_id: String,
    gain: Option<f32>,
    pan: Option<i32>,
    muted: Option<bool>,
    soloed: Option<bool>,
    bus: Option<String>,
) -> Result<(), String> {
    state
        .playback
        .set_track_controls(&track_id, gain, pan, muted, soloed, bus.as_deref())
        .await;
    Ok(())
}

#[tauri::command]
pub async fn audio_queue_jump(
    state: State<'_, AudioEngineState>,
    section_id: String,
    mode: Option<String>,
) -> Result<playback::QueuedJumpInfo, String> {
    state.playback.queue_section_jump(&section_id, mode.as_deref()).await
}

#[tauri::command]
pub async fn audio_cancel_jump(
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state.playback.cancel_queued_jump().await;
    Ok(())
}

#[tauri::command]
pub async fn audio_toggle_vamp(
    state: State<'_, AudioEngineState>,
    enable: Option<bool>,
) -> Result<bool, String> {
    Ok(state.playback.toggle_vamp(enable).await)
}

#[tauri::command]
pub async fn audio_set_pitch(
    state: State<'_, AudioEngineState>,
    semitones: i32,
) -> Result<(), String> {
    state.playback.set_pitch(semitones).await;
    Ok(())
}

#[tauri::command]
pub async fn audio_set_metronome(
    state: State<'_, AudioEngineState>,
    config: metronome::MetronomeConfig,
) -> Result<(), String> {
    state.playback.set_metronome(config);
    Ok(())
}

#[tauri::command]
pub async fn audio_set_split_mono(
    state: State<'_, AudioEngineState>,
    enabled: bool,
) -> Result<(), String> {
    state.playback.set_split_mono(enabled);
    Ok(())
}

#[tauri::command]
pub async fn audio_configure_song(
    state: State<'_, AudioEngineState>,
    bpm: Option<f32>,
    beats_per_bar: Option<u32>,
    sections: Option<Vec<playback::NativeSongSection>>,
    quantize_mode: Option<String>,
) -> Result<(), String> {
    state.playback.configure_song(bpm, beats_per_bar, sections, quantize_mode);
    Ok(())
}

#[tauri::command]
pub async fn audio_preload_project(
    app: tauri::AppHandle,
    state: State<'_, AudioEngineState>,
    project_id: String,
) -> Result<(), String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    let settings = state.current_settings.lock().await;
    let sr = settings.sample_rate.unwrap_or(48000);

    state.playback.preload_project(&local_data, &project_id, sr).await
}

#[tauri::command]
pub async fn audio_set_master_gains(
    state: State<'_, AudioEngineState>,
    master_gain: Option<f32>,
    cue_master_gain: Option<f32>,
) -> Result<(), String> {
    state.playback.set_master_gains(master_gain, cue_master_gain);
    Ok(())
}

#[tauri::command]
pub async fn audio_switch_to_preloaded(
    app: tauri::AppHandle,
    state: State<'_, AudioEngineState>,
) -> Result<playback::ProjectLoadInfo, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    let settings = state.current_settings.lock().await;
    let sr = settings.sample_rate.unwrap_or(48000);

    state.playback.switch_to_preloaded(&local_data, sr).await
}

#[tauri::command]
pub async fn audio_reopen_stream(
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    state.playback.reopen_stream(&state).await
}


fn probe_wav_header_duration(path: &Path) -> Option<f64> {
    if let Ok(mut f) = std::fs::File::open(path) {
        use std::io::Read;
        let mut buf = [0u8; 44];
        if f.read_exact(&mut buf).is_ok() && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WAVE" {
            let channels = u16::from_le_bytes([buf[22], buf[23]]) as u32;
            let sample_rate = u32::from_le_bytes([buf[24], buf[25], buf[26], buf[27]]);
            let bits = u16::from_le_bytes([buf[34], buf[35]]) as u32;
            let data_size = u32::from_le_bytes([buf[40], buf[41], buf[42], buf[43]]);
            if channels > 0 && sample_rate > 0 && bits > 0 && data_size > 0 {
                let bytes_per_sec = sample_rate * channels * (bits / 8);
                if bytes_per_sec > 0 {
                    return Some(data_size as f64 / bytes_per_sec as f64);
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedAudioFile {
    pub file_path: String,
    pub file_name: String,
    pub track_name: String,
    pub track_id: String,
    pub est_duration_sec: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFolderInfo {
    pub folder_path: String,
    pub folder_name: String,
    pub title: String,
    pub artist: String,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub sections: Vec<playback::NativeSongSection>,
    pub files: Vec<ScannedAudioFile>,
}

#[tauri::command]
pub async fn audio_scan_folder(
    folder_path: String,
) -> Result<ScannedFolderInfo, String> {
    let p = Path::new(&folder_path);
    if !p.exists() || !p.is_dir() {
        return Err(format!("La carpeta '{}' no existe en disco", folder_path));
    }

    let folder_name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Canción")
        .to_string();

    let sidecar_path = p.join("omnitracks.project.json");
    let mut title = folder_name.clone();
    let mut artist = "Artista Desconocido".to_string();
    let mut bpm = None;
    let mut key = None;
    let mut sections = Vec::new();
    let mut sidecar_track_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    if sidecar_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&sidecar_path) {
            if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(t) = json_val.get("title").and_then(|v| v.as_str()) {
                    title = t.to_string();
                }
                if let Some(a) = json_val.get("artist").and_then(|v| v.as_str()) {
                    artist = a.to_string();
                }
                if let Some(b) = json_val.get("bpm").and_then(|v| v.as_f64()) {
                    bpm = Some(b);
                }
                if let Some(k) = json_val.get("keySignature").and_then(|v| v.as_str()) {
                    key = Some(k.to_string());
                }
                if let Some(sec_arr) = json_val.get("sections").and_then(|v| v.as_array()) {
                    for s in sec_arr {
                        if let (Some(id), Some(name), Some(start), Some(end)) = (
                            s.get("id").and_then(|v| v.as_str()),
                            s.get("name").and_then(|v| v.as_str()),
                            s.get("startTimeSec").and_then(|v| v.as_f64()),
                            s.get("endTimeSec").and_then(|v| v.as_f64()),
                        ) {
                            let code = s.get("code").and_then(|v| v.as_str()).map(|v| v.to_string());
                            sections.push(playback::NativeSongSection {
                                id: id.to_string(),
                                name: name.to_string(),
                                code,
                                start_sec: start,
                                end_sec: end,
                            });
                        }
                    }
                }
                if let Some(tracks_arr) = json_val.get("tracks").and_then(|v| v.as_array()) {
                    for t in tracks_arr {
                        if let (Some(id), Some(name)) = (
                            t.get("id").and_then(|v| v.as_str()),
                            t.get("name").and_then(|v| v.as_str()),
                        ) {
                            sidecar_track_ids.insert(name.to_lowercase(), id.to_string());
                        }
                    }
                }
            }
        }
    } else {
        let raw = folder_name.clone();
        if let Some(bpm_idx) = raw.to_lowercase().find("bpm") {
            let prefix = &raw[..bpm_idx];
            let num_str: String = prefix.chars().rev().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(parsed_bpm) = num_str.chars().rev().collect::<String>().parse::<f64>() {
                bpm = Some(parsed_bpm);
            }
        }
        if raw.contains(" - ") {
            let parts: Vec<&str> = raw.split(" - ").collect();
            title = parts[0].trim().to_string();
            artist = parts[1].trim().to_string();
        }
    }

    let audio_extensions = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];
    let mut files = Vec::new();
    let entries = std::fs::read_dir(p).map_err(|e| format!("Error leyendo carpeta: {e}"))?;

    let mut auto_idx = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) {
                if audio_extensions.contains(&ext.as_str()) {
                    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
                    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Pista").to_string();
                    let file_stem_lower = file_stem.to_lowercase();

                    let track_id = if let Some(matched_id) = sidecar_track_ids.get(&file_stem_lower) {
                        matched_id.clone()
                    } else {
                        auto_idx += 1;
                        format!("stem-{:02}", auto_idx)
                    };

                    let est_duration_sec = probe_wav_header_duration(&path);

                    files.push(ScannedAudioFile {
                        file_path: path.to_string_lossy().to_string(),
                        file_name,
                        track_name: file_stem,
                        track_id,
                        est_duration_sec,
                    });
                }
            }
        }
    }

    files.sort_by(|a, b| a.track_name.cmp(&b.track_name));

    Ok(ScannedFolderInfo {
        folder_path,
        folder_name,
        title,
        artist,
        bpm,
        key,
        sections,
        files,
    })
}

#[tauri::command]
pub async fn audio_scan_files(
    file_paths: Vec<String>,
) -> Result<ScannedFolderInfo, String> {
    if file_paths.is_empty() {
        return Err("No se especificaron archivos".to_string());
    }

    let first_path = std::path::PathBuf::from(&file_paths[0]);
    let parent = first_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| std::path::PathBuf::from("."));
    let folder_name = parent
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Importado")
        .to_string();

    let audio_extensions = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];
    let mut files = Vec::new();

    let mut auto_idx = 0;
    for fp in file_paths {
        let path = Path::new(&fp);
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) {
                if audio_extensions.contains(&ext.as_str()) {
                    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
                    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Pista").to_string();

                    auto_idx += 1;
                    let track_id = format!("stem-{:02}", auto_idx);
                    let est_duration_sec = probe_wav_header_duration(path);

                    files.push(ScannedAudioFile {
                        file_path: fp,
                        file_name,
                        track_name: file_stem,
                        track_id,
                        est_duration_sec,
                    });
                }
            }
        }
    }

    files.sort_by(|a, b| a.track_name.cmp(&b.track_name));

    let title = folder_name.clone();
    let artist = "Artista Desconocido".to_string();

    Ok(ScannedFolderInfo {
        folder_path: parent.to_string_lossy().to_string(),
        folder_name,
        title,
        artist,
        bpm: None,
        key: None,
        sections: Vec::new(),
        files,
    })
}

#[tauri::command]
pub async fn audio_import_track_bytes_raw(
    app: tauri::AppHandle,
    state: State<'_, AudioEngineState>,
    request: tauri::ipc::Request<'_>,
) -> Result<cache::TrackPcmMetadata, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("Se esperaba cuerpo binario crudo (InvokeBody::Raw)".into());
        }
    };
    let headers = request.headers();
    let project_id = headers
        .get("x-project-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Falta cabecera x-project-id".to_string())?
        .to_string();
    let track_id = headers
        .get("x-track-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Falta cabecera x-track-id".to_string())?
        .to_string();
    let file_name = headers
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().to_string())
        .unwrap_or_else(|| "track.mp3".to_string());
    let target_sample_rate = headers
        .get("x-sample-rate")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u32>().ok());

    let local_data = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let sample_rate = if let Some(r) = target_sample_rate {
        r
    } else {
        let settings = state.current_settings.lock().await;
        settings.sample_rate.unwrap_or(48000)
    };

    cache::check_free_disk_space(&local_data, (bytes.len() as u64) * 4)?;

    let cancel_flag = state.create_import_cancel_flag(&project_id).await;

    tokio::task::spawn_blocking(move || {
        import::decode_and_cache_track_bytes(
            &local_data,
            &project_id,
            &track_id,
            &file_name,
            bytes,
            sample_rate,
            Some(cancel_flag.as_ref()),
        )
    })
    .await
    .map_err(|e| format!("Fallo en tarea blocking de bytes: {e}"))?
}


fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(meta) = p.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NativeCacheStats {
    pub total_bytes: u64,
    pub project_count: usize,
    pub project_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CleanOrphanResult {
    pub freed_bytes: u64,
    pub deleted_count: usize,
}

#[tauri::command]
pub async fn audio_delete_project_cache(
    app: tauri::AppHandle,
    state: State<'_, AudioEngineState>,
    project_id: String,
) -> Result<(), String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    let pcm_base = local_data.join("pcm");
    let proj_dir = pcm_base.join(&project_id);
    if proj_dir.exists() {
        std::fs::remove_dir_all(&proj_dir)
            .map_err(|e| format!("Error eliminando carpeta de caché para '{project_id}': {e}"))?;
        tracing::info!("[Cache] Carpeta de caché eliminada para '{}'", project_id);
    }

    state.playback.unload_project_if_matches(&project_id).await;
    Ok(())
}

#[tauri::command]
pub async fn audio_get_cache_stats(
    app: tauri::AppHandle,
) -> Result<NativeCacheStats, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    let pcm_base = local_data.join("pcm");
    if !pcm_base.exists() {
        return Ok(NativeCacheStats {
            total_bytes: 0,
            project_count: 0,
            project_ids: Vec::new(),
        });
    }

    let mut total_bytes = 0u64;
    let mut project_ids = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&pcm_base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    project_ids.push(name.to_string());
                }
                total_bytes += dir_size(&path);
            }
        }
    }

    Ok(NativeCacheStats {
        total_bytes,
        project_count: project_ids.len(),
        project_ids,
    })
}

#[tauri::command]
pub async fn audio_clean_orphan_caches(
    app: tauri::AppHandle,
    valid_project_ids: Vec<String>,
) -> Result<CleanOrphanResult, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    let pcm_base = local_data.join("pcm");
    if !pcm_base.exists() {
        return Ok(CleanOrphanResult {
            freed_bytes: 0,
            deleted_count: 0,
        });
    }

    let valid_set: std::collections::HashSet<String> = valid_project_ids.into_iter().collect();
    let mut freed_bytes = 0u64;
    let mut deleted_count = 0usize;

    if let Ok(entries) = std::fs::read_dir(&pcm_base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(folder_name) = path.file_name().and_then(|s| s.to_str()) {
                    if !valid_set.contains(folder_name) {
                        let size = dir_size(&path);
                        if std::fs::remove_dir_all(&path).is_ok() {
                            freed_bytes += size;
                            deleted_count += 1;
                            tracing::info!(
                                "[Cache] Carpeta huérfana eliminada: '{}' ({} bytes)",
                                folder_name,
                                size
                            );
                        }
                    }
                }
            }
        }
    }

    Ok(CleanOrphanResult {
        freed_bytes,
        deleted_count,
    })
}

#[tauri::command]
pub async fn audio_check_files_exist(paths: Vec<String>) -> Result<Vec<bool>, String> {
    let results = paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            path.exists() && path.is_file()
        })
        .collect();
    Ok(results)
}
