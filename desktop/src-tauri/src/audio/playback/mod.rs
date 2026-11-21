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
use crate::audio::output::{get_device_name, resolve_output_config, stream_needs_reopen, AudioEngineState, AudioStreamStats};
use crate::audio::pitch::{new_pitch_shifter, PitchShifter};
use crate::audio::resampler::TrackResampler;
use crate::audio::routing::{self, RouteTable, RoutingSlot};

/// Semitonos que se aplican a una pista: el tono del proyecto si su bus se transpone (música) y 0 si es click o guía.
fn track_pitch(pitch: &AtomicI32, bus: &AtomicU8) -> i32 {
    if TrackBus::from_u8(bus.load(Ordering::Relaxed)).transposes() {
        pitch.load(Ordering::Relaxed)
    } else {
        0
    }
}

pub mod fade;
pub use fade::*;

pub mod bus;
pub use bus::*;


pub mod feeder_io;
pub use feeder_io::*;

pub mod types;
pub use types::*;

pub mod block;
pub use block::{apply_pan, buffering_ready, consume_track_block, end_of_song_gain, pan_law, END_FADE_GUARD_FRAMES};

pub mod clock;
pub use clock::{advance_clock, ClockJumps};

pub mod jumps;
pub mod transport;

pub mod callback;
pub use callback::{BlockMixer, CallbackShared, MAX_CALLBACK_FRAMES};

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
    /// Frecuencia (Hz) a la que se abrió el stream actual; 0 si no hay ninguno. Distinta de `sample_rate`, que
    /// pasa a ser la de la caché al cargar un proyecto: si difieren hay que reabrir (`stream_needs_reopen`).
    pub stream_rate: AtomicU32,
    pub stats: Arc<AudioStreamStats>,

    // Phase 4 fields:
    pub sections: Arc<std::sync::Mutex<Vec<NativeSongSection>>>,
    pub quantize_mode: Arc<std::sync::Mutex<String>>, // "1-bar", "2-bars", "section-end", "immediate"
    pub bpm: Arc<AtomicU32>,                           // f32 bits
    pub beats_per_bar: Arc<AtomicU32>,
    pub is_vamping: Arc<AtomicBool>,
    /// Matriz de ruteo de salidas del dispositivo abierto (la lee el callback; la escribe `ensure_stream`).
    pub routing: Arc<RoutingSlot>,
    /// Dispositivo cuyo ruteo está cargado en `routing` (`None` = aún no se abrió ninguno).
    pub active_routing_key: Arc<std::sync::Mutex<Option<String>>>,
    pub master_gain: Arc<AtomicU32>,                   // f32 bits
    pub cue_master_gain: Arc<AtomicU32>,               // f32 bits
    /// Volumen general del envío «Aur.» (f32 bits).
    pub monitor_gain: Arc<AtomicU32>,
    pub pitch_semitones: Arc<AtomicI32>,
    pub queued_jump: Arc<std::sync::Mutex<Option<QueuedJumpInfo>>>,
    pub metronome: Arc<std::sync::Mutex<MetronomeEngine>>,
    pub preloaded_project_id: TokioMutex<Option<String>>,
    pub device_disconnected: Arc<AtomicBool>,
    /// Picos de los buses Main, Cue y salida (los escribe el hilo de audio).
    pub bus_meters: Arc<BusMeters>,
    /// Mezclador de `simulate_callback_block` (pruebas): se crea al primer bloque simulado.
    simulated_mixer: std::sync::Mutex<Option<BlockMixer>>,
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
            stream_rate: AtomicU32::new(0),
            stats,
            sections: Arc::new(std::sync::Mutex::new(Vec::new())),
            quantize_mode: Arc::new(std::sync::Mutex::new("1-bar".to_string())),
            bpm: Arc::new(AtomicU32::new(120.0f32.to_bits())),
            beats_per_bar: Arc::new(AtomicU32::new(4)),
            is_vamping: Arc::new(AtomicBool::new(false)),
            routing: Arc::new(RoutingSlot::new()),
            active_routing_key: Arc::new(std::sync::Mutex::new(None)),
            master_gain: Arc::new(AtomicU32::new(1.0f32.to_bits())),
            cue_master_gain: Arc::new(AtomicU32::new(0.708f32.to_bits())),
            monitor_gain: Arc::new(AtomicU32::new(1.0f32.to_bits())),
            pitch_semitones: Arc::new(AtomicI32::new(0)),
            queued_jump: Arc::new(std::sync::Mutex::new(None)),
            metronome: Arc::new(std::sync::Mutex::new(MetronomeEngine::new(
                MetronomeConfig::default(),
            ))),
            preloaded_project_id: TokioMutex::new(None),
            device_disconnected: Arc::new(AtomicBool::new(false)),
            bus_meters: Arc::new(BusMeters::default()),
            simulated_mixer: std::sync::Mutex::new(None),
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
        self.load_project_with_controls(base_dir, project_id, device_sample_rate, bpm, beats_per_bar, sections, quantize_mode, None)
            .await
    }

    /// Como `load_project`, pero cada pista nace ya con la mezcla de `track_controls` (ganancia, paneo, mute, solo,
    /// bus, «Aur.», secuencia dividida, ganancia de cue). Sin esto, las pistas empiezan a ganancia 1 y con el bus
    /// deducido del ID hasta que llegan sus controles, y el primer Play puede sonar con la mezcla equivocada.
    #[allow(clippy::too_many_arguments)]
    pub async fn load_project_with_controls(
        &self,
        base_dir: &Path,
        project_id: &str,
        device_sample_rate: u32,
        bpm: Option<f32>,
        beats_per_bar: Option<u32>,
        sections: Option<Vec<NativeSongSection>>,
        quantize_mode: Option<String>,
        track_controls: Option<Vec<InitialTrackControl>>,
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
            // El bus inicial se deduce del ID; la interfaz lo fija después con `set_track_controls`. El feeder lo
            // lee para saber si esta pista se transpone (el click y la guía no).
            let lower_id = meta.track_id.to_ascii_lowercase();
            let initial_ctl = track_controls.as_ref().and_then(|v| v.iter().find(|c| c.track_id == meta.track_id));
            let initial_bus = if let Some(b) = initial_ctl.and_then(|c| c.bus.as_deref()) {
                // La interfaz manda el bus explícito: manda sobre lo que sugiera el ID.
                TrackBus::from_str(b) as u8
            } else if lower_id.contains("click") || lower_id.contains("metronom") || lower_id.contains("guia") || lower_id.contains("guide") || lower_id.contains("cue") {
                TrackBus::CueClick as u8
            } else {
                TrackBus::Main as u8
            };
            let bus_track = Arc::new(AtomicU8::new(initial_bus));
            let thread_bus = Arc::clone(&bus_track);
            // Handshake de seek: arrancan en la generación vigente para no bloquear la primera salida de
            // buffering con un contador atrasado.
            let initial_generation = self.seek_generation.load(Ordering::SeqCst);
            let eof_track = Arc::new(AtomicBool::new(false));
            let seek_ack_track = Arc::new(AtomicU64::new(initial_generation));
            let flush_done_track = Arc::new(AtomicU64::new(initial_generation));
            let feeder_alive_track = Arc::new(AtomicBool::new(true));
            let skip_frames_track = Arc::new(AtomicU64::new(0));

            let thread_pcm_path = pcm_path.clone();
            let thread_stop = Arc::clone(&stop_signal);
            let thread_seek = Arc::clone(&seek_req);
            let thread_jump = Arc::clone(&jump_req);
            let thread_vamp = Arc::clone(&is_vamping_track);
            let thread_active_loop = Arc::clone(&active_loop_track);
            let thread_pitch = Arc::clone(&pitch_track);
            let thread_generation = Arc::clone(&self.seek_generation);
            let thread_eof = Arc::clone(&eof_track);
            let thread_seek_ack = Arc::clone(&seek_ack_track);
            let thread_flush_done = Arc::clone(&flush_done_track);
            let thread_alive = Arc::clone(&feeder_alive_track);
            let thread_stats = Arc::clone(&self.stats);
            let is_mono = meta.channels == 1;
            let crossfade_frames = ((FADE_MS / 1000.0) * device_sample_rate as f32).round().max(1.0) as usize;

            // Feeder thread for this track: pre-reads PCM from disk and maintains >= 350 ms in ring buffer
            std::thread::Builder::new()
                .name(format!("omni-feed-{}", meta.track_id))
                .spawn(move || {
                    let _alive = FeederAliveGuard(thread_alive);
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

                    let mut resampler = TrackResampler::new(
                        device_sample_rate,
                        device_sample_rate,
                        chunk_frames,
                        channels_count,
                    ).expect("Failed to initialize track resampler");
                    // Cambio de tono real (la duración no cambia). Solo existe mientras el tono no es 0 y se
                    // (re)crea en cada seek: `set_pitch` del transporte hace un seek al cambiar el tono.
                    let mut shifter: Option<PitchShifter> = new_pitch_shifter(
                        device_sample_rate,
                        channels_count,
                        track_pitch(&thread_pitch, &thread_bus),
                    );

                    let mut input_staging: Vec<Vec<f32>> = vec![Vec::with_capacity(chunk_frames * 4); channels_count];
                    let mut output_staging: Vec<f32> = Vec::with_capacity(chunk_frames * 8);
                    let mut delay_compensated = false;
                    let mut read_error_reported = false;

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
                            shifter = new_pitch_shifter(
                                device_sample_rate,
                                channels_count,
                                track_pitch(&thread_pitch, &thread_bus),
                            );
                            delay_compensated = false;
                            // Ya no se empujará audio de la posición anterior: se confirma la generación
                            // y se espera a que el transporte vacíe el anillo antes de producir nada.
                            thread_eof.store(false, Ordering::SeqCst);
                            thread_seek_ack.store(thread_generation.load(Ordering::SeqCst), Ordering::SeqCst);
                            continue;
                        }

                        // Seek en curso: el transporte aún no vació el anillo. Empujar ahora mezclaría
                        // audio nuevo con el antiguo que está a punto de descartarse.
                        if thread_flush_done.load(Ordering::SeqCst) < thread_seek_ack.load(Ordering::SeqCst) {
                            std::thread::sleep(std::time::Duration::from_millis(1));
                            continue;
                        }

                        // 2. (El cambio de tono no se atiende aquí: `set_pitch` hace un seek y el feeder recrea
                        // el cambio de tono al atenderlo, con el anillo vacío.)

                        // 3. Drain pending output_staging samples into ring buffer
                        while !output_staging.is_empty() && producer.slots() > 0 {
                            let n_to_push = output_staging.len().min(producer.slots());
                            for &s in &output_staging[..n_to_push] {
                                let _ = producer.push(s);
                            }
                            output_staging.drain(..n_to_push);
                        }

                        // Pasado el final de su archivo la pista NO se da por terminada: sigue avanzando con
                        // silencio (`read_into_staging`), al ritmo de la canción. Así un salto o un vamp que vuelve
                        // a una zona donde tiene audio la encuentra en su sitio. `eof` solo lo marca el transporte
                        // cuando este hilo ya no responde.

                        // 4. Check queued jump requests
                        let queued_jump_opt = {
                            let g = thread_jump.lock().unwrap();
                            g.clone()
                        };
                        if let Some(jump) = queued_jump_opt {
                            let should_jump = (current_frame < jump.transition_frame && (current_frame + chunk_frames as u64) >= jump.transition_frame)
                                || (current_frame >= jump.transition_frame);

                            if should_jump {
                                // El empalme se hace EN LA ENTRADA del remuestreador: lo que queda antes de la
                                // transición, el cruce de 8 ms y el audio nuevo entran como una sola señal continua,
                                // sin vaciar ni reiniciar el filtro. Reiniciarlo (como se hacía) deja el audio nuevo
                                // desplazado respecto al cruce y se oye como un clic en cada salto.
                                if current_frame < jump.transition_frame {
                                    let pre_frames = (jump.transition_frame - current_frame) as usize;
                                    if pre_frames > 0 {
                                        let err = read_into_staging(&mut file, is_mono, pre_frames, &mut input_staging);
                                        report_read_error(&mut read_error_reported, &thread_pcm_path, err);
                                    }
                                }

                                let m = crossfade_frames;
                                let mut out_l = vec![0.0f32; m];
                                let mut out_r = vec![0.0f32; m];
                                let mut in_l = vec![0.0f32; m];
                                let mut in_r = vec![0.0f32; m];

                                let err = read_frames_to_slices(&mut file, is_mono, m, &mut out_l, &mut out_r);
                                report_read_error(&mut read_error_reported, &thread_pcm_path, err);
                                let in_offset = jump.target_frame * bytes_per_frame as u64;
                                let _ = file.seek(SeekFrom::Start(in_offset));
                                let err = read_frames_to_slices(&mut file, is_mono, m, &mut in_l, &mut in_r);
                                report_read_error(&mut read_error_reported, &thread_pcm_path, err);

                                for i in 0..m {
                                    let alpha = i as f32 / m as f32;
                                    let sl = out_l[i] * (1.0 - alpha) + in_l[i] * alpha;
                                    let sr = out_r[i] * (1.0 - alpha) + in_r[i] * alpha;
                                    input_staging[0].push(sl);
                                    if !is_mono {
                                        input_staging[1].push(sr);
                                    }
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
                                    // Igual que en el salto de sección: el empalme entra al remuestreador como una
                                    // sola señal continua, sin vaciarlo ni reiniciarlo.
                                    if current_frame < loop_end {
                                        let pre_frames = (loop_end - current_frame) as usize;
                                        if pre_frames > 0 {
                                            let err = read_into_staging(&mut file, is_mono, pre_frames, &mut input_staging);
                                            report_read_error(&mut read_error_reported, &thread_pcm_path, err);
                                        }
                                    }

                                    let m = crossfade_frames;
                                    let mut out_l = vec![0.0f32; m];
                                    let mut out_r = vec![0.0f32; m];
                                    let mut in_l = vec![0.0f32; m];
                                    let mut in_r = vec![0.0f32; m];

                                    let err = read_frames_to_slices(&mut file, is_mono, m, &mut out_l, &mut out_r);
                                    report_read_error(&mut read_error_reported, &thread_pcm_path, err);
                                    let in_offset = loop_start * bytes_per_frame as u64;
                                    let _ = file.seek(SeekFrom::Start(in_offset));
                                    let err = read_frames_to_slices(&mut file, is_mono, m, &mut in_l, &mut in_r);
                                    report_read_error(&mut read_error_reported, &thread_pcm_path, err);

                                    for i in 0..m {
                                        let alpha = i as f32 / m as f32;
                                        let sl = out_l[i] * (1.0 - alpha) + in_l[i] * alpha;
                                        let sr = out_r[i] * (1.0 - alpha) + in_r[i] * alpha;
                                        input_staging[0].push(sl);
                                        if !is_mono {
                                            input_staging[1].push(sr);
                                        }
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

                        // Pasado el final del archivo, cada bloque es silencio: la pista sigue el reloj de la canción.
                        if total_buffered < min_target && output_staging.len() < staging_limit {
                            let t_feeder_start = Instant::now();
                            let err = read_into_staging(&mut file, is_mono, chunk_frames, &mut input_staging);
                            report_read_error(&mut read_error_reported, &thread_pcm_path, err);
                            current_frame += chunk_frames as u64;
                            drain_staging_through_resampler(
                                &mut resampler,
                                shifter.as_mut(),
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
                        } else {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                    }
                })
                .map_err(|e| format!("Error iniciando hilo feeder: {e}"))?;

            active_tracks.push(ActiveTrack {
                track_id: meta.track_id.clone(),
                file_path: pcm_path,
                original_channels: meta.channels,
                total_frames: meta.frame_count,
                gain: Arc::new(AtomicU32::new(initial_ctl.and_then(|c| c.gain).map_or(1.0f32, sane_gain).to_bits())),
                pan: Arc::new(AtomicI32::new(initial_ctl.and_then(|c| c.pan).unwrap_or(0).clamp(-100, 100))),
                muted: Arc::new(AtomicBool::new(initial_ctl.and_then(|c| c.muted).unwrap_or(false))),
                soloed: Arc::new(AtomicBool::new(initial_ctl.and_then(|c| c.soloed).unwrap_or(false))),
                monitor: Arc::new(AtomicBool::new(initial_ctl.and_then(|c| c.monitor).unwrap_or(false))),
                split: Arc::new(AtomicBool::new(initial_ctl.and_then(|c| c.split_sequence).unwrap_or(false))),
                cue_gain: Arc::new(AtomicU32::new(initial_ctl.and_then(|c| c.cue_gain).map_or(1.0f32, sane_gain).to_bits())),
                cue_muted: Arc::new(AtomicBool::new(initial_ctl.and_then(|c| c.cue_muted).unwrap_or(false))),
                bus: bus_track,
                consumer: Arc::new(std::sync::Mutex::new(consumer)),
                stop_signal,
                seek_request: seek_req,
                jump_request: jump_req,
                is_vamping: is_vamping_track,
                active_section_loop: active_loop_track,
                pitch_semitones: pitch_track,
                meter: Arc::new(PeakMeter::default()),
                eof: eof_track,
                seek_ack: seek_ack_track,
                flush_done: flush_done_track,
                feeder_alive: feeder_alive_track,
                skip_frames: skip_frames_track,
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
                monitor: Arc::clone(&t.monitor),
                split: Arc::clone(&t.split),
                cue_gain: Arc::clone(&t.cue_gain),
                cue_muted: Arc::clone(&t.cue_muted),
                bus: Arc::clone(&t.bus),
                meter: Arc::clone(&t.meter),
                eof: Arc::clone(&t.eof),
                flush_done: Arc::clone(&t.flush_done),
                skip_frames: Arc::clone(&t.skip_frames),
            })
            .collect();

        // Orden de adquisición de los mutex de estado de proyecto: primero `loaded_project_id`, después
        // `tracks`. `unload_project_if_matches` usa el mismo orden; con el inverso una carga y una
        // descarga simultáneas podían esperarse mutuamente para siempre (A05).
        let mut loaded = self.loaded_project_id.lock().await;
        let mut tracks_guard = self.tracks.lock().await;
        // Stop any old tracks
        for old in tracks_guard.iter() {
            old.stop_signal.store(true, Ordering::Relaxed);
        }
        *tracks_guard = active_tracks;
        *self.stream_tracks.lock().unwrap() = new_stream_tracks;
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
        let previous = self.pitch_semitones.swap(clamped, Ordering::SeqCst);
        let has_tracks = {
            let tracks = self.tracks.lock().await;
            for trk in tracks.iter() {
                trk.pitch_semitones.store(clamped, Ordering::Relaxed);
            }
            !tracks.is_empty()
        };
        // El cambio de tono vive en el feeder de cada pista y el anillo ya trae ~350 ms con el tono anterior:
        // se reposiciona en el mismo punto (como un seek, con su micro-fundido) para que suene el tono nuevo
        // enseguida. El reloj de la canción no cambia: el tono ya no altera la velocidad.
        if previous != clamped && has_tracks {
            let sr = self.sample_rate.load(Ordering::SeqCst).max(1);
            let position_sec = self.current_frame.load(Ordering::SeqCst) as f64 / sr as f64;
            self.seek(position_sec).await;
        }
    }

    pub fn set_metronome(&self, config: MetronomeConfig) {
        let mut met = self.metronome.lock().unwrap();
        met.config = config;
    }

    /// Cambia el ruteo del dispositivo abierto. No se permite mientras suena: mover canales en pleno directo
    /// produciría un salto brusco. Si el dispositivo no es el que está abierto, no hay nada que aplicar ahora:
    /// `ensure_stream` leerá el ruteo guardado al abrirlo.
    pub fn apply_routing(&self, device_key: &str, table: &RouteTable) -> Result<(), String> {
        let is_active = self.active_routing_key.lock().unwrap().as_deref() == Some(device_key);
        if !is_active {
            return Ok(());
        }
        if self.is_playing.load(Ordering::SeqCst) {
            return Err("Detén la reproducción antes de cambiar el ruteo de salidas.".to_string());
        }
        self.routing.store(table);
        Ok(())
    }

    /// Marca o desmarca una pista para el envío a auriculares («Aur.»).
    pub async fn set_track_monitor(&self, track_id: &str, monitor: bool) {
        let tracks = self.tracks.lock().await;
        if let Some(trk) = tracks.iter().find(|t| t.track_id == track_id) {
            trk.monitor.store(monitor, Ordering::Relaxed);
        }
    }

    /// Marca una pista como secuencia dividida (canal izquierdo = click y guía, derecho = instrumentos).
    pub async fn set_track_split(&self, track_id: &str, split: bool) {
        let tracks = self.tracks.lock().await;
        if let Some(trk) = tracks.iter().find(|t| t.track_id == track_id) {
            trk.split.store(split, Ordering::Relaxed);
        }
    }

    /// Volumen y mute del canal izquierdo (click y guía) de una secuencia dividida.
    pub async fn set_track_cue(&self, track_id: &str, gain: Option<f32>, muted: Option<bool>) {
        let tracks = self.tracks.lock().await;
        if let Some(trk) = tracks.iter().find(|t| t.track_id == track_id) {
            if let Some(g) = gain {
                trk.cue_gain.store(g.clamp(0.0, 4.0).to_bits(), Ordering::Relaxed);
            }
            if let Some(m) = muted {
                trk.cue_muted.store(m, Ordering::Relaxed);
            }
        }
    }

    pub fn set_monitor_gain(&self, gain: f32) {
        self.monitor_gain.store(gain.clamp(0.0, 4.0).to_bits(), Ordering::SeqCst);
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
        // Si el bus cambia entre uno que se transpone y otro que no (y hay tono), el feeder debe recrear su
        // cambio de tono: se reposiciona en el mismo punto, igual que `set_pitch`.
        let mut needs_reseek = false;
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
                let new_bus = TrackBus::from_str(b);
                let old_bus = TrackBus::from_u8(trk.bus.swap(new_bus as u8, Ordering::Relaxed));
                needs_reseek = old_bus.transposes() != new_bus.transposes()
                    && trk.pitch_semitones.load(Ordering::Relaxed) != 0;
            }
        }
        drop(tracks);
        if needs_reseek {
            let sr = self.sample_rate.load(Ordering::SeqCst).max(1);
            let position_sec = self.current_frame.load(Ordering::SeqCst) as f64 / sr as f64;
            self.seek(position_sec).await;
        }
    }

    async fn ensure_stream(&self, engine_state: &AudioEngineState) -> Result<(), String> {
        let mut stream_guard = self.stream.lock().await;
        if stream_guard.is_some() {
            // Un stream abierto cuyo dispositivo se desconectó no sirve: se descarta y se vuelve a resolver
            // (y a validar) el dispositivo antes de reproducir. Tampoco sirve uno abierto a otra frecuencia que
            // la caché cargada (p. ej. abierto antes de montar la canción): sonaría a otra velocidad.
            let open_rate = self.stream_rate.load(Ordering::SeqCst);
            let cache_rate = if self.loaded_project_id.lock().await.is_some() {
                Some(self.sample_rate.load(Ordering::SeqCst))
            } else {
                None
            };
            let rate_mismatch = stream_needs_reopen((open_rate != 0).then_some(open_rate), cache_rate);
            if !self.device_disconnected.load(Ordering::SeqCst) && !rate_mismatch {
                return Ok(());
            }
            *stream_guard = None;
            self.stream_rate.store(0, Ordering::SeqCst);
            self.device_disconnected.store(false, Ordering::SeqCst);
        }

        let settings = engine_state.current_settings.lock().await.clone();
        let host = cpal::default_host();
        let devices = host.output_devices().map_err(|e| e.to_string())?;

        // Un dispositivo elegido por el usuario que ya no está conectado NO se sustituye por el predeterminado de
        // Windows: el click y la guía saldrían por unos altavoces que oye el público.
        let device = match settings.device_name {
            Some(ref name) => {
                let mut found = None;
                for d in devices {
                    if get_device_name(&d) == *name {
                        found = Some(d);
                        break;
                    }
                }
                found.ok_or_else(|| {
                    format!(
                        "El dispositivo de salida «{name}» no está disponible. Conéctalo o elige otro en Ajustes de audio: \
                         OmniTracks no usa otra salida en su lugar para que el click y la guía no lleguen al público."
                    )
                })?
            }
            None => host
                .default_output_device()
                .ok_or_else(|| "No hay dispositivo de salida predeterminado".to_string())?,
        };
        let device_name = get_device_name(&device);

        let default_config = device
            .default_output_config()
            .map_err(|e| format!("Error en configuración de salida: {e}"))?;

        // Con un proyecto cargado la salida debe abrirse a la frecuencia de su caché PCM (A08): los
        // feeders producen audio a esa frecuencia y `self.sample_rate` la guarda desde `load_project`.
        let cache_rate = if self.loaded_project_id.lock().await.is_some() {
            Some(self.sample_rate.load(Ordering::SeqCst))
        } else {
            None
        };
        let supported_ranges: Vec<cpal::SupportedStreamConfigRange> = device
            .supported_output_configs()
            .map(|it| it.collect())
            .unwrap_or_default();
        let default_config = resolve_output_config(default_config, &supported_ranges, cache_rate)?;

        let sample_rate_u32 = default_config.sample_rate();
        self.sample_rate.store(sample_rate_u32, Ordering::SeqCst);

        let channels = default_config.channels() as usize;

        // Ruteo de este dispositivo: el guardado si encaja con su cantidad de canales; si no, la propuesta. Se
        // valida antes de abrir nada: un ruteo inseguro impide reproducir en lugar de aplicarse a medias.
        let routing_key = routing::device_key(host.id().name(), &device_name);
        let resolution = engine_state.routing_store.lock().unwrap().resolve(&routing_key, channels as u16);
        let issues = routing::validate(&resolution.config, channels as u16);
        if !issues.is_empty() {
            return Err(format!(
                "Ruteo de salidas no válido para «{device_name}» ({channels} salidas): {}",
                issues.iter().map(|i| i.message()).collect::<Vec<_>>().join(" ")
            ));
        }
        self.routing.store(&RouteTable::from_config(&resolution.config));
        *self.active_routing_key.lock().unwrap() = Some(routing_key);

        let dev_disconnected_arc = Arc::clone(&self.device_disconnected);
        let is_playing_arc_err = Arc::clone(&self.is_playing);

        let err_fn = move |err| {
            eprintln!("[NativeAudioStream] Error en stream CPAL (posible desconexión): {err}");
            dev_disconnected_arc.store(true, Ordering::SeqCst);
            is_playing_arc_err.store(false, Ordering::SeqCst);
        };
        let stream_config: cpal::StreamConfig = default_config.into();

        // Búferes de mezcla preasignados aquí, fuera del hilo de audio (el callback no asigna memoria).
        let mut mixer = BlockMixer::new(self.callback_shared());
        let stream = device
            .build_output_stream(
                stream_config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    mixer.process(data, channels, sample_rate_u32);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Error construyendo corriente de salida CPAL: {e}"))?;

        stream.play().map_err(|e| format!("Error iniciando stream: {e}"))?;
        self.stream_rate.store(sample_rate_u32, Ordering::SeqCst);
        *stream_guard = Some(stream);

        Ok(())
    }

    /// Los `Arc` del motor que lee el callback de audio (los mismos que cambia el transporte).
    fn callback_shared(&self) -> CallbackShared {
        CallbackShared {
            stream_tracks: Arc::clone(&self.stream_tracks),
            is_playing: Arc::clone(&self.is_playing),
            is_buffering: Arc::clone(&self.is_buffering),
            buffering_start_time: Arc::clone(&self.buffering_start_time),
            last_prefill_duration_ms: Arc::clone(&self.last_prefill_duration_ms),
            seek_generation: Arc::clone(&self.seek_generation),
            current_frame: Arc::clone(&self.current_frame),
            clock_jumps: Arc::clone(&self.clock_jumps),
            total_frames: Arc::clone(&self.total_frames),
            fade: Arc::clone(&self.fade),
            stats: Arc::clone(&self.stats),
            metronome: Arc::clone(&self.metronome),
            master_gain: Arc::clone(&self.master_gain),
            cue_master_gain: Arc::clone(&self.cue_master_gain),
            monitor_gain: Arc::clone(&self.monitor_gain),
            is_vamping: Arc::clone(&self.is_vamping),
            routing: Arc::clone(&self.routing),
            bus_meters: Arc::clone(&self.bus_meters),
        }
    }

    /// Procesa un bloque igual que el callback real de CPAL (el mismo `BlockMixer`), sin abrir ningún
    /// dispositivo. Lo usan las pruebas de integración para reproducir de forma determinista. El mezclador se
    /// crea en la primera llamada y se conserva, como el del stream, para que el metrónomo siga el reloj.
    pub fn simulate_callback_block(&self, data: &mut [f32], channels: usize) {
        let sample_rate = self.sample_rate.load(Ordering::Relaxed).max(1);
        let mut slot = self.simulated_mixer.lock().unwrap();
        let mixer = slot.get_or_insert_with(|| BlockMixer::new(self.callback_shared()));
        mixer.process(data, channels, sample_rate);
    }
}

/// Una ganancia que no es un número finito (NaN, infinito) se descarta: dejaría la pista en silencio o saturada.
fn sane_gain(g: f32) -> f32 {
    if g.is_finite() { g.max(0.0) } else { 1.0 }
}

#[cfg(test)]
mod tests;
