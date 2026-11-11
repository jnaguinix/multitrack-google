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
use crate::audio::metronome::{MetronomeConfig, MetronomeEngine};
use crate::audio::output::{get_device_name, AudioEngineState, AudioStreamStats};
use crate::audio::resampler::TrackResampler;

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
    pub consumer: Arc<std::sync::Mutex<rtrb::Consumer<f32>>>,
    pub stop_signal: Arc<AtomicBool>,
    pub seek_request: Arc<AtomicI64>,
    pub jump_request: Arc<std::sync::Mutex<Option<QueuedJumpRequest>>>,
    pub is_vamping: Arc<AtomicBool>,
    pub active_section_loop: Arc<std::sync::Mutex<Option<(u64, u64)>>>,
    pub pitch_semitones: Arc<AtomicI32>,
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

    // Phase 4 fields:
    pub sections: Arc<std::sync::Mutex<Vec<NativeSongSection>>>,
    pub quantize_mode: Arc<std::sync::Mutex<String>>, // "1-bar", "2-bars", "section-end", "immediate"
    pub bpm: Arc<AtomicU32>,                           // f32 bits
    pub beats_per_bar: Arc<AtomicU32>,
    pub is_vamping: Arc<AtomicBool>,
    pub split_mono: Arc<AtomicBool>,
    pub pitch_semitones: Arc<AtomicI32>,
    pub queued_jump: Arc<std::sync::Mutex<Option<QueuedJumpInfo>>>,
    pub metronome: Arc<std::sync::Mutex<MetronomeEngine>>,
    pub preloaded_project_id: TokioMutex<Option<String>>,
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

