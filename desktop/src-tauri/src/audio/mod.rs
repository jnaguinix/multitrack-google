use serde::{Deserialize, Serialize};
pub mod cache;
pub mod import;
pub mod loudness;
pub mod metronome;
pub mod output;
pub mod pitch;
pub mod playback;
pub mod resampler;
pub mod routing;
pub mod track_ids;

use cache::{ImportProgressEvent, ProjectCacheStatus};
use import::{ImportResult, ImportTrackFile};
use track_ids::{ids_for_files, sidecar_tracks_from_json, SidecarTrack};
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
    // Un cambio de dispositivo con el motor sonando se rechaza antes de guardar nada.
    let device_changed = state.playback.check_device_change(settings.device_name.as_deref())?;
    output::save_settings_to_disk(&state.settings_path, &settings)?;
    {
        let mut current = state.current_settings.lock().await;
        *current = settings;
    }
    // Estando en pausa, la salida se reabre ya en el dispositivo nuevo: si no se puede abrir (desconectado, otra
    // frecuencia…), el error llega ahora a Ajustes de audio y no en mitad del culto al pulsar Play.
    if device_changed {
        state.playback.reopen_stream(&state).await?;
    }
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

/// Encola el análisis de sonoridad de una canción, o de todas las del setlist si no se indica ninguna. Lo que ya está
/// medido y al día se omite en la propia cola. Devuelve cuántas canciones se encolaron.
#[tauri::command]
pub async fn audio_analyze_loudness(
    app: tauri::AppHandle,
    state: State<'_, AudioEngineState>,
    project_id: Option<String>,
) -> Result<usize, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;
    let preferred_rate = state.current_settings.lock().await.cache_rate();
    let ids = match project_id {
        Some(id) => vec![id],
        None => crate::library::setlist_song_ids(&local_data)?,
    };
    let mut queued = 0;
    for id in ids {
        // Sin caché todavía no hay nada que medir: se encolará al terminar de generarla.
        let Some(rate) = loudness::resolve_cache_rate(&local_data, &id, preferred_rate) else { continue };
        if state.loudness.enqueue(&app, &id, rate) {
            queued += 1;
        }
    }
    Ok(queued)
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
        output::effective_cache_rate(Some(r))
    } else {
        let settings = state.current_settings.lock().await;
        settings.cache_rate()
    };

    cache::validate_path_id(&project_id)?;
    // La caché de esta canción va a cambiar: lo que se estuviera midiendo ya no vale.
    state.loudness.cancel(&project_id);

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
    let tracker = Arc::new(import::ImportProgressTracker::new(total_tracks));
    let mut tasks = Vec::new();

    for file in files.into_iter() {
        let sem = Arc::clone(&semaphore);
        let flag = Arc::clone(&cancel_flag);
        let app_clone = app.clone();
        let local_data_clone = local_data.clone();
        let proj_id_clone = project_id.clone();
        let tracker_clone = Arc::clone(&tracker);

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

            let track_name_for_event = track_name.clone();
            let res = tokio::task::spawn_blocking(move || {
                let _permit_guard = permit;
                let on_phase = |phase: import::ImportPhase| {
                    let (percent, finished) = tracker_clone.advance(phase);
                    if let Err(e) = app_clone.emit(
                        "audio://import-progress",
                        ImportProgressEvent {
                            project_id: proj_id_clone.clone(),
                            // Pistas ya terminadas (no el índice de esta pista): los hilos van en paralelo.
                            track_index: finished,
                            total_tracks,
                            track_name: track_name_for_event.clone(),
                            percent,
                            completed: false,
                        },
                    ) {
                        tracing::warn!("No se pudo emitir el progreso de importación: {e}");
                    }
                };
                import::decode_and_cache_track_with_progress(
                    &local_data_clone,
                    &proj_id_clone,
                    &file.track_id,
                    &input_path,
                    sample_rate,
                    Some(&flag),
                    &on_phase,
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
    if !is_cancelled && errors.is_empty() && !tracks.is_empty() {
        // Caché completa: se mide su sonoridad en segundo plano (no compite con la reproducción).
        state.loudness.enqueue(&app, &project_id, sample_rate);
    }
    if !is_cancelled {
        if let Err(e) = app.emit(
            "audio://import-progress",
            ImportProgressEvent {
                project_id: project_id.clone(),
                track_index: total_tracks,
                total_tracks,
                track_name: "Completado".to_string(),
                percent: 100.0,
                completed: true,
            },
        ) {
            tracing::warn!("No se pudo emitir el evento final de importación: {e}");
        }
    }

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
        output::effective_cache_rate(Some(r))
    } else {
        let settings = state.current_settings.lock().await;
        settings.cache_rate()
    };

    let total_tracks_count = track_ids.len();
    // Solo cuentan las pistas con la caché completa (el PCM no puede estar truncado).
    let cached_tracks = cache::collect_cached_tracks(&local_data, &project_id, rate, &track_ids);

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
    track_controls: Option<Vec<playback::InitialTrackControl>>,
) -> Result<playback::ProjectLoadInfo, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    let settings = state.current_settings.lock().await;
    let sr = settings.cache_rate();

    state
        .playback
        .load_project_with_controls(
            &local_data,
            &project_id,
            sr,
            bpm,
            beats_per_bar,
            sections,
            quantize_mode,
            track_controls,
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
    monitor: Option<bool>,
    split_sequence: Option<bool>,
    cue_gain: Option<f32>,
    cue_muted: Option<bool>,
) -> Result<(), String> {
    state
        .playback
        .set_track_controls(&track_id, gain, pan, muted, soloed, bus.as_deref())
        .await;
    if let Some(m) = monitor {
        state.playback.set_track_monitor(&track_id, m).await;
    }
    if let Some(s) = split_sequence {
        state.playback.set_track_split(&track_id, s).await;
    }
    if cue_gain.is_some() || cue_muted.is_some() {
        state.playback.set_track_cue(&track_id, cue_gain, cue_muted).await;
    }
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

/// Estado del ruteo de salidas de un dispositivo, para la pantalla de Ajustes de audio.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingInfo {
    pub device_name: Option<String>,
    pub host: String,
    /// `false` si el dispositivo guardado no está conectado.
    pub device_found: bool,
    /// Canales de salida independientes que expone el dispositivo (los que declara Windows en su formato de mezcla).
    pub channels: u16,
    /// Ruteo vigente (el guardado si encaja con el dispositivo; si no, la propuesta).
    pub config: routing::RoutingConfig,
    /// Propuesta automática para esta cantidad de canales.
    pub proposed: routing::RoutingConfig,
    pub saved: bool,
    /// Había un ruteo guardado para otra cantidad de canales: se descartó y se propone uno nuevo.
    pub stale: bool,
    pub valid: bool,
    pub issues: Vec<String>,
    pub notes: Vec<String>,
    pub summary: String,
}

/// Canales de salida del dispositivo indicado (o del predeterminado). `Ok(None)` = el dispositivo no está conectado.
fn probe_output_device(device_name: Option<&str>) -> Result<(String, Option<u16>), String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let host_name = host.id().name().to_string();
    let device = match device_name {
        Some(name) => host
            .output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| output::get_device_name(d) == name),
        None => host.default_output_device(),
    };
    let channels = device.and_then(|d| d.default_output_config().ok().map(|c| c.channels()));
    Ok((host_name, channels))
}

