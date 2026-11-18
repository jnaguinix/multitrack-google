use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Manager, State};

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
    serde_json::to_string_pretty(&slim).map_err(|e| format!("Error serializando sidecar: {e}"))
}

/// Writes the canonical `omnitracks.project.json` sidecar directly into the song's directory.
/// Non-fatal if the directory is read-only.
pub fn write_sidecar(folder_path: &Path, song: &LibrarySong) -> Result<(), String> {
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err(format!("La carpeta '{}' no existe", folder_path.display()));
    }
    let target = folder_path.join(SIDECAR_CANONICAL_FILENAME);
    let json_str = sidecar_json(song)?;

    let tmp = folder_path.join(unique_tmp_name("omnitracks.project.json"));
    if let Err(e) = fs::write(&tmp, &json_str) {
        tracing::warn!(
            "[Sidecar] No se pudo escribir archivo temporal en '{}': {}",
            folder_path.display(),
            e
        );
        return Ok(());
    }

    if let Err(_e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        if let Err(write_err) = fs::write(&target, &json_str) {
            tracing::warn!(
                "[Sidecar] No se pudo escribir omnitracks.project.json en '{}': {}",
                folder_path.display(),
                write_err
            );
            return Ok(());
        }
    }

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

/// Une a cada canción los picos guardados en `peaks/` (solo a las pistas que no los traen ya en `library.json`).
fn attach_song_peaks(local_data: &Path, song: &mut LibrarySong) {
    let Some(path) = peaks_file_path(local_data, &song.id) else { return };
    let needs = song.tracks.iter().any(|t| t.peaks.as_ref().map_or(true, |p| p.is_empty()));
    if !needs {
        return;
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            tracing::warn!("[Library] No se pudo leer {}: {e}. Los picos se regenerarán con la caché.", path.display());
            return;
        }
    };
    let file: PeaksFileIn = match serde_json::from_str(&content) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("[Library] {} no es válido: {e}. Los picos se regenerarán con la caché.", path.display());
            peaks_stored_lock().remove(&path);
            return;
        }
    };
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
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("No se pudo leer {}: {e}", path.display())),
    };
    serde_json::from_str::<PeaksFileIn>(&content)
        .map(|f| f.tracks)
        .map_err(|e| format!("{} no es válido: {e}", path.display()))
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
    fs::write(&tmp_path, json_str.as_bytes())
        .map_err(|e| format!("Error escribiendo en {}: {e}", tmp_path.display()))?;

    // 2. Si hay un library.json válido, se copia como respaldo antes de reemplazarlo. Uno corrupto no pisa un
    //    respaldo bueno.
    if lib_path.exists() {
        let current_is_valid = fs::read_to_string(&lib_path)
            .map(|s| parse_library_lenient(&s).map(|(_, trailing)| !trailing).unwrap_or(false))
            .unwrap_or(false);
        if current_is_valid {
            let _ = fs::copy(&lib_path, &backup_path);
        }
    }

    // 3. Atomically replace lib_path
    if let Err(e) = fs::rename(&tmp_path, &lib_path) {
        // Fallback for Windows cross-volume or lock edge cases
        let _ = fs::remove_file(&tmp_path);
        fs::write(&lib_path, json_str.as_bytes())
            .map_err(|e2| format!("Error reemplazando {}: rename={e}, write={e2}", lib_path.display()))?;
    }

    Ok(())
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
pub async fn library_save(app: AppHandle, library: LibraryFile) -> Result<(), String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;
    let _guard = lock_library();
    save_library_internal(&local_data, &library)
}

#[tauri::command]
pub async fn library_save_song(app: AppHandle, song: LibrarySong) -> Result<(), String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    {
        // Leer, modificar y escribir como una sola operación: dos guardados a la vez no se pisan.
        let _guard = lock_library();
        let mut lib = load_library_internal(&local_data)?;
        if let Some(idx) = lib.songs.iter().position(|s| s.id == song.id) {
            lib.songs[idx] = song.clone();
        } else {
            lib.songs.push(song.clone());
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

    // Attempt sidecar write if folder path is available
    if let Some(ref folder) = song.folder_path {
        let p = Path::new(folder);
        if p.exists() && p.is_dir() {
            let _ = write_sidecar(p, &song);
        }
    }

    Ok(())
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
        let _ = fs::remove_dir_all(&pcm_dir);
        tracing::info!("[Library] Caché PCM eliminada para '{}'", song_id);
    }

    // Original files are NEVER touched!
    tracing::info!("[Library] Canción '{}' eliminada de la biblioteca", song_id);
    Ok(())
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

#[tauri::command]
pub async fn library_write_sidecar(
    folder_path: String,
    song: LibrarySong,
) -> Result<(), String> {
    let p = Path::new(&folder_path);
    write_sidecar(p, &song)
}

#[tauri::command]
pub async fn library_read_sidecar(
    folder_path: String,
) -> Result<Option<serde_json::Value>, String> {
    let p = Path::new(&folder_path);
    read_sidecar(p)
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CleanMetadata {
    pub title: String,
    pub artist: Option<String>,
    pub key: Option<String>,
    pub bpm: Option<f64>,
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

    // 1. Tuning 440hz
    let lower_s = s.to_lowercase();
    if let Some(idx) = lower_s.find("440hz") {
        let start = idx.saturating_sub(1);
        let end = (idx + 5).min(s.len());
        s.replace_range(start..end, " ");
    } else if let Some(idx) = lower_s.find("440 hz") {
        let start = idx.saturating_sub(1);
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
                if w.to_lowercase().starts_with(&root.to_lowercase()) {
                    let remainder = &w[root.len()..];
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
        let mut cur = s.to_lowercase();
        while let Some(idx) = cur.find(filler) {
            s.replace_range(idx..idx + filler.len(), " ");
            cur = s.to_lowercase();
        }
    }

    // Clean remaining key & bpm from s
    if let Some(ref k) = detected_key {
        let k_low = k.to_lowercase();
        if let Some(idx) = s.to_lowercase().find(&k_low) {
            s.replace_range(idx..idx + k_low.len(), " ");
        }
        for root in &[
            "bb", "c#", "eb", "f#", "ab", "c", "d", "e", "f", "g", "a", "b",
        ] {
            let maj_str = format!("{root} major");
            if let Some(idx) = s.to_lowercase().find(&maj_str) {
                s.replace_range(idx..idx + maj_str.len(), " ");
            }
        }
    }

    if let Some(b) = detected_bpm {
        let b_str = format!("{}bpm", b as u32);
        if let Some(idx) = s.to_lowercase().find(&b_str) {
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
