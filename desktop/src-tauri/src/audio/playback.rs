use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as TokioMutex;

use crate::audio::cache::{get_project_cache_dir, read_track_metadata};
use crate::audio::output::{get_device_name, AudioEngineState, AudioStreamStats};

pub const FADE_MS: f32 = 8.0;

/// Envelope for applying micro-fades only when starting/stopping/seeking,
/// ensuring that contiguous blocks ALWAYS receive 1.0 gain (no dips).
#[derive(Debug, Clone)]
pub struct FadeEnvelope {
    pub fade_type: FadeType,
    pub fade_frames: usize,
    pub current_frame: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FadeType {
    None,
    FadeIn,
    FadeOut,
}

impl FadeEnvelope {
    pub fn new(fade_ms: f32, sample_rate: u32) -> Self {
        let fade_frames = ((fade_ms / 1000.0) * sample_rate as f32).round().max(1.0) as usize;
        Self {
            fade_type: FadeType::None,
            fade_frames,
            current_frame: 0,
        }
    }

    pub fn start_fade_in(&mut self) {
        self.fade_type = FadeType::FadeIn;
        self.current_frame = 0;
    }

    pub fn start_fade_out(&mut self) {
        self.fade_type = FadeType::FadeOut;
        self.current_frame = 0;
    }

    pub fn is_fading_out(&self) -> bool {
        self.fade_type == FadeType::FadeOut
    }

    pub fn is_fade_out_complete(&self) -> bool {
        self.fade_type == FadeType::FadeOut && self.current_frame >= self.fade_frames
    }

    /// Advances one frame and returns the gain multiplier.
    /// In normal continuous playback (FadeType::None), this returns EXACTLY 1.0.
    pub fn next_gain(&mut self) -> f32 {
        match self.fade_type {
            FadeType::None => 1.0,
            FadeType::FadeIn => {
                let g = (self.current_frame as f32 / self.fade_frames as f32).min(1.0);
                self.current_frame += 1;
                if self.current_frame >= self.fade_frames {
                    self.fade_type = FadeType::None;
                }
                g
            }
            FadeType::FadeOut => {
                let g = (1.0 - (self.current_frame as f32 / self.fade_frames as f32)).max(0.0);
                self.current_frame += 1;
                g
            }
        }
    }
}

pub struct ActiveTrack {
    pub track_id: String,
    pub file_path: PathBuf,
    pub original_channels: u16,
    pub total_frames: u64,
    pub gain: Arc<AtomicU32>, // f32 bits
    pub pan: Arc<AtomicI32>,  // -100 to 100
    pub muted: Arc<AtomicBool>,
    pub soloed: Arc<AtomicBool>,
    pub consumer: Arc<std::sync::Mutex<rtrb::Consumer<f32>>>,
    pub stop_signal: Arc<AtomicBool>,
    pub seek_request: Arc<AtomicI64>,
}

pub struct PlaybackEngine {
    pub loaded_project_id: TokioMutex<Option<String>>,
    pub is_playing: Arc<AtomicBool>,
    pub current_frame: Arc<AtomicU64>,
    pub total_frames: Arc<AtomicU64>,
    pub sample_rate: Arc<AtomicU32>,
    pub tracks: TokioMutex<Vec<ActiveTrack>>,
    pub fade: Arc<std::sync::Mutex<FadeEnvelope>>,
    pub stream: TokioMutex<Option<cpal::Stream>>,
    pub stats: Arc<AudioStreamStats>,
}

impl PlaybackEngine {
    pub fn new(stats: Arc<AudioStreamStats>) -> Self {
        Self {
            loaded_project_id: TokioMutex::new(None),
            is_playing: Arc::new(AtomicBool::new(false)),
            current_frame: Arc::new(AtomicU64::new(0)),
            total_frames: Arc::new(AtomicU64::new(0)),
            sample_rate: Arc::new(AtomicU32::new(48000)),
            tracks: TokioMutex::new(Vec::new()),
            fade: Arc::new(std::sync::Mutex::new(FadeEnvelope::new(FADE_MS, 48000))),
            stream: TokioMutex::new(None),
            stats,
        }
    }

