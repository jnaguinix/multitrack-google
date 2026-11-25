//! Gestión y reproducción en tiempo real de packs de pads en audio (12 notas C..B en bucle sin costuras).
//!
//! Los archivos originales (WAV, FLAC, MP3, OGG, M4A, AIF) se decodifican y convierten una sola vez al
//! importar el pack en `%LOCALAPPDATA%\org.omnitracks.desktop\pad_packs\<id>\note_00..11.pcm` (PCM i16 estéreo
//! sin costuras). Al tocar, solo la nota activa vive en memoria (`Arc<PadPackBuffer>`) y el callback la lee
//! sin asignar ni liberar memoria (las voces viejas se devuelven a `retired` para que otro hilo las libere).

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::f32::consts::FRAC_PI_2;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::audio::cache::validate_path_id;
use crate::audio::import::{decode_audio_file, resample_channels};
use crate::audio::output::effective_cache_rate;

/// Duración máxima de un bucle en disco/RAM (segundos) tras recortar entradas y colas comerciales.
const MAX_LOOP_SEC: usize = 45;
/// Si el audio supera esta duración (segundos) se recortan hasta `EDGE_SKIP_SEC` al inicio y al final.
const LONG_AUDIO_THRESHOLD_SEC: usize = 16;
const EDGE_SKIP_SEC: usize = 5;
/// Duración objetivo del empalme de igual potencia para que el bucle no tenga costuras.
const LOOP_XFADE_SEC: usize = 4;
/// Nivel RMS objetivo de cada nota importada (equilibrado con el sintetizador interno, bajo el limitador).
const TARGET_PACK_RMS: f32 = 0.14;
const MAX_PACK_PEAK: f32 = 0.78;
/// Tiempo de fundido cruzado en el callback al cambiar de nota o entrar/salir de un pack (segundos).
const SAMPLE_XFADE_SEC: f32 = 0.55;
/// Capacidad preasignada de la cola de búferes retirados: evita asignaciones y `drop` en el hilo de audio.
const RETIRED_CAP: usize = 64;

/// Metadatos de un pack de pads importado en disco.
/// Sin comas en estos comentarios: `scripts/verify-ipc.ts` analiza los campos de la struct.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PadPackInfo {
    pub id: String,
    pub name: String,
    pub source_folder: String,
    pub sample_rate: u32,
    pub available_notes: Vec<u8>,
    pub duration_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PadPacksIndex {
    version: u32,
    packs: Vec<PadPackInfo>,
}

fn packs_root(base_dir: &Path) -> PathBuf {
    base_dir.join("pad_packs")
}

fn packs_index_path(base_dir: &Path) -> PathBuf {
    packs_root(base_dir).join("packs.json")
}

fn pack_dir(base_dir: &Path, pack_id: &str) -> PathBuf {
    packs_root(base_dir).join(pack_id)
}

fn note_pcm_path(pack_path: &Path, note: u8) -> PathBuf {
    pack_path.join(format!("note_{:02}.pcm", note % 12))
}

fn write_atomic_bytes(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear '{}': {e}", parent.display()))?;
    }
    let tmp = target.with_extension(format!("tmp.{}", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| format!("No se pudo escribir '{}': {e}", tmp.display()))?;
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("No se pudo guardar '{}': {e}", target.display()));
    }
    Ok(())
}

fn load_packs_index(base_dir: &Path) -> Result<PadPacksIndex, String> {
    let path = packs_index_path(base_dir);
    if !path.exists() {
        return Ok(PadPacksIndex { version: 1, packs: Vec::new() });
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("No se pudo leer '{}': {e}", path.display()))?;
    serde_json::from_str::<PadPacksIndex>(&raw).map_err(|e| format!("Archivo packs.json dañado en '{}': {e}", path.display()))
}

fn save_packs_index(base_dir: &Path, index: &PadPacksIndex) -> Result<(), String> {
    let json = serde_json::to_string_pretty(index).map_err(|e| format!("Error serializando packs.json: {e}"))?;
    write_atomic_bytes(&packs_index_path(base_dir), json.as_bytes())
}

fn sanitize_pack_id(name: &str) -> String {
    let slug: String = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let compact: Vec<&str> = slug.split('-').filter(|s| !s.is_empty()).collect();
    let base = if compact.is_empty() { "pack".to_string() } else { compact.join("-") };
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("pack-{base}-{:x}", (ms & 0xffff_ffff) as u32)
}

