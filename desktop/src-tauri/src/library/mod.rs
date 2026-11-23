use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Manager, State};

use crate::audio::loudness::SongLoudness;
use crate::audio::output::AudioEngineState;

pub const SIDECAR_CANONICAL_FILENAME: &str = "omnitracks.project.json";
pub const SIDECAR_FALLBACK_FILENAME: &str = ".omnitracks.json";
pub const LIBRARY_FILENAME: &str = "library.json";
pub const LIBRARY_BACKUP_FILENAME: &str = "library.backup.json";
pub const LIBRARY_TMP_FILENAME: &str = "library.json.tmp";
/// Carpeta (junto a `library.json`) con los picos de forma de onda: un archivo `<id de la canción>.json` por canción.
pub const PEAKS_DIRNAME: &str = "peaks";

/// Serializa todo acceso a `library.json`. Los comandos de Tauri se ejecutan en paralelo: sin este cerrojo,
/// dos guardados a la vez (p. ej. al mover un fader) se pisaban el archivo temporal y dejaban basura al final
/// del JSON, y el ciclo leer-modificar-escribir de dos canciones perdía el cambio de una de ellas.
static LIBRARY_LOCK: Mutex<()> = Mutex::new(());
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Toma el cerrojo de la biblioteca. Un hilo que falló con el cerrojo tomado no lo deja inutilizable.
fn lock_library() -> MutexGuard<'static, ()> {
    LIBRARY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Nombre de archivo temporal único por escritura: dos escrituras nunca comparten archivo.
fn unique_tmp_name(base: &str) -> String {
    format!("{base}.{}.{}.tmp", std::process::id(), TMP_COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Intentos de renombrado al reemplazar un archivo (ver `replace_file_atomic`).
const REPLACE_ATTEMPTS: u32 = 8;

/// Reemplaza `target` por `tmp` con un renombrado atómico: `target` es siempre el archivo anterior completo o el
/// nuevo completo, nunca uno a medias. En Windows el renombrado sobre un archivo que otro programa tiene abierto
/// (antivirus, indexador, copia de seguridad) falla un instante, así que se reintenta (~0,45 s en total). Si no se
/// logra, NO se escribe directamente sobre `target` (una escritura interrumpida lo dejaría truncado): se borra `tmp`,
/// `target` queda como estaba y se devuelve el error.
fn replace_file_atomic(tmp: &Path, target: &Path) -> Result<(), String> {
    let mut delay_ms = 10u64;
    let mut last_error = String::new();
    for attempt in 0..REPLACE_ATTEMPTS {
        match fs::rename(tmp, target) {
            Ok(()) => return Ok(()),
            Err(e) => last_error = e.to_string(),
        }
        if attempt + 1 < REPLACE_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            delay_ms = (delay_ms * 2).min(100);
        }
    }
    let _ = fs::remove_file(tmp);
    Err(format!("no se pudo reemplazar {}: {last_error}", target.display()))
}

/// Lee el primer valor JSON del texto e ignora lo que venga después. Un archivo con basura al final (la
/// consecuencia de una escritura interrumpida o solapada) sigue siendo recuperable. Devuelve también si había
/// algo más que espacios tras el valor.
fn parse_library_lenient(content: &str) -> Result<(LibraryFile, bool), serde_json::Error> {
    let mut stream = serde_json::Deserializer::from_str(content).into_iter::<LibraryFile>();
    match stream.next() {
        Some(Ok(lib)) => {
            let has_trailing = !content[stream.byte_offset()..].trim().is_empty();
            Ok((lib, has_trailing))
        }
        Some(Err(e)) => Err(e),
        None => serde_json::from_str::<LibraryFile>(content).map(|l| (l, false)),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTrack {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub file_size: Option<u64>,
    #[serde(default)]
    pub modified_at: Option<u64>,
    #[serde(default)]
    pub duration_sec: Option<f64>,
    #[serde(default)]
    pub sample_rate: Option<u32>,
    #[serde(default)]
    pub channels: Option<u16>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub gain: Option<f32>,
    #[serde(default)]
    pub pan: Option<f32>,
    #[serde(default)]
    pub muted: Option<bool>,
    #[serde(default)]
    pub soloed: Option<bool>,
    /// «Aur.»: la pista también se oye en los auriculares.
    #[serde(default)]
    pub monitor: Option<bool>,
    /// Secuencia dividida (canal izquierdo = click y guía, derecho = instrumentos).
    #[serde(default)]
    pub split_sequence: Option<bool>,
    #[serde(default)]
    pub cue_gain: Option<f32>,
    #[serde(default)]
    pub cue_muted: Option<bool>,
    #[serde(default)]
    pub bus: Option<String>,
    /// Picos de la forma de onda (320 por pista). Son datos derivados del audio: el sidecar de la carpeta no los
    /// lleva (`write_sidecar`) y, si faltan, el motor los vuelve a leer de la caché PCM al cargar la canción.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peaks: Option<Vec<f32>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySongSection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    pub start_time_sec: f64,
    pub end_time_sec: f64,
    #[serde(default)]
    pub vamp_by_default: Option<bool>,
    #[serde(default)]
    pub cue_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySong {
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub folder_path: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub in_setlist: Option<bool>,
    #[serde(default)]
    pub setlist_order: Option<usize>,
    pub bpm: f64,
    #[serde(default)]
    pub beats_per_bar: Option<u32>,
    #[serde(default)]
    pub beat_unit: Option<u32>,
    pub key_signature: String,
    #[serde(default)]
    pub total_bars: Option<u32>,
    #[serde(default)]
    pub duration_sec: Option<f64>,
    #[serde(default)]
    pub quantize_mode: Option<String>,
    #[serde(default)]
    pub split_routing_mode: Option<String>,
    #[serde(default)]
    pub click_enabled: Option<bool>,
    #[serde(default)]
    pub click_gain: Option<f32>,
    #[serde(default)]
    pub click_pan: Option<f32>,
    #[serde(default)]
    pub click_subdivision: Option<u32>,
    #[serde(default)]
    pub guide_cues_enabled: Option<bool>,
    #[serde(default)]
    pub guide_voice_readout: Option<bool>,
    #[serde(default)]
    pub guide_gain: Option<f32>,
    #[serde(default)]
    pub guide_pan: Option<f32>,
    #[serde(default)]
    pub master_gain: Option<f32>,
    #[serde(default)]
    pub cue_master_gain: Option<f32>,
    /// Volumen general de las pistas marcadas «Aur.» en los auriculares.
    #[serde(default)]
    pub monitor_gain: Option<f32>,
    #[serde(default)]
    pub pitch_semitones: Option<i32>,
    #[serde(default)]
    pub is_title_custom: Option<bool>,
    /// Notas de la canción para el servicio (por ejemplo «entrar con el coro»).
    #[serde(default)]
    pub notes: Option<String>,
    /// Qué hacer al terminar esta canción: «stop», «cue-next» o «auto-play». Sin valor: el ajuste general.
    #[serde(default)]
    pub transition_to_next: Option<String>,
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub last_used_at: Option<u64>,
    #[serde(default)]
    pub sections: Vec<LibrarySongSection>,
    #[serde(default)]
    pub tracks: Vec<LibraryTrack>,
    /// Sonoridad de la mezcla de referencia (EBU R128), medida por el motor en segundo plano (`audio/loudness.rs`).
    /// Es un dato derivado de la caché: el sidecar no lo lleva y un guardado de la interfaz que no lo trae no lo borra.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loudness: Option<SongLoudness>,
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFile {
    pub version: u32,
    pub updated_at: u64,
    #[serde(default)]
    pub active_setlist: Vec<String>,
    #[serde(default)]
    pub songs: Vec<LibrarySong>,
}

impl Default for LibraryFile {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: current_timestamp_ms(),
            active_setlist: Vec::new(),
            songs: Vec::new(),
        }
    }
}

pub fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Locates a project sidecar inside a folder: checks canonical `omnitracks.project.json`
/// first, then falls back to `.omnitracks.json` for compatibility.
pub fn find_sidecar_path(folder: &Path) -> Option<PathBuf> {
    let canonical = folder.join(SIDECAR_CANONICAL_FILENAME);
    if canonical.exists() {
        return Some(canonical);
    }
    let fallback = folder.join(SIDECAR_FALLBACK_FILENAME);
    if fallback.exists() {
        return Some(fallback);
    }
    None
}

/// Reads the sidecar JSON if found in the specified folder.
pub fn read_sidecar(folder_path: &Path) -> Result<Option<serde_json::Value>, String> {
    if let Some(path) = find_sidecar_path(folder_path) {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Error leyendo sidecar {}: {e}", path.display()))?;
        let parsed = serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|e| format!("Error parseando sidecar {}: {e}", path.display()))?;
        return Ok(Some(parsed));
    }
    Ok(None)
}

/// Contenido del sidecar: la configuración de la canción sin los picos de forma de onda. Estos son datos derivados
/// del audio (ocupaban ~90 % de las líneas del archivo) y se regeneran con la caché PCM.
pub fn sidecar_json(song: &LibrarySong) -> Result<String, String> {
    let mut slim = song.clone();
    for track in &mut slim.tracks {
        track.peaks = None;
    }
    slim.loudness = None;
    serde_json::to_string_pretty(&slim).map_err(|e| format!("Error serializando sidecar: {e}"))
}

/// Escribe el sidecar canónico `omnitracks.project.json` en la carpeta de la canción, con archivo temporal único y
/// reemplazo atómico (nunca una escritura directa sobre el sidecar). Si no se puede (carpeta ausente, de solo
/// lectura, disco desconectado, archivo bloqueado) devuelve el error: quien llama decide cómo avisar, pero no se
/// da por guardado algo que no lo está.
pub fn write_sidecar(folder_path: &Path, song: &LibrarySong) -> Result<(), String> {
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err(format!("La carpeta '{}' no existe", folder_path.display()));
    }
    let target = folder_path.join(SIDECAR_CANONICAL_FILENAME);
    let json_str = sidecar_json(song)?;

    let tmp = folder_path.join(unique_tmp_name("omnitracks.project.json"));
    if let Err(e) = fs::write(&tmp, &json_str) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("No se pudo escribir en la carpeta '{}': {e}", folder_path.display()));
    }
    replace_file_atomic(&tmp, &target)
        .map_err(|e| format!("No se pudo guardar {SIDECAR_CANONICAL_FILENAME} en '{}': {e}", folder_path.display()))?;

    tracing::info!(
        "[Sidecar] omnitracks.project.json guardado en '{}'",
        folder_path.display()
    );
    Ok(())
}

// ------------------------------------------------------------------
// Picos de forma de onda fuera de library.json
// ------------------------------------------------------------------
//
// Los picos (320 por pista) son datos derivados del audio y ocupaban ~90 % de `library.json`, que se reescribía
// entero en cada guardado. Ahora viven en `peaks/<id>.json`: `save_library_internal` los separa y
// `load_library_internal` los vuelve a unir a cada canción, así que el resto de la aplicación no nota la diferencia.

/// Resumen (hash) de los picos ya escritos por archivo, para no volver a escribir ni leer los que no cambiaron.
fn peaks_stored() -> &'static Mutex<HashMap<PathBuf, u64>> {
    static STORED: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
    STORED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn peaks_stored_lock() -> MutexGuard<'static, HashMap<PathBuf, u64>> {
    peaks_stored().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Serialize)]
struct PeaksFileOut<'a> {
    version: u32,
    tracks: BTreeMap<&'a str, &'a [f32]>,
}

#[derive(Deserialize)]
struct PeaksFileIn {
    #[serde(default)]
    tracks: HashMap<String, Vec<f32>>,
}