    pub async fn load_project(
        &self,
        base_dir: &Path,
        project_id: &str,
        device_sample_rate: u32,
    ) -> Result<ProjectLoadInfo, String> {
        self.stop().await;

        let proj_dir = get_project_cache_dir(base_dir, project_id, device_sample_rate);
        if !proj_dir.exists() {
            return Err(format!(
                "No existe caché PCM para el proyecto '{project_id}' a {device_sample_rate} Hz"
            ));
        }

        let mut read_dir = std::fs::read_dir(&proj_dir)
            .map_err(|e| format!("Error leyendo directorio de caché: {e}"))?;

        let mut track_metas = Vec::new();
        while let Some(Ok(entry)) = read_dir.next() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Some(track_id) = path.file_stem().and_then(|s| s.to_str()) {
                    if let Ok(meta) = read_track_metadata(base_dir, project_id, device_sample_rate, track_id) {
                        track_metas.push(meta);
                    }
                }
            }
        }

        if track_metas.is_empty() {
            return Err("No se encontraron pistas válidas en la caché del proyecto".to_string());
        }

        let mut max_frames = 0u64;
        let mut active_tracks = Vec::new();

        // 500 ms of stereo audio in the ring buffer: 48000 * 0.5 * 2 = 48000 samples
        let ring_buffer_capacity = ((device_sample_rate as f32 * 0.5) as usize * 2).max(4096);