fn is_ignored_word(word: &str) -> bool {
    matches!(
        word,
        "pad"
            | "pads"
            | "warm"
            | "ambient"
            | "shimmer"
            | "drone"
            | "drones"
            | "strings"
            | "string"
            | "worship"
            | "soft"
            | "bright"
            | "dark"
            | "deep"
            | "motion"
            | "swell"
            | "swells"
            | "cloud"
            | "heaven"
            | "halo"
            | "major"
            | "minor"
            | "maj"
            | "min"
            | "mayor"
            | "menor"
            | "key"
            | "of"
            | "in"
            | "the"
            | "de"
            | "del"
            | "en"
            | "loop"
            | "loops"
            | "mono"
            | "stereo"
            | "audio"
            | "track"
            | "sustained"
            | "infinite"
            | "44k"
            | "48k"
            | "44100"
            | "48000"
    )
}

fn match_base_note_str(s: &str) -> Option<u8> {
    match s {
        "c" | "do" | "b#" | "si#" => Some(0),
        "c#" | "db" | "do#" | "reb" => Some(1),
        "d" | "re" => Some(2),
        "d#" | "eb" | "re#" | "mib" => Some(3),
        "e" | "mi" | "fb" | "fab" => Some(4),
        "f" | "fa" | "e#" | "mi#" => Some(5),
        "f#" | "gb" | "fa#" | "solb" => Some(6),
        "g" | "sol" => Some(7),
        "g#" | "ab" | "sol#" | "lab" => Some(8),
        "a" | "la" => Some(9),
        "a#" | "bb" | "la#" | "sib" => Some(10),
        "b" | "si" | "cb" | "dob" => Some(11),
        _ => None,
    }
}

fn parse_single_note_token(token: &str) -> Option<u8> {
    let norm = token
        .trim()
        .to_ascii_lowercase()
        .replace('♯', "#")
        .replace('♭', "b");
    if norm.is_empty() || is_ignored_word(&norm) || norm.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    if let Some(n) = match_base_note_str(&norm) {
        return Some(n);
    }

    // Sufijos de modo / acorde al final del token (`F#m`, `BbMaj`, `Cm`, `Dminor`).
    let mut stem = norm.as_str();
    for suffix in ["major", "minor", "maj7", "min7", "mayor", "menor", "maj", "min", "m"] {
        if let Some(prefix) = stem.strip_suffix(suffix) {
            if !prefix.is_empty() {
                stem = prefix;
                break;
            }
        }
    }

    // Dígito de octava opcional al final (`C3`, `Eb2`, `F#3`).
    let bytes = stem.as_bytes();
    if bytes.len() >= 2 && matches!(bytes[bytes.len() - 1], b'0'..=b'7') {
        let without_oct = &stem[..bytes.len() - 1];
        if let Some(n) = match_base_note_str(without_oct) {
            return Some(n);
        }
    }

    match_base_note_str(stem)
}

/// Detecta la nota cromática (`0..=11`, `C=0`) a partir del nombre del archivo de un pack.
/// Reconoce notación inglesa (`C`, `C#`, `Eb`, `Bb`, `F#m`), solfeo (`Do`, `Re`, `Sol#`, `Sib`) y
/// modificadores separados (`"F Sharp.wav"`, `"B Flat.mp3"`), priorizando tokens hacia el final.
pub fn parse_pad_pack_filename(file_name: &str) -> Option<u8> {
    let name = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '_' | '-' | '(' | ')' | '[' | ']' | '.' | ',' | '/' | '\\' => ' ',
            other => other,
        })
        .collect();
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }

    // Unir pares `[nota, "sharp"/"flat"/"sostenido"/"bemol"]` desde el final hacia el principio.
    let mut i = tokens.len();
    while i > 0 {
        i -= 1;
        let cur = tokens[i].to_ascii_lowercase();
        if i > 0 && matches!(cur.as_str(), "sharp" | "flat" | "sostenido" | "bemol") {
            let offset = if matches!(cur.as_str(), "sharp" | "sostenido") { 1 } else { -1 };
            if let Some(base) = parse_single_note_token(tokens[i - 1]) {
                return Some(((base as i32 + offset).rem_euclid(12)) as u8);
            }
        }
        if let Some(note) = parse_single_note_token(tokens[i]) {
            return Some(note);
        }
    }
    None
}

fn is_supported_audio_ext(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "wav" | "flac" | "mp3" | "ogg" | "m4a" | "aac" | "aif" | "aiff"
    )
}

