pub mod output;

use output::{
    AudioDeviceInfo, AudioEngineState, AudioSettings, TestToneResult,
};
use std::sync::Arc;
use tauri::State;

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
pub async fn audio_test_tone(
    state: State<'_, AudioEngineState>,
    device_name: Option<String>,
    channel: u16,
    frequency: Option<f32>,
    duration_ms: Option<u64>,
) -> Result<TestToneResult, String> {
    let freq = frequency.unwrap_or(440.0);
    let dur = duration_ms.unwrap_or(1200);

    let (stream, result) = output::play_test_tone(device_name.as_deref(), channel, freq, dur)?;

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
