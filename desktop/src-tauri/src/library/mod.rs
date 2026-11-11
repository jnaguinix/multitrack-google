use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::audio::output::AudioEngineState;

pub const SIDECAR_CANONICAL_FILENAME: &str = "omnitracks.project.json";
pub const SIDECAR_FALLBACK_FILENAME: &str = ".omnitracks.json";
pub const LIBRARY_FILENAME: &str = "library.json";
pub const LIBRARY_BACKUP_FILENAME: &str = "library.backup.json";
pub const LIBRARY_TMP_FILENAME: &str = "library.json.tmp";

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
    #[serde(default)]
    pub bus: Option<String>,
    #[serde(default)]
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
    #[serde(default)]
    pub pitch_semitones: Option<i32>,
    #[serde(default)]
    pub is_title_custom: Option<bool>,
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

/// Writes the canonical `omnitracks.project.json` sidecar directly into the song's directory.
/// Non-fatal if the directory is read-only.
pub fn write_sidecar(folder_path: &Path, song: &LibrarySong) -> Result<(), String> {
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err(format!("La carpeta '{}' no existe", folder_path.display()));
    }
    let target = folder_path.join(SIDECAR_CANONICAL_FILENAME);
    let json_str = serde_json::to_string_pretty(song)
        .map_err(|e| format!("Error serializando sidecar: {e}"))?;

    let tmp = folder_path.join("omnitracks.project.json.tmp");
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

/// Loads library.json from the app local data dir.
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
                if let Ok(lib) = serde_json::from_str::<LibraryFile>(&content) {
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
        Ok(content) => match serde_json::from_str::<LibraryFile>(&content) {
            Ok(lib) => Ok(lib),
            Err(parse_err) => {
                tracing::error!(
                    "[Library] Error parseando {}: {}. Intentando backup...",
                    lib_path.display(),
                    parse_err
                );
                if backup_path.exists() {
                    if let Ok(backup_content) = fs::read_to_string(&backup_path) {
                        if let Ok(lib) = serde_json::from_str::<LibraryFile>(&backup_content) {
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
    let tmp_path = local_data.join(LIBRARY_TMP_FILENAME);

    let json_str = serde_json::to_string_pretty(library)
        .map_err(|e| format!("Error serializando library.json: {e}"))?;

    // 1. Write to tmp file
    fs::write(&tmp_path, json_str.as_bytes())
        .map_err(|e| format!("Error escribiendo en {}: {e}", tmp_path.display()))?;

    // 2. If lib_path exists, backup before replacing
    if lib_path.exists() {
        let _ = fs::copy(&lib_path, &backup_path);
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
    load_library_internal(&local_data)
}

#[tauri::command]
pub async fn library_save(app: AppHandle, library: LibraryFile) -> Result<(), String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;
    save_library_internal(&local_data, &library)
}

#[tauri::command]
pub async fn library_save_song(app: AppHandle, song: LibrarySong) -> Result<(), String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Error resolviendo app_local_data_dir: {e}"))?;

    let mut lib = load_library_internal(&local_data)?;
    if let Some(idx) = lib.songs.iter().position(|s| s.id == song.id) {
        lib.songs[idx] = song.clone();
    } else {
        lib.songs.push(song.clone());
    }

    lib.updated_at = current_timestamp_ms();
    save_library_internal(&local_data, &lib)?;

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
    let mut lib = load_library_internal(&local_data)?;
    lib.songs.retain(|s| s.id != song_id);
    lib.active_setlist.retain(|id| id != &song_id);
    lib.updated_at = current_timestamp_ms();
    save_library_internal(&local_data, &lib)?;

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
}