/// Convierte canales decodificados (`f32`) en un bucle estéreo `i16` intercalado sin costuras:
/// recorta entradas/salidas en archivos largos, pliega `4 s` de cola con fundido de igual potencia (`sin`/`cos`)
/// sobre el inicio y normaliza suavemente a `TARGET_PACK_RMS` respetando `MAX_PACK_PEAK`.
pub fn build_seamless_loop(channels: &[Vec<f32>], sample_rate: u32) -> Vec<i16> {
    if channels.is_empty() || channels[0].is_empty() {
        return Vec::new();
    }
    let left_src = &channels[0];
    let right_src = if channels.len() >= 2 && !channels[1].is_empty() {
        &channels[1]
    } else {
        &channels[0]
    };
    let total = left_src.len().min(right_src.len());
    if total == 0 {
        return Vec::new();
    }

    let sr = sample_rate.max(8_000) as usize;
    let (start, end) = if total > LONG_AUDIO_THRESHOLD_SEC * sr {
        let trim = (EDGE_SKIP_SEC * sr).min((total.saturating_sub(10 * sr)) / 2);
        let max_span = MAX_LOOP_SEC * sr;
        let stop = (total - trim).min(trim + max_span);
        (trim, stop)
    } else {
        (0, total.min(MAX_LOOP_SEC * sr))
    };

    let span = end.saturating_sub(start);
    if span == 0 {
        return Vec::new();
    }

    let mut out_l: Vec<f32>;
    let mut out_r: Vec<f32>;
    if span < 64 {
        out_l = left_src[start..end].to_vec();
        out_r = right_src[start..end].to_vec();
    } else {
        let xfade = (LOOP_XFADE_SEC * sr).min(span / 4).max(16.min(span / 2));
        let loop_len = span - xfade;
        out_l = Vec::with_capacity(loop_len);
        out_r = Vec::with_capacity(loop_len);
        let denom = xfade.max(1) as f32;
        for i in 0..xfade {
            let angle = FRAC_PI_2 * (i as f32 / denom);
            let (g_in, g_out) = angle.sin_cos();
            let h = start + i;
            let t = start + loop_len + i;
            out_l.push(left_src[h] * g_in + left_src[t] * g_out);
            out_r.push(right_src[h] * g_in + right_src[t] * g_out);
        }
        for pos in (start + xfade)..(start + loop_len) {
            out_l.push(left_src[pos]);
            out_r.push(right_src[pos]);
        }
    }

    let frames = out_l.len();
    let mut sq = 0.0f64;
    let mut peak = 0.0f32;
    for i in 0..frames {
        let l = if out_l[i].is_finite() { out_l[i] } else { 0.0 };
        let r = if out_r[i].is_finite() { out_r[i] } else { 0.0 };
        peak = peak.max(l.abs()).max(r.abs());
        sq += (l as f64) * (l as f64) + (r as f64) * (r as f64);
    }
    let rms = (sq / (2 * frames.max(1)) as f64).sqrt() as f32;
    let scale = if rms > 1e-5 {
        let desired = (TARGET_PACK_RMS / rms).clamp(0.1, 4.0);
        desired.min(MAX_PACK_PEAK / peak.max(1e-6))
    } else {
        1.0
    };

    let mut interleaved = Vec::with_capacity(frames * 2);
    for i in 0..frames {
        let l = (out_l[i] * scale).clamp(-1.0, 1.0);
        let r = (out_r[i] * scale).clamp(-1.0, 1.0);
        interleaved.push((l * 32767.0).round().clamp(-32768.0, 32767.0) as i16);
        interleaved.push((r * 32767.0).round().clamp(-32768.0, 32767.0) as i16);
    }
    interleaved
}

fn write_pcm_i16_atomic(target: &Path, samples: &[i16]) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    write_atomic_bytes(target, &bytes)
}

fn read_pcm_i16(path: &Path) -> Result<Vec<i16>, String> {
    let bytes = fs::read(path).map_err(|e| format!("No se pudo leer '{}': {e}", path.display()))?;
    if bytes.len() < 4 || bytes.len() % 4 != 0 {
        return Err(format!("Archivo PCM inválido o truncado: '{}'", path.display()));
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        out.push(i16::from_le_bytes([chunk[0], chunk[1]]));
    }
    Ok(out)
}

/// Lista todos los packs de pads importados en `base_dir`.
pub fn list_pad_packs(base_dir: &Path) -> Result<Vec<PadPackInfo>, String> {
    Ok(load_packs_index(base_dir)?.packs)
}