/// Ruta del archivo de picos de una canción. El ID solo conserva letras, números, `-`, `_` y `.`: nunca sale de la
/// carpeta `peaks`.
fn peaks_file_path(local_data: &Path, song_id: &str) -> Option<PathBuf> {
    let safe: String = song_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect();
    if safe.is_empty() || safe.chars().all(|c| c == '.') {
        return None;
    }
    Some(local_data.join(PEAKS_DIRNAME).join(format!("{safe}.json")))
}

/// Resumen de los picos de la canción (pista y valores, en orden). `None` si ninguna pista tiene picos.
fn peaks_hash(song: &LibrarySong) -> Option<u64> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut any = false;
    for track in &song.tracks {
        if let Some(peaks) = track.peaks.as_ref().filter(|p| !p.is_empty()) {
            any = true;
            track.id.hash(&mut hasher);
            peaks.len().hash(&mut hasher);
            for v in peaks {
                v.to_bits().hash(&mut hasher);
            }
        }
    }
    any.then(|| hasher.finish())
}

fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(unique_tmp_name("peaks"));
    fs::write(&tmp, bytes)?;
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Deja los picos de la canción en `peaks/<id>.json` (solo si cambiaron). Devuelve `true` si quedan a salvo en
/// disco y se pueden quitar de `library.json`; con `false` (sin picos o error al escribir) se conservan dentro.
fn store_song_peaks(local_data: &Path, song: &LibrarySong) -> bool {
    let Some(hash) = peaks_hash(song) else { return false };
    let Some(path) = peaks_file_path(local_data, &song.id) else { return false };

    if peaks_stored_lock().get(&path) == Some(&hash) && path.is_file() {
        return true;
    }

    let tracks: BTreeMap<&str, &[f32]> = song
        .tracks
        .iter()
        .filter_map(|t| t.peaks.as_deref().filter(|p| !p.is_empty()).map(|p| (t.id.as_str(), p)))
        .collect();
    let result = serde_json::to_vec(&PeaksFileOut { version: 1, tracks })
        .map_err(|e| e.to_string())
        .and_then(|bytes| {
            fs::create_dir_all(path.parent().unwrap_or(local_data)).map_err(|e| e.to_string())?;
            write_atomic(&path, &bytes).map_err(|e| e.to_string())
        });
    match result {
        Ok(()) => {
            peaks_stored_lock().insert(path, hash);
            true
        }
        Err(e) => {
            tracing::warn!(
                "[Library] No se pudieron guardar los picos de '{}' en {}: {e}. Se conservan dentro de library.json.",
                song.id,
                path.display()
            );
            false
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedTrackPeaks {
    track_id: String,
    #[serde(default)]
    peaks: Vec<f32>,
}

/// Picos que guarda la caché PCM de una canción (`pcm/<canción>/<frecuencia>/<pista>.json`), por ID de pista. Es la
/// fuente de respaldo cuando la canción aún no tiene `peaks/<canción>.json`: una canción recién importada y añadida
/// al setlist tiene caché pero ningún archivo de picos (este solo se escribía cuando la interfaz guardaba picos, y la
/// interfaz no los recibía al terminar la caché), así que su onda salía plana. Si hay varias frecuencias, manda la más
/// reciente. Solo se lee lo que falta: son muchos archivos pequeños y el disco puede ser lento.
fn peaks_from_pcm_cache(local_data: &Path, song_id: &str) -> HashMap<String, Vec<f32>> {
    // El ID es un nombre de carpeta: sin separadores ni «..» no puede salir de `pcm`.
    if song_id.is_empty() || song_id.chars().any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))) {
        return HashMap::new();
    }
    let song_dir = local_data.join("pcm").join(song_id);
    let Ok(rates) = fs::read_dir(&song_dir) else { return HashMap::new() };
    let mut rate_dirs: Vec<(std::time::SystemTime, PathBuf)> = rates
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.path()))
        .collect();
    rate_dirs.sort_by(|a, b| b.0.cmp(&a.0));
    let mut found: HashMap<String, Vec<f32>> = HashMap::new();
    for (_, dir) in rate_dirs {
        let Ok(files) = fs::read_dir(&dir) else { continue };
        for entry in files.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let meta = match fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|c| {
                serde_json::from_str::<CachedTrackPeaks>(&c).map_err(|e| e.to_string())
            }) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!("[Library] No se pudieron leer los picos de {}: {e}", path.display());
                    continue;
                }
            };
            if !meta.peaks.is_empty() {
                found.entry(meta.track_id).or_insert(meta.peaks);
            }
        }
    }
    found
}

/// Une a cada canción los picos guardados en `peaks/` (solo a las pistas que no los traen ya en `library.json`).
fn attach_song_peaks(local_data: &Path, song: &mut LibrarySong) {
    let Some(path) = peaks_file_path(local_data, &song.id) else { return };
    let lacks = |song: &LibrarySong| song.tracks.iter().any(|t| t.peaks.as_ref().map_or(true, |p| p.is_empty()));
    if !lacks(song) {
        return;
    }
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<PeaksFileIn>(&content) {
            Ok(file) => {
                for track in &mut song.tracks {
                    if track.peaks.as_ref().map_or(true, |p| p.is_empty()) {
                        if let Some(peaks) = file.tracks.get(&track.id) {
                            track.peaks = Some(peaks.clone());
                        }
                    }
                }
                if let Some(hash) = peaks_hash(song) {
                    peaks_stored_lock().insert(path, hash);
                }
            }
            Err(e) => {
                tracing::warn!("[Library] {} no es válido: {e}. Los picos se regenerarán con la caché.", path.display());
                peaks_stored_lock().remove(&path);
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            tracing::warn!("[Library] No se pudo leer {}: {e}. Los picos se regenerarán con la caché.", path.display());
        }
    }
    // Lo que aún falta (canción nueva sin archivo de picos, o pistas añadidas después) sale de la caché PCM.
    if lacks(song) {
        let cached = peaks_from_pcm_cache(local_data, &song.id);
        for track in &mut song.tracks {
            if track.peaks.as_ref().map_or(true, |p| p.is_empty()) {
                if let Some(peaks) = cached.get(&track.id) {
                    track.peaks = Some(peaks.clone());
                }
            }
        }
    }
}

/// Borra el archivo de picos de una canción (al eliminarla de la biblioteca).
fn remove_song_peaks(local_data: &Path, song_id: &str) {
    if let Some(path) = peaks_file_path(local_data, song_id) {
        peaks_stored_lock().remove(&path);
        if let Err(e) = fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("[Library] No se pudo borrar {}: {e}", path.display());
            }
        }
    }
}

/// Copia de la biblioteca para escribir en `library.json`: sin los picos que ya están a salvo en `peaks/`.
fn library_for_disk(local_data: &Path, library: &LibraryFile) -> LibraryFile {
    let mut slim = library.clone();
    for song in &mut slim.songs {
        if store_song_peaks(local_data, song) {
            for track in &mut song.tracks {
                track.peaks = None;
            }
        }
    }
    slim
}

/// Biblioteca para la interfaz: los picos de `peaks/` se unen **solo a las canciones del setlist** (sus fichas
/// dibujan una mini onda antes de abrir la canción). El resto sale sin picos: al abrir una canción el motor devuelve
/// los suyos desde la caché PCM, y al añadir una al setlist la interfaz los pide con `library_get_song_peaks`.
/// Una biblioteca anterior, con los picos dentro, se migra sola: se reescribe ligera y con su carpeta `peaks/`.
pub fn load_library_for_ui(local_data: &Path) -> Result<LibraryFile, String> {
    let mut lib = load_library_internal(local_data)?;
    let legacy = lib
        .songs
        .iter()
        .any(|s| s.tracks.iter().any(|t| t.peaks.as_ref().map_or(false, |p| !p.is_empty())));
    if legacy {
        match save_library_internal(local_data, &lib) {
            Ok(()) => tracing::info!("[Library] library.json migrado: los picos de forma de onda pasaron a {PEAKS_DIRNAME}/"),
            Err(e) => tracing::warn!("[Library] No se pudo migrar library.json a la versión ligera: {e}"),
        }
    }
    let active: std::collections::HashSet<String> = lib.active_setlist.iter().cloned().collect();
    for song in &mut lib.songs {
        // Mismo criterio que la interfaz: el marcador de la canción manda y, sin él, la lista del setlist activo.
        let in_setlist = song.in_setlist.unwrap_or_else(|| active.contains(&song.id));
        if in_setlist {
            attach_song_peaks(local_data, song);
        } else {
            for track in &mut song.tracks {
                track.peaks = None;
            }
        }
    }
    Ok(lib)
}

/// Picos guardados de una canción, por ID de pista. Vacío si la canción aún no tiene archivo de picos.
pub fn read_song_peaks(local_data: &Path, song_id: &str) -> Result<HashMap<String, Vec<f32>>, String> {
    let Some(path) = peaks_file_path(local_data, song_id) else { return Ok(HashMap::new()) };
    let mut peaks = match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<PeaksFileIn>(&content)
            .map(|f| f.tracks)
            .map_err(|e| format!("{} no es válido: {e}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(e) => return Err(format!("No se pudo leer {}: {e}", path.display())),
    };
    // Las pistas sin picos guardados salen de la caché PCM (canción recién importada o con pistas nuevas).
    for (track_id, track_peaks) in peaks_from_pcm_cache(local_data, song_id) {
        peaks.entry(track_id).or_insert(track_peaks);
    }
    Ok(peaks)
}

/// Loads library.json from the app local data dir, **sin** picos (los de las canciones se guardan en `peaks/`).
/// If absent, creates an initial empty library.json.
/// If corrupted, falls back to library.backup.json.
pub fn load_library_internal(local_data: &Path) -> Result<LibraryFile, String> {
    if !local_data.exists() {
        fs::create_dir_all(local_data)
            .map_err(|e| format!("Error creando carpeta local data: {e}"))?;
    }

    let lib_path = local_data.join(LIBRARY_FILENAME);
    let backup_path = local_data.join(LIBRARY_BACKUP_FILENAME);

    if !lib_path.exists() {
        if backup_path.exists() {
            if let Ok(content) = fs::read_to_string(&backup_path) {
                if let Ok((lib, _)) = parse_library_lenient(&content) {
                    tracing::warn!("[Library] library.json ausente; restaurado desde backup");
                    let _ = save_library_internal(local_data, &lib);
                    return Ok(lib);
                }
            }
        }
        let initial = LibraryFile::default();
        save_library_internal(local_data, &initial)?;
        return Ok(initial);
    }

    match fs::read_to_string(&lib_path) {
        Ok(content) => match parse_library_lenient(&content) {
            Ok((lib, has_trailing)) => {
                if has_trailing {
                    tracing::warn!(
                        "[Library] library.json tenía caracteres sobrantes al final; se ignoran y se reescribe limpio"
                    );
                    let _ = save_library_internal(local_data, &lib);
                }
                Ok(lib)
            }
            Err(parse_err) => {
                tracing::error!(
                    "[Library] Error parseando {}: {}. Intentando backup...",
                    lib_path.display(),
                    parse_err
                );
                if backup_path.exists() {
                    if let Ok(backup_content) = fs::read_to_string(&backup_path) {
                        if let Ok((lib, _)) = parse_library_lenient(&backup_content) {
                            tracing::warn!("[Library] Recuperado exitosamente desde backup");
                            return Ok(lib);
                        }
                    }
                }
                Err(format!(
                    "Archivo library.json corrupto y sin backup válido: {parse_err}"
                ))
            }
        },
        Err(e) => Err(format!("Error leyendo {}: {e}", lib_path.display())),
    }
}

/// Saves library.json atomically using a temporary file and keeping a backup of the previous version.
pub fn save_library_internal(local_data: &Path, library: &LibraryFile) -> Result<(), String> {
    if !local_data.exists() {
        fs::create_dir_all(local_data)
            .map_err(|e| format!("Error creando carpeta local data: {e}"))?;
    }

    let lib_path = local_data.join(LIBRARY_FILENAME);
    let backup_path = local_data.join(LIBRARY_BACKUP_FILENAME);
    let tmp_path = local_data.join(unique_tmp_name(LIBRARY_TMP_FILENAME));

    let json_str = serde_json::to_string_pretty(&library_for_disk(local_data, library))
        .map_err(|e| format!("Error serializando library.json: {e}"))?;

    // 1. Write to tmp file
    if let Err(e) = fs::write(&tmp_path, json_str.as_bytes()) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Error escribiendo en {}: {e}", tmp_path.display()));
    }

    // 2. Si hay un library.json válido, se copia como respaldo antes de reemplazarlo. Uno corrupto no pisa un
    //    respaldo bueno. El respaldo también se escribe en un temporal y se renombra: copiar directo sobre él y
    //    quedar a medias dejaría sin copia buena justo cuando hiciera falta. Si no se puede refrescar, el guardado
    //    sigue (lo nuevo importa más) y queda avisado en el registro.
    if lib_path.exists() {
        let current_is_valid = fs::read_to_string(&lib_path)
            .map(|s| parse_library_lenient(&s).map(|(_, trailing)| !trailing).unwrap_or(false))
            .unwrap_or(false);
        if current_is_valid {
            let backup_tmp = local_data.join(unique_tmp_name(LIBRARY_BACKUP_FILENAME));
            match fs::copy(&lib_path, &backup_tmp) {
                Ok(_) => {
                    if let Err(e) = replace_file_atomic(&backup_tmp, &backup_path) {
                        tracing::warn!("[Library] No se pudo refrescar library.backup.json: {e}");
                    }
                }
                Err(e) => {
                    let _ = fs::remove_file(&backup_tmp);
                    tracing::warn!("[Library] No se pudo copiar el respaldo de library.json: {e}");
                }
            }
        }
    }

    // 3. Reemplazo atómico de library.json. Sin plan B de escritura directa: si no se logra, el library.json anterior
    //    queda intacto y el error llega a quien guarda.
    replace_file_atomic(&tmp_path, &lib_path).map_err(|e| format!("Error guardando library.json: {e}"))
}

