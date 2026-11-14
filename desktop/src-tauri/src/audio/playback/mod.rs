use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tokio::sync::Mutex as TokioMutex;

use crate::audio::cache::{get_project_cache_dir, read_track_metadata};
use crate::audio::metronome::{MetronomeConfig, MetronomeEngine};
use crate::audio::output::{get_device_name, AudioEngineState, AudioStreamStats};
use crate::audio::resampler::TrackResampler;

pub mod fade;
pub use fade::*;

pub mod bus;
pub use bus::*;

pub mod guide;
pub use guide::*;

pub mod feeder_io;
pub use feeder_io::*;

pub mod types;
pub use types::*;

pub mod clock;
pub use clock::{advance_clock, ClockJumps};

pub mod jumps;
pub mod transport;

pub struct PlaybackEngine {
    pub loaded_project_id: TokioMutex<Option<String>>,
    pub is_playing: Arc<AtomicBool>,
    pub is_buffering: Arc<AtomicBool>,
    pub buffering_start_time: Arc<std::sync::Mutex<Option<Instant>>>,
    pub last_prefill_duration_ms: Arc<AtomicU64>,
    pub seek_generation: Arc<AtomicU64>,
    pub current_frame: Arc<AtomicU64>,
    /// Saltos de sección y vueltas de vamp pendientes de aplicar al reloj (`current_frame`).
    pub clock_jumps: Arc<ClockJumps>,
    pub total_frames: Arc<AtomicU64>,
    pub sample_rate: Arc<AtomicU32>,
    pub tracks: TokioMutex<Vec<ActiveTrack>>,
    pub stream_tracks: Arc<std::sync::Mutex<Vec<StreamTrackHandle>>>,
    pub fade: Arc<std::sync::Mutex<FadeEnvelope>>,
    pub stream: TokioMutex<Option<cpal::Stream>>,
    pub stats: Arc<AudioStreamStats>,

    // Phase 4 fields:
    pub sections: Arc<std::sync::Mutex<Vec<NativeSongSection>>>,
    pub quantize_mode: Arc<std::sync::Mutex<String>>, // "1-bar", "2-bars", "section-end", "immediate"
    pub bpm: Arc<AtomicU32>,                           // f32 bits
    pub beats_per_bar: Arc<AtomicU32>,
    pub is_vamping: Arc<AtomicBool>,
    pub split_mono: Arc<AtomicBool>,
    pub master_gain: Arc<AtomicU32>,                   // f32 bits
    pub cue_master_gain: Arc<AtomicU32>,               // f32 bits
    pub pitch_semitones: Arc<AtomicI32>,
    pub queued_jump: Arc<std::sync::Mutex<Option<QueuedJumpInfo>>>,
    pub metronome: Arc<std::sync::Mutex<MetronomeEngine>>,
    pub guide_cue: Arc<std::sync::Mutex<GuideCueEngine>>,
    pub preloaded_project_id: TokioMutex<Option<String>>,
    pub device_disconnected: Arc<AtomicBool>,
    /// Picos de los buses Main, Cue y salida (los escribe el hilo de audio).
    pub bus_meters: Arc<BusMeters>,
}



impl PlaybackEngine {
    pub fn new(stats: Arc<AudioStreamStats>) -> Self {
        Self {
            loaded_project_id: TokioMutex::new(None),
            is_playing: Arc::new(AtomicBool::new(false)),
            is_buffering: Arc::new(AtomicBool::new(false)),
            buffering_start_time: Arc::new(std::sync::Mutex::new(None)),
            last_prefill_duration_ms: Arc::new(AtomicU64::new(0)),
            seek_generation: Arc::new(AtomicU64::new(0)),
            current_frame: Arc::new(AtomicU64::new(0)),
            clock_jumps: Arc::new(ClockJumps::new()),
            total_frames: Arc::new(AtomicU64::new(0)),
            sample_rate: Arc::new(AtomicU32::new(48000)),
            tracks: TokioMutex::new(Vec::new()),
            stream_tracks: Arc::new(std::sync::Mutex::new(Vec::new())),
            fade: Arc::new(std::sync::Mutex::new(FadeEnvelope::new(FADE_MS, 48000))),
            stream: TokioMutex::new(None),
            stats,
            sections: Arc::new(std::sync::Mutex::new(Vec::new())),
            quantize_mode: Arc::new(std::sync::Mutex::new("1-bar".to_string())),
            bpm: Arc::new(AtomicU32::new(120.0f32.to_bits())),
            beats_per_bar: Arc::new(AtomicU32::new(4)),
            is_vamping: Arc::new(AtomicBool::new(false)),
            split_mono: Arc::new(AtomicBool::new(false)),
            master_gain: Arc::new(AtomicU32::new(1.0f32.to_bits())),
            cue_master_gain: Arc::new(AtomicU32::new(0.708f32.to_bits())),
            pitch_semitones: Arc::new(AtomicI32::new(0)),
            queued_jump: Arc::new(std::sync::Mutex::new(None)),
            metronome: Arc::new(std::sync::Mutex::new(MetronomeEngine::new(
                MetronomeConfig::default(),
            ))),
            guide_cue: Arc::new(std::sync::Mutex::new(GuideCueEngine::new())),
            preloaded_project_id: TokioMutex::new(None),
            device_disconnected: Arc::new(AtomicBool::new(false)),
            bus_meters: Arc::new(BusMeters::default()),
        }
    }