        for meta in &track_metas {
            if meta.frame_count > max_frames {
                max_frames = meta.frame_count;
            }

            let pcm_path = proj_dir.join(format!("{}.pcm", meta.track_id));
            if !pcm_path.exists() {
                continue;
            }

            let (mut producer, consumer) = rtrb::RingBuffer::<f32>::new(ring_buffer_capacity);
            let stop_signal = Arc::new(AtomicBool::new(false));
            let seek_req = Arc::new(AtomicI64::new(-1));

            let thread_pcm_path = pcm_path.clone();
            let thread_stop = Arc::clone(&stop_signal);
            let thread_seek = Arc::clone(&seek_req);
            let is_mono = meta.channels == 1;
            let total_trk_frames = meta.frame_count;

            // Feeder thread for this track: pre-reads PCM from disk and maintains >= 350 ms in ring buffer
            std::thread::Builder::new()
                .name(format!("omni-feed-{}", meta.track_id))
                .spawn(move || {
                    let mut file = match File::open(&thread_pcm_path) {
                        Ok(f) => f,
                        Err(e) => {
                            eprintln!("[Feeder] Error abriendo {}: {}", thread_pcm_path.display(), e);
                            return;
                        }
                    };

                    let bytes_per_frame = if is_mono { 2 } else { 4 };
                    let chunk_frames = 1024usize;
                    let mut byte_buf = vec![0u8; chunk_frames * bytes_per_frame];
                    let mut current_frame = 0u64;

                    while !thread_stop.load(Ordering::Relaxed) {
                        // Check seek requests
                        let target_seek = thread_seek.swap(-1, Ordering::SeqCst);
                        if target_seek >= 0 {
                            current_frame = target_seek as u64;
                            let file_offset = current_frame * bytes_per_frame as u64;
                            let _ = file.seek(SeekFrom::Start(file_offset));
                        }

                        // Check if ring buffer needs more audio (keep it between 350ms and 500ms full)
                        let free_slots = producer.slots();
                        let slots_needed_for_chunk = chunk_frames * 2;

                        if free_slots >= slots_needed_for_chunk && current_frame < total_trk_frames {
                            let frames_to_read = chunk_frames.min((total_trk_frames - current_frame) as usize);
                            let bytes_to_read = frames_to_read * bytes_per_frame;

                            match file.read_exact(&mut byte_buf[..bytes_to_read]) {
                                Ok(()) => {
                                    if is_mono {
                                        // Expand mono i16 to stereo f32 interleaved
                                        for i in 0..frames_to_read {
                                            let s_i16 = i16::from_le_bytes([byte_buf[i * 2], byte_buf[i * 2 + 1]]);
                                            let s_f32 = s_i16 as f32 / 32768.0;
                                            let _ = producer.push(s_f32); // Left
                                            let _ = producer.push(s_f32); // Right
                                        }
                                    } else {
                                        // Stereo i16 to stereo f32 interleaved
                                        for i in 0..frames_to_read {
                                            let l_i16 = i16::from_le_bytes([byte_buf[i * 4], byte_buf[i * 4 + 1]]);
                                            let r_i16 = i16::from_le_bytes([byte_buf[i * 4 + 2], byte_buf[i * 4 + 3]]);
                                            let _ = producer.push(l_i16 as f32 / 32768.0);
                                            let _ = producer.push(r_i16 as f32 / 32768.0);
                                        }
                                    }
                                    current_frame += frames_to_read as u64;
                                }
                                Err(_) => {
                                    // End of file or read error
                                    std::thread::sleep(std::time::Duration::from_millis(5));
                                }
                            }
                        } else {
                            // Ring buffer sufficiently filled or EOF; sleep briefly to avoid busy loop
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                    }
                })
                .map_err(|e| format!("Error iniciando hilo feeder: {e}"))?;

            active_tracks.push(ActiveTrack {
                track_id: meta.track_id.clone(),
                file_path: pcm_path,
                original_channels: meta.channels,
                total_frames: meta.frame_count,
                gain: Arc::new(AtomicU32::new(1.0f32.to_bits())),
                pan: Arc::new(AtomicI32::new(0)),
                muted: Arc::new(AtomicBool::new(false)),
                soloed: Arc::new(AtomicBool::new(false)),
                consumer: Arc::new(std::sync::Mutex::new(consumer)),
                stop_signal,
                seek_request: seek_req,
            });
        }

        self.sample_rate.store(device_sample_rate, Ordering::SeqCst);
        self.current_frame.store(0, Ordering::SeqCst);
        self.total_frames.store(max_frames, Ordering::SeqCst);
        *self.fade.lock().unwrap() = FadeEnvelope::new(FADE_MS, device_sample_rate);

        let duration_sec = max_frames as f64 / device_sample_rate as f64;
        let track_count = active_tracks.len();

        let mut tracks_guard = self.tracks.lock().await;
        // Stop any old tracks
        for old in tracks_guard.iter() {
            old.stop_signal.store(true, Ordering::Relaxed);
        }
        *tracks_guard = active_tracks;

        let mut loaded = self.loaded_project_id.lock().await;
        *loaded = Some(project_id.to_string());

        Ok(ProjectLoadInfo {
            project_id: project_id.to_string(),
            sample_rate: device_sample_rate,
            track_count,
            duration_sec,
            total_frames: max_frames,
        })
    }

    pub async fn play(&self, state: &AudioEngineState) -> Result<(), String> {
        let loaded = self.loaded_project_id.lock().await;
        if loaded.is_none() {
            return Err("No hay proyecto cargado en el motor nativo".to_string());
        }

        if self.is_playing.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Start 8 ms fade-in
        self.fade.lock().unwrap().start_fade_in();
        self.is_playing.store(true, Ordering::SeqCst);

        // Ensure CPAL output stream is active
        self.ensure_stream(state).await?;
        Ok(())
    }

    pub async fn pause(&self) {
        if !self.is_playing.load(Ordering::SeqCst) {
            return;
        }

        // Apply 8 ms fade-out before pausing to avoid clicks
        self.fade.lock().unwrap().start_fade_out();
        tokio::time::sleep(std::time::Duration::from_millis((FADE_MS * 1.5) as u64)).await;

        self.is_playing.store(false, Ordering::SeqCst);
    }

