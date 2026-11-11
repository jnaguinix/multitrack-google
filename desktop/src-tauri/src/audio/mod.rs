pub mod cache;
pub mod import;
pub mod output;
pub mod playback;

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

    let total_tracks = files.len();
    let cancel_flag = state.create_import_cancel_flag(&project_id).await;

    let semaphore = Arc::new(tokio::sync::Semaphore::new(2)); // Max 2 concurrent track decoders
    let mut tasks = Vec::new();

    for (idx, file) in files.into_iter().enumerate() {
        let sem = Arc::clone(&semaphore);
        let flag = Arc::clone(&cancel_flag);
        let app_clone = app.clone();
        let local_data_clone = local_data.clone();
        let proj_id_clone = project_id.clone();

        tasks.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.map_err(|e| e.to_string())?;

            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("Cancelado por el usuario".to_string());
            }

            let input_path = Path::new(&file.file_path);
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

            let res = import::decode_and_cache_track(
                &local_data_clone,
                &proj_id_clone,
                &file.track_id,
                input_path,
                sample_rate,
                Some(&flag),
            );

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
) -> Result<playback::ProjectLoadInfo, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    let settings = state.current_settings.lock().await;
    let sr = settings.sample_rate.unwrap_or(48000);

    state.playback.load_project(&local_data, &project_id, sr).await
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
) -> Result<(), String> {
    state
        .playback
        .set_track_controls(&track_id, gain, pan, muted, soloed)
        .await;
    Ok(())
}