    pub async fn load_project(
        &self,
        base_dir: &Path,
        project_id: &str,
        device_sample_rate: u32,
        bpm: Option<f32>,
        beats_per_bar: Option<u32>,
        sections: Option<Vec<NativeSongSection>>,
        quantize_mode: Option<String>,
    ) -> Result<ProjectLoadInfo, String> {
        self.stop().await;
        self.is_buffering.store(true, Ordering::SeqCst);
        *self.buffering_start_time.lock().unwrap() = Some(Instant::now());

        if let Some(b) = bpm {
            self.bpm.store(b.to_bits(), Ordering::SeqCst);
            self.metronome.lock().unwrap().config.bpm = b;
        }
        if let Some(bpb) = beats_per_bar {
            self.beats_per_bar.store(bpb, Ordering::SeqCst);
            self.metronome.lock().unwrap().config.beats_per_bar = bpb;
        }
        if let Some(secs) = sections {
            *self.sections.lock().unwrap() = secs;
        }
        if let Some(qm) = quantize_mode {
            *self.quantize_mode.lock().unwrap() = qm;
        }

        let proj_dir = get_project_cache_dir(base_dir, project_id, device_sample_rate);
        if !proj_dir.exists() {
            let pcm_root = base_dir.join("pcm").join(project_id);
            let mut other_rates = Vec::new();
            if let Ok(entries) = std::fs::read_dir(&pcm_root) {
                for entry in entries.flatten() {
                    if let Ok(file_type) = entry.file_type() {
                        if file_type.is_dir() {
                            if let Some(name) = entry.file_name().to_str() {
                                if let Ok(rate) = name.parse::<u32>() {
                                    other_rates.push(rate);
                                }
                            }
                        }
                    }
                }
            }
            if !other_rates.is_empty() {
                return Err(format!(
                    "No existe caché PCM para el proyecto '{project_id}' a {device_sample_rate} Hz (ruta buscada: '{}'). Se encontraron frecuencias existentes: {:?} Hz. Utiliza el botón «Generar caché nativa» para convertirla.",
                    proj_dir.display(),
                    other_rates
                ));
            }
            return Err(format!(
                "No existe caché PCM para el proyecto '{project_id}' a {device_sample_rate} Hz (ruta buscada: '{}'). Genera la caché nativa antes de reproducir.",
                proj_dir.display()
            ));
        }

        let mut read_dir = std::fs::read_dir(&proj_dir)
            .map_err(|e| format!("Error leyendo directorio de caché en '{}': {e}", proj_dir.display()))?;

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
            return Err(format!(
                "No se encontraron metadatos (.json) en la caché de '{}'",
                proj_dir.display()
            ));
        }