fn routing_notes(channels: u16) -> Vec<String> {
    let mut notes = Vec::new();
    if channels <= 2 {
        notes.push(
            "Windows (WASAPI compartido) solo expone los canales que declara el controlador. Una interfaz con más de dos \
             salidas suele aparecer como varios pares estéreo separados («Analógico 1+2», «3+4»…) que no se pueden \
             combinar en un solo dispositivo. Para usar más canales hace falta ASIO o un formato multicanal \
             configurado en Windows."
                .to_string(),
        );
    } else {
        notes.push(format!(
            "Windows expone {channels} canales de salida en este dispositivo. Una salida de audífonos que solo replica \
             a otra no se distingue por software."
        ));
    }
    notes.push("Comprueba cada canal con el tono de prueba antes de un servicio.".to_string());
    notes
}

fn build_routing_info(state: &AudioEngineState, device_name: Option<String>) -> Result<RoutingInfo, String> {
    let (host, channels) = probe_output_device(device_name.as_deref())?;
    let found = channels.is_some();
    let channels = channels.unwrap_or(0);
    let key = routing::device_key(&host, device_name.as_deref().unwrap_or("(predeterminado)"));
    let resolution = state.routing_store.lock().unwrap().resolve(&key, channels);
    let mut issues: Vec<String> = routing::validate(&resolution.config, channels).iter().map(|i| i.message()).collect();
    if !found {
        issues.insert(
            0,
            format!(
                "El dispositivo «{}» no está conectado.",
                device_name.as_deref().unwrap_or("predeterminado")
            ),
        );
    }
    Ok(RoutingInfo {
        device_name,
        host,
        device_found: found,
        channels,
        summary: routing::describe(&resolution.config),
        proposed: routing::propose(channels),
        saved: resolution.saved,
        stale: resolution.stale,
        valid: issues.is_empty(),
        issues,
        notes: routing_notes(channels),
        config: resolution.config,
    })
}

