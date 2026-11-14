use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, AtomicU64, AtomicU8, Ordering};
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
    /// Pico post-fader de la pista; lo escribe el hilo de audio y lo lee `get_playback_state`.
    pub meter: Arc<PeakMeter>,
    /// El feeder ya empujó al anillo todo lo que le quedaba: llegó al final del archivo, o el destino
    /// de un seek cae más allá de él. Una pista así no cuenta para salir de buffering.
    pub eof: Arc<AtomicBool>,
    /// Última generación de seek que el feeder confirmó: ya no empuja audio de posiciones anteriores.
    pub seek_ack: Arc<AtomicU64>,
    /// Última generación de seek cuyo anillo ya se vació. El feeder no empuja audio nuevo hasta que
    /// coincide con su confirmación y el callback no sale de buffering sin ella.
    pub flush_done: Arc<AtomicU64>,
    /// `false` cuando el hilo feeder terminó (error al abrir el archivo, parada o fallo interno).
    pub feeder_alive: Arc<AtomicBool>,
    /// Fotogramas que esta pista dejó de sonar por quedarse sin datos (underrun). El audio que llega
    /// después sigue la línea temporal de antes del hueco: se descarta esa cantidad para que la pista
    /// vuelva a coincidir con el reloj y con el resto. Lo escribe el callback; el transporte lo pone a 0
    /// al vaciar el anillo.
    pub skip_frames: Arc<AtomicU64>,
}

pub struct StreamTrackHandle {
    pub consumer: Arc<std::sync::Mutex<rtrb::Consumer<f32>>>,
    pub gain: Arc<AtomicU32>,
    pub pan: Arc<AtomicI32>,
    pub muted: Arc<AtomicBool>,
    pub soloed: Arc<AtomicBool>,
    pub bus: Arc<AtomicU8>,
    pub meter: Arc<PeakMeter>,
    pub eof: Arc<AtomicBool>,
    pub flush_done: Arc<AtomicU64>,
    pub skip_frames: Arc<AtomicU64>,
}

/// Pico (valor absoluto máximo) desde la última lectura, por canal, guardado como bits de f32.
/// Para valores >= 0 el orden de los bits coincide con el numérico, así que `fetch_max` sobre u32
/// da el máximo correcto. Seguro para el hilo de audio: sin memoria, sin bloqueos, sin logging.
#[derive(Default)]
pub struct PeakMeter {
    l: AtomicU32,
    r: AtomicU32,
}

impl PeakMeter {
    /// Registra un pico (se toma el valor absoluto). NaN e infinitos se ignoran.
    #[inline]
    pub fn record(&self, l: f32, r: f32) {
        let l = l.abs();
        let r = r.abs();
        if l.is_finite() {
            self.l.fetch_max(l.to_bits(), Ordering::Relaxed);
        }
        if r.is_finite() {
            self.r.fetch_max(r.to_bits(), Ordering::Relaxed);
        }
    }

    /// Devuelve el pico desde la última lectura y lo pone a 0.
    pub fn take(&self) -> (f32, f32) {
        (
            f32::from_bits(self.l.swap(0, Ordering::Relaxed)),
            f32::from_bits(self.r.swap(0, Ordering::Relaxed)),
        )
    }
}

/// Medidores de los buses: Main (con master), Cue (pistas a cue + click + guía, con cue master)
/// y la salida final antes del recorte.
#[derive(Default)]
pub struct BusMeters {
    pub main: PeakMeter,
    pub cue: PeakMeter,
    pub out: PeakMeter,
    /// Click sintético y guía hablada, ya con el cue master aplicado (señales mono).
    pub click: PeakMeter,
    pub guide: PeakMeter,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct LevelPair {
    pub l: f32,
    pub r: f32,
}

impl From<(f32, f32)> for LevelPair {
    fn from((l, r): (f32, f32)) -> Self {
        Self { l, r }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLevel {
    pub track_id: String,
    pub l: f32,
    pub r: f32,
}

/// Picos desde la lectura anterior (lineales, 1.0 = 0 dBFS).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetersSnapshotDto {
    pub tracks: Vec<TrackLevel>,
    pub main: LevelPair,
    pub cue: LevelPair,
    pub out: LevelPair,
    pub click: LevelPair,
    pub guide: LevelPair,
    /// La salida superó 1.0 antes del recorte en algún momento desde la lectura anterior.
    pub clipped: bool,
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
    #[serde(default)]
    pub meters: MetersSnapshotDto,
}
