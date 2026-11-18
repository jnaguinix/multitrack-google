//! Análisis de sonoridad (EBU R128) de la mezcla de referencia de cada canción, en segundo plano.
//!
//! Lee la caché PCM que ya existe (no decodifica nada), suma las pistas que salen por Main como las suma el motor
//! (mismo ruteo y misma ley de paneo, con las pistas a ganancia 1 y al centro) y mide ese resultado con `ebur128`:
//! sonoridad integrada (LUFS), rango de sonoridad (LU) y True Peak (dBTP). **No toca la reproducción**: corre en un
//! hilo propio, nunca en el callback, y se detiene mientras suena algo. Los stems no se normalizan: se mide la suma.
//!
//! El resultado es la referencia «tal como viene». El volumen master de la canción es un factor lineal posterior a la
//! suma, así que desplaza la sonoridad exactamente en 20·log10(master) dB: la interfaz lo aplica al mostrarla y no
//! hace falta volver a analizar cuando se mueve.

use std::collections::VecDeque;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use ebur128::{EbuR128, Mode};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::cache::{get_track_pcm_path, read_track_metadata};
use crate::audio::playback::{apply_pan, pan_law, TrackBus};
use crate::library::{self, LibrarySong};

/// Versión del método de medida. Si cambia (qué pistas entran, cómo se suman), los resultados guardados se rehacen.
pub const LOUDNESS_REFERENCE_VERSION: u32 = 1;

/// Fotogramas que se leen y miden por vuelta (1 s a 48 kHz): memoria constante sea cual sea la duración.
const CHUNK_FRAMES: usize = 48_000;

/// Resultado del análisis de una canción (referencia: pistas de Main a ganancia 1, sin volumen master).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongLoudness {
    /// Sonoridad integrada en LUFS; `None` si la mezcla es silencio o dura menos de 400 ms.
    #[serde(default)]
    pub integrated_lufs: Option<f64>,
    /// Rango de sonoridad en LU.
    #[serde(default)]
    pub loudness_range_lu: Option<f64>,
    /// Pico real (True Peak) de la mezcla antes del limitador, en dBTP.
    #[serde(default)]
    pub true_peak_dbtp: Option<f64>,
    /// Pico de muestra en dBFS.
    #[serde(default)]
    pub sample_peak_dbfs: Option<f64>,
    pub duration_sec: f64,
    /// Pistas que entraron en la mezcla de referencia.
    pub tracks_measured: u32,
    /// Qué se midió: cambia si cambia la caché o el reparto de pistas (ver `signature`).
    pub signature: String,
    pub reference_version: u32,
    pub analyzed_at: u64,
}

/// Una pista que entra en la mezcla de referencia.
#[derive(Clone, Debug, PartialEq)]
pub struct TrackSpec {
    pub track_id: String,
    /// Secuencia dividida: solo el canal derecho es música (el izquierdo es click y guía).
    pub split: bool,
}

/// Las pistas de la canción que salen por Main (bus «main» o «both»), igual que en el motor. Click y Guía no cuentan.
pub fn main_track_specs(song: &LibrarySong) -> Vec<TrackSpec> {
    song.tracks
        .iter()
        .filter(|t| matches!(TrackBus::from_str(t.bus.as_deref().unwrap_or("main")), TrackBus::Main | TrackBus::Both))
        .map(|t| TrackSpec { track_id: t.id.clone(), split: t.split_sequence.unwrap_or(false) })
        .collect()
}

/// FNV-1a de 64 bits: estable entre versiones de Rust (la firma se guarda en disco).
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Firma de lo que se mide: pistas, su caché (fecha y tamaño) y su reparto. Si coincide con la del resultado guardado,
/// no hace falta analizar otra vez. `Err` si falta la caché de alguna pista.
pub fn signature(base_dir: &Path, project_id: &str, sample_rate: u32, specs: &[TrackSpec]) -> Result<String, String> {
    let mut parts = Vec::with_capacity(specs.len());
    for spec in specs {
        let meta = read_track_metadata(base_dir, project_id, sample_rate, &spec.track_id)?;
        parts.push(format!(
            "{}|{}|{}|{}|{}",
            spec.track_id, meta.created_at, meta.frame_count, meta.channels, spec.split
        ));
    }
    parts.sort();
    Ok(format!("v{LOUDNESS_REFERENCE_VERSION}:{sample_rate}:{:016x}", fnv1a(&parts.join(";"))))
}