fn routing_key_for(device_name: &Option<String>) -> Result<String, String> {
    let (host, _) = probe_output_device(device_name.as_deref())?;
    Ok(routing::device_key(&host, device_name.as_deref().unwrap_or("(predeterminado)")))
}

#[tauri::command]
pub async fn audio_get_routing(
    state: State<'_, AudioEngineState>,
    device_name: Option<String>,
) -> Result<RoutingInfo, String> {
    build_routing_info(&state, device_name)
}

/// Guarda el ruteo de un dispositivo. Solo se guarda si es válido para su cantidad de canales.
#[tauri::command]
pub async fn audio_set_routing(
    state: State<'_, AudioEngineState>,
    device_name: Option<String>,
    config: routing::RoutingConfig,
) -> Result<RoutingInfo, String> {
    let (host, channels) = probe_output_device(device_name.as_deref())?;
    let channels = channels.ok_or_else(|| {
        format!(
            "El dispositivo «{}» no está conectado: conéctalo para guardar su ruteo.",
            device_name.as_deref().unwrap_or("predeterminado")
        )
    })?;
    let mut config = config;
    config.custom = true;
    let issues = routing::validate(&config, channels);
    if !issues.is_empty() {
        // No se guarda ni se aplica: se devuelve para que la pantalla muestre qué corregir.
        let mut info = build_routing_info(&state, device_name)?;
        info.config = config;
        info.issues = issues.iter().map(|i| i.message()).collect();
        info.valid = false;
        return Ok(info);
    }
    let key = routing::device_key(&host, device_name.as_deref().unwrap_or("(predeterminado)"));
    state.playback.apply_routing(&key, &routing::RouteTable::from_config(&config))?;
    state.routing_store.lock().unwrap().set(&key, config)?;
    build_routing_info(&state, device_name)
}

/// Descarta el ruteo guardado de un dispositivo y vuelve a la propuesta automática.
#[tauri::command]
pub async fn audio_reset_routing(
    state: State<'_, AudioEngineState>,
    device_name: Option<String>,
) -> Result<RoutingInfo, String> {
    let (_, channels) = probe_output_device(device_name.as_deref())?;
    let key = routing_key_for(&device_name)?;
    if let Some(ch) = channels {
        state.playback.apply_routing(&key, &routing::RouteTable::from_config(&routing::propose(ch)))?;
    }
    state.routing_store.lock().unwrap().remove(&key)?;
    build_routing_info(&state, device_name)
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
    let sr = settings.cache_rate();

    state.playback.preload_project(&local_data, &project_id, sr).await
}

