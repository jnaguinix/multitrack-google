pub mod cache;
pub mod import;
pub mod output;

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

    let total_tracks = files.len();
    let mut tracks = Vec::new();
    let mut errors = Vec::new();

    for (idx, file) in files.iter().enumerate() {
        let input_path = Path::new(&file.file_path);
        let track_name = input_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Pista")
            .to_string();

        let _ = app.emit(
            "audio://import-progress",
            ImportProgressEvent {
                project_id: project_id.clone(),
                track_index: idx,
                total_tracks,
                track_name: track_name.clone(),
                percent: (idx as f32 / total_tracks.max(1) as f32) * 100.0,
                completed: false,
            },
        );

        match import::decode_and_cache_track(
            &local_data,
            &project_id,
            &file.track_id,
            input_path,
            sample_rate,
        ) {
            Ok(meta) => tracks.push(meta),
            Err(e) => errors.push(format!("{track_name}: {e}")),
        }
    }

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

    Ok(ImportResult { tracks, errors })
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