/// Control del análisis desde fuera: se consulta una vez por vuelta.
pub trait AnalysisControl {
    /// `Err` detiene el análisis (cancelado). Puede bloquearse un rato (por ejemplo mientras suena algo).
    fn checkpoint(&self) -> Result<(), String>;
}

/// Sin pausas ni cancelación (pruebas).
pub struct Unrestricted;
impl AnalysisControl for Unrestricted {
    fn checkpoint(&self) -> Result<(), String> {
        Ok(())
    }
}

/// Lee hasta llenar `buf` o llegar al final del archivo. Devuelve los bytes leídos.
fn read_available(file: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

fn to_db(linear: f64) -> Option<f64> {
    (linear.is_finite() && linear > 0.0).then(|| 20.0 * linear.log10())
}

fn finite(value: f64) -> Option<f64> {
    value.is_finite().then_some(value)
}

struct OpenTrack {
    file: File,
    frames: u64,
    mono: bool,
    split: bool,
}

/// Mide la mezcla de referencia de la canción a partir de su caché PCM.
pub fn analyze_reference_mix(
    base_dir: &Path,
    project_id: &str,
    sample_rate: u32,
    specs: &[TrackSpec],
    control: &dyn AnalysisControl,
) -> Result<SongLoudness, String> {
    if specs.is_empty() {
        return Err("la canción no tiene pistas de música (todas son click o guía)".to_string());
    }
    let signature = signature(base_dir, project_id, sample_rate, specs)?;

    let mut tracks = Vec::with_capacity(specs.len());
    for spec in specs {
        let meta = read_track_metadata(base_dir, project_id, sample_rate, &spec.track_id)?;
        let path = get_track_pcm_path(base_dir, project_id, sample_rate, &spec.track_id);
        let file = File::open(&path).map_err(|e| format!("no se pudo abrir {}: {e}", path.display()))?;
        tracks.push(OpenTrack { file, frames: meta.frame_count, mono: meta.channels == 1, split: spec.split });
    }
    let total_frames = tracks.iter().map(|t| t.frames).max().unwrap_or(0);

    let mode = Mode::I | Mode::LRA | Mode::TRUE_PEAK | Mode::SAMPLE_PEAK | Mode::HISTOGRAM;
    let mut meter = EbuR128::new(2, sample_rate, mode).map_err(|e| format!("no se pudo crear el medidor: {e}"))?;

    // Mismo reparto que el callback del motor, con ganancia 1 y paneo al centro.
    let law = pan_law(0.0, 1.0);
    let mut raw = vec![0u8; CHUNK_FRAMES * 4];
    let mut mix_l = vec![0.0f32; CHUNK_FRAMES];
    let mut mix_r = vec![0.0f32; CHUNK_FRAMES];
    let mut interleaved = vec![0.0f32; CHUNK_FRAMES * 2];

    let mut position = 0u64;
    while position < total_frames {
        control.checkpoint()?;
        let n = ((total_frames - position) as usize).min(CHUNK_FRAMES);
        mix_l[..n].fill(0.0);
        mix_r[..n].fill(0.0);

        for track in &mut tracks {
            if position >= track.frames {
                continue;
            }
            let take = ((track.frames - position) as usize).min(n);
            let bytes_per_frame = if track.mono { 2 } else { 4 };
            let wanted = take * bytes_per_frame;
            let got = read_available(&mut track.file, &mut raw[..wanted]).map_err(|e| format!("error leyendo la caché: {e}"))?;
            // Si el archivo es más corto que sus metadatos, lo que falta es silencio.
            for f in 0..(got / bytes_per_frame) {
                let (l, r) = if track.mono {
                    let s = f32::from(i16::from_le_bytes([raw[f * 2], raw[f * 2 + 1]])) / 32768.0;
                    (s, s)
                } else {
                    (
                        f32::from(i16::from_le_bytes([raw[f * 4], raw[f * 4 + 1]])) / 32768.0,
                        f32::from(i16::from_le_bytes([raw[f * 4 + 2], raw[f * 4 + 3]])) / 32768.0,
                    )
                };
                let (ml, mr) = if track.split { apply_pan(r, r, law) } else { apply_pan(l, r, law) };
                mix_l[f] += ml;
                mix_r[f] += mr;
            }
        }

        for f in 0..n {
            interleaved[f * 2] = mix_l[f];
            interleaved[f * 2 + 1] = mix_r[f];
        }
        meter.add_frames_f32(&interleaved[..n * 2]).map_err(|e| format!("error de medida: {e}"))?;
        position += n as u64;
    }

    let true_peak = (0..2).filter_map(|ch| meter.true_peak(ch).ok()).fold(0.0f64, f64::max);
    let sample_peak = (0..2).filter_map(|ch| meter.sample_peak(ch).ok()).fold(0.0f64, f64::max);

    Ok(SongLoudness {
        integrated_lufs: meter.loudness_global().ok().and_then(finite),
        loudness_range_lu: meter.loudness_range().ok().and_then(finite),
        true_peak_dbtp: to_db(true_peak),
        sample_peak_dbfs: to_db(sample_peak),
        duration_sec: total_frames as f64 / f64::from(sample_rate.max(1)),
        tracks_measured: tracks.len() as u32,
        signature,
        reference_version: LOUDNESS_REFERENCE_VERSION,
        analyzed_at: library::current_timestamp_ms(),
    })
}

/// Resultado de preparar el análisis de una canción.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Medida nueva (ya no hace falta nada más que guardarla).
    Measured(SongLoudness),
    /// El resultado guardado ya corresponde a la caché actual.
    UpToDate,
    /// No se puede analizar todavía (sin caché completa a esa frecuencia o la canción ya no está).
    NotReady(String),
}