/// Escanea `folder_path`, detecta las notas C..B, decodifica/remuestrea a `target_sr`,
/// genera bucles sin costuras en `base_dir/pad_packs/<id>/` y registra el pack en `packs.json`.
pub fn import_pad_pack_folder(
    base_dir: &Path,
    name: &str,
    folder_path: &Path,
    target_sr: u32,
) -> Result<PadPackInfo, String> {
    if !folder_path.is_dir() {
        return Err(format!("La carpeta '{}' no existe o no es accesible.", folder_path.display()));
    }
    let sr = effective_cache_rate(Some(target_sr));

    let mut files = Vec::new();
    let rd = fs::read_dir(folder_path).map_err(|e| format!("Error leyendo '{}': {e}", folder_path.display()))?;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_file() && is_supported_audio_ext(&p) {
            files.push(p);
        }
    }
    files.sort();

    let mut by_note: [Option<PathBuf>; 12] = Default::default();
    for path in files {
        let fname = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if let Some(note) = parse_pad_pack_filename(fname) {
            if by_note[note as usize].is_none() {
                by_note[note as usize] = Some(path);
            }
        }
    }

    let matched_count = by_note.iter().filter(|x| x.is_some()).count();
    if matched_count == 0 {
        return Err("No se reconoció ninguna nota (C, C#, D, Eb... o Do, Re, Mi...) en los archivos de esa carpeta.".to_string());
    }

    let clean_name = {
        let t = name.trim();
        if t.is_empty() {
            folder_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Pack de pads")
                .to_string()
        } else {
            t.to_string()
        }
    };
    let pack_id = sanitize_pack_id(&clean_name);
    validate_path_id(&pack_id)?;
    let out_dir = pack_dir(base_dir, &pack_id);
    fs::create_dir_all(&out_dir).map_err(|e| format!("Error creando '{}': {e}", out_dir.display()))?;

    let mut available = BTreeSet::new();
    let mut sum_dur = 0.0f64;

    for (note_idx, slot) in by_note.into_iter().enumerate() {
        let Some(src_path) = slot else { continue };
        let decoded = match decode_audio_file(&src_path, None) {
            Ok(d) => d,
            Err(e) => {
                let _ = fs::remove_dir_all(&out_dir);
                return Err(format!("Error decodificando '{}': {e}", src_path.display()));
            }
        };
        let resampled = if decoded.sample_rate != sr {
            match resample_channels(&decoded.channels, decoded.sample_rate as usize, sr as usize) {
                Ok(ch) => ch,
                Err(e) => {
                    let _ = fs::remove_dir_all(&out_dir);
                    return Err(format!("Error remuestreando '{}': {e}", src_path.display()));
                }
            }
        } else {
            decoded.channels
        };

        let loop_pcm = build_seamless_loop(&resampled, sr);
        if loop_pcm.len() < 4 {
            continue;
        }
        let frames = loop_pcm.len() / 2;
        sum_dur += frames as f64 / sr as f64;
        if let Err(e) = write_pcm_i16_atomic(&note_pcm_path(&out_dir, note_idx as u8), &loop_pcm) {
            let _ = fs::remove_dir_all(&out_dir);
            return Err(e);
        }
        available.insert(note_idx as u8);
    }

    if available.is_empty() {
        let _ = fs::remove_dir_all(&out_dir);
        return Err("Los archivos detectados no contenían audio válido para generar el pack.".to_string());
    }

    let available_notes: Vec<u8> = available.into_iter().collect();
    let avg_dur = sum_dur / available_notes.len().max(1) as f64;
    let info = PadPackInfo {
        id: pack_id,
        name: clean_name,
        source_folder: folder_path.to_string_lossy().to_string(),
        sample_rate: sr,
        available_notes,
        duration_sec: avg_dur,
    };

    let mut index = load_packs_index(base_dir)?;
    index.packs.retain(|p| p.id != info.id);
    index.packs.push(info.clone());
    save_packs_index(base_dir, &index)?;
    Ok(info)
}

/// Elimina un pack de pads de disco y del índice `packs.json`.
pub fn delete_pad_pack(base_dir: &Path, pack_id: &str) -> Result<(), String> {
    validate_path_id(pack_id)?;
    let mut index = load_packs_index(base_dir)?;
    index.packs.retain(|p| p.id != pack_id);
    save_packs_index(base_dir, &index)?;
    let dir = pack_dir(base_dir, pack_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("Error borrando carpeta del pack '{}': {e}", dir.display()))?;
    }
    Ok(())
}