#[tauri::command]
pub async fn audio_set_master_gains(
    state: State<'_, AudioEngineState>,
    master_gain: Option<f32>,
    cue_master_gain: Option<f32>,
    monitor_gain: Option<f32>,
) -> Result<(), String> {
    state.playback.set_master_gains(master_gain, cue_master_gain);
    if let Some(g) = monitor_gain {
        state.playback.set_monitor_gain(g);
    }
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
    let sr = settings.cache_rate();

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

fn probe_audio_duration(path: &Path) -> Option<f64> {
    if let Some(d) = probe_wav_header_duration(path) {
        return Some(d);
    }
    // Fallback rápido con Symphonia para leer duración de cabecera (FLAC, MP3 con Xing, WAV complejo)
    let file = std::fs::File::open(path).ok()?;
    let mss = symphonia::core::io::MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = symphonia::core::probe::Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &Default::default(), &Default::default())
        .ok()?;
    let track = probed
        .format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)?;
    if let (Some(n_frames), Some(tb)) = (track.codec_params.n_frames, track.codec_params.time_base) {
        let time = tb.calc_time(n_frames);
        return Some(time.seconds as f64 + time.frac);
    } else if let (Some(n_frames), Some(sr)) = (track.codec_params.n_frames, track.codec_params.sample_rate) {
        if sr > 0 {
            return Some(n_frames as f64 / sr as f64);
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
    pub file_size: Option<u64>,
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

    let sidecar_path = crate::library::find_sidecar_path(p);
    let mut title = folder_name.clone();
    let mut artist = "Artista Desconocido".to_string();
    let mut bpm = None;
    let mut key = None;
    let mut sections = Vec::new();
    let mut sidecar_tracks: Vec<SidecarTrack> = Vec::new();

    if let Some(ref sp) = sidecar_path {
        if let Ok(content) = std::fs::read_to_string(sp) {
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
                sidecar_tracks = sidecar_tracks_from_json(&json_val);
            }
        }
    } else {
        let cleaned = crate::library::clean_song_title_and_metadata(&folder_name);
        title = cleaned.title;
        if let Some(art) = cleaned.artist {
            artist = art;
        }
        if bpm.is_none() {
            bpm = cleaned.bpm;
        }
        if key.is_none() {
            key = cleaned.key;
        }
    }

    let audio_extensions = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];
    let mut files = Vec::new();
    let entries = std::fs::read_dir(p).map_err(|e| format!("Error leyendo carpeta: {e}"))?;

    let mut audio_paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| audio_extensions.contains(&s.to_lowercase().as_str()))
                    .unwrap_or(false)
        })
        .collect();
    audio_paths.sort();
    // Los IDs que el sidecar guardó se emparejan por nombre de ARCHIVO (la pista lleva el nombre del catálogo).
    let file_names: Vec<String> = audio_paths
        .iter()
        .map(|path| path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string())
        .collect();
    let track_ids = ids_for_files(&sidecar_tracks, &file_names);
    for (path, track_id) in audio_paths.into_iter().zip(track_ids) {
        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Pista").to_string();
        let est_duration_sec = probe_audio_duration(&path);
        let file_size = path.metadata().ok().map(|m| m.len());

        files.push(ScannedAudioFile {
            file_path: path.to_string_lossy().to_string(),
            file_name,
            track_name: file_stem,
            track_id,
            est_duration_sec,
            file_size,
        });
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

    // Archivos de audio válidos de la selección, en el orden elegido.
    let valid_paths: Vec<String> = file_paths
        .into_iter()
        .filter(|fp| {
            let path = Path::new(fp);
            path.is_file()
                && path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| audio_extensions.contains(&s.to_lowercase().as_str()))
                    .unwrap_or(false)
        })
        .collect();
    // Si la carpeta de los archivos tiene sidecar, las pistas que ya conoce conservan su ID (emparejadas por nombre de
    // archivo) y las nuevas no heredan el de ninguna pista conocida. Antes todo era `stem-01`, `stem-02`… por posición y
    // chocaba con los IDs de las pistas ya guardadas al añadir archivos a una canción.
    let sidecar_tracks: Vec<SidecarTrack> = crate::library::find_sidecar_path(&parent)
        .and_then(|sp| std::fs::read_to_string(sp).ok())
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .map(|json| sidecar_tracks_from_json(&json))
        .unwrap_or_default();
    let file_names: Vec<String> = valid_paths
        .iter()
        .map(|fp| Path::new(fp).file_name().and_then(|s| s.to_str()).unwrap_or("").to_string())
        .collect();
    let track_ids = ids_for_files(&sidecar_tracks, &file_names);
    for ((fp, file_name), track_id) in valid_paths.into_iter().zip(file_names).zip(track_ids) {
        let path = Path::new(&fp);
        let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Pista").to_string();
        let est_duration_sec = probe_audio_duration(path);
        let file_size = path.metadata().ok().map(|m| m.len());
        files.push(ScannedAudioFile {
            file_path: fp.clone(),
            file_name,
            track_name: file_stem,
            track_id,
            est_duration_sec,
            file_size,
        });
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
        output::effective_cache_rate(Some(r))
    } else {
        let settings = state.current_settings.lock().await;
        settings.cache_rate()
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

    cache::validate_path_id(&project_id)?;
    state.loudness.cancel(&project_id);
    // Primero se descarga la canción (si es la montada): en Windows no se puede borrar un PCM que el motor tiene
    // abierto, y con el borrado fallido la canción seguiría montada sobre una caché a medias.
    state.playback.unload_project_if_matches(&project_id).await;
    let pcm_base = local_data.join("pcm");
    let proj_dir = pcm_base.join(&project_id);
    if proj_dir.exists() {
        std::fs::remove_dir_all(&proj_dir)
            .map_err(|e| format!("Error eliminando carpeta de caché para '{project_id}': {e}"))?;
        tracing::info!("[Cache] Carpeta de caché eliminada para '{}'", project_id);
    }
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