/// Analiza una canción de la biblioteca: lee sus pistas de `library.json`, comprueba que haya caché completa y que el
/// resultado guardado no esté al día, y la mide. No guarda nada.
pub fn analyze_song(
    base_dir: &Path,
    project_id: &str,
    sample_rate: u32,
    control: &dyn AnalysisControl,
) -> Result<Outcome, String> {
    let Some(song) = library::read_song(base_dir, project_id)? else {
        return Ok(Outcome::NotReady("la canción ya no está en la biblioteca".to_string()));
    };
    let specs = main_track_specs(&song);
    if specs.is_empty() {
        return Ok(Outcome::NotReady("la canción no tiene pistas de música".to_string()));
    }
    let current = match signature(base_dir, project_id, sample_rate, &specs) {
        Ok(s) => s,
        Err(e) => return Ok(Outcome::NotReady(format!("caché incompleta: {e}"))),
    };
    if song
        .loudness
        .as_ref()
        .is_some_and(|l| l.signature == current && l.reference_version == LOUDNESS_REFERENCE_VERSION)
    {
        return Ok(Outcome::UpToDate);
    }
    analyze_reference_mix(base_dir, project_id, sample_rate, &specs, control).map(Outcome::Measured)
}

/// Frecuencia de la caché de una canción: la preferida si existe y, si no, la primera que haya.
pub fn resolve_cache_rate(base_dir: &Path, project_id: &str, preferred: u32) -> Option<u32> {
    let dir = base_dir.join("pcm").join(project_id);
    if dir.join(preferred.to_string()).is_dir() {
        return Some(preferred);
    }
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()))
        .min()
}

// ---------------------------------------------------------------------------------------------------------------------
// Cola en segundo plano
// ---------------------------------------------------------------------------------------------------------------------

/// Aviso a la interfaz (`audio://loudness`): el resultado de una canción o por qué no se pudo analizar.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessEvent {
    pub project_id: String,
    pub loudness: Option<SongLoudness>,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
struct Job {
    project_id: String,
    sample_rate: u32,
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<Job>,
    running: Option<(String, Arc<AtomicBool>)>,
}

/// Cola de análisis con un único hilo: una canción cada vez, sin competir con la reproducción.
pub struct LoudnessQueue {
    inner: Mutex<Inner>,
    wake: Condvar,
    /// `true` mientras suena algo: el análisis se detiene hasta que pare.
    playing: Arc<AtomicBool>,
    started: AtomicBool,
}

struct JobControl {
    cancel: Arc<AtomicBool>,
    playing: Arc<AtomicBool>,
}

impl AnalysisControl for JobControl {
    fn checkpoint(&self) -> Result<(), String> {
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Err("cancelado".to_string());
            }
            if !self.playing.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        // Cede el procesador entre vuelta y vuelta: el análisis nunca debe notarse.
        std::thread::sleep(Duration::from_millis(2));
        Ok(())
    }
}

