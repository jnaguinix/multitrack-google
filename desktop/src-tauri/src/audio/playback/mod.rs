use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSongSection {
    pub id: String,
    pub name: String,
    pub code: Option<String>,
    pub start_sec: f64,
    pub end_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedJumpInfo {
    pub target_section_id: String,
    pub target_sec: f64,
    pub transition_sec: f64,
    pub target_frame: u64,
    pub transition_frame: u64,
}

#[derive(Debug, Clone)]
pub struct QueuedJumpRequest {
    pub target_frame: u64,
    pub transition_frame: u64,
    pub crossfade_frames: usize,
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
    pub bus: Arc<AtomicU8>,   // 0: Main, 1: CueClick, 2: Both
    pub consumer: Arc<std::sync::Mutex<rtrb::Consumer<f32>>>,
    pub stop_signal: Arc<AtomicBool>,
    pub seek_request: Arc<AtomicI64>,
    pub jump_request: Arc<std::sync::Mutex<Option<QueuedJumpRequest>>>,
    pub is_vamping: Arc<AtomicBool>,
    pub active_section_loop: Arc<std::sync::Mutex<Option<(u64, u64)>>>,
    pub pitch_semitones: Arc<AtomicI32>,
}

pub struct StreamTrackHandle {
    pub consumer: Arc<std::sync::Mutex<rtrb::Consumer<f32>>>,
    pub gain: Arc<AtomicU32>,
    pub pan: Arc<AtomicI32>,
    pub muted: Arc<AtomicBool>,
    pub soloed: Arc<AtomicBool>,
    pub bus: Arc<AtomicU8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchSongResult {
    pub project_id: String,
    pub track_count: usize,
    pub duration_sec: f64,
    pub switch_duration_ms: u64,
}

pub struct PlaybackEngine {
    pub loaded_project_id: TokioMutex<Option<String>>,
    pub is_playing: Arc<AtomicBool>,
    pub is_buffering: Arc<AtomicBool>,
    pub buffering_start_time: Arc<std::sync::Mutex<Option<Instant>>>,
    pub last_prefill_duration_ms: Arc<AtomicU64>,
    pub seek_generation: Arc<AtomicU64>,
    pub current_frame: Arc<AtomicU64>,
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
}

fn read_frames_to_slices<R: Read>(
    reader: &mut R,
    is_mono: bool,
    frames: usize,
    out_l: &mut [f32],
    out_r: &mut [f32],
) {
    let bytes_per_frame = if is_mono { 2 } else { 4 };
    let mut buf = vec![0u8; frames * bytes_per_frame];
    if reader.read_exact(&mut buf).is_ok() {
        if is_mono {
            for i in 0..frames {
                let s = i16::from_le_bytes([buf[i * 2], buf[i * 2 + 1]]) as f32 / 32768.0;
                out_l[i] = s;
                out_r[i] = s;
            }
        } else {
            for i in 0..frames {
                out_l[i] = i16::from_le_bytes([buf[i * 4], buf[i * 4 + 1]]) as f32 / 32768.0;
                out_r[i] = i16::from_le_bytes([buf[i * 4 + 2], buf[i * 4 + 3]]) as f32 / 32768.0;
            }
        }
    } else {
        out_l[..frames].fill(0.0);
        out_r[..frames].fill(0.0);
    }
}

fn read_into_staging<R: Read>(
    reader: &mut R,
    is_mono: bool,
    frames: usize,
    staging: &mut [Vec<f32>],
) {
    if frames == 0 {
        return;
    }
    let bytes_per_frame = if is_mono { 2 } else { 4 };
    let mut buf = vec![0u8; frames * bytes_per_frame];
    if let Ok(()) = reader.read_exact(&mut buf) {
        if is_mono {
            let ch0 = &mut staging[0];
            ch0.reserve(frames);
            for i in 0..frames {
                let s = i16::from_le_bytes([buf[i * 2], buf[i * 2 + 1]]) as f32 / 32768.0;
                ch0.push(s);
            }
        } else {
            let (ch0, rest) = staging.split_at_mut(1);
            let ch1 = &mut rest[0];
            ch0[0].reserve(frames);
            ch1.reserve(frames);
            for i in 0..frames {
                let l = i16::from_le_bytes([buf[i * 4], buf[i * 4 + 1]]) as f32 / 32768.0;
                let r = i16::from_le_bytes([buf[i * 4 + 2], buf[i * 4 + 3]]) as f32 / 32768.0;
                ch0[0].push(l);
                ch1.push(r);
            }
        }
    }
}

fn drain_staging_through_resampler(
    resampler: &mut TrackResampler,
    is_mono: bool,
    input_staging: &mut [Vec<f32>],
    output_staging: &mut Vec<f32>,
    delay_compensated: &mut bool,
    allow_partial: bool,
) {
    let chunk_size = resampler.chunk_size;

    while input_staging[0].len() >= chunk_size {
        let mut in_chunk: Vec<Vec<f32>> = Vec::with_capacity(input_staging.len());
        for ch in input_staging.iter_mut() {
            let chunk: Vec<f32> = ch.drain(..chunk_size).collect();
            in_chunk.push(chunk);
        }

        if let Ok(processed) = resampler.process(&in_chunk) {
            let out_frames = processed[0].len();
            let start_frame = if !*delay_compensated {
                *delay_compensated = true;
                resampler.output_delay().min(out_frames)
            } else {
                0
            };

            for i in start_frame..out_frames {
                if is_mono {
                    let s = processed[0][i];
                    output_staging.push(s);
                    output_staging.push(s);
                } else {
                    output_staging.push(processed[0][i]);
                    output_staging.push(processed[1][i]);
                }
            }
        }
    }

    if allow_partial && !input_staging[0].is_empty() {
        let partial_in: Vec<Vec<f32>> = input_staging.iter_mut().map(|ch| ch.drain(..).collect()).collect();
        if let Ok(processed) = resampler.process_partial(Some(&partial_in)) {
            if !processed.is_empty() {
                let out_frames = processed[0].len();
                let start_frame = if !*delay_compensated {
                    *delay_compensated = true;
                    resampler.output_delay().min(out_frames)
                } else {
                    0
                };
                for i in start_frame..out_frames {
                    if is_mono {
                        let s = processed[0][i];
                        output_staging.push(s);
                        output_staging.push(s);
                    } else {
                        output_staging.push(processed[0][i]);
                        output_staging.push(processed[1][i]);
                    }
                }
            }
        }
    }
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
                    "No existe cachÃ© PCM para el proyecto '{project_id}' a {device_sample_rate} Hz (ruta buscada: '{}'). Se encontraron frecuencias existentes: {:?} Hz. Utiliza el botÃ³n Â«Generar cachÃ© nativaÂ» para convertirla.",
                    proj_dir.display(),
                    other_rates
                ));
            }
            return Err(format!(
                "No existe cachÃ© PCM para el proyecto '{project_id}' a {device_sample_rate} Hz (ruta buscada: '{}'). Genera la cachÃ© nativa antes de reproducir.",
                proj_dir.display()
            ));
        }

        let mut read_dir = std::fs::read_dir(&proj_dir)
            .map_err(|e| format!("Error leyendo directorio de cachÃ© en '{}': {e}", proj_dir.display()))?;

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
                "No se encontraron metadatos (.json) en la cachÃ© de '{}'",
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
            });
        }

        self.sample_rate.store(device_sample_rate, Ordering::SeqCst);
        self.current_frame.store(0, Ordering::SeqCst);
        self.total_frames.store(max_frames, Ordering::SeqCst);
        self.is_vamping.store(false, Ordering::SeqCst);
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

    pub async fn queue_section_jump(
        &self,
        section_id: &str,
        quantize_mode_opt: Option<&str>,
    ) -> Result<QueuedJumpInfo, String> {
        let sr = self.sample_rate.load(Ordering::SeqCst) as f64;
        let cur_frame = self.current_frame.load(Ordering::SeqCst);
        let cur_sec_now = cur_frame as f64 / sr;

        tracing::info!("[NativeEngine] queue_section_jump: target='{}', cur_frame={}, cur_sec={:.2}", section_id, cur_frame, cur_sec_now);

        let (target_sec_obj, cur_sec_end) = {
            let sections_guard = self.sections.lock().unwrap();
            let target = sections_guard
                .iter()
                .find(|s| s.id == section_id)
                .ok_or_else(|| format!("SecciÃ³n '{section_id}' no encontrada en las {} secciones registradas", sections_guard.len()))?
                .clone();
            let cur_end = sections_guard
                .iter()
                .find(|s| cur_sec_now >= s.start_sec && cur_sec_now < s.end_sec)
                .map(|s| s.end_sec);
            (target, cur_end)
        };

        let target_frame = (target_sec_obj.start_sec * sr).round() as u64;

        let mode = quantize_mode_opt
            .map(|s| s.to_string())
            .unwrap_or_else(|| self.quantize_mode.lock().unwrap().clone());

        if mode == "immediate" {
            tracing::info!("[NativeEngine] Immediate jump to '{}' ({:.2}s)", section_id, target_sec_obj.start_sec);
            self.seek(target_sec_obj.start_sec).await;
            *self.queued_jump.lock().unwrap() = None;
            self.guide_cue.lock().unwrap().trigger_chime();
            return Ok(QueuedJumpInfo {
                target_section_id: target_sec_obj.id,
                target_sec: target_sec_obj.start_sec,
                transition_sec: target_sec_obj.start_sec,
                target_frame,
                transition_frame: target_frame,
            });
        }

        let bpm = f32::from_bits(self.bpm.load(Ordering::SeqCst)).max(10.0) as f64;
        let bpb = self.beats_per_bar.load(Ordering::SeqCst).max(1) as f64;
        let sec_per_bar = (60.0 / bpm) * bpb;
        let frames_per_bar = (sec_per_bar * sr).max(1.0);

        // Ring buffer holds up to 500ms of audio. Add 100ms safety margin.
        let min_safe_ahead = (0.600 * sr).round() as u64;
        let min_transition_frame = cur_frame + min_safe_ahead;

        let cur_bar = (cur_frame as f64 / frames_per_bar).floor();
        let mut target_bar = cur_bar + 1.0;

        let transition_frame = if mode == "1-bar" {
            let mut trans = (target_bar * frames_per_bar).round() as u64;
            if trans < min_transition_frame || (trans as f64 - cur_frame as f64) < (0.25 * sr) {
                target_bar = ((min_transition_frame as f64 / frames_per_bar).ceil()).max(target_bar + 1.0);
                trans = (target_bar * frames_per_bar).round() as u64;
            }
            trans
        } else if mode == "2-bars" {
            let mut trans = ((cur_bar + 2.0) * frames_per_bar).round() as u64;
            if trans < min_transition_frame {
                target_bar = ((min_transition_frame as f64 / frames_per_bar).ceil()).max(cur_bar + 2.0);
                trans = (target_bar * frames_per_bar).round() as u64;
            }
            trans
        } else if mode == "section-end" {
            if let Some(end_sec) = cur_sec_end {
                let end_f = (end_sec * sr).round() as u64;
                if end_f >= min_transition_frame {
                    end_f
                } else {
                    ((target_bar + 1.0) * frames_per_bar).round() as u64
                }
            } else {
                ((target_bar + 1.0) * frames_per_bar).round() as u64
            }
        } else {
            ((target_bar + 1.0) * frames_per_bar).round() as u64
        };

        let transition_sec = transition_frame as f64 / sr;
        let crossfade_frames = ((FADE_MS / 1000.0) * sr as f32).round().max(1.0) as usize;

        tracing::info!(
            "[NativeEngine] Scheduled jump: target='{}' ({:.2}s), trans at {:.2}s (frame {}), mode='{}'",
            target_sec_obj.id,
            target_sec_obj.start_sec,
            transition_sec,
            transition_frame,
            mode
        );

        let jump_info = QueuedJumpInfo {
            target_section_id: target_sec_obj.id.clone(),
            target_sec: target_sec_obj.start_sec,
            transition_sec,
            target_frame,
            transition_frame,
        };

        *self.queued_jump.lock().unwrap() = Some(jump_info.clone());
        self.guide_cue.lock().unwrap().trigger_chime();

        let req = QueuedJumpRequest {
            target_frame,
            transition_frame,
            crossfade_frames,
        };
        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            *trk.jump_request.lock().unwrap() = Some(req.clone());
        }

        Ok(jump_info)
    }

    pub async fn cancel_queued_jump(&self) {
        tracing::info!("[NativeEngine] cancel_queued_jump");
        *self.queued_jump.lock().unwrap() = None;
        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            *trk.jump_request.lock().unwrap() = None;
        }
    }

    pub async fn toggle_vamp(&self, enable: Option<bool>) -> bool {
        let new_state = match enable {
            Some(e) => e,
            None => !self.is_vamping.load(Ordering::SeqCst),
        };
        self.is_vamping.store(new_state, Ordering::SeqCst);

        let cur_frame = self.current_frame.load(Ordering::SeqCst);
        let sr = self.sample_rate.load(Ordering::SeqCst) as f64;
        let cur_sec = cur_frame as f64 / sr;

        tracing::info!("[NativeEngine] toggle_vamp: new_state={new_state}, cur_frame={cur_frame}, cur_sec={cur_sec:.2}");

        if new_state {
            self.guide_cue.lock().unwrap().trigger_chime();
            let active_loop = {
                let sections_guard = self.sections.lock().unwrap();
                sections_guard
                    .iter()
                    .find(|s| cur_sec >= s.start_sec && cur_sec < s.end_sec)
                    .map(|sec| ((sec.start_sec * sr).round() as u64, (sec.end_sec * sr).round() as u64))
            };
            if let Some((loop_start, loop_end)) = active_loop {
                tracing::info!("[NativeEngine] Vamp active loop: frames {} -> {}", loop_start, loop_end);
                let tracks = self.tracks.lock().await;
                for trk in tracks.iter() {
                    trk.is_vamping.store(true, Ordering::Relaxed);
                    *trk.active_section_loop.lock().unwrap() = Some((loop_start, loop_end));
                }
            }
        } else {
            let tracks = self.tracks.lock().await;
            for trk in tracks.iter() {
                trk.is_vamping.store(false, Ordering::Relaxed);
                *trk.active_section_loop.lock().unwrap() = None;
            }
        }

        new_state
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
            return Err(format!("No existe cachÃ© PCM para precargar proyecto '{project_id}'"));
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
        let project_id = preloaded.ok_or_else(|| "No hay ninguna canciÃ³n precargada en cola".to_string())?;
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

    pub async fn reopen_stream(&self, engine_state: &AudioEngineState) -> Result<(), String> {
        {
            let mut stream_guard = self.stream.lock().await;
            *stream_guard = None;
        }
        self.device_disconnected.store(false, Ordering::SeqCst);
        self.ensure_stream(engine_state).await?;
        tracing::info!("[NativeEngine] Audio stream reopened successfully");
        Ok(())
    }

    pub async fn play(&self, state: &AudioEngineState) -> Result<(), String> {
        {
            let loaded = self.loaded_project_id.lock().await;
            if loaded.is_none() {
                return Err("No hay proyecto cargado en el motor nativo".to_string());
            }
        }

        if self.is_playing.load(Ordering::SeqCst) {
            return Ok(());
        }

        let tot = self.total_frames.load(Ordering::SeqCst);
        if tot > 0 && self.current_frame.load(Ordering::SeqCst) >= tot {
            self.seek(0.0).await;
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

        self.is_buffering.store(false, Ordering::SeqCst);
        *self.buffering_start_time.lock().unwrap() = None;
        self.current_frame.store(0, Ordering::SeqCst);
        *self.queued_jump.lock().unwrap() = None;
        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            trk.seek_request.store(0, Ordering::SeqCst);
            *trk.jump_request.lock().unwrap() = None;
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

        // Enter buffering/preparation state:
        self.seek_generation.fetch_add(1, Ordering::SeqCst);
        self.is_buffering.store(true, Ordering::SeqCst);
        *self.buffering_start_time.lock().unwrap() = Some(Instant::now());

        self.current_frame.store(target_frame as u64, Ordering::SeqCst);
        *self.queued_jump.lock().unwrap() = None;

        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            trk.seek_request.store(target_frame, Ordering::SeqCst);
            *trk.jump_request.lock().unwrap() = None;
            if let Ok(mut c) = trk.consumer.lock() {
                while c.pop().is_ok() {}
            }
        }

        tracing::info!("[NativeEngine] seek to target_sec={:.2} (frame {})", target_sec, target_frame);
    }

    pub fn get_playback_state(&self) -> PlaybackStateSnapshot {
        let sr = self.sample_rate.load(Ordering::SeqCst).max(1);
        let cur = self.current_frame.load(Ordering::SeqCst);
        let tot = self.total_frames.load(Ordering::SeqCst);
        let cur_sec = cur as f64 / sr as f64;

        let sections_guard = self.sections.lock().unwrap();
        let active_section_id = sections_guard
            .iter()
            .find(|s| cur_sec >= s.start_sec && cur_sec < s.end_sec)
            .map(|s| s.id.clone());

        let mut queued_guard = self.queued_jump.lock().unwrap();
        if let Some(q) = queued_guard.as_ref() {
            if cur >= q.transition_frame {
                *queued_guard = None;
            }
        }
        let queued_section_id = queued_guard.as_ref().map(|q| q.target_section_id.clone());

        let met = self.metronome.lock().unwrap();

        PlaybackStateSnapshot {
            is_playing: self.is_playing.load(Ordering::SeqCst),
            is_buffering: self.is_buffering.load(Ordering::SeqCst),
            prefill_duration_ms: self.last_prefill_duration_ms.load(Ordering::Relaxed),
            device_disconnected: self.device_disconnected.load(Ordering::Relaxed),
            position_sec: cur_sec,
            duration_sec: tot as f64 / sr as f64,
            current_frame: cur,
            total_frames: tot,
            underruns: self.stats.underruns.load(Ordering::Relaxed),
            callbacks: self.stats.callbacks.load(Ordering::Relaxed),
            max_callback_duration_us: self.stats.max_callback_duration_us.load(Ordering::Relaxed),
            max_feeder_block_duration_us: self.stats.max_feeder_block_duration_us.load(Ordering::Relaxed),
            min_ring_buffer_level_ms: {
                let m = self.stats.min_ring_buffer_level_ms.load(Ordering::Relaxed);
                if m == u64::MAX {
                    None
                } else {
                    Some(m)
                }
            },
            active_section_id,
            queued_section_id,
            is_vamping: self.is_vamping.load(Ordering::SeqCst),
            pitch_semitones: self.pitch_semitones.load(Ordering::SeqCst),
            click_enabled: met.config.enabled,
            click_gain: met.config.gain,
            click_subdivision: met.config.subdivision,
            quantize_mode: self.quantize_mode.lock().unwrap().clone(),
            split_mono: self.split_mono.load(Ordering::SeqCst),
            master_gain: f32::from_bits(self.master_gain.load(Ordering::Relaxed)),
            cue_master_gain: f32::from_bits(self.cue_master_gain.load(Ordering::Relaxed)),
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
            .map_err(|e| format!("Error en configuraciÃ³n de salida: {e}"))?;

        let sample_rate_u32 = default_config.sample_rate();
        self.sample_rate.store(sample_rate_u32, Ordering::SeqCst);

        let channels = default_config.channels() as usize;

        let stream_tracks_arc = Arc::clone(&self.stream_tracks);
        let is_playing = Arc::clone(&self.is_playing);
        let is_buffering_arc = Arc::clone(&self.is_buffering);
        let buffering_start_arc = Arc::clone(&self.buffering_start_time);
        let prefill_dur_arc = Arc::clone(&self.last_prefill_duration_ms);
        let current_frame = Arc::clone(&self.current_frame);
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

        let dev_disconnected_arc = Arc::clone(&self.device_disconnected);
        let is_playing_arc_err = Arc::clone(&self.is_playing);

        let err_fn = move |err| {
            eprintln!("[NativeAudioStream] Error en stream CPAL (posible desconexiÃ³n): {err}");
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

                    if let Ok(mut met) = metronome_arc.try_lock() {
                        met.render_block(start_song_f, end_song_f, frames, sample_rate_u32, &mut click_buf[..frames]);
                    }

                    if let Ok(mut gc) = guide_cue_arc.try_lock() {
                        if let Ok(sec_guard) = sections_arc.try_lock() {
                            gc.render_block(start_song_f, frames, sample_rate_u32, &sec_guard, &mut guide_buf[..frames]);
                        }
                    }

                    let is_split = split_mono_arc.load(Ordering::Relaxed);
                    let master_g = f32::from_bits(master_gain_arc.load(Ordering::Relaxed));
                    let cue_g = f32::from_bits(cue_master_gain_arc.load(Ordering::Relaxed));

                    // Write into output buffer applying the micro-fade envelope and split-mono / stereo routing
                    for f in 0..frames {
                        let env_gain = fade.next_gain();

                        if is_split {
                            // Split-Mono mode:
                            // Output channel 0 (Left / In-Ear) -> pure Cue/Click bus: cue tracks + both tracks + click + guide
                            // Output channel 1 (Right / Main)  -> Main bus tracks + both tracks summed to mono
                            let cue_sum = ((cue_l[f] + cue_r[f] + both_l[f] + both_r[f]) * 0.5 + click_buf[f] + guide_buf[f]) * cue_g * env_gain;
                            let main_sum = ((main_l[f] + main_r[f] + both_l[f] + both_r[f]) * 0.5) * master_g * env_gain;

                            data[f * channels] = cue_sum.clamp(-1.0, 1.0);
                            if channels > 1 {
                                data[f * channels + 1] = main_sum.clamp(-1.0, 1.0);
                            }
                        } else {
                            // Standard Stereo mode:
                            let out_l = (((main_l[f] + both_l[f]) * master_g) + ((cue_l[f] + both_l[f] + click_buf[f] + guide_buf[f]) * cue_g)) * env_gain;
                            let out_r = (((main_r[f] + both_r[f]) * master_g) + ((cue_r[f] + both_r[f] + click_buf[f] + guide_buf[f]) * cue_g)) * env_gain;

                            data[f * channels] = out_l.clamp(-1.0, 1.0);
                            if channels > 1 {
                                data[f * channels + 1] = out_r.clamp(-1.0, 1.0);
                            }
                        }
                    }

                    current_frame.fetch_add((frames as f64 * pitch_ratio).round() as u64, Ordering::Relaxed);
                    if current_frame.load(Ordering::Relaxed) >= total_frames.load(Ordering::Relaxed) && !vamping_arc.load(Ordering::Relaxed) {
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
                for f in 0..frames {
                    let l = c.pop().unwrap_or(0.0);
                    let r = c.pop().unwrap_or(0.0);
                    let tl = l * pan_l;
                    let tr = r * pan_r;
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
            }
        }

        let master_g = f32::from_bits(self.master_gain.load(Ordering::Relaxed));
        let cue_g = f32::from_bits(self.cue_master_gain.load(Ordering::Relaxed));
        for f in 0..frames {
            let env_gain = fade.next_gain();
            let out_l = (((main_l[f] + both_l[f]) * master_g) + ((cue_l[f] + both_l[f]) * cue_g)) * env_gain;
            let out_r = (((main_r[f] + both_r[f]) * master_g) + ((cue_r[f] + both_r[f]) * cue_g)) * env_gain;
            data[f * channels] = out_l.clamp(-1.0, 1.0);
            if channels > 1 {
                data[f * channels + 1] = out_r.clamp(-1.0, 1.0);
            }
        }

        let pitch_st = self.pitch_semitones.load(Ordering::Relaxed);
        let pitch_ratio = 2.0f64.powf(pitch_st as f64 / 12.0);
        self.current_frame.fetch_add((frames as f64 * pitch_ratio).round() as u64, Ordering::Relaxed);
        if self.current_frame.load(Ordering::Relaxed) >= self.total_frames.load(Ordering::Relaxed)
            && !self.is_vamping.load(Ordering::Relaxed)
        {
            self.is_playing.store(false, Ordering::Relaxed);
        }
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
    #[serde(default)]
    pub track_peaks: std::collections::HashMap<String, Vec<f32>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStateSnapshot {
    pub is_playing: bool,
    pub is_buffering: bool,
    pub prefill_duration_ms: u64,
    pub device_disconnected: bool,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub current_frame: u64,
    pub total_frames: u64,
    pub underruns: u64,
    pub callbacks: u64,
    pub max_callback_duration_us: u64,
    pub max_feeder_block_duration_us: u64,
    pub min_ring_buffer_level_ms: Option<u64>,
    pub active_section_id: Option<String>,
    pub queued_section_id: Option<String>,
    pub is_vamping: bool,
    pub pitch_semitones: i32,
    pub click_enabled: bool,
    pub click_gain: f32,
    pub click_subdivision: u32,
    pub quantize_mode: String,
    pub split_mono: bool,
    pub master_gain: f32,
    pub cue_master_gain: f32,
}

#[cfg(test)]
mod tests;