/// La sonoridad la mide el motor, no la interfaz: si esta guarda la canción sin ella (aún no se había enterado de la
/// medida), se conserva la que ya estaba guardada.
fn preserve_loudness(incoming: &mut LibrarySong, stored: Option<&LibrarySong>) {
    if incoming.loudness.is_none() {
        incoming.loudness = stored.and_then(|s| s.loudness.clone());
    }
}

/// Una canción de la biblioteca (sin picos), o `None` si no existe.
pub fn read_song(local_data: &Path, song_id: &str) -> Result<Option<LibrarySong>, String> {
    let _guard = lock_library();
    Ok(load_library_internal(local_data)?.songs.into_iter().find(|s| s.id == song_id))
}

/// IDs de las canciones del setlist (marcador de la canción o, sin él, lista del setlist activo).
pub fn setlist_song_ids(local_data: &Path) -> Result<Vec<String>, String> {
    let _guard = lock_library();
    let lib = load_library_internal(local_data)?;
    Ok(lib
        .songs
        .iter()
        .filter(|s| s.in_setlist.unwrap_or_else(|| lib.active_setlist.contains(&s.id)))
        .map(|s| s.id.clone())
        .collect())
}

/// Guarda (o borra) la sonoridad de una canción sin tocar nada más de ella (ni su fecha de modificación: «Recientes»
/// no debe cambiar porque el motor haya medido). `false` si la canción ya no está.
pub fn set_song_loudness(local_data: &Path, song_id: &str, loudness: Option<SongLoudness>) -> Result<bool, String> {
    let _guard = lock_library();
    let mut lib = load_library_internal(local_data)?;
    let Some(song) = lib.songs.iter_mut().find(|s| s.id == song_id) else { return Ok(false) };
    song.loudness = loudness;
    save_library_internal(local_data, &lib)?;
    Ok(true)
}

// ---- Setlist: pertenencia y orden
//
// Quitar, vaciar y reordenar cambian solo dos datos de cada canción (si está en el setlist y en qué posición) y la
// lista `active_setlist`. Se hacen aquí, leyendo la biblioteca del disco y escribiéndola bajo el mismo cerrojo: la
// interfaz ya no manda una copia completa (que podía estar desactualizada y pisar un guardado posterior de otra
// canción, un volumen o la sonoridad que mide el motor) ni reescribe cada canción para cambiar su número de orden.
// No tocan `updated_at` de las canciones: mover una ficha no es modificarla (afectaría a «Recientes»).

/// ¿Está la canción en el setlist? El marcador de la canción manda y, sin él, la lista del setlist activo.
fn is_in_setlist(lib: &LibraryFile, song: &LibrarySong) -> bool {
    song.in_setlist.unwrap_or_else(|| lib.active_setlist.contains(&song.id))
}

/// Ids de las canciones del setlist en su orden actual (por `setlist_order`; las que no lo traen, al final y en el
/// orden de la lista del setlist activo y, después, de la biblioteca).
fn setlist_ids_in_order(lib: &LibraryFile) -> Vec<String> {
    // Clave: `setlist_order`, posición en `active_setlist` y posición en la biblioteca (la sort es estable).
    let mut ids: Vec<(usize, usize, String)> = lib
        .songs
        .iter()
        .filter(|s| is_in_setlist(lib, s))
        .map(|s| {
            let activo = lib.active_setlist.iter().position(|a| a == &s.id).unwrap_or(usize::MAX);
            (s.setlist_order.unwrap_or(usize::MAX), activo, s.id.clone())
        })
        .collect();
    ids.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    ids.into_iter().map(|(_, _, id)| id).collect()
}

/// Escribe un orden (0, 1, 2…) en las canciones del setlist y deja `active_setlist` igual a ese orden.
fn apply_setlist_order(lib: &mut LibraryFile, ordered: &[String]) {
    for (pos, id) in ordered.iter().enumerate() {
        if let Some(song) = lib.songs.iter_mut().find(|s| &s.id == id) {
            song.in_setlist = Some(true);
            song.setlist_order = Some(pos);
        }
    }
    lib.active_setlist = ordered.to_vec();
}

/// Saca una canción del setlist (sigue en la biblioteca). `false` si ya no estaba.
pub fn setlist_remove(local_data: &Path, song_id: &str) -> Result<bool, String> {
    let _guard = lock_library();
    let mut lib = load_library_internal(local_data)?;
    let antes = lib.clone();
    let mut resto = setlist_ids_in_order(&lib);
    let estaba = resto.iter().any(|id| id == song_id) || lib.active_setlist.iter().any(|id| id == song_id);
    resto.retain(|id| id != song_id);
    if let Some(song) = lib.songs.iter_mut().find(|s| s.id == song_id) {
        song.in_setlist = Some(false);
        song.setlist_order = None;
    }
    apply_setlist_order(&mut lib, &resto);
    if lib != antes {
        lib.updated_at = current_timestamp_ms();
        save_library_internal(local_data, &lib)?;
    }
    Ok(estaba)
}

/// Saca todas las canciones del setlist. Devuelve cuántas estaban.
pub fn setlist_clear(local_data: &Path) -> Result<usize, String> {
    let _guard = lock_library();
    let mut lib = load_library_internal(local_data)?;
    let estaban = setlist_ids_in_order(&lib);
    for song in lib.songs.iter_mut() {
        if estaban.contains(&song.id) {
            song.in_setlist = Some(false);
            song.setlist_order = None;
        }
    }
    lib.active_setlist.clear();
    if !estaban.is_empty() {
        lib.updated_at = current_timestamp_ms();
        save_library_internal(local_data, &lib)?;
    }
    Ok(estaban.len())
}

/// Reordena el setlist. `ordered` es el orden pedido: se ignoran los ids repetidos, los que no existen y los que no
/// están en el setlist (reordenar no añade canciones); las del setlist que no aparezcan quedan después, en su orden.
pub fn setlist_reorder(local_data: &Path, ordered: &[String]) -> Result<(), String> {
    let _guard = lock_library();
    let mut lib = load_library_internal(local_data)?;
    let actuales = setlist_ids_in_order(&lib);
    let mut nuevo: Vec<String> = Vec::with_capacity(actuales.len());
    for id in ordered {
        if actuales.contains(id) && !nuevo.contains(id) {
            nuevo.push(id.clone());
        }
    }
    for id in &actuales {
        if !nuevo.contains(id) {
            nuevo.push(id.clone());
        }
    }
    let antes = lib.clone();
    apply_setlist_order(&mut lib, &nuevo);
    if lib == antes {
        return Ok(());
    }
    lib.updated_at = current_timestamp_ms();
    save_library_internal(local_data, &lib)
}

// ==========================================
// TAURI COMMANDS
// ==========================================

#[tauri::command]
pub async fn library_load(app: AppHandle) -> Result<LibraryFile, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;
    let _guard = lock_library();
    load_library_for_ui(&local_data)
}

/// Picos de forma de onda de una canción (ID de pista -> picos). La interfaz los pide al añadirla al setlist.
#[tauri::command]
pub async fn library_get_song_peaks(app: AppHandle, song_id: String) -> Result<HashMap<String, Vec<f32>>, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;
    let _guard = lock_library();
    read_song_peaks(&local_data, &song_id)
}

#[tauri::command]
pub async fn library_save_song(app: AppHandle, song: LibrarySong) -> Result<SaveSongOutcome, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;
    save_song_internal(&local_data, song)
}

/// Resultado de guardar una canción. Si falla el guardado en `library.json`, es un error del comando. Que no se
/// pueda escribir el sidecar de su carpeta no impide guardarla (la biblioteca manda), pero se informa aquí para que la
/// interfaz avise: la mezcla no quedó en la carpeta de la canción.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveSongOutcome {
    pub sidecar_error: Option<String>,
}