/// Busca el archivo de la nota pedida o la nota disponible más cercana en `±3` semitonos.
fn find_best_note_file(pack_path: &Path, target_note: u8) -> Option<(u8, PathBuf, f64)> {
    let target = target_note % 12;
    let exact = note_pcm_path(pack_path, target);
    if exact.exists() {
        return Some((target, exact, 1.0));
    }
    for delta in [1i32, -1, 2, -2, 3, -3] {
        let src_note = ((target as i32 - delta).rem_euclid(12)) as u8;
        let path = note_pcm_path(pack_path, src_note);
        if path.exists() {
            let ratio = 2.0_f64.powf(delta as f64 / 12.0);
            return Some((src_note, path, ratio));
        }
    }
    None
}

/// Búfer estéreo `i16` inmutable en RAM correspondiente a la nota cargada del pack activo.
#[derive(Debug)]
pub struct PadPackBuffer {
    pub samples: Vec<i16>,
    pub frames: usize,
    pub sample_rate: u32,
    pub note: u8,
    pub pitch_ratio: f64,
}

/// Puente sin bloqueos para cargar búferes de pack en hilos de fondo y entregárselos al callback.
pub struct PadPackBridge {
    base_dir: Mutex<Option<PathBuf>>,
    active_pack_id: Mutex<Option<String>>,
    /// `None` = sin cambios; `Some(None)` = volver al sintetizador; `Some(Some(buf))` = nota nueva lista.
    pending: Mutex<Option<Option<Arc<PadPackBuffer>>>>,
    /// Cola preasignada donde el callback deposita los `Arc` viejos para que otro hilo los libere fuera del audio.
    retired: Mutex<Vec<Arc<PadPackBuffer>>>,
    request_gen: AtomicU64,
}

impl Default for PadPackBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl PadPackBridge {
    pub fn new() -> Self {
        Self {
            base_dir: Mutex::new(None),
            active_pack_id: Mutex::new(None),
            pending: Mutex::new(None),
            retired: Mutex::new(Vec::with_capacity(RETIRED_CAP)),
            request_gen: AtomicU64::new(0),
        }
    }

    pub fn set_base_dir(&self, dir: &Path) {
        *self.base_dir.lock().unwrap() = Some(dir.to_path_buf());
    }

    pub fn active_pack_id(&self) -> Option<String> {
        self.active_pack_id.lock().unwrap().clone()
    }

    pub fn has_active_pack(&self) -> bool {
        self.active_pack_id.lock().unwrap().is_some()
    }

    /// Libera en el hilo llamador (fuera del callback de audio) cualquier búfer retirado pendiente.
    pub fn drain_retired(&self) {
        if let Ok(mut g) = self.retired.try_lock() {
            g.clear();
        }
    }

    /// Selecciona un pack (`Some(id)`) o vuelve al sintetizador (`None`) y carga la nota actual si aplica.
    pub fn set_pack(&self, base_dir: Option<&Path>, pack_id: Option<String>, note: u8) -> Result<(), String> {
        self.drain_retired();
        if let Some(dir) = base_dir {
            self.set_base_dir(dir);
        }
        let clean = pack_id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if let Some(ref id) = clean {
            validate_path_id(id)?;
        }
        *self.active_pack_id.lock().unwrap() = clean.clone();
        self.request_gen.fetch_add(1, Ordering::SeqCst);
        if clean.is_none() {
            *self.pending.lock().unwrap() = Some(None);
            return Ok(());
        }
        self.load_note_sync(note)
    }

    /// Desactiva el pack activo (al pasar a canción con pistas o descargar) y vuelve al sintetizador.
    pub fn clear_pack(&self) {
        self.drain_retired();
        *self.active_pack_id.lock().unwrap() = None;
        self.request_gen.fetch_add(1, Ordering::SeqCst);
        *self.pending.lock().unwrap() = Some(None);
    }

    /// Lee del disco la nota `note` del pack activo y la deja en `pending` para el siguiente bloque del callback.
    pub fn load_note_sync(&self, note: u8) -> Result<(), String> {
        self.drain_retired();
        let gen = self.request_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let pack_id = self.active_pack_id.lock().unwrap().clone();
        let Some(pack_id) = pack_id else {
            *self.pending.lock().unwrap() = Some(None);
            return Ok(());
        };
        let base_dir = self.base_dir.lock().unwrap().clone();
        let Some(base_dir) = base_dir else {
            *self.pending.lock().unwrap() = Some(None);
            return Err("No se ha establecido el directorio de datos para cargar packs de pads.".to_string());
        };

        let index = load_packs_index(&base_dir)?;
        let sample_rate = index
            .packs
            .iter()
            .find(|p| p.id == pack_id)
            .map(|p| p.sample_rate)
            .unwrap_or(48_000);
        let dir = pack_dir(&base_dir, &pack_id);
        let Some((src_note, pcm_path, pitch_ratio)) = find_best_note_file(&dir, note % 12) else {
            *self.pending.lock().unwrap() = Some(None);
            return Ok(());
        };
        let samples = read_pcm_i16(&pcm_path)?;
        let frames = samples.len() / 2;
        if frames < 2 {
            *self.pending.lock().unwrap() = Some(None);
            return Ok(());
        }
        let buf = Arc::new(PadPackBuffer {
            samples,
            frames,
            sample_rate,
            note: src_note,
            pitch_ratio,
        });
        if self.request_gen.load(Ordering::SeqCst) == gen && self.active_pack_id.lock().unwrap().as_deref() == Some(pack_id.as_str()) {
            *self.pending.lock().unwrap() = Some(Some(buf));
        }
        Ok(())
    }