        for meta in &track_metas {
            let pcm_path = proj_dir.join(format!("{}.pcm", meta.track_id));
            if !pcm_path.exists() {
                return Err(format!(
                    "Falta el archivo PCM para la pista '{}' (ruta buscada: '{}')",
                    meta.track_id,
                    pcm_path.display()
                ));
            }
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
            let jump_req = Arc::new(std::sync::Mutex::new(None::<QueuedJumpRequest>));
            let is_vamping_track = Arc::clone(&self.is_vamping);
            let active_loop_track = Arc::new(std::sync::Mutex::new(None));
            let pitch_track = Arc::clone(&self.pitch_semitones);

            let thread_pcm_path = pcm_path.clone();
            let thread_stop = Arc::clone(&stop_signal);
            let thread_seek = Arc::clone(&seek_req);
            let thread_jump = Arc::clone(&jump_req);
            let thread_vamp = Arc::clone(&is_vamping_track);
            let thread_active_loop = Arc::clone(&active_loop_track);
            let thread_pitch = Arc::clone(&pitch_track);
            let thread_stats = Arc::clone(&self.stats);
            let is_mono = meta.channels == 1;
            let total_trk_frames = meta.frame_count;
            let crossfade_frames = ((FADE_MS / 1000.0) * device_sample_rate as f32).round().max(1.0) as usize;

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
                    let channels_count = if is_mono { 1 } else { 2 };
                    let mut current_frame = 0u64;

                    let mut last_pitch = thread_pitch.load(Ordering::Relaxed);
                    let mut resampler = TrackResampler::new(
                        device_sample_rate,
                        device_sample_rate,
                        last_pitch,
                        chunk_frames,
                        channels_count,
                    ).expect("Failed to initialize track resampler");

                    let mut input_staging: Vec<Vec<f32>> = vec![Vec::with_capacity(chunk_frames * 4); channels_count];
                    let mut output_staging: Vec<f32> = Vec::with_capacity(chunk_frames * 8);
                    let mut delay_compensated = false;

                    while !thread_stop.load(Ordering::Relaxed) {
                        // 1. Check seek requests
                        let target_seek = thread_seek.swap(-1, Ordering::SeqCst);
                        if target_seek >= 0 {
                            current_frame = target_seek as u64;
                            let file_offset = current_frame * bytes_per_frame as u64;
                            let _ = file.seek(SeekFrom::Start(file_offset));
                            for ch in input_staging.iter_mut() {
                                ch.clear();
                            }
                            output_staging.clear();
                            resampler.reset();
                            let cur_pitch = thread_pitch.load(Ordering::Relaxed);
                            let _ = resampler.set_pitch(cur_pitch, false);
                            delay_compensated = false;
                            continue;
                        }

                        // 2. Check pitch change
                        let cur_pitch = thread_pitch.load(Ordering::Relaxed);
                        if cur_pitch != last_pitch {
                            last_pitch = cur_pitch;
                            let _ = resampler.set_pitch(cur_pitch, true);
                        }

                        // 3. Drain pending output_staging samples into ring buffer
                        while !output_staging.is_empty() && producer.slots() > 0 {
                            let n_to_push = output_staging.len().min(producer.slots());
                            for &s in &output_staging[..n_to_push] {
                                let _ = producer.push(s);
                            }
                            output_staging.drain(..n_to_push);
                        }

                        // 4. Check queued jump requests
                        let queued_jump_opt = {
                            let g = thread_jump.lock().unwrap();
                            g.clone()
                        };
                        if let Some(jump) = queued_jump_opt {
                            let should_jump = (current_frame < jump.transition_frame && (current_frame + chunk_frames as u64) >= jump.transition_frame)
                                || (current_frame >= jump.transition_frame);

                            if should_jump {
                                if current_frame < jump.transition_frame {
                                    let pre_frames = (jump.transition_frame - current_frame) as usize;
                                    if pre_frames > 0 {
                                        read_into_staging(&mut file, is_mono, pre_frames, &mut input_staging);
                                    }
                                    drain_staging_through_resampler(
                                        &mut resampler,
                                        is_mono,
                                        &mut input_staging,
                                        &mut output_staging,
                                        &mut delay_compensated,
                                        true,
                                    );
                                }

                                let m = crossfade_frames;
                                let mut out_l = vec![0.0f32; m];
                                let mut out_r = vec![0.0f32; m];
                                let mut in_l = vec![0.0f32; m];
                                let mut in_r = vec![0.0f32; m];

                                read_frames_to_slices(&mut file, is_mono, m, &mut out_l, &mut out_r);
                                let in_offset = jump.target_frame * bytes_per_frame as u64;
                                let _ = file.seek(SeekFrom::Start(in_offset));
                                read_frames_to_slices(&mut file, is_mono, m, &mut in_l, &mut in_r);

                                for i in 0..m {
                                    let alpha = i as f32 / m as f32;
                                    let sl = out_l[i] * (1.0 - alpha) + in_l[i] * alpha;
                                    let sr = out_r[i] * (1.0 - alpha) + in_r[i] * alpha;
                                    output_staging.push(sl);
                                    output_staging.push(sr);
                                }

                                current_frame = jump.target_frame + m as u64;
                                let next_offset = current_frame * bytes_per_frame as u64;
                                let _ = file.seek(SeekFrom::Start(next_offset));
                                begin_new_segment(&mut resampler, &mut delay_compensated, thread_pitch.load(Ordering::Relaxed));
                                *thread_jump.lock().unwrap() = None;
                                continue;
                            }
                        }

                        // 5. Check vamp loop
                        if thread_vamp.load(Ordering::Relaxed) {
                            let loop_opt = {
                                let g = thread_active_loop.lock().unwrap();
                                *g
                            };
                            if let Some((loop_start, loop_end)) = loop_opt {
                                let should_loop = (current_frame < loop_end && (current_frame + chunk_frames as u64) >= loop_end)
                                    || (current_frame >= loop_end);

                                if should_loop {
                                    if current_frame < loop_end {
                                        let pre_frames = (loop_end - current_frame) as usize;
                                        if pre_frames > 0 {
                                            read_into_staging(&mut file, is_mono, pre_frames, &mut input_staging);
                                        }
                                        drain_staging_through_resampler(
                                            &mut resampler,
                                            is_mono,
                                            &mut input_staging,
                                            &mut output_staging,
                                            &mut delay_compensated,
                                            true,
                                        );
                                    }

                                    let m = crossfade_frames;
                                    let mut out_l = vec![0.0f32; m];
                                    let mut out_r = vec![0.0f32; m];
                                    let mut in_l = vec![0.0f32; m];
                                    let mut in_r = vec![0.0f32; m];

                                    read_frames_to_slices(&mut file, is_mono, m, &mut out_l, &mut out_r);
                                    let in_offset = loop_start * bytes_per_frame as u64;
                                    let _ = file.seek(SeekFrom::Start(in_offset));
                                    read_frames_to_slices(&mut file, is_mono, m, &mut in_l, &mut in_r);

                                    for i in 0..m {
                                        let alpha = i as f32 / m as f32;
                                        let sl = out_l[i] * (1.0 - alpha) + in_l[i] * alpha;
                                        let sr = out_r[i] * (1.0 - alpha) + in_r[i] * alpha;
                                        output_staging.push(sl);
                                        output_staging.push(sr);
                                    }

                                    current_frame = loop_start + m as u64;
                                    let next_offset = current_frame * bytes_per_frame as u64;
                                    let _ = file.seek(SeekFrom::Start(next_offset));
                                    begin_new_segment(&mut resampler, &mut delay_compensated, thread_pitch.load(Ordering::Relaxed));
                                    continue;
                                }
                            }
                        }

                        // 6. Standard linear buffer fill (keep it >= 350 ms full, but strictly bound output_staging)
                        let total_buffered = (ring_buffer_capacity - producer.slots()) + output_staging.len();
                        let min_target = (device_sample_rate as f32 * 0.35) as usize * 2;
                        let staging_limit = chunk_frames * 2;

                        if total_buffered < min_target && current_frame < total_trk_frames && output_staging.len() < staging_limit {
                            let t_feeder_start = Instant::now();
                            let frames_to_read = chunk_frames.min((total_trk_frames - current_frame) as usize);
                            if frames_to_read > 0 {
                                read_into_staging(&mut file, is_mono, frames_to_read, &mut input_staging);
                                current_frame += frames_to_read as u64;
                            }
                            drain_staging_through_resampler(
                                &mut resampler,
                                is_mono,
                                &mut input_staging,
                                &mut output_staging,
                                &mut delay_compensated,
                                false,
                            );

                            let dur_us = t_feeder_start.elapsed().as_micros() as u64;
                            let mut cur_max = thread_stats.max_feeder_block_duration_us.load(Ordering::Relaxed);
                            while dur_us > cur_max {
                                match thread_stats.max_feeder_block_duration_us.compare_exchange_weak(
                                    cur_max,
                                    dur_us,
                                    Ordering::Relaxed,
                                    Ordering::Relaxed,
                                ) {
                                    Ok(_) => break,
                                    Err(actual) => cur_max = actual,
                                }
                            }

                            while !output_staging.is_empty() && producer.slots() > 0 {
                                let n_to_push = output_staging.len().min(producer.slots());
                                for &s in &output_staging[..n_to_push] {
                                    let _ = producer.push(s);
                                }
                                output_staging.drain(..n_to_push);
                            }
                        } else if current_frame >= total_trk_frames && !input_staging[0].is_empty() && output_staging.len() < staging_limit {
                            let t_feeder_start = Instant::now();
                            drain_staging_through_resampler(
                                &mut resampler,
                                is_mono,
                                &mut input_staging,
                                &mut output_staging,
                                &mut delay_compensated,
                                true,
                            );
                            let dur_us = t_feeder_start.elapsed().as_micros() as u64;
                            let mut cur_max = thread_stats.max_feeder_block_duration_us.load(Ordering::Relaxed);
                            while dur_us > cur_max {
                                match thread_stats.max_feeder_block_duration_us.compare_exchange_weak(
                                    cur_max,
                                    dur_us,
                                    Ordering::Relaxed,
                                    Ordering::Relaxed,
                                ) {
                                    Ok(_) => break,
                                    Err(actual) => cur_max = actual,
                                }
                            }
                            while !output_staging.is_empty() && producer.slots() > 0 {
                                let n_to_push = output_staging.len().min(producer.slots());
                                for &s in &output_staging[..n_to_push] {
                                    let _ = producer.push(s);
                                }
                                output_staging.drain(..n_to_push);
                            }
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        } else {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                    }
                })
                .map_err(|e| format!("Error iniciando hilo feeder: {e}"))?;