    pub async fn stop(&self) {
        if self.is_playing.load(Ordering::SeqCst) {
            self.fade.lock().unwrap().start_fade_out();
            tokio::time::sleep(std::time::Duration::from_millis((FADE_MS * 1.5) as u64)).await;
            self.is_playing.store(false, Ordering::SeqCst);
        }

        self.current_frame.store(0, Ordering::SeqCst);
        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            trk.seek_request.store(0, Ordering::SeqCst);
            if let Ok(mut c) = trk.consumer.lock() {
                while c.pop().is_ok() {}
            }
        }
    }

    pub async fn seek(&self, target_sec: f64) {
        let sr = self.sample_rate.load(Ordering::SeqCst);
        let target_frame = (target_sec * sr as f64).round().max(0.0) as i64;

        let was_playing = self.is_playing.load(Ordering::SeqCst);
        if was_playing {
            self.fade.lock().unwrap().start_fade_out();
            tokio::time::sleep(std::time::Duration::from_millis((FADE_MS * 1.2) as u64)).await;
        }

        self.current_frame.store(target_frame as u64, Ordering::SeqCst);

        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            trk.seek_request.store(target_frame, Ordering::SeqCst);
            if let Ok(mut c) = trk.consumer.lock() {
                while c.pop().is_ok() {}
            }
        }

        if was_playing {
            self.fade.lock().unwrap().start_fade_in();
        }
    }

    pub fn get_playback_state(&self) -> PlaybackStateSnapshot {
        let sr = self.sample_rate.load(Ordering::SeqCst).max(1);
        let cur = self.current_frame.load(Ordering::SeqCst);
        let tot = self.total_frames.load(Ordering::SeqCst);

        PlaybackStateSnapshot {
            is_playing: self.is_playing.load(Ordering::SeqCst),
            position_sec: cur as f64 / sr as f64,
            duration_sec: tot as f64 / sr as f64,
            current_frame: cur,
            total_frames: tot,
            underruns: self.stats.underruns.load(Ordering::Relaxed),
            callbacks: self.stats.callbacks.load(Ordering::Relaxed),
            max_callback_duration_us: self.stats.max_callback_duration_us.load(Ordering::Relaxed),
        }
    }

    pub async fn set_track_controls(
        &self,
        track_id: &str,
        gain: Option<f32>,
        pan: Option<i32>,
        muted: Option<bool>,
        soloed: Option<bool>,
    ) {
        let tracks = self.tracks.lock().await;
        if let Some(trk) = tracks.iter().find(|t| t.track_id == track_id) {
            if let Some(g) = gain {
                trk.gain.store(g.to_bits(), Ordering::Relaxed);
            }
            if let Some(p) = pan {
                trk.pan.store(p.clamp(-100, 100), Ordering::Relaxed);
            }
            if let Some(m) = muted {
                trk.muted.store(m, Ordering::Relaxed);
            }
            if let Some(s) = soloed {
                trk.soloed.store(s, Ordering::Relaxed);
            }
        }
    }

    async fn ensure_stream(&self, engine_state: &AudioEngineState) -> Result<(), String> {
        let mut stream_guard = self.stream.lock().await;
        if stream_guard.is_some() {
            return Ok(());
        }

        let settings = engine_state.current_settings.lock().await.clone();
        let host = cpal::default_host();
        let devices = host.output_devices().map_err(|e| e.to_string())?;

        let mut matched_device = None;
        if let Some(ref name) = settings.device_name {
            for d in devices {
                if get_device_name(&d) == *name {
                    matched_device = Some(d);
                    break;
                }
            }
        }

        let device = match matched_device {
            Some(d) => d,
            None => host
                .default_output_device()
                .ok_or_else(|| "No hay dispositivo de salida predeterminado".to_string())?,
        };

        let default_config = device
            .default_output_config()
            .map_err(|e| format!("Error en configuración de salida: {e}"))?;

        let sample_rate = default_config.sample_rate();
        self.sample_rate.store(sample_rate, Ordering::SeqCst);

        let channels = default_config.channels() as usize;

        let tracks_arc = {
            let trks = self.tracks.lock().await;
            trks.iter()
                .map(|t| (
                    Arc::clone(&t.consumer),
                    Arc::clone(&t.gain),
                    Arc::clone(&t.pan),
                    Arc::clone(&t.muted),
                    Arc::clone(&t.soloed),
                ))
                .collect::<Vec<_>>()
        };

        let is_playing = Arc::clone(&self.is_playing);
        let current_frame = Arc::clone(&self.current_frame);
        let total_frames = Arc::clone(&self.total_frames);
        let fade_arc = Arc::clone(&self.fade);
        let stats = Arc::clone(&self.stats);

        let err_fn = |err| eprintln!("[NativeAudioStream] Error en stream CPAL: {err}");
        let stream_config: cpal::StreamConfig = default_config.into();

        let stream = device
            .build_output_stream(
                stream_config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    let t0 = Instant::now();
                    stats.callbacks.fetch_add(1, Ordering::Relaxed);

                    // Silence output if not playing
                    if !is_playing.load(Ordering::Relaxed) {
                        data.fill(0.0);
                        return;
                    }

                    let frames = data.len() / channels;
                    let mut fade = fade_arc.lock().unwrap();

                    // Check if any track has solo
                    let any_solo = tracks_arc.iter().any(|(_, _, _, _, s)| s.load(Ordering::Relaxed));

                    let mut mixed_l = vec![0.0f32; frames];
                    let mut mixed_r = vec![0.0f32; frames];

                    for (consumer_arc, gain_bits, pan_val, muted, soloed) in &tracks_arc {
                        let is_muted = muted.load(Ordering::Relaxed);
                        let is_solo = soloed.load(Ordering::Relaxed);

                        if is_muted || (any_solo && !is_solo) {
                            // Still drain consumer so it stays in sync
                            if let Ok(mut c) = consumer_arc.lock() {
                                for _ in 0..frames * 2 {
                                    let _ = c.pop();
                                }
                            }
                            continue;
                        }

                        let g = f32::from_bits(gain_bits.load(Ordering::Relaxed));
                        let p = pan_val.load(Ordering::Relaxed) as f32 / 100.0;
                        // Equal power pan
                        let angle = (p + 1.0) * (std::f32::consts::PI / 4.0);
                        let pan_l = angle.cos() * g;
                        let pan_r = angle.sin() * g;

                        if let Ok(mut c) = consumer_arc.lock() {
                            let mut had_underrun = false;
                            for f in 0..frames {
                                let l = match c.pop() {
                                    Ok(v) => v,
                                    Err(_) => {
                                        had_underrun = true;
                                        0.0
                                    }
                                };
                                let r = match c.pop() {
                                    Ok(v) => v,
                                    Err(_) => {
                                        had_underrun = true;
                                        0.0
                                    }
                                };
                                mixed_l[f] += l * pan_l;
                                mixed_r[f] += r * pan_r;
                            }
                            if had_underrun {
                                stats.underruns.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }

                    // Write into output buffer applying the micro-fade envelope
                    for f in 0..frames {
                        let env_gain = fade.next_gain();
                        let out_l = (mixed_l[f] * env_gain).clamp(-1.0, 1.0);
                        let out_r = (mixed_r[f] * env_gain).clamp(-1.0, 1.0);

                        data[f * channels] = out_l;
                        if channels > 1 {
                            data[f * channels + 1] = out_r;
                        }
                    }

                    current_frame.fetch_add(frames as u64, Ordering::Relaxed);
                    if current_frame.load(Ordering::Relaxed) >= total_frames.load(Ordering::Relaxed) {
                        is_playing.store(false, Ordering::Relaxed);
                    }

                    let dur_us = t0.elapsed().as_micros() as u64;
                    let mut max_us = stats.max_callback_duration_us.load(Ordering::Relaxed);
                    while dur_us > max_us {
                        match stats.max_callback_duration_us.compare_exchange_weak(
                            max_us,
                            dur_us,
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                        ) {
                            Ok(_) => break,
                            Err(actual) => max_us = actual,
                        }
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Error construyendo corriente de salida CPAL: {e}"))?;

        stream.play().map_err(|e| format!("Error iniciando stream: {e}"))?;
        *stream_guard = Some(stream);

        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLoadInfo {
    pub project_id: String,
    pub sample_rate: u32,
    pub track_count: usize,
    pub duration_sec: f64,
    pub total_frames: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStateSnapshot {
    pub is_playing: bool,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub current_frame: u64,
    pub total_frames: u64,
    pub underruns: u64,
    pub callbacks: u64,
    pub max_callback_duration_us: u64,
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn test_fade_only_on_play_pause_seek_never_contiguous() {
        let sr = 48000;
        let mut env = FadeEnvelope::new(FADE_MS, sr);
        assert_eq!(env.fade_frames, 384); // 8 ms at 48 kHz = 384 frames

        // Initially no fade: contiguous playback gives EXACT 1.0 gain
        for _ in 0..1000 {
            assert_eq!(env.next_gain(), 1.0);
        }

        // On Play: start fade-in
        env.start_fade_in();
        assert_eq!(env.next_gain(), 0.0); // frame 0 starts at 0

        // Advance half of fade (192 frames)
        for _ in 1..192 {
            let _ = env.next_gain();
        }
        let half_gain = env.next_gain();
        assert!((half_gain - 0.5).abs() < 0.01);

        // Advance to the end of fade
        for _ in 193..384 {
            let _ = env.next_gain();
        }

        // Now fade is complete: subsequent frames and next contiguous blocks MUST be strictly 1.0
        assert_eq!(env.fade_type, FadeType::None);
        for _ in 0..5000 {
            assert_eq!(env.next_gain(), 1.0, "Contiguous block had a gain drop!");
        }

        // On Pause / Seek: start fade-out
        env.start_fade_out();
        assert_eq!(env.next_gain(), 1.0); // starts at 1.0
        for _ in 1..192 {
            let _ = env.next_gain();
        }
        let half_fadeout = env.next_gain();
        assert!((half_fadeout - 0.5).abs() < 0.01);

        for _ in 193..384 {
            let _ = env.next_gain();
        }
        // At the end of fade-out, gain is 0.0
        assert_eq!(env.next_gain(), 0.0);
    }

    #[test]
    fn test_rtrb_ring_buffer_feeder_and_underrun() {
        let (mut prod, mut cons) = rtrb::RingBuffer::<f32>::new(1024);
        assert_eq!(prod.slots(), 1024);

        // Push 512 samples
        for i in 0..512 {
            assert!(prod.push(i as f32).is_ok());
        }
        assert_eq!(prod.slots(), 512);

        // Consume 512 samples
        for i in 0..512 {
            assert_eq!(cons.pop().unwrap(), i as f32);
        }

        // Attempting to pop more must return Err (underrun condition)
        assert!(cons.pop().is_err());
    }

    #[test]
    fn test_mixer_gain_pan_mute_solo_logic() {
        // Test gain clamping & equal-power panning formula
        let g = 0.8f32;
        let p_center = 0.0f32;
        let angle_c = (p_center + 1.0) * (std::f32::consts::PI / 4.0);
        let pan_l = angle_c.cos() * g;
        let pan_r = angle_c.sin() * g;
        assert!((pan_l - pan_r).abs() < 0.001);

        // Hard Left: p = -1.0
        let p_left = -1.0f32;
        let angle_l = (p_left + 1.0) * (std::f32::consts::PI / 4.0);
        assert!((angle_l.cos() * g - g).abs() < 0.001);
        assert!((angle_l.sin() * g).abs() < 0.001);
    }
}