    /// Lee con `try_lock` si hay una actualización pendiente para el callback (0 esperas, 0 asignaciones).
    #[inline]
    pub fn take_pending_nonblocking(&self) -> Option<Option<Arc<PadPackBuffer>>> {
        let Ok(mut guard) = self.pending.try_lock() else {
            return None;
        };
        guard.take()
    }

    /// Recibe un búfer retirado desde el callback sin liberarlo en el hilo de audio.
    #[inline]
    pub fn retire_nonblocking(&self, buf: Arc<PadPackBuffer>) {
        if let Ok(mut guard) = self.retired.try_lock() {
            if guard.len() < guard.capacity() {
                guard.push(buf);
                return;
            }
        }
        // Solo si no pudo encolarse en RETIRED_CAP (caso excepcional), evitar fuga silenciosa.
        drop(buf);
    }
}

#[derive(Default)]
struct SampleVoiceSlot {
    buf: Option<Arc<PadPackBuffer>>,
    pos: f64,
    level: f32,
    target_level: f32,
}

impl SampleVoiceSlot {
    #[inline]
    fn read_stereo(&mut self, device_sr: u32) -> (f32, f32) {
        let Some(ref buf) = self.buf else {
            return (0.0, 0.0);
        };
        let frames = buf.frames;
        if frames < 2 {
            return (0.0, 0.0);
        }
        let idx0 = (self.pos as usize) % frames;
        let idx1 = if idx0 + 1 >= frames { 0 } else { idx0 + 1 };
        let frac = (self.pos - self.pos.floor()) as f32;
        let s = &buf.samples;
        let base0 = idx0 * 2;
        let base1 = idx1 * 2;
        let l0 = s[base0] as f32;
        let r0 = s[base0 + 1] as f32;
        let l1 = s[base1] as f32;
        let r1 = s[base1 + 1] as f32;
        let inv = 1.0 / 32768.0;
        let out_l = (l0 + (l1 - l0) * frac) * inv;
        let out_r = (r0 + (r1 - r0) * frac) * inv;

        let step = buf.pitch_ratio * (buf.sample_rate as f64 / device_sr.max(1) as f64);
        let mut next = self.pos + step;
        let fl = frames as f64;
        while next >= fl {
            next -= fl;
        }
        self.pos = next;
        (out_l, out_r)
    }
}

/// Reproductor en tiempo real de dos ranuras para bucles de packs (cero asignaciones y cero `drop` en callback).
pub struct PadSamplePlayer {
    slots: [SampleVoiceSlot; 2],
    active_idx: usize,
    wants_sample: bool,
}

impl Default for PadSamplePlayer {
    fn default() -> Self {
        Self::new()
    }
}

impl PadSamplePlayer {
    pub fn new() -> Self {
        Self {
            slots: [SampleVoiceSlot::default(), SampleVoiceSlot::default()],
            active_idx: 0,
            wants_sample: false,
        }
    }

    #[inline]
    pub fn wants_sample(&self) -> bool {
        self.wants_sample
    }

    #[inline]
    pub fn is_active(&self) -> bool {
        self.wants_sample || self.slots.iter().any(|s| s.buf.is_some() && (s.level > 0.0 || s.target_level > 0.0))
    }