impl LoudnessQueue {
    pub fn new(playing: Arc<AtomicBool>) -> Self {
        Self { inner: Mutex::new(Inner::default()), wake: Condvar::new(), playing, started: AtomicBool::new(false) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Encola el análisis de una canción (si ya está en cola o analizándose, no hace nada). Devuelve si se encoló.
    pub fn enqueue(self: &Arc<Self>, app: &AppHandle, project_id: &str, sample_rate: u32) -> bool {
        {
            let mut inner = self.lock();
            let running_same = inner.running.as_ref().is_some_and(|(id, _)| id == project_id);
            if running_same || inner.queue.iter().any(|j| j.project_id == project_id) {
                return false;
            }
            inner.queue.push_back(Job { project_id: project_id.to_string(), sample_rate });
        }
        self.start_worker(app);
        self.wake.notify_one();
        true
    }

    /// Quita la canción de la cola y detiene su análisis si está en marcha (su caché va a cambiar o desaparecer).
    pub fn cancel(&self, project_id: &str) {
        let mut inner = self.lock();
        inner.queue.retain(|j| j.project_id != project_id);
        if let Some((id, flag)) = &inner.running {
            if id == project_id {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    fn start_worker(self: &Arc<Self>, app: &AppHandle) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let queue = Arc::clone(self);
        let app = app.clone();
        let spawned = std::thread::Builder::new().name("omni-loudness".to_string()).spawn(move || queue.worker_loop(&app));
        if let Err(e) = spawned {
            self.started.store(false, Ordering::SeqCst);
            tracing::error!("[Sonoridad] No se pudo iniciar el hilo de análisis: {e}");
        }
    }

    fn worker_loop(&self, app: &AppHandle) {
        loop {
            let (job, cancel) = {
                let mut inner = self.lock();
                loop {
                    if let Some(job) = inner.queue.pop_front() {
                        let flag = Arc::new(AtomicBool::new(false));
                        inner.running = Some((job.project_id.clone(), Arc::clone(&flag)));
                        break (job, flag);
                    }
                    inner = self.wake.wait(inner).unwrap_or_else(|poisoned| poisoned.into_inner());
                }
            };
            self.run_job(app, &job, cancel);
            self.lock().running = None;
        }
    }

    fn run_job(&self, app: &AppHandle, job: &Job, cancel: Arc<AtomicBool>) {
        let emit = |event: LoudnessEvent| {
            if let Err(e) = app.emit("audio://loudness", event) {
                tracing::warn!("[Sonoridad] No se pudo avisar a la interfaz: {e}");
            }
        };
        let local_data = match app.path().app_local_data_dir() {
            Ok(dir) => dir,
            Err(e) => {
                tracing::warn!("[Sonoridad] No se pudo resolver la carpeta de datos: {e}");
                return;
            }
        };
        let control = JobControl { cancel, playing: Arc::clone(&self.playing) };
        match analyze_song(&local_data, &job.project_id, job.sample_rate, &control) {
            Ok(Outcome::Measured(result)) => match library::set_song_loudness(&local_data, &job.project_id, Some(result.clone())) {
                Ok(true) => {
                    tracing::info!(
                        "[Sonoridad] '{}': {:?} LUFS, True Peak {:?} dBTP ({} pistas)",
                        job.project_id,
                        result.integrated_lufs,
                        result.true_peak_dbtp,
                        result.tracks_measured
                    );
                    emit(LoudnessEvent { project_id: job.project_id.clone(), loudness: Some(result), error: None });
                }
                Ok(false) => tracing::info!("[Sonoridad] '{}' ya no está en la biblioteca; resultado descartado", job.project_id),
                Err(e) => {
                    tracing::warn!("[Sonoridad] No se pudo guardar el resultado de '{}': {e}", job.project_id);
                    emit(LoudnessEvent { project_id: job.project_id.clone(), loudness: None, error: Some(e) });
                }
            },
            Ok(Outcome::UpToDate) => {}
            Ok(Outcome::NotReady(why)) => tracing::info!("[Sonoridad] '{}' aún no se puede analizar: {why}", job.project_id),
            Err(e) if e == "cancelado" => tracing::info!("[Sonoridad] Análisis de '{}' cancelado", job.project_id),
            Err(e) => {
                tracing::warn!("[Sonoridad] Falló el análisis de '{}': {e}", job.project_id);
                emit(LoudnessEvent { project_id: job.project_id.clone(), loudness: None, error: Some(e) });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::cache::{write_track_pcm_and_metadata, TrackPcmMetadata};
    use crate::library::{LibraryFile, LibrarySong, LibraryTrack};

    const SR: u32 = 48_000;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("omnitracks_sonoridad_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Seno de 1 kHz de `amplitude` (pico lineal) durante `seconds`; si `stereo`, el mismo en ambos canales.
    fn sine(amplitude: f32, seconds: f32, stereo: bool) -> (Vec<i16>, u64) {
        let frames = (seconds * SR as f32) as usize;
        let mut out = Vec::with_capacity(frames * if stereo { 2 } else { 1 });
        for f in 0..frames {
            let v = (amplitude * (2.0 * std::f32::consts::PI * 1000.0 * f as f32 / SR as f32).sin() * 32767.0).round() as i16;
            out.push(v);
            if stereo {
                out.push(v);
            }
        }
        (out, frames as u64)
    }

    fn write_track(dir: &Path, project: &str, id: &str, samples: &[i16], frames: u64, stereo: bool, created: &str) {
        let meta = TrackPcmMetadata {
            format_version: 1,
            track_id: id.to_string(),
            target_sample_rate: SR,
            original_sample_rate: SR,
            original_channels: if stereo { 2 } else { 1 },
            original_path: format!("{id}.wav"),
            original_file_size: frames * 4,
            original_modified_ms: 1,
            channels: if stereo { 2 } else { 1 },
            is_effectively_mono: !stereo,
            frame_count: frames,
            duration_sec: frames as f64 / SR as f64,
            peaks: vec![0.5; 4],
            created_at: created.to_string(),
        };
        write_track_pcm_and_metadata(dir, project, &meta, samples).unwrap();
    }

    fn track(id: &str, bus: &str) -> LibraryTrack {
        LibraryTrack { id: id.to_string(), name: id.to_string(), bus: Some(bus.to_string()), ..Default::default() }
    }

    fn main_specs(ids: &[&str]) -> Vec<TrackSpec> {
        ids.iter().map(|id| TrackSpec { track_id: id.to_string(), split: false }).collect()
    }

    /// Ganancia (lineal) con la que el motor reparte una pista estéreo con L = R = 1 al centro.
    fn center_gain() -> f64 {
        f64::from(apply_pan(1.0, 1.0, pan_law(0.0, 1.0)).0)
    }

    #[test]
    fn un_seno_estereo_de_menos_23_dbfs_da_la_sonoridad_que_marca_la_norma() {
        let dir = temp_dir("norma");
        let amplitude = 10f32.powf(-23.0 / 20.0);
        let (samples, frames) = sine(amplitude, 6.0, true);
        write_track(&dir, "p", "a", &samples, frames, true, "t1");

        let r = analyze_reference_mix(&dir, "p", SR, &main_specs(&["a"]), &Unrestricted).unwrap();
        // La mezcla pasa por la ley de paneo del motor: esa ganancia es parte de lo que suena.
        let expected = -23.0 + 20.0 * center_gain().log10();
        let got = r.integrated_lufs.expect("debe haber sonoridad integrada");
        println!("norma: medido {got:.3} LUFS, esperado {expected:.3} LUFS (ganancia del paneo al centro {:.3}); True Peak {:?} dBTP", center_gain(), r.true_peak_dbtp);
        assert!((got - expected).abs() < 0.15, "esperado {expected:.2} LUFS, medido {got:.2}");
        let peak = r.true_peak_dbtp.expect("debe haber True Peak");
        assert!((peak - expected).abs() < 0.4, "True Peak {peak:.2} frente a {expected:.2} (un seno: el pico es su amplitud, no la sonoridad)");
        assert_eq!((r.tracks_measured, r.reference_version), (1, LOUDNESS_REFERENCE_VERSION));
        assert!((r.duration_sec - 6.0).abs() < 0.01);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn una_pista_mono_equivale_a_la_misma_en_estereo_y_las_pistas_se_suman() {
        let dir = temp_dir("mono");
        let amplitude = 0.1f32;
        let (stereo, frames) = sine(amplitude, 5.0, true);
        let (mono, _) = sine(amplitude, 5.0, false);
        write_track(&dir, "p", "st", &stereo, frames, true, "t1");
        write_track(&dir, "p", "mo", &mono, frames, false, "t1");

        let a = analyze_reference_mix(&dir, "p", SR, &main_specs(&["st"]), &Unrestricted).unwrap();
        let b = analyze_reference_mix(&dir, "p", SR, &main_specs(&["mo"]), &Unrestricted).unwrap();
        let (la, lb) = (a.integrated_lufs.unwrap(), b.integrated_lufs.unwrap());
        assert!((la - lb).abs() < 0.05, "mono y estéreo idénticos deben medir igual: {la:.2} frente a {lb:.2}");

        // Dos pistas iguales suenan 6 dB más fuerte (se suman en amplitud, mismas muestras).
        let both = analyze_reference_mix(&dir, "p", SR, &main_specs(&["st", "mo"]), &Unrestricted).unwrap();
        let delta = both.integrated_lufs.unwrap() - la;
        assert!((delta - 6.02).abs() < 0.2, "dos pistas iguales deben subir ~6 dB, subieron {delta:.2}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn solo_entran_las_pistas_de_main_y_las_mas_cortas_se_rellenan_con_silencio() {
        let dir = temp_dir("seleccion");
        let (long, frames) = sine(0.1, 6.0, true);
        let (short, short_frames) = sine(0.1, 2.0, true);
        write_track(&dir, "p", "larga", &long, frames, true, "t1");
        write_track(&dir, "p", "corta", &short, short_frames, true, "t1");
        write_track(&dir, "p", "click", &long, frames, true, "t1");

        let song = LibrarySong {
            id: "p".to_string(),
            tracks: vec![track("larga", "main"), track("corta", "both"), track("click", "cue-click"), track("guia", "guide")],
            ..Default::default()
        };
        let ids: Vec<String> = main_track_specs(&song).into_iter().map(|s| s.track_id).collect();
        assert_eq!(ids, vec!["larga", "corta"], "Click y Guía no entran en la mezcla de referencia");

        let r = analyze_reference_mix(&dir, "p", SR, &main_specs(&["larga", "corta"]), &Unrestricted).unwrap();
        assert!((r.duration_sec - 6.0).abs() < 0.01, "dura lo que la pista más larga");
        assert_eq!(r.tracks_measured, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn una_secuencia_dividida_solo_aporta_su_canal_derecho() {
        let dir = temp_dir("dividida");
        // Izquierdo: seno fuerte (click y guía). Derecho: silencio (sin música).
        let frames = (5.0 * SR as f32) as usize;
        let mut samples = Vec::with_capacity(frames * 2);
        for f in 0..frames {
            let v = (0.5 * (2.0 * std::f32::consts::PI * 1000.0 * f as f32 / SR as f32).sin() * 32767.0) as i16;
            samples.push(v);
            samples.push(0);
        }
        write_track(&dir, "p", "seq", &samples, frames as u64, true, "t1");
        let specs = vec![TrackSpec { track_id: "seq".to_string(), split: true }];
        let r = analyze_reference_mix(&dir, "p", SR, &specs, &Unrestricted).unwrap();
        assert!(r.integrated_lufs.is_none(), "sin música en el canal derecho no hay sonoridad: {:?}", r.integrated_lufs);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn el_silencio_y_lo_demasiado_corto_no_inventan_una_sonoridad() {
        let dir = temp_dir("silencio");
        let silence = vec![0i16; SR as usize * 2 * 3];
        write_track(&dir, "p", "mudo", &silence, SR as u64 * 3, true, "t1");
        let r = analyze_reference_mix(&dir, "p", SR, &main_specs(&["mudo"]), &Unrestricted).unwrap();
        assert!(r.integrated_lufs.is_none() && r.true_peak_dbtp.is_none(), "{r:?}");

        let (blip, frames) = sine(0.3, 0.2, true);
        write_track(&dir, "p", "corto", &blip, frames, true, "t1");
        let r = analyze_reference_mix(&dir, "p", SR, &main_specs(&["corto"]), &Unrestricted).unwrap();
        assert!(r.integrated_lufs.is_none(), "menos de 400 ms no tiene sonoridad integrada: {:?}", r.integrated_lufs);
        assert!(r.true_peak_dbtp.is_some(), "el pico sí se mide");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn la_firma_cambia_si_cambia_la_cache_o_el_reparto_y_no_si_no() {
        let dir = temp_dir("firma");
        let (samples, frames) = sine(0.1, 2.0, true);
        write_track(&dir, "p", "a", &samples, frames, true, "t1");
        let specs = main_specs(&["a"]);
        let s1 = signature(&dir, "p", SR, &specs).unwrap();
        assert_eq!(s1, signature(&dir, "p", SR, &specs).unwrap(), "estable");

        let split = vec![TrackSpec { track_id: "a".to_string(), split: true }];
        assert_ne!(s1, signature(&dir, "p", SR, &split).unwrap(), "el reparto cuenta");

        write_track(&dir, "p", "a", &samples, frames, true, "t2"); // caché regenerada
        assert_ne!(s1, signature(&dir, "p", SR, &specs).unwrap(), "una caché nueva cambia la firma");

        assert!(signature(&dir, "p", SR, &main_specs(&["nada"])).is_err(), "sin caché no hay firma");
        let _ = std::fs::remove_dir_all(&dir);
    }

    struct CancelAfter(std::cell::Cell<u32>);
    impl AnalysisControl for CancelAfter {
        fn checkpoint(&self) -> Result<(), String> {
            let n = self.0.get();
            if n == 0 {
                return Err("cancelado".to_string());
            }
            self.0.set(n - 1);
            Ok(())
        }
    }

    #[test]
    fn cancelar_detiene_el_analisis() {
        let dir = temp_dir("cancelar");
        let (samples, frames) = sine(0.1, 10.0, true);
        write_track(&dir, "p", "a", &samples, frames, true, "t1");
        let r = analyze_reference_mix(&dir, "p", SR, &main_specs(&["a"]), &CancelAfter(std::cell::Cell::new(3)));
        assert_eq!(r, Err("cancelado".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn analizar_una_cancion_de_la_biblioteca_mide_guarda_y_luego_esta_al_dia() {
        let dir = temp_dir("biblioteca");
        let (samples, frames) = sine(0.1, 4.0, true);
        write_track(&dir, "song-1", "a", &samples, frames, true, "t1");
        write_track(&dir, "song-1", "click", &samples, frames, true, "t1");
        let song = LibrarySong {
            id: "song-1".to_string(),
            title: "Prueba".to_string(),
            tracks: vec![track("a", "main"), track("click", "cue-click")],
            ..Default::default()
        };
        library::save_library_internal(&dir, &LibraryFile { songs: vec![song], ..Default::default() }).unwrap();

        let Outcome::Measured(result) = analyze_song(&dir, "song-1", SR, &Unrestricted).unwrap() else {
            panic!("la primera vez debe medir");
        };
        assert_eq!(result.tracks_measured, 1, "el click no entra");
        assert!(library::set_song_loudness(&dir, "song-1", Some(result.clone())).unwrap());

        assert_eq!(analyze_song(&dir, "song-1", SR, &Unrestricted).unwrap(), Outcome::UpToDate);
        // Una caché regenerada deja el resultado obsoleto.
        write_track(&dir, "song-1", "a", &samples, frames, true, "t2");
        assert!(matches!(analyze_song(&dir, "song-1", SR, &Unrestricted).unwrap(), Outcome::Measured(_)));
        // Sin caché o sin canción no es un error: todavía no se puede.
        assert!(matches!(analyze_song(&dir, "otra", SR, &Unrestricted).unwrap(), Outcome::NotReady(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn la_cache_se_busca_a_la_frecuencia_preferida_o_a_la_que_haya() {
        let dir = temp_dir("frecuencia");
        let (samples, frames) = sine(0.1, 1.0, true);
        write_track(&dir, "p", "a", &samples, frames, true, "t1");
        assert_eq!(resolve_cache_rate(&dir, "p", 48_000), Some(48_000));
        assert_eq!(resolve_cache_rate(&dir, "p", 44_100), Some(48_000), "si no está la preferida, la que haya");
        assert_eq!(resolve_cache_rate(&dir, "sin-cache", 48_000), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn la_cola_no_duplica_canciones_y_cancelar_quita_las_pendientes() {
        let queue = Arc::new(LoudnessQueue::new(Arc::new(AtomicBool::new(false))));
        {
            let mut inner = queue.lock();
            inner.queue.push_back(Job { project_id: "a".to_string(), sample_rate: SR });
            inner.queue.push_back(Job { project_id: "b".to_string(), sample_rate: SR });
            inner.running = Some(("c".to_string(), Arc::new(AtomicBool::new(false))));
        }
        queue.cancel("a");
        queue.cancel("c");
        let inner = queue.lock();
        assert_eq!(inner.queue.iter().map(|j| j.project_id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        assert!(inner.running.as_ref().unwrap().1.load(Ordering::Relaxed), "la que se está analizando recibe la orden de parar");
    }
}