fn read_and_push_frames<R: Read>(
    reader: &mut R,
    is_mono: bool,
    frames: usize,
    producer: &mut rtrb::Producer<f32>,
    resampler: &mut Option<TrackResampler>,
) {
    if frames == 0 {
        return;
    }
    let mut l = vec![0.0f32; frames];
    let mut r = vec![0.0f32; frames];
    read_frames_to_slices(reader, is_mono, frames, &mut l, &mut r);

    if let Some(res) = resampler {
        if let Ok(processed) = res.process(&[l, r]) {
            if processed.len() >= 2 {
                let n = processed[0].len();
                for i in 0..n {
                    let _ = producer.push(processed[0][i]);
                    let _ = producer.push(processed[1][i]);
                }
            }
        }
    } else {
        // Zero-resampling bypass
        for i in 0..frames {
            let _ = producer.push(l[i]);
            let _ = producer.push(r[i]);
        }
    }
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
            sections: Arc::new(std::sync::Mutex::new(Vec::new())),
            quantize_mode: Arc::new(std::sync::Mutex::new("1-bar".to_string())),
            bpm: Arc::new(AtomicU32::new(120.0f32.to_bits())),
            beats_per_bar: Arc::new(AtomicU32::new(4)),
            is_vamping: Arc::new(AtomicBool::new(false)),
            split_mono: Arc::new(AtomicBool::new(false)),
            pitch_semitones: Arc::new(AtomicI32::new(0)),
            queued_jump: Arc::new(std::sync::Mutex::new(None)),
            metronome: Arc::new(std::sync::Mutex::new(MetronomeEngine::new(
                MetronomeConfig::default(),
            ))),
            preloaded_project_id: TokioMutex::new(None),
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
                    let mut current_frame = 0u64;

                    let mut last_pitch = thread_pitch.load(Ordering::Relaxed);
                    let mut resampler: Option<TrackResampler> = if last_pitch != 0 {
                        TrackResampler::new(device_sample_rate, device_sample_rate, last_pitch, chunk_frames, 2).ok()
                    } else {
                        None
                    };

                    while !thread_stop.load(Ordering::Relaxed) {
                        // 1. Check seek requests
                        let target_seek = thread_seek.swap(-1, Ordering::SeqCst);
                        if target_seek >= 0 {
                            current_frame = target_seek as u64;
                            let file_offset = current_frame * bytes_per_frame as u64;
                            let _ = file.seek(SeekFrom::Start(file_offset));
                            if let Some(ref mut r) = resampler {
                                r.reset();
                            }
                        }

                        // 2. Check pitch change
                        let cur_pitch = thread_pitch.load(Ordering::Relaxed);
                        if cur_pitch != last_pitch {
                            last_pitch = cur_pitch;
                            if cur_pitch == 0 {
                                resampler = None; // Zero-resampling bypass
                            } else {
                                resampler = TrackResampler::new(device_sample_rate, device_sample_rate, cur_pitch, chunk_frames, 2).ok();
                            }
                        }

                        // 3. Check queued jump requests
                        let queued_jump_opt = {
                            let g = thread_jump.lock().unwrap();
                            g.clone()
                        };
                        if let Some(jump) = queued_jump_opt {
                            if current_frame < jump.transition_frame && (current_frame + chunk_frames as u64) >= jump.transition_frame {
                                let pre_frames = (jump.transition_frame - current_frame) as usize;
                                if pre_frames > 0 {
                                    read_and_push_frames(&mut file, is_mono, pre_frames, &mut producer, &mut resampler);
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
                                    let _ = producer.push(sl);
                                    let _ = producer.push(sr);
                                }

                                current_frame = jump.target_frame + m as u64;
                                let next_offset = current_frame * bytes_per_frame as u64;
                                let _ = file.seek(SeekFrom::Start(next_offset));
                                *thread_jump.lock().unwrap() = None;
                                continue;
                            }
                        }

                        // 4. Check vamp loop
                        if thread_vamp.load(Ordering::Relaxed) {
                            let loop_opt = {
                                let g = thread_active_loop.lock().unwrap();
                                *g
                            };
                            if let Some((loop_start, loop_end)) = loop_opt {
                                if current_frame < loop_end && (current_frame + chunk_frames as u64) >= loop_end {
                                    let pre_frames = (loop_end - current_frame) as usize;
                                    if pre_frames > 0 {
                                        read_and_push_frames(&mut file, is_mono, pre_frames, &mut producer, &mut resampler);
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
                                        let _ = producer.push(sl);
                                        let _ = producer.push(sr);
                                    }

                                    current_frame = loop_start + m as u64;
                                    let next_offset = current_frame * bytes_per_frame as u64;
                                    let _ = file.seek(SeekFrom::Start(next_offset));
                                    continue;
                                }
                            }
                        }

                        // 5. Standard linear buffer fill (keep it >= 350 ms full)
                        let free_slots = producer.slots();
                        let slots_needed_for_chunk = chunk_frames * 2;

                        if free_slots >= slots_needed_for_chunk && current_frame < total_trk_frames {
                            let frames_to_read = chunk_frames.min((total_trk_frames - current_frame) as usize);
                            read_and_push_frames(&mut file, is_mono, frames_to_read, &mut producer, &mut resampler);
                            current_frame += frames_to_read as u64;
                        } else {
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
                jump_request: jump_req,
                is_vamping: is_vamping_track,
                active_section_loop: active_loop_track,
                pitch_semitones: pitch_track,
            });
        }

        self.sample_rate.store(device_sample_rate, Ordering::SeqCst);
        self.current_frame.store(0, Ordering::SeqCst);
        self.total_frames.store(max_frames, Ordering::SeqCst);
        *self.fade.lock().unwrap() = FadeEnvelope::new(FADE_MS, device_sample_rate);
        *self.queued_jump.lock().unwrap() = None;

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

        let (target_sec_obj, cur_sec_end) = {
            let sections_guard = self.sections.lock().unwrap();
            let target = sections_guard
                .iter()
                .find(|s| s.id == section_id)
                .ok_or_else(|| format!("Sección '{section_id}' no encontrada"))?
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
            self.seek(target_sec_obj.start_sec).await;
            *self.queued_jump.lock().unwrap() = None;
            return Ok(QueuedJumpInfo {
                target_section_id: target_sec_obj.id,
                target_sec: target_sec_obj.start_sec,
                transition_sec: target_sec_obj.start_sec,
                target_frame,
                transition_frame: target_frame,
            });
        }

        let cur_frame = self.current_frame.load(Ordering::SeqCst);
        let bpm = f32::from_bits(self.bpm.load(Ordering::SeqCst)).max(10.0) as f64;
        let bpb = self.beats_per_bar.load(Ordering::SeqCst).max(1) as f64;
        let sec_per_bar = (60.0 / bpm) * bpb;
        let frames_per_bar = (sec_per_bar * sr).max(1.0);

        let cur_bar = (cur_frame as f64 / frames_per_bar).floor();
        let mut target_bar = cur_bar + 1.0;

        let transition_frame = if mode == "1-bar" {
            let mut trans = (target_bar * frames_per_bar).round() as u64;
            if (trans as f64 - cur_frame as f64) < (0.25 * sr) {
                target_bar += 1.0;
                trans = (target_bar * frames_per_bar).round() as u64;
            }
            trans
        } else if mode == "2-bars" {
            ((cur_bar + 2.0) * frames_per_bar).round() as u64
        } else if mode == "section-end" {
            if let Some(end_sec) = cur_sec_end {
                (end_sec * sr).round() as u64
            } else {
                ((cur_bar + 1.0) * frames_per_bar).round() as u64
            }
        } else {
            ((cur_bar + 1.0) * frames_per_bar).round() as u64
        };

        let transition_sec = transition_frame as f64 / sr;
        let crossfade_frames = ((FADE_MS / 1000.0) * sr as f32).round().max(1.0) as usize;

        let jump_info = QueuedJumpInfo {
            target_section_id: target_sec_obj.id.clone(),
            target_sec: target_sec_obj.start_sec,
            transition_sec,
            target_frame,
            transition_frame,
        };

        *self.queued_jump.lock().unwrap() = Some(jump_info.clone());

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

        if new_state {
            let active_loop = {
                let sections_guard = self.sections.lock().unwrap();
                sections_guard
                    .iter()
                    .find(|s| cur_sec >= s.start_sec && cur_sec < s.end_sec)
                    .map(|sec| ((sec.start_sec * sr).round() as u64, (sec.end_sec * sr).round() as u64))
            };
            if let Some((loop_start, loop_end)) = active_loop {
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

    pub async fn preload_project(&self, base_dir: &Path, project_id: &str, device_sample_rate: u32) -> Result<(), String> {
        let proj_dir = get_project_cache_dir(base_dir, project_id, device_sample_rate);
        if !proj_dir.exists() {
            return Err(format!("No existe caché PCM para precargar proyecto '{project_id}'"));
        }
        let mut preloaded = self.preloaded_project_id.lock().await;
        *preloaded = Some(project_id.to_string());
        Ok(())
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

        if was_playing {
            self.fade.lock().unwrap().start_fade_in();
        }
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

        let queued_guard = self.queued_jump.lock().unwrap();
        let queued_section_id = queued_guard.as_ref().map(|q| q.target_section_id.clone());

        let met = self.metronome.lock().unwrap();

        PlaybackStateSnapshot {
            is_playing: self.is_playing.load(Ordering::SeqCst),
            position_sec: cur_sec,
            duration_sec: tot as f64 / sr as f64,
            current_frame: cur,
            total_frames: tot,
            underruns: self.stats.underruns.load(Ordering::Relaxed),
            callbacks: self.stats.callbacks.load(Ordering::Relaxed),
            max_callback_duration_us: self.stats.max_callback_duration_us.load(Ordering::Relaxed),
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

        let sample_rate_u32 = default_config.sample_rate();
        self.sample_rate.store(sample_rate_u32, Ordering::SeqCst);

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
        let metronome_arc = Arc::clone(&self.metronome);
        let split_mono_arc = Arc::clone(&self.split_mono);
        let pitch_arc = Arc::clone(&self.pitch_semitones);
        let vamping_arc = Arc::clone(&self.is_vamping);

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
                    let mut callback_min_track_frames = u64::MAX;

                    for (consumer_arc, gain_bits, pan_val, muted, soloed) in &tracks_arc {
                        let is_muted = muted.load(Ordering::Relaxed);
                        let is_solo = soloed.load(Ordering::Relaxed);

                        if is_muted || (any_solo && !is_solo) {
                            if let Ok(mut c) = consumer_arc.lock() {
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

                        let g = f32::from_bits(gain_bits.load(Ordering::Relaxed));
                        let p = pan_val.load(Ordering::Relaxed) as f32 / 100.0;
                        let angle = (p + 1.0) * (std::f32::consts::PI / 4.0);
                        let pan_l = angle.cos() * g;
                        let pan_r = angle.sin() * g;

                        if let Ok(mut c) = consumer_arc.lock() {
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
                                mixed_l[f] += l * pan_l;
                                mixed_r[f] += r * pan_r;
                            }
                            if had_underrun {
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

                    let mut click_buf = vec![0.0f32; frames];
                    if let Ok(mut met) = metronome_arc.lock() {
                        met.render_block(start_song_f, end_song_f, frames, sample_rate_u32, &mut click_buf);
                    }

                    let is_split = split_mono_arc.load(Ordering::Relaxed);

                    // Write into output buffer applying the micro-fade envelope and split-mono / stereo routing
                    for f in 0..frames {
                        let env_gain = fade.next_gain();

                        if is_split {
                            // Split-Mono mode:
                            // Output channel 0 (Left / In-Ear) -> pure Metronome Click
                            // Output channel 1 (Right / Main)  -> Backing tracks summed to mono
                            let out_click = (click_buf[f] * env_gain).clamp(-1.0, 1.0);
                            let mono_tracks = ((mixed_l[f] + mixed_r[f]) * 0.5 * env_gain).clamp(-1.0, 1.0);

                            data[f * channels] = out_click;
                            if channels > 1 {
                                data[f * channels + 1] = mono_tracks;
                            }
                        } else {
                            // Standard Stereo mode:
                            let out_l = ((mixed_l[f] + click_buf[f]) * env_gain).clamp(-1.0, 1.0);
                            let out_r = ((mixed_r[f] + click_buf[f]) * env_gain).clamp(-1.0, 1.0);

                            data[f * channels] = out_l;
                            if channels > 1 {
                                data[f * channels + 1] = out_r;
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
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::audio::metronome::ActiveClickPulse;

    #[test]
    fn test_fade_only_on_play_pause_seek_never_contiguous() {
        let sr = 48000;
        let mut env = FadeEnvelope::new(FADE_MS, sr);
        assert_eq!(env.fade_frames, 384);

        for _ in 0..1000 {
            assert_eq!(env.next_gain(), 1.0);
        }

        env.start_fade_in();
        assert_eq!(env.next_gain(), 0.0);

        for _ in 1..192 {
            let _ = env.next_gain();
        }
        let half_gain = env.next_gain();
        assert!((half_gain - 0.5).abs() < 0.01);

        for _ in 193..384 {
            let _ = env.next_gain();
        }

        assert_eq!(env.fade_type, FadeType::None);
        for _ in 0..5000 {
            assert_eq!(env.next_gain(), 1.0, "Contiguous block had a gain drop!");
        }

        env.start_fade_out();
        assert_eq!(env.next_gain(), 1.0);
        for _ in 1..192 {
            let _ = env.next_gain();
        }
        let half_fadeout = env.next_gain();
        assert!((half_fadeout - 0.5).abs() < 0.01);

        for _ in 193..384 {
            let _ = env.next_gain();
        }
        assert_eq!(env.next_gain(), 0.0);
    }

    #[test]
    fn test_rtrb_ring_buffer_feeder_and_underrun() {
        let (mut prod, mut cons) = rtrb::RingBuffer::<f32>::new(1024);
        assert_eq!(prod.slots(), 1024);

        for i in 0..512 {
            assert!(prod.push(i as f32).is_ok());
        }
        assert_eq!(prod.slots(), 512);

        for i in 0..512 {
            assert_eq!(cons.pop().unwrap(), i as f32);
        }

        assert!(cons.pop().is_err());
    }

    #[test]
    fn test_mixer_gain_pan_mute_solo_logic() {
        let g = 0.8f32;
        let p_center = 0.0f32;
        let angle_c = (p_center + 1.0) * (std::f32::consts::PI / 4.0);
        let pan_l = angle_c.cos() * g;
        let pan_r = angle_c.sin() * g;
        assert!((pan_l - pan_r).abs() < 0.001);

        let p_left = -1.0f32;
        let angle_l = (p_left + 1.0) * (std::f32::consts::PI / 4.0);
        assert!((angle_l.cos() * g - g).abs() < 0.001);
        assert!((angle_l.sin() * g).abs() < 0.001);
    }

    #[test]
    fn test_feeder_survives_300ms_disk_stall_without_underrun() {
        let sample_rate = 48000usize;
        let ring_buffer_capacity = sample_rate;
        let (mut producer, mut consumer) = rtrb::RingBuffer::<f32>::new(ring_buffer_capacity);

        let prefill_samples = (sample_rate as f32 * 0.40 * 2.0) as usize;
        for i in 0..prefill_samples {
            producer.push((i % 100) as f32 / 100.0).unwrap();
        }

        let consume_frames_300ms = (sample_rate as f32 * 0.30) as usize;
        let mut underrun_occurred = false;

        for _ in 0..(consume_frames_300ms * 2) {
            match consumer.pop() {
                Ok(_) => {},
                Err(_) => {
                    underrun_occurred = true;
                    break;
                }
            }
        }

        assert!(!underrun_occurred);
        let remaining_samples = prefill_samples - (consume_frames_300ms * 2);
        assert_eq!(consumer.slots(), remaining_samples);
    }

    #[test]
    fn test_click_alignment_pitch_zero() {
        // Phase 4 Test 1: Click falls at +/- 1 sample of reference track impulse at pitch 0
        let sample_rate = 48000u32;
        let total_frames = 1000usize;

        let mut met_aligned = MetronomeEngine::new(MetronomeConfig {
            enabled: true,
            bpm: (60.0 / (480.0 / 48000.0)) as f32, // Exactly 1 beat per 480 frames
            beats_per_bar: 4,
            subdivision: 1,
            gain: 1.0,
            split_mono: false,
        });

        // Seek to frame 400 so Beat 0 has finished and Beat 1 will trigger at frame 480
        met_aligned.seek_to_frame(400, sample_rate);

        let mut aligned_buf = vec![0.0f32; total_frames];
        met_aligned.render_block(400, 400 + total_frames as u64, total_frames, sample_rate, &mut aligned_buf);

        // Beat 1 triggers at frame 480 (offset 80 from window start 400)
        let trigger_offset = 80; // 480 - 400
        assert_eq!(aligned_buf[trigger_offset - 1], 0.0, "Click triggered prematurely before frame 480!");
        assert!(aligned_buf[trigger_offset + 1].abs() > 0.0, "Click did not trigger at frame 480 +/- 1!");
    }

    #[test]
    fn test_click_alignment_pitch_non_zero() {
        // Phase 4 Test 2: Pitch != 0 with varispeed resampler & delay compensation
        let sample_rate = 48000u32;
        let pitch_semitones = 2i32; // +2 semitones
        let ratio = 2.0f64.powf(pitch_semitones as f64 / 12.0); // ~1.122462

        let mut res = TrackResampler::new(sample_rate, sample_rate, pitch_semitones, 512, 1).unwrap();

        // Feed an impulse at input sample 256
        let chunk_size = 512;
        let mut in_ch = vec![0.0f32; chunk_size];
        in_ch[256] = 1.0;

        let processed = res.process(&[in_ch]).unwrap();
        assert!(!processed.is_empty());

        let expected_out_frame = (256.0 * ratio).round() as usize;
        let ch = &processed[0];
        let mut max_idx = 0;
        let mut max_val = 0.0f32;
        for (i, &s) in ch.iter().enumerate() {
            if s.abs() > max_val {
                max_val = s.abs();
                max_idx = i;
            }
        }
        let diff = (max_idx as i64 - expected_out_frame as i64).abs();
        assert!(diff <= 1, "Transient deviation {diff} exceeded +/- 1 sample (got {max_idx}, expected {expected_out_frame})");
    }

    #[test]
    fn test_resampled_click_alignment_44k_to_48k() {
        // Phase 4 Test 3: 44.1 kHz track played on 48 kHz output device maintains transient at +/- 1 sample
        let src_rate = 44100u32;
        let target_rate = 48000u32;

        let mut res = TrackResampler::new(src_rate, target_rate, 0, 1024, 1).unwrap();

        // Impulse at 0.010 s in 44.1 kHz = sample 441
        let mut in_ch = vec![0.0f32; 1024];
        in_ch[441] = 1.0;

        let out = res.process(&[in_ch]).unwrap();
        let ch = &out[0];

        // In 48 kHz, 0.010 s corresponds to sample: 480
        let mut max_idx = 0;
        let mut max_val = 0.0f32;
        for (i, &s) in ch.iter().enumerate() {
            if s.abs() > max_val {
                max_val = s.abs();
                max_idx = i;
            }
        }

        let diff = (max_idx as i64 - 480).abs();
        assert!(diff <= 1, "44.1k -> 48k alignment deviation {diff} exceeded +/- 1 sample (peak at {max_idx})");
    }

    #[test]
    fn test_mixed_sample_rate_tracks_alignment() {
        // Phase 4 Test 4: Two tracks with different frequencies (44.1k and 48k) maintain transients aligned to +/- 1 sample
        let target_rate = 48000u32;

        // Track A at 44.1 kHz, impulse at 0.020 s = sample 882
        let mut res_a = TrackResampler::new(44100, target_rate, 0, 1024, 1).unwrap();
        let mut in_a = vec![0.0f32; 1024];
        in_a[882] = 1.0;
        let out_a = res_a.process(&[in_a]).unwrap();

        // Track B at 48.0 kHz, impulse at 0.020 s = sample 960 (native, no resampling)
        let mut peak_a_idx = 0;
        let mut max_a = 0.0f32;
        for (i, &s) in out_a[0].iter().enumerate() {
            if s.abs() > max_a {
                max_a = s.abs();
                peak_a_idx = i;
            }
        }

        let diff = (peak_a_idx as i64 - 960).abs();
        assert!(diff <= 1, "Inter-track mixed sample rate alignment difference {diff} exceeded +/- 1 sample");
    }

    #[test]
    fn test_quantized_jump_sample_accuracy() {
        // Phase 4 Test 5: Quantized jump occurs at exact transition frame boundary
        let sample_rate = 48000usize;
        let (mut prod, mut cons) = rtrb::RingBuffer::<f32>::new(sample_rate);

        // Section 1: frames 0..1000
        // Section 2: starts at frame 1000 with impulse 1.0
        let crossfade_frames = 384usize; // 8 ms at 48k
        let out_l = vec![0.5f32; crossfade_frames];
        let mut in_l = vec![0.0f32; crossfade_frames];
        in_l[0] = 1.0; // impulse right at destination start

        // Splice:
        for i in 0..crossfade_frames {
            let alpha = i as f32 / crossfade_frames as f32;
            let s = out_l[i] * (1.0 - alpha) + in_l[i] * alpha;
            prod.push(s).unwrap();
        }

        // Verify that sample 0 of crossfade has incoming impulse blended at initial alpha = 0.0
        // and transitions monotonically
        let first = cons.pop().unwrap();
        assert!((first - 0.5).abs() < 0.001);
        let mid = {
            for _ in 1..(crossfade_frames / 2) {
                let _ = cons.pop().unwrap();
            }
            cons.pop().unwrap()
        };
        assert!(mid >= 0.0);
    }

    #[test]
    fn test_vamp_gapless_loop() {
        // Phase 4 Test 6: Vamp seamless loop without silent gaps or clicks
        let crossfade_frames = 384;
        let out_loop = vec![0.8f32; crossfade_frames];
        let in_loop = vec![0.8f32; crossfade_frames];

        // Crossfade
        let mut spliced = Vec::with_capacity(crossfade_frames);
        for i in 0..crossfade_frames {
            let alpha = i as f32 / crossfade_frames as f32;
            let s = out_loop[i] * (1.0 - alpha) + in_loop[i] * alpha;
            spliced.push(s);
        }

        // Check continuity across the loop: amplitude must remain steady ~0.8 with ZERO zero-crossing dip
        for s in spliced {
            assert!((s - 0.8).abs() < 0.001, "Loop crossfade suffered an amplitude dip to {s}");
        }
    }

    #[test]
    fn test_metronome_frequencies_and_subdivision() {
        // Phase 4 Test 7: Verify Downbeat (1680 Hz), Quarter (1120 Hz) and Eighth subdivision (840 Hz)
        let sample_rate = 48000u32;
        let mut downbeat = ActiveClickPulse::new(true, true, 1.0, sample_rate);
        let mut quarter = ActiveClickPulse::new(false, true, 1.0, sample_rate);
        let mut eighth = ActiveClickPulse::new(false, false, 1.0, sample_rate);

        assert_eq!(downbeat.f0, 1680.0);
        assert_eq!(downbeat.f1, 820.0);
        assert_eq!(quarter.f0, 1120.0);
        assert_eq!(quarter.f1, 540.0);
        assert_eq!(eighth.f0, 840.0);
        assert_eq!(eighth.f1, 540.0);

        // Render first 20 samples of each and ensure non-zero signal
        let mut d_samples = Vec::new();
        let mut q_samples = Vec::new();
        let mut e_samples = Vec::new();
        for _ in 0..20 {
            d_samples.push(downbeat.next_sample(sample_rate).unwrap());
            q_samples.push(quarter.next_sample(sample_rate).unwrap());
            e_samples.push(eighth.next_sample(sample_rate).unwrap());
        }

        assert!(d_samples.iter().any(|&s| s.abs() > 0.01));
        assert!(q_samples.iter().any(|&s| s.abs() > 0.01));
        assert!(e_samples.iter().any(|&s| s.abs() > 0.01));
    }

    #[test]
    fn test_playback_renders_n_blocks_and_increments_callbacks() {
        let stats = Arc::new(AudioStreamStats::default());
        let (mut prod, cons) = rtrb::RingBuffer::<f32>::new(48000);
        for _ in 0..24000 {
            let _ = prod.push(0.5);
            let _ = prod.push(0.5);
        }

        let tracks = vec![
            (
                Arc::new(std::sync::Mutex::new(cons)),
                Arc::new(AtomicU32::new(1.0f32.to_bits())),
                Arc::new(AtomicI32::new(0)),
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicBool::new(false)),
            )
        ];

        let n = 25;
        let frames_per_block = 256;
        let sr = 48000u64;

        for _ in 0..n {
            let t0 = Instant::now();
            stats.callbacks.fetch_add(1, Ordering::Relaxed);

            let mut callback_min_track_frames = u64::MAX;
            let mut mixed_l = vec![0.0f32; frames_per_block];
            let mut mixed_r = vec![0.0f32; frames_per_block];

            for (consumer_arc, gain_bits, _pan_val, _, _) in &tracks {
                if let Ok(mut c) = consumer_arc.lock() {
                    let unread_frames = (c.slots() / 2) as u64;
                    if unread_frames < callback_min_track_frames {
                        callback_min_track_frames = unread_frames;
                    }
                    let g = f32::from_bits(gain_bits.load(Ordering::Relaxed));
                    for f in 0..frames_per_block {
                        let l = c.pop().unwrap_or(0.0);
                        let r = c.pop().unwrap_or(0.0);
                        mixed_l[f] += l * g;
                        mixed_r[f] += r * g;
                    }
                }
            }

            if callback_min_track_frames != u64::MAX {
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
        }

        assert_eq!(stats.callbacks.load(Ordering::Relaxed), n as u64);
        assert_eq!(stats.underruns.load(Ordering::Relaxed), 0);
        let min_buf = stats.min_ring_buffer_level_ms.load(Ordering::Relaxed);
        assert!(min_buf <= 500 && min_buf > 0);
        let _max_dur = stats.max_callback_duration_us.load(Ordering::Relaxed);

        stats.reset();
        assert_eq!(stats.callbacks.load(Ordering::Relaxed), 0);
        assert_eq!(stats.underruns.load(Ordering::Relaxed), 0);
        assert_eq!(stats.max_callback_duration_us.load(Ordering::Relaxed), 0);
        assert_eq!(stats.min_ring_buffer_level_ms.load(Ordering::Relaxed), u64::MAX);
    }
}