/// Guarda la canción en `library.json` y su sidecar. Separado del comando para poder probarlo sin la aplicación.
pub fn save_song_internal(local_data: &Path, song: LibrarySong) -> Result<SaveSongOutcome, String> {
    let local_data = local_data.to_path_buf();
    {
        // Leer, modificar y escribir como una sola operación: dos guardados a la vez no se pisan.
        let _guard = lock_library();
        let mut lib = load_library_internal(&local_data)?;
        // La sonoridad la mide el motor: si la interfaz guarda la canción sin ella (aún no se había enterado), se conserva.
        let mut stored = song.clone();
        if let Some(idx) = lib.songs.iter().position(|s| s.id == song.id) {
            preserve_loudness(&mut stored, Some(&lib.songs[idx]));
            lib.songs[idx] = stored;
        } else {
            lib.songs.push(stored);
        }

        if let Some(in_set) = song.in_setlist {
            if in_set {
                if !lib.active_setlist.contains(&song.id) {
                    lib.active_setlist.push(song.id.clone());
                }
            } else {
                lib.active_setlist.retain(|id| id != &song.id);
            }
        }

        lib.updated_at = current_timestamp_ms();
        save_library_internal(&local_data, &lib)?;
    }

    // El sidecar va a la carpeta de la canción (si tiene): un fallo no deshace el guardado de la biblioteca, pero sale
    // en el resultado para que la interfaz lo muestre.
    let mut outcome = SaveSongOutcome::default();
    if let Some(ref folder) = song.folder_path {
        if let Err(e) = write_sidecar(Path::new(folder), &song) {
            tracing::warn!("[Sidecar] '{}': {e}", song.id);
            outcome.sidecar_error = Some(e);
        }
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn library_delete_song(
    app: AppHandle,
    state: State<'_, AudioEngineState>,
    song_id: String,
) -> Result<(), String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    crate::audio::cache::validate_path_id(&song_id)?;
    // La caché va a desaparecer: lo que se estuviera midiendo ya no vale.
    state.loudness.cancel(&song_id);

    // 1. Remove from library.json
    {
        let _guard = lock_library();
        let mut lib = load_library_internal(&local_data)?;
        lib.songs.retain(|s| s.id != song_id);
        lib.active_setlist.retain(|id| id != &song_id);
        lib.updated_at = current_timestamp_ms();
        save_library_internal(&local_data, &lib)?;
        remove_song_peaks(&local_data, &song_id);
    }

    // 2. Unload from audio playback engine if currently loaded
    state.playback.unload_project_if_matches(&song_id).await;

    // 3. Delete native PCM cache folder pcm/<song_id>
    let pcm_dir = local_data.join("pcm").join(&song_id);
    if pcm_dir.exists() {
        // La canción ya no está en la biblioteca: si la caché no se puede borrar (archivo abierto, antivirus) se
        // devuelve el error para que la interfaz avise, en lugar de dejar la carpeta huérfana sin decir nada.
        fs::remove_dir_all(&pcm_dir)
            .map_err(|e| format!("La canción se quitó de la biblioteca, pero no se pudo borrar su caché ({}): {e}", pcm_dir.display()))?;
        tracing::info!("[Library] Caché PCM eliminada para '{}'", song_id);
    }

    // Original files are NEVER touched!
    tracing::info!("[Library] Canción '{}' eliminada de la biblioteca", song_id);
    Ok(())
}

/// Quita una canción del setlist (sigue en la biblioteca). Devuelve si estaba en él.
#[tauri::command]
pub async fn library_setlist_remove(app: AppHandle, song_id: String) -> Result<bool, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;
    setlist_remove(&local_data, &song_id)
}

/// Vacía el setlist (las canciones siguen en la biblioteca). Devuelve cuántas había.
#[tauri::command]
pub async fn library_setlist_clear(app: AppHandle) -> Result<usize, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;
    setlist_clear(&local_data)
}

/// Reordena el setlist según `song_ids` (no añade ni quita canciones).
#[tauri::command]
pub async fn library_setlist_reorder(app: AppHandle, song_ids: Vec<String>) -> Result<(), String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;
    setlist_reorder(&local_data, &song_ids)
}

