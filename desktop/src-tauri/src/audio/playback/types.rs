use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, AtomicU8};
use std::sync::Arc;
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLoadInfo {
    pub project_id: String,
    pub sample_rate: u32,
    pub track_count: usize,
    pub duration_sec: f64,
    pub total_frames: u64,
    #[serde(default)]
    pub track_peaks: HashMap<String, Vec<f32>>,
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