    /// Aplica novedades de `bridge` y retira búferes terminados sin bloquear ni asignar.
    pub fn sync(&mut self, bridge: &PadPackBridge) {
        if let Some(update) = bridge.take_pending_nonblocking() {
            match update {
                None => {
                    self.wants_sample = false;
                    for s in &mut self.slots {
                        s.target_level = 0.0;
                    }
                }
                Some(new_buf) => {
                    self.wants_sample = true;
                    let cur_slot = &self.slots[self.active_idx];
                    let same_buf = cur_slot
                        .buf
                        .as_ref()
                        .is_some_and(|b| Arc::ptr_eq(b, &new_buf) && cur_slot.target_level > 0.0);
                    if same_buf {
                        bridge.retire_nonblocking(new_buf);
                    } else {
                        let next_idx = 1 - self.active_idx;
                        if let Some(old) = self.slots[next_idx].buf.take() {
                            bridge.retire_nonblocking(old);
                        }
                        self.slots[self.active_idx].target_level = 0.0;
                        self.slots[next_idx].buf = Some(new_buf);
                        self.slots[next_idx].pos = 0.0;
                        self.slots[next_idx].level = 0.0;
                        self.slots[next_idx].target_level = 1.0;
                        self.active_idx = next_idx;
                    }
                }
            }
        }
    }

    /// Libera referencias terminadas hacia `bridge.retired` sin invocar `drop` en el hilo de audio.
    pub fn release_finished(&mut self, bridge: &PadPackBridge) {
        for s in &mut self.slots {
            if s.level == 0.0 && s.target_level == 0.0 {
                if let Some(old) = s.buf.take() {
                    bridge.retire_nonblocking(old);
                }
            }
        }
    }

    /// Descarta todo de inmediato enviando los `Arc` a `bridge.retired`.
    pub fn silence_reset(&mut self, bridge: &PadPackBridge) {
        self.wants_sample = false;
        for s in &mut self.slots {
            s.level = 0.0;
            s.target_level = 0.0;
            s.pos = 0.0;
            if let Some(old) = s.buf.take() {
                bridge.retire_nonblocking(old);
            }
        }
    }

    #[inline]
    pub fn next_sample(&mut self, device_sr: u32) -> (f32, f32) {
        let step = 1.0 / (SAMPLE_XFADE_SEC * device_sr.max(1) as f32).max(1.0);
        let mut out_l = 0.0f32;
        let mut out_r = 0.0f32;
        for s in &mut self.slots {
            if s.buf.is_none() || (s.level == 0.0 && s.target_level == 0.0) {
                continue;
            }
            if s.level < s.target_level {
                s.level = (s.level + step).min(s.target_level);
            } else if s.level > s.target_level {
                s.level = (s.level - step).max(s.target_level);
            }
            let l = s.level;
            let curve = l * l * (3.0 - 2.0 * l);
            let (sl, sr) = s.read_stereo(device_sr);
            out_l += sl * curve;
            out_r += sr * curve;
        }
        (out_l, out_r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "omnitracks_padpacks_{tag}_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_test_wav(path: &Path, sample_rate: u32, seconds: f32, freq_hz: f32) {
        let frames = (sample_rate as f32 * seconds) as usize;
        let data_bytes = (frames * 4) as u32;
        let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
        bytes.extend_from_slice(&2u16.to_le_bytes()); // estéreo
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate * 4).to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_bytes.to_le_bytes());
        for i in 0..frames {
            let phase = TAU * freq_hz * (i as f32 / sample_rate as f32);
            let s_l = (phase.sin() * 0.25 * 32767.0) as i16;
            let s_r = (((phase * 1.001).sin()) * 0.25 * 32767.0) as i16;
            bytes.extend_from_slice(&s_l.to_le_bytes());
            bytes.extend_from_slice(&s_r.to_le_bytes());
        }
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn test_parse_pad_pack_filename() {
        assert_eq!(parse_pad_pack_filename("C.wav"), Some(0));
        assert_eq!(parse_pad_pack_filename("04 - Warm Pad - Eb.mp3"), Some(3));
        assert_eq!(parse_pad_pack_filename("Ambient_A_Major.wav"), Some(9));
        assert_eq!(parse_pad_pack_filename("Worship Pad (F#m).flac"), Some(6));
        assert_eq!(parse_pad_pack_filename("Warm_Pad_BbMaj.m4a"), Some(10));
        assert_eq!(parse_pad_pack_filename("Pad_Eb2.wav"), Some(3));
        assert_eq!(parse_pad_pack_filename("F Sharp.wav"), Some(6));
        assert_eq!(parse_pad_pack_filename("B Flat.mp3"), Some(10));
        assert_eq!(parse_pad_pack_filename("Do.wav"), Some(0));
        assert_eq!(parse_pad_pack_filename("07_Sol#.wav"), Some(8));
        assert_eq!(parse_pad_pack_filename("Pad Sib.wav"), Some(10));
        assert_eq!(parse_pad_pack_filename("04 - La Presencia - D.wav"), Some(2));
        assert_eq!(parse_pad_pack_filename("Ambient.wav"), None);
        assert_eq!(parse_pad_pack_filename("Warm_Pad_Loop.mp3"), None);
        assert_eq!(parse_pad_pack_filename("Strings_Soft_Worship.flac"), None);
    }