#[tauri::command]
pub async fn library_update_song_folder(
    app: AppHandle,
    song_id: String,
    new_folder_path: String,
) -> Result<(), String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    let _guard = lock_library();
    let mut lib = load_library_internal(&local_data)?;
    if let Some(song) = lib.songs.iter_mut().find(|s| s.id == song_id) {
        song.folder_path = Some(new_folder_path);
        song.updated_at = current_timestamp_ms();
        save_library_internal(&local_data, &lib)?;
        Ok(())
    } else {
        Err(format!(
            "Canción con id '{}' no encontrada en la biblioteca",
            song_id
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CleanMetadata {
    pub title: String,
    pub artist: Option<String>,
    pub key: Option<String>,
    pub bpm: Option<f64>,
}

/// Inicio del separador (espacio, guion o guion bajo) que está justo antes de `idx`; si lo anterior es otra letra,
/// `idx`. Siempre cae en un límite de carácter, así que es seguro para `replace_range` con cualquier texto.
fn separator_start_before(s: &str, idx: usize) -> usize {
    match s[..idx].chars().next_back() {
        Some(c) if c == '-' || c == '_' || c.is_whitespace() => idx - c.len_utf8(),
        _ => idx,
    }
}

pub fn clean_song_title_and_metadata(raw: &str) -> CleanMetadata {
    if raw.is_empty() {
        return CleanMetadata {
            title: "Nueva Sesión".to_string(),
            artist: None,
            key: None,
            bpm: None,
        };
    }

    let mut text = raw.trim();
    if let Some(dot_idx) = text.rfind('.') {
        if dot_idx > 0 && text.len() - dot_idx <= 5 {
            text = &text[..dot_idx];
        }
    }
    let mut s = text.to_string();

    // 1. Tuning 440hz. Todas las búsquedas por posición usan minúsculas ASCII (`to_ascii_lowercase`): conservan la
    // longitud en bytes, así que un índice hallado ahí vale sobre `s`. Con `to_lowercase` (Unicode) algunas letras
    // (p. ej. «İ») cambian de tamaño y el índice caía fuera o dentro de otra letra: pánico (plan 3.5, AG H16).
    let lower_s = s.to_ascii_lowercase();
    if let Some(idx) = lower_s.find("440hz") {
        let start = separator_start_before(&s, idx);
        let end = (idx + 5).min(s.len());
        s.replace_range(start..end, " ");
    } else if let Some(idx) = lower_s.find("440 hz") {
        let start = separator_start_before(&s, idx);
        let end = (idx + 6).min(s.len());
        s.replace_range(start..end, " ");
    }

    // 2. BPM detection
    let mut detected_bpm = None;
    let words: Vec<&str> = s
        .split(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .filter(|w| !w.is_empty())
        .collect();
    for w in &words {
        let lw = w.to_lowercase();
        if lw.ends_with("bpm") {
            let num_part = &lw[..lw.len() - 3];
            if let Ok(b) = num_part.parse::<f64>() {
                if (40.0..=260.0).contains(&b) {
                    detected_bpm = Some(b);
                }
            }
        }
    }

    // 3. Key detection
    let mut detected_key = None;
    let s_lower = s.to_lowercase();
    for root in &[
        "c#", "eb", "f#", "ab", "bb", "db", "gb", "c", "d", "e", "f", "g", "a", "b",
    ] {
        let maj_pat = format!("{root} major");
        let min_pat = format!("{root} minor");
        let m_pat = format!("{root}m");
        if s_lower.contains(&maj_pat) {
            let r_cap = root.to_uppercase();
            detected_key = Some(format!("{r_cap} Major"));
            break;
        } else if s_lower.contains(&min_pat) || s_lower.contains(&m_pat) {
            let r_cap = root.to_uppercase();
            detected_key = Some(format!("{r_cap} Minor"));
            break;
        }
    }

    // Attached key+bpm like Bb124
    if detected_bpm.is_none() || detected_key.is_none() {
        for w in &words {
            for root in &[
                "Bb", "C#", "Eb", "F#", "Ab", "Db", "Gb", "C", "D", "E", "F", "G", "A", "B",
            ] {
                if w.to_ascii_lowercase().starts_with(&root.to_ascii_lowercase()) {
                    let Some(remainder) = w.get(root.len()..) else { continue };
                    if let Ok(b) = remainder.parse::<f64>() {
                        if (40.0..=260.0).contains(&b) {
                            if detected_bpm.is_none() {
                                detected_bpm = Some(b);
                            }
                            if detected_key.is_none() {
                                detected_key = Some(root.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // Extract title if enclosed in underscores like _ERES BENDITO_
    let mut enclosed_title = None;
    if let (Some(first_u), Some(last_u)) = (s.find('_'), s.rfind('_')) {
        if first_u < last_u && last_u - first_u > 2 {
            let candidate = s[first_u + 1..last_u].trim();
            if !candidate.is_empty() {
                enclosed_title = Some(candidate.to_string());
                s.replace_range(first_u..=last_u, " ");
            }
        }
    }

    // Remove filler words
    for filler in &[
        "multitrack",
        "original",
        "mt",
        "stems",
        "stem",
        "secuencias",
        "secuencia",
        "sequence",
    ] {
        let mut cur = s.to_ascii_lowercase();
        while let Some(idx) = cur.find(filler) {
            s.replace_range(idx..idx + filler.len(), " ");
            cur = s.to_ascii_lowercase();
        }
    }

    // Clean remaining key & bpm from s
    if let Some(ref k) = detected_key {
        let k_low = k.to_ascii_lowercase();
        if let Some(idx) = s.to_ascii_lowercase().find(&k_low) {
            s.replace_range(idx..idx + k_low.len(), " ");
        }
        for root in &[
            "bb", "c#", "eb", "f#", "ab", "c", "d", "e", "f", "g", "a", "b",
        ] {
            let maj_str = format!("{root} major");
            if let Some(idx) = s.to_ascii_lowercase().find(&maj_str) {
                s.replace_range(idx..idx + maj_str.len(), " ");
            }
        }
    }

    if let Some(b) = detected_bpm {
        let b_str = format!("{}bpm", b as u32);
        if let Some(idx) = s.to_ascii_lowercase().find(&b_str) {
            s.replace_range(idx..idx + b_str.len(), " ");
        }
        let b_plain = format!("{}", b as u32);
        if let Some(idx) = s.find(&b_plain) {
            s.replace_range(idx..idx + b_plain.len(), " ");
        }
    }

    let mut title = String::new();
    let mut artist = None;

    if let Some(enc) = enclosed_title {
        title = enc;
        let art = s
            .trim_matches(|c: char| c == '-' || c == '_' || c.is_whitespace())
            .trim();
        if !art.is_empty() {
            artist = Some(art.to_string());
        }
    } else if s.contains(" - ") {
        let parts: Vec<&str> = s
            .split(" - ")
            .map(|p| p.trim_matches(|c: char| c == '-' || c == '_' || c.is_whitespace()).trim())
            .filter(|p| !p.is_empty())
            .collect();
        if !parts.is_empty() {
            title = parts[0].to_string();
        }
        if parts.len() > 1 {
            artist = Some(parts[1].to_string());
        }
    } else if s.contains('-') {
        let parts: Vec<&str> = s
            .split('-')
            .map(|p| p.trim_matches(|c: char| c == '-' || c == '_' || c.is_whitespace()).trim())
            .filter(|p| !p.is_empty())
            .collect();
        if !parts.is_empty() {
            title = parts[0].to_string();
        }
        if parts.len() > 1 {
            artist = Some(parts[1].to_string());
        }
    } else {
        title = s
            .trim_matches(|c: char| c == '-' || c == '_' || c.is_whitespace())
            .to_string();
    }

    // Title case if ALL UPPERCASE
    if !title.is_empty() && title == title.to_uppercase() && title.len() > 2 {
        title = title
            .split_whitespace()
            .map(|word| {
                let mut chars = word.chars();
                match chars.next() {
                    None => String::new(),
                    Some(first) => {
                        first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                    }
                }
            })
            .collect::<Vec<String>>()
            .join(" ");
    }

    CleanMetadata {
        title: title.trim().to_string(),
        artist,
        key: detected_key,
        bpm: detected_bpm,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plan 3.5 (AG H16): nombres de archivo con letras no ASCII no deben provocar un pánico al limpiar el título.
    /// Antes se buscaba en `to_lowercase()` y el índice se usaba sobre el texto original (la minúscula de algunas
    /// letras mide otros bytes), y el recorte previo a «440hz» podía caer dentro de una letra con tilde.
    #[test]
    fn test_limpiar_titulo_con_texto_no_ascii_no_entra_en_panico() {
        let entradas = [
            "é440hz",
            "Canción440hz",
            "Señor 440 hz",
            "ñ440 hz.wav",
            "İİİ 100bpm",
            "İSTANBUL - Güzel 120bpm 440hz",
            "ÁÉÍÓÚ Bb124 - Él",
            "_ÉL ES BENDITO_ Ñandú 98bpm",
            "Alabaré a mi Señor multitrack 72bpm",
            "日本語の曲 440hz 90bpm",
            "🎵 Gloria 440hz",
            "ẞ stems C# minor 85bpm",
            "K 440hz",
        ];
        for entrada in entradas {
            let limpio = clean_song_title_and_metadata(entrada);
            assert!(!limpio.title.is_empty() || entrada.trim().is_empty(), "«{entrada}» dejó el título vacío");
        }
        // Y lo que se detecta sigue siendo lo mismo con letras no ASCII delante.
        assert_eq!(clean_song_title_and_metadata("İİİ 100bpm").bpm, Some(100.0));
        assert_eq!(clean_song_title_and_metadata("Canción Ñandú 98bpm").bpm, Some(98.0));
        assert_eq!(clean_song_title_and_metadata("Canción 440hz").title, "Canción");
    }

    #[test]
    fn test_library_save_and_load_roundtrip() {
        let tmp_dir = std::env::temp_dir().join(format!("omnitracks_test_lib_{}", current_timestamp_ms()));
        let _ = fs::create_dir_all(&tmp_dir);

        let mut lib = LibraryFile::default();
        lib.songs.push(LibrarySong {
            id: "song-123".to_string(),
            title: "Eres Bendito".to_string(),
            artist: "Jaime Murrell".to_string(),
            bpm: 108.0,
            key_signature: "G Major".to_string(),
            updated_at: current_timestamp_ms(),
            ..Default::default()
        });
        lib.active_setlist.push("song-123".to_string());

        assert!(save_library_internal(&tmp_dir, &lib).is_ok());

        let loaded = load_library_internal(&tmp_dir).expect("Debe cargar library.json");
        assert_eq!(loaded.songs.len(), 1);
        assert_eq!(loaded.songs[0].title, "Eres Bendito");
        assert_eq!(loaded.active_setlist, vec!["song-123"]);

        // Cleanup
        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_atomic_write_and_backup() {
        let tmp_dir = std::env::temp_dir().join(format!("omnitracks_test_atomic_{}", current_timestamp_ms()));
        let _ = fs::create_dir_all(&tmp_dir);

        let mut lib1 = LibraryFile::default();
        lib1.songs.push(LibrarySong {
            id: "v1".to_string(),
            title: "Version 1".to_string(),
            artist: "Artist".to_string(),
            bpm: 120.0,
            key_signature: "C Major".to_string(),
            updated_at: 1000,
            ..Default::default()
        });
        save_library_internal(&tmp_dir, &lib1).unwrap();

        let mut lib2 = lib1.clone();
        lib2.songs[0].title = "Version 2".to_string();
        save_library_internal(&tmp_dir, &lib2).unwrap();

        // Verify backup exists with version 1
        let backup_path = tmp_dir.join(LIBRARY_BACKUP_FILENAME);
        assert!(backup_path.exists());
        let backup_str = fs::read_to_string(&backup_path).unwrap();
        assert!(backup_str.contains("Version 1"));

        // Verify active file has version 2
        let current = load_library_internal(&tmp_dir).unwrap();
        assert_eq!(current.songs[0].title, "Version 2");

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    fn song(id: &str, title: &str) -> LibrarySong {
        LibrarySong {
            id: id.to_string(),
            title: title.to_string(),
            artist: "A".to_string(),
            bpm: 120.0,
            key_signature: "C Major".to_string(),
            updated_at: 1,
            ..Default::default()
        }
    }

    #[test]
    fn test_library_con_basura_al_final_se_recupera_y_se_reescribe_limpia() {
        let dir = std::env::temp_dir().join(format!("omnitracks_test_basura_{}", current_timestamp_ms()));
        let _ = fs::create_dir_all(&dir);
        let mut lib = LibraryFile::default();
        lib.songs.push(song("a", "Una"));
        lib.songs.push(song("b", "Dos"));
        let json = serde_json::to_string_pretty(&lib).unwrap();
        // El fallo real: un JSON válido seguido de un trozo del contenido anterior («]\n}»).
        fs::write(dir.join(LIBRARY_FILENAME), format!("{json}]\n}}")).unwrap();
        fs::write(dir.join(LIBRARY_BACKUP_FILENAME), format!("{json}]\n}}")).unwrap();

        let loaded = load_library_internal(&dir).expect("debe recuperar las canciones sin perderlas");
        assert_eq!(loaded.songs.len(), 2);
        assert_eq!(loaded.songs[1].title, "Dos");
        // Se reescribió limpio: ya no hay nada tras el JSON.
        let on_disk = fs::read_to_string(dir.join(LIBRARY_FILENAME)).unwrap();
        assert!(serde_json::from_str::<LibraryFile>(&on_disk).is_ok(), "library.json debe quedar como JSON estricto");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_un_library_corrupto_no_pisa_el_respaldo_bueno() {
        let dir = std::env::temp_dir().join(format!("omnitracks_test_respaldo_{}", current_timestamp_ms()));
        let _ = fs::create_dir_all(&dir);
        let mut good = LibraryFile::default();
        good.songs.push(song("a", "Buena"));
        save_library_internal(&dir, &good).unwrap();
        save_library_internal(&dir, &good).unwrap(); // ahora existe el respaldo con «Buena»
        // El principal queda ilegible (ni siquiera un JSON).
        fs::write(dir.join(LIBRARY_FILENAME), "{ esto no es json").unwrap();
        let mut next = good.clone();
        next.songs[0].title = "Nueva".to_string();
        save_library_internal(&dir, &next).unwrap();
        let backup = fs::read_to_string(dir.join(LIBRARY_BACKUP_FILENAME)).unwrap();
        assert!(backup.contains("Buena"), "el respaldo bueno no debe sustituirse por el archivo corrupto");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_guardados_simultaneos_no_corrompen_ni_pierden_canciones() {
        let dir = std::env::temp_dir().join(format!("omnitracks_test_concurrente_{}", current_timestamp_ms()));
        let _ = fs::create_dir_all(&dir);
        save_library_internal(&dir, &LibraryFile::default()).unwrap();
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        // Misma operación que `library_save_song`: leer, modificar y escribir bajo el cerrojo.
                        let _guard = lock_library();
                        let mut lib = load_library_internal(&dir).expect("la biblioteca no debe corromperse");
                        let id = format!("t{t}-{i}");
                        lib.songs.push(song(&id, &id));
                        save_library_internal(&dir, &lib).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let final_lib = load_library_internal(&dir).expect("el archivo final debe ser válido");
        assert_eq!(final_lib.songs.len(), 8 * 25, "ningún guardado simultáneo debe perder su canción");
        let on_disk = fs::read_to_string(dir.join(LIBRARY_FILENAME)).unwrap();
        assert!(serde_json::from_str::<LibraryFile>(&on_disk).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- Setlist por comandos de Rust (plan 4.1)

    fn en_setlist(id: &str, titulo: &str, orden: usize) -> LibrarySong {
        let mut s = song(id, titulo);
        s.in_setlist = Some(true);
        s.setlist_order = Some(orden);
        s
    }

    /// a, b y c en el setlist (en ese orden) y «fuera» solo en la biblioteca. «b» lleva sonoridad y volumen master.
    fn biblioteca_con_setlist(dir: &Path) -> LibraryFile {
        let mut lib = LibraryFile::default();
        lib.songs = vec![en_setlist("a", "Una", 0), en_setlist("b", "Dos", 1), en_setlist("c", "Tres", 2), song("fuera", "Fuera")];
        lib.songs[1].loudness = Some(sonoridad(-14.0));
        lib.songs[1].master_gain = Some(0.5);
        lib.active_setlist = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        save_library_internal(dir, &lib).unwrap();
        lib
    }

    fn orden_del_setlist(dir: &Path) -> Vec<String> {
        setlist_ids_in_order(&load_library_internal(dir).unwrap())
    }

    #[test]
    fn test_quitar_del_setlist_solo_cambia_la_pertenencia_y_no_pisa_otros_guardados() {
        let dir = carpeta_de_prueba("setlist_quitar");
        let inicial = biblioteca_con_setlist(&dir);
        // Otro guardado posterior a lo que la interfaz tenía cargado (el fallo de H05: la interfaz mandaba su copia
        // completa y esta edición se perdía).
        let mut despues = inicial.clone();
        despues.songs[2].title = "Tres (editada)".to_string();
        despues.songs[2].master_gain = Some(0.8);
        save_library_internal(&dir, &despues).unwrap();

        assert!(setlist_remove(&dir, "a").unwrap());

        let lib = load_library_internal(&dir).unwrap();
        assert_eq!(lib.songs.len(), 4, "quitar del setlist no borra de la biblioteca");
        let a = lib.songs.iter().find(|s| s.id == "a").unwrap();
        assert_eq!(a.in_setlist, Some(false));
        assert_eq!(a.setlist_order, None);
        assert_eq!(a.title, "Una", "lo demás de la canción quitada sigue igual");
        assert_eq!(lib.active_setlist, vec!["b".to_string(), "c".to_string()]);
        assert_eq!(orden_del_setlist(&dir), vec!["b".to_string(), "c".to_string()]);
        // Las que quedan conservan todo lo suyo, incluido lo guardado después y lo que mide el motor.
        let c = lib.songs.iter().find(|s| s.id == "c").unwrap();
        assert_eq!(c.title, "Tres (editada)");
        assert_eq!(c.master_gain, Some(0.8));
        let b = lib.songs.iter().find(|s| s.id == "b").unwrap();
        assert_eq!(b.loudness, Some(sonoridad(-14.0)));
        assert_eq!(b.master_gain, Some(0.5));
        assert!(lib.songs.iter().all(|s| s.updated_at == 1), "mover fichas no cambia la fecha de modificación de las canciones");
        assert_eq!(lib.songs.iter().find(|s| s.id == "fuera").unwrap(), &song("fuera", "Fuera"), "la que no estaba en el setlist no se toca");
        // Quitar una que ya no está avisa y no cambia nada.
        assert!(!setlist_remove(&dir, "a").unwrap());
        assert!(!setlist_remove(&dir, "no-existe").unwrap());
        assert_eq!(load_library_internal(&dir).unwrap().songs, lib.songs);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_quitar_del_setlist_una_cancion_de_biblioteca_antigua_sin_marcador() {
        let dir = carpeta_de_prueba("setlist_sin_marcador");
        let mut lib = LibraryFile::default();
        // Biblioteca anterior: sin `inSetlist` en las canciones, solo la lista del setlist activo.
        lib.songs = vec![song("a", "Una"), song("b", "Dos")];
        lib.active_setlist = vec!["a".to_string(), "b".to_string()];
        save_library_internal(&dir, &lib).unwrap();
        assert_eq!(setlist_song_ids(&dir).unwrap().len(), 2);

        assert!(setlist_remove(&dir, "a").unwrap());
        assert_eq!(setlist_song_ids(&dir).unwrap(), vec!["b".to_string()], "«a» no debe volver a aparecer en el setlist");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_vaciar_el_setlist_deja_las_canciones_en_la_biblioteca() {
        let dir = carpeta_de_prueba("setlist_vaciar");
        let inicial = biblioteca_con_setlist(&dir);
        assert_eq!(setlist_clear(&dir).unwrap(), 3);

        let lib = load_library_internal(&dir).unwrap();
        assert_eq!(lib.songs.len(), 4);
        assert!(lib.active_setlist.is_empty());
        assert!(setlist_song_ids(&dir).unwrap().is_empty());
        for s in &lib.songs {
            assert_ne!(s.in_setlist, Some(true), "{} no debe seguir en el setlist", s.id);
            assert_eq!(s.setlist_order, None);
        }
        let b = lib.songs.iter().find(|s| s.id == "b").unwrap();
        assert_eq!(b.loudness, inicial.songs[1].loudness, "la sonoridad medida no se pierde");
        assert_eq!(b.master_gain, Some(0.5));
        // Vaciar uno ya vacío no hace nada.
        assert_eq!(setlist_clear(&dir).unwrap(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_reordenar_el_setlist_ignora_lo_que_no_es_del_setlist_y_no_pierde_canciones() {
        let dir = carpeta_de_prueba("setlist_reordenar");
        let inicial = biblioteca_con_setlist(&dir);
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        // Orden completo, con un id repetido, uno que no existe y otro que no está en el setlist.
        setlist_reorder(&dir, &ids(&["c", "a", "b", "no-existe", "c", "fuera"])).unwrap();
        assert_eq!(orden_del_setlist(&dir), ids(&["c", "a", "b"]));
        let lib = load_library_internal(&dir).unwrap();
        assert_eq!(lib.active_setlist, ids(&["c", "a", "b"]));
        for (pos, id) in ["c", "a", "b"].iter().enumerate() {
            assert_eq!(lib.songs.iter().find(|s| s.id == *id).unwrap().setlist_order, Some(pos));
        }
        let fuera = lib.songs.iter().find(|s| s.id == "fuera").unwrap();
        assert_ne!(fuera.in_setlist, Some(true), "reordenar no añade canciones al setlist");
        assert_eq!(lib.songs.len(), 4);
        assert!(lib.songs.iter().all(|s| s.updated_at == 1));
        // Solo cambió el orden: lo demás de cada canción es idéntico.
        for s in &lib.songs {
            let mut igual = s.clone();
            let original = inicial.songs.iter().find(|o| o.id == s.id).unwrap();
            igual.setlist_order = original.setlist_order;
            assert_eq!(&igual, original, "{} solo debe cambiar de posición", s.id);
        }

        // Un orden parcial deja el resto después, en el orden que ya tenían.
        setlist_reorder(&dir, &ids(&["b"])).unwrap();
        assert_eq!(orden_del_setlist(&dir), ids(&["b", "c", "a"]));
        // Un orden vacío no cambia nada.
        setlist_reorder(&dir, &[]).unwrap();
        assert_eq!(orden_del_setlist(&dir), ids(&["b", "c", "a"]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_cambios_del_setlist_y_guardados_de_canciones_a_la_vez_no_pierden_nada() {
        let dir = carpeta_de_prueba("setlist_concurrente");
        biblioteca_con_setlist(&dir);
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mut handles = Vec::new();
        for t in 0..4 {
            let dir = dir.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..20 {
                    // Lo que hace `library_save_song` al guardar una canción nueva.
                    let _guard = lock_library();
                    let mut lib = load_library_internal(&dir).expect("la biblioteca no debe corromperse");
                    lib.songs.push(song(&format!("n{t}-{i}"), "Nueva"));
                    save_library_internal(&dir, &lib).unwrap();
                }
            }));
        }
        for t in 0..4 {
            let dir = dir.clone();
            let orden = if t % 2 == 0 { ids(&["c", "b", "a"]) } else { ids(&["a", "c", "b"]) };
            handles.push(std::thread::spawn(move || {
                for _ in 0..20 {
                    setlist_reorder(&dir, &orden).unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let lib = load_library_internal(&dir).expect("el archivo final debe ser válido");
        assert_eq!(lib.songs.len(), 4 + 4 * 20, "reordenar no debe perder canciones guardadas a la vez");
        let mut en_set = orden_del_setlist(&dir);
        en_set.sort();
        assert_eq!(en_set, ids(&["a", "b", "c"]));
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- Escritura segura de library.json, su respaldo y el sidecar (plan 4.2)

    fn sin_temporales(dir: &Path) -> bool {
        fs::read_dir(dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp"))
    }

    /// Abre el archivo como lo haría un antivirus o un indexador: otros pueden leerlo y escribirlo, pero no
    /// renombrarlo ni borrarlo (sin FILE_SHARE_DELETE).
    #[cfg(windows)]
    fn abrir_sin_compartir_borrado(path: &Path) -> fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new().read(true).share_mode(1 | 2).open(path).unwrap()
    }

    fn biblioteca_con_titulo(titulo: &str) -> LibraryFile {
        let mut lib = LibraryFile::default();
        lib.songs.push(song("a", titulo));
        lib
    }

    #[cfg(windows)]
    #[test]
    fn test_si_no_se_puede_reemplazar_library_json_no_se_escribe_directo_sobre_el_archivo() {
        let dir = carpeta_de_prueba("reemplazo_bloqueado");
        save_library_internal(&dir, &biblioteca_con_titulo("Version 1")).unwrap();
        let bloqueo = abrir_sin_compartir_borrado(&dir.join(LIBRARY_FILENAME));

        // Con el archivo abierto sin permitir renombrarlo, el reemplazo no es posible. Antes caía a `fs::write`
        // directo sobre library.json (que Windows sí permite): una escritura interrumpida lo habría dejado truncado.
        let resultado = save_library_internal(&dir, &biblioteca_con_titulo("Version 2"));
        assert!(resultado.is_err(), "sin poder reemplazar, el guardado debe avisar del error");
        let contenido = fs::read_to_string(dir.join(LIBRARY_FILENAME)).unwrap();
        assert!(contenido.contains("Version 1") && !contenido.contains("Version 2"), "el archivo anterior queda intacto");
        assert!(sin_temporales(&dir), "no debe quedar el temporal del intento fallido");

        // Liberado el archivo, el siguiente guardado funciona.
        drop(bloqueo);
        save_library_internal(&dir, &biblioteca_con_titulo("Version 2")).unwrap();
        assert!(fs::read_to_string(dir.join(LIBRARY_FILENAME)).unwrap().contains("Version 2"));
        assert!(sin_temporales(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn test_un_bloqueo_pasajero_del_archivo_se_reintenta_y_el_guardado_sale() {
        let dir = carpeta_de_prueba("reemplazo_pasajero");
        save_library_internal(&dir, &biblioteca_con_titulo("Version 1")).unwrap();
        let bloqueo = abrir_sin_compartir_borrado(&dir.join(LIBRARY_FILENAME));
        // Como un antivirus que suelta el archivo a los pocos milisegundos.
        let liberador = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(40));
            drop(bloqueo);
        });
        save_library_internal(&dir, &biblioteca_con_titulo("Version 2")).expect("debe reintentar hasta que se libere");
        liberador.join().unwrap();
        assert!(fs::read_to_string(dir.join(LIBRARY_FILENAME)).unwrap().contains("Version 2"));
        assert!(sin_temporales(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn test_el_respaldo_no_se_copia_directo_sobre_el_anterior() {
        let dir = carpeta_de_prueba("respaldo_bloqueado");
        save_library_internal(&dir, &biblioteca_con_titulo("Version 1")).unwrap();
        save_library_internal(&dir, &biblioteca_con_titulo("Version 2")).unwrap(); // respaldo = «Version 1»
        let bloqueo = abrir_sin_compartir_borrado(&dir.join(LIBRARY_BACKUP_FILENAME));

        // Lo nuevo se guarda aunque el respaldo no se pueda refrescar...
        save_library_internal(&dir, &biblioteca_con_titulo("Version 3")).expect("el guardado no depende del respaldo");
        assert!(fs::read_to_string(dir.join(LIBRARY_FILENAME)).unwrap().contains("Version 3"));
        // ...y el respaldo, que no se pudo reemplazar, no se sobrescribió a medias: sigue siendo el anterior completo.
        let respaldo = fs::read_to_string(dir.join(LIBRARY_BACKUP_FILENAME)).unwrap();
        assert!(respaldo.contains("Version 1") && !respaldo.contains("Version 2"), "{respaldo}");
        assert!(parse_library_lenient(&respaldo).is_ok());
        drop(bloqueo);
        assert!(sin_temporales(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_un_sidecar_que_no_se_puede_escribir_devuelve_el_error_y_no_deja_temporales() {
        let carpeta = carpeta_de_prueba("sidecar_error");
        // Una carpeta donde el sidecar no se puede crear: en su sitio hay una carpeta con ese nombre.
        fs::create_dir(carpeta.join(SIDECAR_CANONICAL_FILENAME)).unwrap();
        let cancion = song("a", "Una");
        let error = write_sidecar(&carpeta, &cancion).expect_err("no se pudo escribir: debe decirlo, no devolver Ok");
        assert!(error.contains(SIDECAR_CANONICAL_FILENAME), "{error}");
        assert!(sin_temporales(&carpeta));

        // Carpeta que no existe (disco desconectado, carpeta movida).
        assert!(write_sidecar(&carpeta.join("no-existe"), &cancion).is_err());

        // Con la carpeta en buen estado se escribe, completo y sin temporales.
        let buena = carpeta_de_prueba("sidecar_bueno");
        write_sidecar(&buena, &cancion).unwrap();
        let escrito = fs::read_to_string(buena.join(SIDECAR_CANONICAL_FILENAME)).unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&escrito).is_ok());
        assert!(sin_temporales(&buena));
        let _ = fs::remove_dir_all(&carpeta);
        let _ = fs::remove_dir_all(&buena);
    }

    #[test]
    fn test_guardar_una_cancion_informa_si_su_sidecar_no_se_pudo_escribir_y_la_biblioteca_si_se_guarda() {
        let datos = carpeta_de_prueba("guardar_cancion_datos");
        let carpeta_mala = carpeta_de_prueba("guardar_cancion_mala");
        fs::create_dir(carpeta_mala.join(SIDECAR_CANONICAL_FILENAME)).unwrap();
        let carpeta_buena = carpeta_de_prueba("guardar_cancion_buena");

        let mut con_carpeta_mala = song("a", "Una");
        con_carpeta_mala.folder_path = Some(carpeta_mala.to_string_lossy().to_string());
        let resultado = save_song_internal(&datos, con_carpeta_mala).expect("la biblioteca sí se guarda");
        assert!(resultado.sidecar_error.is_some(), "el fallo del sidecar debe salir en el resultado");
        assert_eq!(read_song(&datos, "a").unwrap().unwrap().title, "Una", "y la canción quedó en la biblioteca");

        let mut con_carpeta_buena = song("b", "Dos");
        con_carpeta_buena.folder_path = Some(carpeta_buena.to_string_lossy().to_string());
        assert_eq!(save_song_internal(&datos, con_carpeta_buena).unwrap(), SaveSongOutcome::default());
        assert!(carpeta_buena.join(SIDECAR_CANONICAL_FILENAME).is_file());

        // Sin carpeta (importada por archivos): no hay sidecar que escribir ni error que avisar.
        assert_eq!(save_song_internal(&datos, song("c", "Tres")).unwrap(), SaveSongOutcome::default());
        // El resultado llega a la interfaz con este nombre.
        let json = serde_json::to_string(&SaveSongOutcome { sidecar_error: Some("x".into()) }).unwrap();
        assert_eq!(json, "{\"sidecarError\":\"x\"}");
        let _ = fs::remove_dir_all(&datos);
        let _ = fs::remove_dir_all(&carpeta_mala);
        let _ = fs::remove_dir_all(&carpeta_buena);
    }

    // ---- Sonoridad medida por el motor

    fn sonoridad(lufs: f64) -> SongLoudness {
        SongLoudness {
            integrated_lufs: Some(lufs),
            loudness_range_lu: Some(5.0),
            true_peak_dbtp: Some(-1.0),
            sample_peak_dbfs: Some(-1.2),
            duration_sec: 200.0,
            tracks_measured: 8,
            signature: "v1:48000:abc".to_string(),
            reference_version: 1,
            analyzed_at: 1,
        }
    }

    #[test]
    fn un_guardado_sin_sonoridad_conserva_la_que_ya_estaba_y_uno_con_sonoridad_la_sustituye() {
        let mut guardada = LibrarySong { id: "s".to_string(), ..Default::default() };
        guardada.loudness = Some(sonoridad(-14.0));

        let mut sin = LibrarySong { id: "s".to_string(), title: "Nuevo título".to_string(), ..Default::default() };
        preserve_loudness(&mut sin, Some(&guardada));
        assert_eq!(sin.loudness, Some(sonoridad(-14.0)), "la interfaz no sabía de la medida: no se pierde");
        assert_eq!(sin.title, "Nuevo título", "lo demás es lo que mandó la interfaz");

        let mut con = LibrarySong { id: "s".to_string(), loudness: Some(sonoridad(-9.0)), ..Default::default() };
        preserve_loudness(&mut con, Some(&guardada));
        assert_eq!(con.loudness, Some(sonoridad(-9.0)), "si trae medida, manda la suya");

        let mut nueva = LibrarySong::default();
        preserve_loudness(&mut nueva, None);
        assert!(nueva.loudness.is_none(), "una canción nueva sin medida sigue sin ella");
    }

    #[test]
    fn la_sonoridad_se_guarda_en_la_biblioteca_sin_tocar_el_resto_y_el_sidecar_no_la_lleva() {
        let dir = carpeta_de_prueba("sonoridad");
        let song = LibrarySong { id: "s".to_string(), title: "Canción".to_string(), updated_at: 777, in_setlist: Some(true), ..Default::default() };
        let otra = LibrarySong { id: "o".to_string(), title: "Otra".to_string(), updated_at: 5, ..Default::default() };
        save_library_internal(&dir, &LibraryFile { songs: vec![song.clone(), otra], ..Default::default() }).unwrap();

        assert!(set_song_loudness(&dir, "s", Some(sonoridad(-12.5))).unwrap());
        assert!(!set_song_loudness(&dir, "no-existe", Some(sonoridad(-1.0))).unwrap(), "una canción que ya no está se avisa, no se inventa");

        let leida = read_song(&dir, "s").unwrap().unwrap();
        assert_eq!(leida.loudness, Some(sonoridad(-12.5)));
        assert_eq!(leida.updated_at, 777, "medir no cambia la fecha de modificación («Recientes»)");
        assert_eq!(leida.title, "Canción");
        assert!(read_song(&dir, "o").unwrap().unwrap().loudness.is_none());
        assert_eq!(setlist_song_ids(&dir).unwrap(), vec!["s".to_string()]);

        // La interfaz recibe los nombres en camelCase y el sidecar de la carpeta no lleva el dato derivado.
        let json = serde_json::to_string(&leida).unwrap();
        assert!(json.contains("\"integratedLufs\":-12.5") && json.contains("\"truePeakDbtp\""), "{json}");
        assert!(!sidecar_json(&leida).unwrap().contains("loudness"), "el sidecar solo lleva configuración");

        set_song_loudness(&dir, "s", None).unwrap();
        assert!(read_song(&dir, "s").unwrap().unwrap().loudness.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- Picos de forma de onda fuera de library.json

    fn carpeta_de_prueba(nombre: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(unique_tmp_name(&format!("omnitracks_picos_{nombre}")));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Canción con 320 picos por pista. `en_setlist`: marcador de la canción (la interfaz solo recibe los picos de
    /// las del setlist).
    fn cancion_con_picos(id: &str, pistas: &[&str], base: f32, en_setlist: bool) -> LibrarySong {
        LibrarySong {
            id: id.to_string(),
            title: format!("Canción {id}"),
            in_setlist: Some(en_setlist),
            tracks: pistas
                .iter()
                .enumerate()
                .map(|(n, pista)| LibraryTrack {
                    id: pista.to_string(),
                    name: pista.to_string(),
                    peaks: Some((0..320).map(|i| base + (i as f32 / 1000.0) + n as f32 / 100.0).collect()),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    fn biblioteca_con(songs: Vec<LibrarySong>) -> LibraryFile {
        LibraryFile { songs, ..Default::default() }
    }

    fn sin_picos(song: &LibrarySong) -> LibrarySong {
        let mut s = song.clone();
        for t in &mut s.tracks {
            t.peaks = None;
        }
        s
    }

    /// Meta de una pista en la caché PCM (`pcm/<canción>/<frecuencia>/<pista>.json`), con los campos que importan.
    fn escribir_meta_de_cache(dir: &Path, song_id: &str, rate: u32, track_id: &str, peaks: &[f32]) {
        let carpeta = dir.join("pcm").join(song_id).join(rate.to_string());
        fs::create_dir_all(&carpeta).unwrap();
        let meta = serde_json::json!({ "formatVersion": 1, "trackId": track_id, "targetSampleRate": rate, "peaks": peaks });
        fs::write(carpeta.join(format!("{track_id}.json")), meta.to_string()).unwrap();
    }

    /// Una canción recién importada y añadida al setlist tiene caché PCM pero aún ningún `peaks/<id>.json` (los
    /// picos solo llegaban a ese archivo cuando la interfaz los guardaba, y la interfaz no los recibía al terminar la
    /// caché): su onda quedaba plana. La caché guarda los picos de cada pista y es la fuente de respaldo.
    #[test]
    fn test_los_picos_de_una_cancion_sin_archivo_de_picos_salen_de_la_cache_pcm() {
        let dir = carpeta_de_prueba("picos_de_la_cache");
        let mut nueva = cancion_con_picos("song-n", &["a", "b"], 0.0, true);
        for t in &mut nueva.tracks {
            t.peaks = None;
        }
        save_library_internal(&dir, &biblioteca_con(vec![nueva])).unwrap();
        assert!(!dir.join(PEAKS_DIRNAME).join("song-n.json").exists(), "no hay archivo de picos");
        assert!(read_song_peaks(&dir, "song-n").unwrap().is_empty(), "y tampoco caché todavía");

        let pico_a: Vec<f32> = (0..320).map(|i| 0.2 + i as f32 / 1000.0).collect();
        let pico_b: Vec<f32> = (0..320).map(|i| 0.5 + i as f32 / 2000.0).collect();
        escribir_meta_de_cache(&dir, "song-n", 44100, "a", &pico_a);
        escribir_meta_de_cache(&dir, "song-n", 44100, "b", &pico_b);

        let leidos = read_song_peaks(&dir, "song-n").unwrap();
        assert_eq!(leidos.get("a"), Some(&pico_a), "library_get_song_peaks devuelve los de la caché");
        assert_eq!(leidos.get("b"), Some(&pico_b));

        // Al abrir la app, la ficha de una canción del setlist ya sale con su onda.
        let ui = load_library_for_ui(&dir).unwrap();
        assert_eq!(ui.songs[0].tracks[0].peaks.as_ref(), Some(&pico_a));
        assert_eq!(ui.songs[0].tracks[1].peaks.as_ref(), Some(&pico_b));

        // Un nombre de canción con rutas no sale de la carpeta `pcm`.
        assert!(read_song_peaks(&dir, "..").unwrap().is_empty());
        assert!(read_song_peaks(&dir, "..\\x").unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_los_picos_van_a_su_archivo_y_la_interfaz_recibe_solo_los_del_setlist() {
        let dir = carpeta_de_prueba("ida_y_vuelta");
        let en_set = cancion_con_picos("song-1", &["a", "b"], 0.1, true);
        let fuera = cancion_con_picos("song-2", &["a"], 0.2, false);
        let lib = biblioteca_con(vec![en_set.clone(), fuera.clone()]);
        save_library_internal(&dir, &lib).unwrap();

        let en_disco = fs::read_to_string(dir.join(LIBRARY_FILENAME)).unwrap();
        assert!(!en_disco.contains("peaks"), "library.json no debe llevar picos");
        let con_picos = serde_json::to_string_pretty(&lib).unwrap().lines().count();
        assert!(
            en_disco.lines().count() * 5 < con_picos,
            "library.json debe ser mucho más ligero: {} líneas frente a {con_picos}",
            en_disco.lines().count()
        );
        assert!(dir.join(PEAKS_DIRNAME).join("song-1.json").is_file());
        assert!(dir.join(PEAKS_DIRNAME).join("song-2.json").is_file());
        // La biblioteca en memoria conserva sus picos.
        assert_eq!(lib.songs[0].tracks[0].peaks.as_ref().map(Vec::len), Some(320));

        // La carga «cruda» (la de los guardados) no trae picos de nadie.
        let cruda = load_library_internal(&dir).unwrap();
        assert_eq!(cruda.songs, vec![sin_picos(&en_set), sin_picos(&fuera)]);

        // La de la interfaz trae los de la canción del setlist y deja sin picos la otra.
        let para_ui = load_library_for_ui(&dir).unwrap();
        assert_eq!(para_ui.songs[0], en_set, "la del setlist vuelve con todos sus picos");
        assert_eq!(para_ui.songs[1], sin_picos(&fuera), "la que no está en el setlist sale sin picos");

        // Y sus picos se pueden pedir cuando se añade al setlist.
        let pedidos = read_song_peaks(&dir, "song-2").unwrap();
        assert_eq!(pedidos.len(), 1);
        assert_eq!(pedidos["a"], fuera.tracks[0].peaks.clone().unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_sin_marcador_de_setlist_manda_la_lista_del_setlist_activo() {
        let dir = carpeta_de_prueba("lista_activa");
        let mut a = cancion_con_picos("song-a", &["x"], 0.1, true);
        let mut b = cancion_con_picos("song-b", &["x"], 0.2, true);
        a.in_setlist = None;
        b.in_setlist = None;
        let mut lib = biblioteca_con(vec![a.clone(), b.clone()]);
        lib.active_setlist = vec!["song-b".to_string()];
        save_library_internal(&dir, &lib).unwrap();

        let ui = load_library_for_ui(&dir).unwrap();
        assert!(ui.songs[0].tracks[0].peaks.is_none(), "song-a no está en la lista activa");
        assert_eq!(ui.songs[1].tracks[0].peaks, b.tracks[0].peaks, "song-b sí");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_guardar_desde_la_carga_cruda_no_borra_ni_toca_los_picos_de_otras_canciones() {
        let dir = carpeta_de_prueba("guardado_cruzado");
        let lib = biblioteca_con(vec![
            cancion_con_picos("song-1", &["a"], 0.1, true),
            cancion_con_picos("song-2", &["a"], 0.2, false),
        ]);
        save_library_internal(&dir, &lib).unwrap();
        let archivo2 = dir.join(PEAKS_DIRNAME).join("song-2.json");
        let antes = fs::read(&archivo2).unwrap();

        // Lo que hace library_save_song: carga cruda, cambia una canción (que llega sin picos) y guarda.
        let mut cruda = load_library_internal(&dir).unwrap();
        cruda.songs[0].title = "Cambiada".to_string();
        save_library_internal(&dir, &cruda).unwrap();

        assert_eq!(fs::read(&archivo2).unwrap(), antes, "el archivo de picos de la otra canción no cambió");
        assert!(dir.join(PEAKS_DIRNAME).join("song-1.json").is_file(), "ni se borró el de la canción guardada");
        let ui = load_library_for_ui(&dir).unwrap();
        assert_eq!(ui.songs[0].title, "Cambiada");
        assert_eq!(ui.songs[0].tracks[0].peaks, lib.songs[0].tracks[0].peaks, "sus picos siguen ahí");
        assert_eq!(read_song_peaks(&dir, "song-2").unwrap()["a"], lib.songs[1].tracks[0].peaks.clone().unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_una_biblioteca_antigua_con_picos_dentro_se_migra_sola() {
        let dir = carpeta_de_prueba("migracion");
        let en_set = cancion_con_picos("song-viejo", &["a", "b"], 0.3, true);
        let fuera = cancion_con_picos("song-fuera", &["a"], 0.4, false);
        let lib = biblioteca_con(vec![en_set.clone(), fuera.clone()]);
        // Formato anterior: todo en library.json, sin carpeta peaks.
        fs::write(dir.join(LIBRARY_FILENAME), serde_json::to_string_pretty(&lib).unwrap()).unwrap();
        assert!(!dir.join(PEAKS_DIRNAME).exists());

        let cargada = load_library_for_ui(&dir).unwrap();
        assert_eq!(cargada.songs[0], en_set, "la del setlist conserva sus picos");
        assert_eq!(cargada.songs[1], sin_picos(&fuera), "la otra no los trae a la interfaz");

        let en_disco = fs::read_to_string(dir.join(LIBRARY_FILENAME)).unwrap();
        assert!(!en_disco.contains("peaks"), "tras cargar, library.json queda ligero");
        assert!(dir.join(PEAKS_DIRNAME).join("song-viejo.json").is_file());
        assert!(dir.join(PEAKS_DIRNAME).join("song-fuera.json").is_file(), "los de la que no está en el setlist también se migran");
        assert_eq!(read_song_peaks(&dir, "song-fuera").unwrap()["a"], fuera.tracks[0].peaks.clone().unwrap());
        // El respaldo conserva la versión anterior completa, por si hiciera falta volver atrás.
        let respaldo = fs::read_to_string(dir.join(LIBRARY_BACKUP_FILENAME)).unwrap();
        assert!(respaldo.contains("peaks"));
        // Y una segunda carga sigue dando lo mismo.
        assert_eq!(load_library_for_ui(&dir).unwrap(), cargada);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_guardar_sin_cambiar_los_picos_no_reescribe_su_archivo_y_si_cambian_si() {
        let dir = carpeta_de_prueba("sin_cambios");
        let mut lib = biblioteca_con(vec![cancion_con_picos("song-1", &["a"], 0.1, true)]);
        save_library_internal(&dir, &lib).unwrap();

        // Se sustituye el archivo por una marca: si un guardado sin cambios lo reescribiera, la marca desaparecería.
        let archivo = dir.join(PEAKS_DIRNAME).join("song-1.json");
        fs::write(&archivo, "{\"marca\":true}").unwrap();
        lib.songs[0].title = "Otro título".to_string();
        save_library_internal(&dir, &lib).unwrap();
        assert_eq!(fs::read_to_string(&archivo).unwrap(), "{\"marca\":true}", "picos iguales: no se reescribe");

        // Si el archivo desaparece, el siguiente guardado lo recrea aunque los picos no hayan cambiado.
        fs::remove_file(&archivo).unwrap();
        save_library_internal(&dir, &lib).unwrap();
        assert!(archivo.is_file(), "archivo ausente: se vuelve a escribir");

        // Si cambian los picos, sí se reescribe.
        fs::write(&archivo, "{\"marca\":true}").unwrap();
        lib.songs[0].tracks[0].peaks.as_mut().unwrap()[0] = 0.99;
        save_library_internal(&dir, &lib).unwrap();
        assert_ne!(fs::read_to_string(&archivo).unwrap(), "{\"marca\":true}", "picos distintos: se reescribe");
        assert_eq!(load_library_for_ui(&dir).unwrap().songs[0].tracks[0].peaks.as_ref().unwrap()[0], 0.99);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_si_no_se_pueden_guardar_los_picos_se_conservan_dentro_de_library_json() {
        let dir = carpeta_de_prueba("sin_carpeta");
        // `peaks` es un archivo: no se puede crear la carpeta con ese nombre.
        fs::write(dir.join(PEAKS_DIRNAME), "no soy una carpeta").unwrap();
        let lib = biblioteca_con(vec![cancion_con_picos("song-1", &["a"], 0.1, true)]);

        save_library_internal(&dir, &lib).expect("el guardado no debe fallar por los picos");
        let en_disco = fs::read_to_string(dir.join(LIBRARY_FILENAME)).unwrap();
        assert!(en_disco.contains("peaks"), "sin dónde guardarlos, los picos se quedan en library.json");
        assert_eq!(load_library_for_ui(&dir).unwrap(), lib, "no se pierde nada");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_un_archivo_de_picos_corrupto_no_impide_cargar_y_borrar_la_cancion_lo_quita() {
        let dir = carpeta_de_prueba("corrupto");
        let lib = biblioteca_con(vec![cancion_con_picos("song-1", &["a"], 0.1, true)]);
        save_library_internal(&dir, &lib).unwrap();
        let archivo = dir.join(PEAKS_DIRNAME).join("song-1.json");

        fs::write(&archivo, "{ esto no es json").unwrap();
        let cargada = load_library_for_ui(&dir).unwrap();
        assert_eq!(cargada.songs.len(), 1, "la canción se carga igual");
        assert!(cargada.songs[0].tracks[0].peaks.is_none(), "sin picos hasta que la caché los regenere");
        assert!(read_song_peaks(&dir, "song-1").is_err(), "pedirlos explícitamente sí avisa del archivo dañado");
        assert!(read_song_peaks(&dir, "song-que-no-existe").unwrap().is_empty());

        remove_song_peaks(&dir, "song-1");
        assert!(!archivo.exists(), "al eliminar la canción se borra su archivo de picos");
        // Un ID raro no puede salir de la carpeta peaks.
        let ruta = peaks_file_path(&dir, "../../fuera").unwrap();
        assert!(ruta.starts_with(dir.join(PEAKS_DIRNAME)), "{ruta:?}");
        assert!(peaks_file_path(&dir, "..").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_el_sidecar_no_lleva_picos_y_uno_antiguo_con_picos_se_lee() {
        let pista = |id: &str| LibraryTrack {
            id: id.to_string(),
            name: id.to_string(),
            peaks: Some((0..320).map(|i| i as f32 / 320.0).collect()),
            ..Default::default()
        };
        let song = LibrarySong {
            id: "s1".to_string(),
            title: "Prueba".to_string(),
            tracks: vec![pista("a"), pista("b")],
            ..Default::default()
        };

        let json = sidecar_json(&song).unwrap();
        assert!(!json.contains("peaks"), "el sidecar no debe llevar picos ni `peaks: null`");
        let con_picos = serde_json::to_string_pretty(&song).unwrap().lines().count();
        assert!(
            json.lines().count() * 5 < con_picos,
            "sin picos el sidecar debe ser mucho más corto: {} líneas frente a {con_picos}",
            json.lines().count()
        );
        // La canción original no se toca: la biblioteca conserva sus picos.
        assert_eq!(song.tracks[0].peaks.as_ref().map(Vec::len), Some(320));

        // El sidecar nuevo se lee, con los picos vacíos.
        let nuevo: LibrarySong = serde_json::from_str(&json).unwrap();
        assert_eq!(nuevo.tracks.len(), 2);
        assert!(nuevo.tracks.iter().all(|t| t.peaks.is_none()));
        assert_eq!(nuevo.tracks[1].id, "b");

        // Un sidecar antiguo (con picos) sigue leyéndose.
        let antiguo = serde_json::to_string_pretty(&song).unwrap();
        assert!(antiguo.contains("peaks"));
        let leido: LibrarySong = serde_json::from_str(&antiguo).unwrap();
        assert_eq!(leido.tracks[0].peaks.as_ref().map(Vec::len), Some(320));
    }

    #[test]
    fn test_sidecar_find_canonical_and_fallback() {
        let tmp_dir = std::env::temp_dir().join(format!("omnitracks_test_sidecar_{}", current_timestamp_ms()));
        let _ = fs::create_dir_all(&tmp_dir);

        // Neither exists
        assert!(find_sidecar_path(&tmp_dir).is_none());

        // Create fallback
        let fallback_file = tmp_dir.join(SIDECAR_FALLBACK_FILENAME);
        fs::write(&fallback_file, "{}").unwrap();
        assert_eq!(find_sidecar_path(&tmp_dir), Some(fallback_file.clone()));

        // Create canonical
        let canonical_file = tmp_dir.join(SIDECAR_CANONICAL_FILENAME);
        fs::write(&canonical_file, "{}").unwrap();
        assert_eq!(find_sidecar_path(&tmp_dir), Some(canonical_file));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_clean_song_title_and_metadata() {
        // Caso 1: Multitrack _ERES BENDITO_ ORIGINAL Jaime Murrel-G major-108bpm-440hz
        let c1 = clean_song_title_and_metadata("Multitrack _ERES BENDITO_ ORIGINAL Jaime Murrel-G major-108bpm-440hz");
        assert_eq!(c1.title, "Eres Bendito");
        assert_eq!(c1.artist.as_deref(), Some("Jaime Murrel"));
        assert_eq!(c1.key.as_deref(), Some("G Major"));
        assert_eq!(c1.bpm, Some(108.0));

        // Caso 2: Dios el mas grande - Juan Carlos A - MT
        let c2 = clean_song_title_and_metadata("Dios el mas grande - Juan Carlos A - MT");
        assert_eq!(c2.title, "Dios el mas grande");
        assert_eq!(c2.artist.as_deref(), Some("Juan Carlos A"));

        // Caso 3: Dios el mas grande - Juan Carlos A -Bb124
        let c3 = clean_song_title_and_metadata("Dios el mas grande - Juan Carlos A -Bb124");
        assert_eq!(c3.title, "Dios el mas grande");
        assert_eq!(c3.artist.as_deref(), Some("Juan Carlos A"));
        assert_eq!(c3.key.as_deref(), Some("Bb"));
        assert_eq!(c3.bpm, Some(124.0));
    }


    #[test]
    fn test_library_song_conserva_las_notas() {
        let tmp_dir = std::env::temp_dir().join(format!("omnitracks_notas_{}", current_timestamp_ms()));
        let _ = fs::create_dir_all(&tmp_dir);

        let mut lib = LibraryFile::default();
        lib.songs.push(LibrarySong {
            id: "song-notas".to_string(),
            title: "Friend of God".to_string(),
            artist: "Israel Houghton".to_string(),
            bpm: 120.0,
            key_signature: "C Major".to_string(),
            notes: Some("Entrar con el coro; subir medio tono en el puente".to_string()),
            transition_to_next: Some("stop".to_string()),
            updated_at: current_timestamp_ms(),
            ..Default::default()
        });
        assert!(save_library_internal(&tmp_dir, &lib).is_ok());

        let loaded = load_library_internal(&tmp_dir).unwrap();
        assert_eq!(
            loaded.songs[0].notes.as_deref(),
            Some("Entrar con el coro; subir medio tono en el puente")
        );
        assert_eq!(loaded.songs[0].transition_to_next.as_deref(), Some("stop"));

        // Una biblioteca guardada antes de existir el campo sigue cargando (notes = None).
        let json = r#"{"id":"vieja","title":"x","artist":"y","bpm":100.0,"keySignature":"C","updatedAt":1}"#;
        let old: LibrarySong = serde_json::from_str(json).unwrap();
        assert_eq!(old.notes, None);
        assert_eq!(old.transition_to_next, None);

        let _ = fs::remove_dir_all(tmp_dir);
    }
}