            let lower_id = meta.track_id.to_ascii_lowercase();
            let initial_bus = if lower_id.contains("click") || lower_id.contains("metronom") || lower_id.contains("guia") || lower_id.contains("guide") || lower_id.contains("cue") {
                TrackBus::CueClick as u8
            } else {
                TrackBus::Main as u8
            };

            active_tracks.push(ActiveTrack {
                track_id: meta.track_id.clone(),
                file_path: pcm_path,
                original_channels: meta.channels,
                total_frames: meta.frame_count,
                gain: Arc::new(AtomicU32::new(1.0f32.to_bits())),
                pan: Arc::new(AtomicI32::new(0)),
                muted: Arc::new(AtomicBool::new(false)),
                soloed: Arc::new(AtomicBool::new(false)),
                bus: Arc::new(AtomicU8::new(initial_bus)),
                consumer: Arc::new(std::sync::Mutex::new(consumer)),
                stop_signal,
                seek_request: seek_req,
                jump_request: jump_req,
                is_vamping: is_vamping_track,
                active_section_loop: active_loop_track,
                pitch_semitones: pitch_track,
                meter: Arc::new(PeakMeter::default()),
            });
        }

        self.sample_rate.store(device_sample_rate, Ordering::SeqCst);
        self.current_frame.store(0, Ordering::SeqCst);
        self.reposition_metronome(0);
        self.total_frames.store(max_frames, Ordering::SeqCst);
        self.is_vamping.store(false, Ordering::SeqCst);
        self.clock_jumps.reset();
        *self.fade.lock().unwrap() = FadeEnvelope::new(FADE_MS, device_sample_rate);
        *self.queued_jump.lock().unwrap() = None;
        {
            let mut gc = self.guide_cue.lock().unwrap();
            gc.last_announced_section_id = None;
            gc.active_chime_sample = None;
        }

        let duration_sec = max_frames as f64 / device_sample_rate as f64;
        let track_count = active_tracks.len();

        let mut track_peaks = std::collections::HashMap::new();
        for meta in &track_metas {
            track_peaks.insert(meta.track_id.clone(), meta.peaks.clone());
        }

        let new_stream_tracks: Vec<StreamTrackHandle> = active_tracks
            .iter()
            .map(|t| StreamTrackHandle {
                consumer: Arc::clone(&t.consumer),
                gain: Arc::clone(&t.gain),
                pan: Arc::clone(&t.pan),
                muted: Arc::clone(&t.muted),
                soloed: Arc::clone(&t.soloed),
                bus: Arc::clone(&t.bus),
                meter: Arc::clone(&t.meter),
            })
            .collect();

        let mut tracks_guard = self.tracks.lock().await;
        // Stop any old tracks
        for old in tracks_guard.iter() {
            old.stop_signal.store(true, Ordering::Relaxed);
        }
        *tracks_guard = active_tracks;
        *self.stream_tracks.lock().unwrap() = new_stream_tracks;

        let mut loaded = self.loaded_project_id.lock().await;
        *loaded = Some(project_id.to_string());

        tracing::info!(
            "[NativeEngine] Loaded project '{}' ({} tracks, {:.2}s, {} Hz)",
            project_id,
            track_count,
            duration_sec,
            device_sample_rate
        );

        Ok(ProjectLoadInfo {
            project_id: project_id.to_string(),
            sample_rate: device_sample_rate,
            track_count,
            duration_sec,
            total_frames: max_frames,
            track_peaks,
        })
    }

    pub fn configure_song(
        &self,
        bpm: Option<f32>,
        beats_per_bar: Option<u32>,
        sections: Option<Vec<NativeSongSection>>,
        quantize_mode: Option<String>,
    ) {
        if let Some(b) = bpm {
            self.bpm.store(b.to_bits(), Ordering::SeqCst);
            let mut met = self.metronome.lock().unwrap();
            met.config.bpm = b;
        }
        if let Some(bpb) = beats_per_bar {
            self.beats_per_bar.store(bpb, Ordering::SeqCst);
            let mut met = self.metronome.lock().unwrap();
            met.config.beats_per_bar = bpb;
        }
        if let Some(secs) = sections {
            *self.sections.lock().unwrap() = secs;
        }
        if let Some(qm) = quantize_mode {
            *self.quantize_mode.lock().unwrap() = qm;
        }
    }

    pub async fn set_pitch(&self, semitones: i32) {
        let clamped = semitones.clamp(-6, 6);
        self.pitch_semitones.store(clamped, Ordering::SeqCst);
        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            trk.pitch_semitones.store(clamped, Ordering::Relaxed);
        }
    }

    pub fn set_metronome(&self, config: MetronomeConfig) {
        let mut met = self.metronome.lock().unwrap();
        met.config = config;
    }

    pub fn set_split_mono(&self, enabled: bool) {
        self.split_mono.store(enabled, Ordering::SeqCst);
        let mut met = self.metronome.lock().unwrap();
        met.config.split_mono = enabled;
    }

    pub fn set_master_gains(&self, master_gain: Option<f32>, cue_master_gain: Option<f32>) {
        if let Some(mg) = master_gain {
            self.master_gain.store(mg.clamp(0.0, 4.0).to_bits(), Ordering::SeqCst);
        }
        if let Some(cg) = cue_master_gain {
            self.cue_master_gain.store(cg.clamp(0.0, 4.0).to_bits(), Ordering::SeqCst);
        }
    }

    pub async fn preload_project(&self, base_dir: &Path, project_id: &str, device_sample_rate: u32) -> Result<(), String> {
        let proj_dir = get_project_cache_dir(base_dir, project_id, device_sample_rate);
        if !proj_dir.exists() {
            return Err(format!("No existe caché PCM para precargar proyecto '{project_id}'"));
        }
        let mut preloaded = self.preloaded_project_id.lock().await;
        *preloaded = Some(project_id.to_string());
        tracing::info!("[NativeEngine] Preloaded project '{}'", project_id);
        Ok(())
    }

    pub async fn switch_to_preloaded(&self, base_dir: &Path, device_sample_rate: u32) -> Result<ProjectLoadInfo, String> {
        let preloaded = {
            let mut g = self.preloaded_project_id.lock().await;
            g.take()
        };
        let project_id = preloaded.ok_or_else(|| "No hay ninguna canción precargada en cola".to_string())?;
        tracing::info!("[NativeEngine] Switching to preloaded project '{}'", project_id);
        let res = self.load_project(base_dir, &project_id, device_sample_rate, None, None, None, None).await?;
        Ok(res)
    }

    pub async fn unload_project_if_matches(&self, project_id: &str) {
        let mut loaded = self.loaded_project_id.lock().await;
        if loaded.as_deref() == Some(project_id) {
            self.is_playing.store(false, Ordering::SeqCst);
            self.is_buffering.store(false, Ordering::SeqCst);
            self.current_frame.store(0, Ordering::SeqCst);
            self.reposition_metronome(0);
            self.clock_jumps.reset();
            self.total_frames.store(0, Ordering::SeqCst);
            let mut tracks = self.tracks.lock().await;
            for old in tracks.iter() {
                old.stop_signal.store(true, Ordering::Relaxed);
            }
            tracks.clear();
            self.stream_tracks.lock().unwrap().clear();
            *loaded = None;
            tracing::info!("[NativeEngine] Unloaded project '{}'", project_id);
        }
        let mut preloaded = self.preloaded_project_id.lock().await;
        if preloaded.as_deref() == Some(project_id) {
            *preloaded = None;
        }
    }

    pub async fn set_track_controls(
        &self,
        track_id: &str,
        gain: Option<f32>,
        pan: Option<i32>,
        muted: Option<bool>,
        soloed: Option<bool>,
        bus: Option<&str>,
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
            if let Some(b) = bus {
                trk.bus.store(TrackBus::from_str(b) as u8, Ordering::Relaxed);
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

        let sample_rate_u32 = default_config.sample_rate();
        self.sample_rate.store(sample_rate_u32, Ordering::SeqCst);

        let channels = default_config.channels() as usize;

        let stream_tracks_arc = Arc::clone(&self.stream_tracks);
        let is_playing = Arc::clone(&self.is_playing);
        let is_buffering_arc = Arc::clone(&self.is_buffering);
        let buffering_start_arc = Arc::clone(&self.buffering_start_time);
        let prefill_dur_arc = Arc::clone(&self.last_prefill_duration_ms);
        let current_frame = Arc::clone(&self.current_frame);
        let clock_jumps = Arc::clone(&self.clock_jumps);
        let total_frames = Arc::clone(&self.total_frames);
        let fade_arc = Arc::clone(&self.fade);
        let stats = Arc::clone(&self.stats);
        let metronome_arc = Arc::clone(&self.metronome);
        let guide_cue_arc = Arc::clone(&self.guide_cue);
        let sections_arc = Arc::clone(&self.sections);
        let split_mono_arc = Arc::clone(&self.split_mono);
        let master_gain_arc = Arc::clone(&self.master_gain);
        let cue_master_gain_arc = Arc::clone(&self.cue_master_gain);
        let pitch_arc = Arc::clone(&self.pitch_semitones);
        let vamping_arc = Arc::clone(&self.is_vamping);
        let bus_meters_arc = Arc::clone(&self.bus_meters);

        let dev_disconnected_arc = Arc::clone(&self.device_disconnected);
        let is_playing_arc_err = Arc::clone(&self.is_playing);

        let err_fn = move |err| {
            eprintln!("[NativeAudioStream] Error en stream CPAL (posible desconexión): {err}");
            dev_disconnected_arc.store(true, Ordering::SeqCst);
            is_playing_arc_err.store(false, Ordering::SeqCst);
        };
        let stream_config: cpal::StreamConfig = default_config.into();

        // Pre-allocated scratch buffers for callback (avoids heap allocation in audio thread)
        let mut main_l = Vec::<f32>::with_capacity(4096);
        let mut main_r = Vec::<f32>::with_capacity(4096);
        let mut cue_l = Vec::<f32>::with_capacity(4096);
        let mut cue_r = Vec::<f32>::with_capacity(4096);
        let mut both_l = Vec::<f32>::with_capacity(4096);
        let mut both_r = Vec::<f32>::with_capacity(4096);
        let mut click_buf = Vec::<f32>::with_capacity(4096);
        let mut guide_buf = Vec::<f32>::with_capacity(4096);
        // Fotograma de la canción donde debería empezar el siguiente bloque si el reloj fuera continuo.
        // Si no coincide (seek, salto de sección, vuelta de vamp) el metrónomo se recoloca.
        let mut expected_start_frame = u64::MAX;

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

                    let tracks_guard = match stream_tracks_arc.try_lock() {
                        Ok(g) => g,
                        Err(_) => {
                            data.fill(0.0);
                            return;
                        }
                    };

                    if tracks_guard.is_empty() {
                        data.fill(0.0);
                        return;
                    }

                    let frames = data.len() / channels;

                    // Ensure scratch buffers are correctly sized without reallocating
                    if main_l.len() < frames {
                        main_l.resize(frames, 0.0);
                        main_r.resize(frames, 0.0);
                        cue_l.resize(frames, 0.0);
                        cue_r.resize(frames, 0.0);
                        both_l.resize(frames, 0.0);
                        both_r.resize(frames, 0.0);
                        click_buf.resize(frames, 0.0);
                        guide_buf.resize(frames, 0.0);
                    }
                    main_l[..frames].fill(0.0);
                    main_r[..frames].fill(0.0);
                    cue_l[..frames].fill(0.0);
                    cue_r[..frames].fill(0.0);
                    both_l[..frames].fill(0.0);
                    both_r[..frames].fill(0.0);
                    click_buf[..frames].fill(0.0);
                    guide_buf[..frames].fill(0.0);

                    let mut fade = match fade_arc.try_lock() {
                        Ok(f) => f,
                        Err(_) => {
                            data.fill(0.0);
                            return;
                        }
                    };

                    // Check buffering state BEFORE popping any frames from track consumers
                    if is_buffering_arc.load(Ordering::Relaxed) {
                        let mut min_avail_frames = u64::MAX;
                        for trk in tracks_guard.iter() {
                            if let Ok(c) = trk.consumer.try_lock() {
                                let avail = (c.slots() / 2) as u64;
                                if avail < min_avail_frames {
                                    min_avail_frames = avail;
                                }
                            }
                        }
                        let sr = (sample_rate_u32.max(1)) as u64;
                        let track_level_ms = if min_avail_frames == u64::MAX { 0 } else { (min_avail_frames * 1000) / sr };
                        if track_level_ms < 150 {
                            data.fill(0.0);
                            return;
                        } else {
                            is_buffering_arc.store(false, Ordering::SeqCst);
                            let dur_ms = if let Ok(mut guard) = buffering_start_arc.try_lock() {
                                guard.take().map(|t| t.elapsed().as_millis() as u64).unwrap_or(0)
                            } else {
                                0
                            };
                            prefill_dur_arc.store(dur_ms, Ordering::Relaxed);
                            stats.min_ring_buffer_level_ms.store(u64::MAX, Ordering::Relaxed);
                            fade.start_fade_in();
                        }
                    }

                    // Check if any track has solo
                    let any_solo = tracks_guard.iter().any(|t| t.soloed.load(Ordering::Relaxed));
                    let mut callback_min_track_frames = u64::MAX;

                    for trk in tracks_guard.iter() {
                        let is_muted = trk.muted.load(Ordering::Relaxed);
                        let is_solo = trk.soloed.load(Ordering::Relaxed);
                        let track_bus = TrackBus::from_u8(trk.bus.load(Ordering::Relaxed));

                        if is_muted || (any_solo && !is_solo) {
                            if let Ok(mut c) = trk.consumer.try_lock() {
                                let unread_frames = (c.slots() / 2) as u64;
                                if unread_frames < callback_min_track_frames {
                                    callback_min_track_frames = unread_frames;
                                }
                                for _ in 0..frames * 2 {
                                    let _ = c.pop();
                                }
                            }
                            continue;
                        }

                        let g = f32::from_bits(trk.gain.load(Ordering::Relaxed));
                        let p = trk.pan.load(Ordering::Relaxed) as f32 / 100.0;
                        let angle = (p + 1.0) * (std::f32::consts::PI / 4.0);
                        let pan_l = angle.cos() * g;
                        let pan_r = angle.sin() * g;

                        if let Ok(mut c) = trk.consumer.try_lock() {
                            let unread_frames = (c.slots() / 2) as u64;
                            if unread_frames < callback_min_track_frames {
                                callback_min_track_frames = unread_frames;
                            }

                            let mut had_underrun = false;
                            let mut pk_l = 0.0f32;
                            let mut pk_r = 0.0f32;
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
                                let tl = l * pan_l;
                                let tr = r * pan_r;
                                pk_l = pk_l.max(tl.abs());
                                pk_r = pk_r.max(tr.abs());
                                match track_bus {
                                    TrackBus::Main => {
                                        main_l[f] += tl;
                                        main_r[f] += tr;
                                    }
                                    TrackBus::CueClick => {
                                        cue_l[f] += tl;
                                        cue_r[f] += tr;
                                    }
                                    TrackBus::Both => {
                                        both_l[f] += tl;
                                        both_r[f] += tr;
                                    }
                                }
                            }
                            trk.meter.record(pk_l, pk_r);
                            if had_underrun && !is_buffering_arc.load(Ordering::Relaxed) {
                                stats.underruns.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }

                    if callback_min_track_frames != u64::MAX {
                        let sr = (sample_rate_u32.max(1)) as u64;
                        let track_level_ms = (callback_min_track_frames * 1000) / sr;
                        let mut current_min = stats.min_ring_buffer_level_ms.load(Ordering::Relaxed);
                        while track_level_ms < current_min {
                            match stats.min_ring_buffer_level_ms.compare_exchange_weak(
                                current_min,
                                track_level_ms,
                                Ordering::Relaxed,
                                Ordering::Relaxed,
                            ) {
                                Ok(_) => break,
                                Err(actual) => current_min = actual,
                            }
                        }
                    }

                    // Render synthesized click metronome
                    let start_song_f = current_frame.load(Ordering::Relaxed);
                    let pitch_st = pitch_arc.load(Ordering::Relaxed);
                    let pitch_ratio = 2.0f64.powf(pitch_st as f64 / 12.0);
                    let end_song_f = start_song_f + (frames as f64 * pitch_ratio).round() as u64;

                    let mut metronome_pending_reposition = false;
                    if let Ok(mut met) = metronome_arc.try_lock() {
                        if start_song_f != expected_start_frame {
                            met.seek_to_frame(start_song_f, sample_rate_u32);
                        }
                        met.render_block(start_song_f, end_song_f, frames, sample_rate_u32, &mut click_buf[..frames]);
                    } else if start_song_f != expected_start_frame {
                        metronome_pending_reposition = true;
                    }
                    expected_start_frame = if metronome_pending_reposition { u64::MAX } else { end_song_f };

                    if let Ok(mut gc) = guide_cue_arc.try_lock() {
                        if let Ok(sec_guard) = sections_arc.try_lock() {
                            gc.render_block(start_song_f, frames, sample_rate_u32, &sec_guard, &mut guide_buf[..frames]);
                        }
                    }

                    let is_split = split_mono_arc.load(Ordering::Relaxed);
                    let master_g = f32::from_bits(master_gain_arc.load(Ordering::Relaxed));
                    let cue_g = f32::from_bits(cue_master_gain_arc.load(Ordering::Relaxed));

                    // Medidores de bus: acumuladores locales en la pila; se publican una vez por bloque.
                    let (mut mk_l, mut mk_r, mut ck_l, mut ck_r, mut ok_l, mut ok_r) =
                        (0.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32);
                    let (mut clk_pk, mut gde_pk) = (0.0f32, 0.0f32);

                    // Write into output buffer applying the micro-fade envelope and split-mono / stereo routing
                    for f in 0..frames {
                        let env_gain = fade.next_gain();
                        clk_pk = clk_pk.max((click_buf[f] * cue_g * env_gain).abs());
                        gde_pk = gde_pk.max((guide_buf[f] * cue_g * env_gain).abs());

                        if is_split {
                            // Split-Mono mode:
                            // Output channel 0 (Left / In-Ear) -> pure Cue/Click bus: cue tracks + both tracks + click + guide
                            // Output channel 1 (Right / Main)  -> Main bus tracks + both tracks summed to mono
                            let cue_sum = ((cue_l[f] + cue_r[f] + both_l[f] + both_r[f]) * 0.5 + click_buf[f] + guide_buf[f]) * cue_g * env_gain;
                            let main_sum = ((main_l[f] + main_r[f] + both_l[f] + both_r[f]) * 0.5) * master_g * env_gain;

                            mk_l = mk_l.max(main_sum.abs());
                            ck_l = ck_l.max(cue_sum.abs());
                            ok_l = ok_l.max(cue_sum.abs());
                            ok_r = ok_r.max(main_sum.abs());

                            data[f * channels] = cue_sum.clamp(-1.0, 1.0);
                            if channels > 1 {
                                data[f * channels + 1] = main_sum.clamp(-1.0, 1.0);
                            }
                        } else {
                            // Standard Stereo mode (misma suma que antes, separada por bus para medirla):
                            let bus_main_l = (main_l[f] + both_l[f]) * master_g;
                            let bus_main_r = (main_r[f] + both_r[f]) * master_g;
                            let bus_cue_l = (cue_l[f] + both_l[f] + click_buf[f] + guide_buf[f]) * cue_g;
                            let bus_cue_r = (cue_r[f] + both_r[f] + click_buf[f] + guide_buf[f]) * cue_g;
                            let out_l = (bus_main_l + bus_cue_l) * env_gain;
                            let out_r = (bus_main_r + bus_cue_r) * env_gain;

                            mk_l = mk_l.max((bus_main_l * env_gain).abs());
                            mk_r = mk_r.max((bus_main_r * env_gain).abs());
                            ck_l = ck_l.max((bus_cue_l * env_gain).abs());
                            ck_r = ck_r.max((bus_cue_r * env_gain).abs());
                            ok_l = ok_l.max(out_l.abs());
                            ok_r = ok_r.max(out_r.abs());

                            data[f * channels] = out_l.clamp(-1.0, 1.0);
                            if channels > 1 {
                                data[f * channels + 1] = out_r.clamp(-1.0, 1.0);
                            }
                        }
                    }
                    if is_split {
                        // En split cada bus sale por un solo canal: se muestra igual en L y R.
                        mk_r = mk_l;
                        ck_r = ck_l;
                    }
                    bus_meters_arc.main.record(mk_l, mk_r);
                    bus_meters_arc.cue.record(ck_l, ck_r);
                    bus_meters_arc.out.record(ok_l, ok_r);
                    bus_meters_arc.click.record(clk_pk, clk_pk);
                    bus_meters_arc.guide.record(gde_pk, gde_pk);

                    let vamping_now = vamping_arc.load(Ordering::Relaxed);
                    let clock_now = advance_clock(
                        &current_frame,
                        &clock_jumps,
                        (frames as f64 * pitch_ratio).round() as u64,
                        vamping_now,
                    );
                    if clock_now >= total_frames.load(Ordering::Relaxed) && !vamping_now {
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

    /// Simulates one real-time CPAL audio callback block using the shared `stream_tracks`
    /// and atomic engine state (used for deterministic multi-song integration testing).
    pub fn simulate_callback_block(&self, data: &mut [f32], channels: usize) {
        let sample_rate_u32 = self.sample_rate.load(Ordering::Relaxed).max(1);
        self.stats.callbacks.fetch_add(1, Ordering::Relaxed);

        if !self.is_playing.load(Ordering::Relaxed) {
            data.fill(0.0);
            return;
        }

        let tracks_guard = match self.stream_tracks.try_lock() {
            Ok(g) => g,
            Err(_) => {
                data.fill(0.0);
                return;
            }
        };

        if tracks_guard.is_empty() {
            data.fill(0.0);
            return;
        }

        let frames = data.len() / channels.max(1);
        let mut fade = self.fade.lock().unwrap();

        if self.is_buffering.load(Ordering::Relaxed) {
            let mut min_avail_frames = u64::MAX;
            for trk in tracks_guard.iter() {
                if let Ok(c) = trk.consumer.lock() {
                    let avail = (c.slots() / 2) as u64;
                    if avail < min_avail_frames {
                        min_avail_frames = avail;
                    }
                }
            }
            let sr = sample_rate_u32 as u64;
            let track_level_ms = if min_avail_frames == u64::MAX { 0 } else { (min_avail_frames * 1000) / sr };
            if track_level_ms < 150 {
                data.fill(0.0);
                return;
            } else {
                self.is_buffering.store(false, Ordering::SeqCst);
                let dur_ms = if let Some(t_start) = self.buffering_start_time.lock().unwrap().take() {
                    t_start.elapsed().as_millis() as u64
                } else {
                    0
                };
                self.last_prefill_duration_ms.store(dur_ms, Ordering::Relaxed);
                self.stats.min_ring_buffer_level_ms.store(u64::MAX, Ordering::Relaxed);
                fade.start_fade_in();
            }
        }

        let any_solo = tracks_guard.iter().any(|t| t.soloed.load(Ordering::Relaxed));
        let mut main_l = vec![0.0f32; frames];
        let mut main_r = vec![0.0f32; frames];
        let mut cue_l = vec![0.0f32; frames];
        let mut cue_r = vec![0.0f32; frames];
        let mut both_l = vec![0.0f32; frames];
        let mut both_r = vec![0.0f32; frames];

        for trk in tracks_guard.iter() {
            let is_muted = trk.muted.load(Ordering::Relaxed);
            let is_solo = trk.soloed.load(Ordering::Relaxed);
            let track_bus = TrackBus::from_u8(trk.bus.load(Ordering::Relaxed));

            if is_muted || (any_solo && !is_solo) {
                if let Ok(mut c) = trk.consumer.lock() {
                    for _ in 0..frames * 2 {
                        let _ = c.pop();
                    }
                }
                continue;
            }

            let g = f32::from_bits(trk.gain.load(Ordering::Relaxed));
            let p = trk.pan.load(Ordering::Relaxed) as f32 / 100.0;
            let angle = (p + 1.0) * (std::f32::consts::PI / 4.0);
            let pan_l = angle.cos() * g;
            let pan_r = angle.sin() * g;

            if let Ok(mut c) = trk.consumer.lock() {
                let mut pk_l = 0.0f32;
                let mut pk_r = 0.0f32;
                for f in 0..frames {
                    let l = c.pop().unwrap_or(0.0);
                    let r = c.pop().unwrap_or(0.0);
                    let tl = l * pan_l;
                    let tr = r * pan_r;
                    pk_l = pk_l.max(tl.abs());
                    pk_r = pk_r.max(tr.abs());
                    match track_bus {
                        TrackBus::Main => {
                            main_l[f] += tl;
                            main_r[f] += tr;
                        }
                        TrackBus::CueClick => {
                            cue_l[f] += tl;
                            cue_r[f] += tr;
                        }
                        TrackBus::Both => {
                            both_l[f] += tl;
                            both_r[f] += tr;
                        }
                    }
                }
                trk.meter.record(pk_l, pk_r);
            }
        }

        let master_g = f32::from_bits(self.master_gain.load(Ordering::Relaxed));
        let cue_g = f32::from_bits(self.cue_master_gain.load(Ordering::Relaxed));
        let (mut mk_l, mut mk_r, mut ck_l, mut ck_r, mut ok_l, mut ok_r) =
            (0.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for f in 0..frames {
            let env_gain = fade.next_gain();
            let bus_main_l = (main_l[f] + both_l[f]) * master_g;
            let bus_main_r = (main_r[f] + both_r[f]) * master_g;
            let bus_cue_l = (cue_l[f] + both_l[f]) * cue_g;
            let bus_cue_r = (cue_r[f] + both_r[f]) * cue_g;
            let out_l = (bus_main_l + bus_cue_l) * env_gain;
            let out_r = (bus_main_r + bus_cue_r) * env_gain;
            mk_l = mk_l.max((bus_main_l * env_gain).abs());
            mk_r = mk_r.max((bus_main_r * env_gain).abs());
            ck_l = ck_l.max((bus_cue_l * env_gain).abs());
            ck_r = ck_r.max((bus_cue_r * env_gain).abs());
            ok_l = ok_l.max(out_l.abs());
            ok_r = ok_r.max(out_r.abs());
            data[f * channels] = out_l.clamp(-1.0, 1.0);
            if channels > 1 {
                data[f * channels + 1] = out_r.clamp(-1.0, 1.0);
            }
        }
        self.bus_meters.main.record(mk_l, mk_r);
        self.bus_meters.cue.record(ck_l, ck_r);
        self.bus_meters.out.record(ok_l, ok_r);

        let pitch_st = self.pitch_semitones.load(Ordering::Relaxed);
        let pitch_ratio = 2.0f64.powf(pitch_st as f64 / 12.0);
        let vamping_now = self.is_vamping.load(Ordering::Relaxed);
        let clock_now = advance_clock(
            &self.current_frame,
            &self.clock_jumps,
            (frames as f64 * pitch_ratio).round() as u64,
            vamping_now,
        );
        if clock_now >= self.total_frames.load(Ordering::Relaxed) && !vamping_now {
            self.is_playing.store(false, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests;