    #[test]
    fn test_build_seamless_loop_sin_salto_y_rms_limpio() {
        let sr = 48_000u32;
        let len = sr as usize * 20; // > 16s para probar recorte + crossfade de 4s
        let mut ch_l = Vec::with_capacity(len);
        let mut ch_r = Vec::with_capacity(len);
        for i in 0..len {
            let env = if i < sr as usize * 2 {
                i as f32 / (sr as f32 * 2.0)
            } else if i > len - sr as usize * 2 {
                (len - i) as f32 / (sr as f32 * 2.0)
            } else {
                1.0
            };
            let t = i as f32 / sr as f32;
            ch_l.push((TAU * 130.81 * t).sin() * 0.4 * env);
            ch_r.push((TAU * 130.81 * t + 0.3).sin() * 0.4 * env);
        }
        let pcm = build_seamless_loop(&[ch_l, ch_r], sr);
        assert!(pcm.len() > sr as usize * 4);
        let frames = pcm.len() / 2;

        // Comprobar continuidad en la costura de vuelta (último fotograma -> fotograma 0).
        let last_l = pcm[(frames - 1) * 2] as f32 / 32768.0;
        let first_l = pcm[0] as f32 / 32768.0;
        let wrap_step = (first_l - last_l).abs();
        assert!(wrap_step < 0.02, "salto en el empalme del bucle: {wrap_step}");

        let mut sq = 0.0f64;
        let mut peak = 0.0f32;
        for &v in &pcm {
            let f = v as f32 / 32768.0;
            peak = peak.max(f.abs());
            sq += (f as f64) * (f as f64);
        }
        let rms = (sq / pcm.len() as f64).sqrt() as f32;
        assert!(peak < 0.85, "pico fuera de rango: {peak}");
        assert!(rms > 0.09 && rms < 0.22, "RMS inesperado: {rms}");
    }

    #[test]
    fn test_importar_listar_borrar_y_reproducir_pack_sin_asignaciones() {
        let base = temp_dir("base");
        let src = temp_dir("src");
        write_test_wav(&src.join("Warm_C.wav"), 48_000, 3.0, 130.81);
        write_test_wav(&src.join("Warm_D.wav"), 44_100, 3.0, 146.83);
        write_test_wav(&src.join("Ignored.wav"), 48_000, 2.0, 100.0);

        let info = import_pad_pack_folder(&base, "Foundry Test", &src, 48_000).expect("importar pack");
        assert_eq!(info.name, "Foundry Test");
        assert_eq!(info.available_notes, vec![0, 2]);
        assert_eq!(info.sample_rate, 48_000);

        let listed = list_pad_packs(&base).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, info.id);

        // Puente + reproductor con prueba de cero asignaciones y nota faltante (C# -> usa C o D a ±1 st).
        let bridge = Arc::new(PadPackBridge::new());
        bridge.set_pack(Some(&base), Some(info.id.clone()), 0).unwrap();

        let mut player = PadSamplePlayer::new();
        player.sync(&bridge);
        assert!(player.wants_sample() && player.is_active());

        // Carga la nota faltante C# (1) para que quede en `pending` y se cambie durante la sección medida.
        bridge.load_note_sync(1).unwrap();

        let allocs = crate::alloc_probe::count_allocs(|| {
            let mut pk = 0.0f32;
            for b in 0..120u32 {
                if b == 30 {
                    player.sync(&bridge);
                }
                for _ in 0..480 {
                    let (l, r) = player.next_sample(48_000);
                    assert!(l.is_finite() && r.is_finite());
                    pk = pk.max(l.abs()).max(r.abs());
                }
                player.release_finished(&bridge);
            }
            assert!(pk > 0.08, "el reproductor de pack debe emitir audio claro: {pk}");
        });
        assert_eq!(allocs, 0, "PadSamplePlayer asignó o liberó memoria en el callback");

        bridge.clear_pack();
        player.sync(&bridge);
        for _ in 0..80 {
            for _ in 0..480 {
                let _ = player.next_sample(48_000);
            }
            player.release_finished(&bridge);
        }
        assert!(!player.is_active(), "tras limpiar pack y pasar el crossfade debe quedar inactivo");
        bridge.drain_retired();

        delete_pad_pack(&base, &info.id).unwrap();
        assert!(list_pad_packs(&base).unwrap().is_empty());

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&src);
    }
}
