//! Asignación de IDs de pista al escanear o importar una carpeta.

use std::collections::HashSet;

/// Devuelve un ID único por archivo. `matched[i]` es el ID que el sidecar guardó para el archivo `i`
/// (si lo hay).
///
/// - Los IDs del sidecar se reservan antes de generar ninguno nuevo: un archivo nuevo nunca recibe el ID
///   de una pista que el sidecar ya conoce, aparezca antes o después en la carpeta (A12).
/// - Si dos archivos reclaman el mismo ID del sidecar (p. ej. `bajo.wav` y `bajo.mp3`), solo el primero lo
///   conserva; el otro recibe uno nuevo, de modo que no compartan PCM, JSON ni archivos temporales.
/// - Los IDs nuevos son `stem-01`, `stem-02`… saltando los ya usados.
pub fn assign_track_ids(matched: &[Option<String>]) -> Vec<String> {
    assign_track_ids_reserving(matched, &[])
}

/// Como `assign_track_ids`, pero además ningún ID nuevo coincide con uno de `reserved` (los de todas las pistas que el
/// sidecar conoce, estén o no sus archivos en esta carpeta): una pista conocida cuyo archivo falta o se renombró
/// conserva su caché PCM bajo ese ID, y un archivo nuevo que lo heredara tomaría audio de otro archivo.
pub fn assign_track_ids_reserving(matched: &[Option<String>], reserved: &[String]) -> Vec<String> {
    let mut used: HashSet<String> = HashSet::new();
    let mut keeps: Vec<bool> = Vec::with_capacity(matched.len());
    for m in matched {
        keeps.push(match m {
            Some(id) => used.insert(id.clone()),
            None => false,
        });
    }
    used.extend(reserved.iter().cloned());
    let mut next = 0u32;
    let mut out = Vec::with_capacity(matched.len());
    for (m, keep) in matched.iter().zip(keeps) {
        if keep {
            out.push(m.clone().unwrap_or_default());
            continue;
        }
        loop {
            next += 1;
            let candidate = format!("stem-{next:02}");
            if used.insert(candidate.clone()) {
                out.push(candidate);
                break;
            }
        }
    }
    out
}

/// Una pista que el sidecar de la carpeta conoce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarTrack {
    pub id: String,
    /// Nombre de la pista en la app («Bajo», «Guitarra 1»…): NO es el nombre del archivo.
    pub name: String,
    /// Nombre del archivo de audio (con extensión), si el sidecar lo guardó.
    pub file_name: Option<String>,
}

/// Las pistas del sidecar (`tracks` del JSON). El nombre del archivo sale de `fileName` o, si falta, del último
/// tramo de `filePath`.
pub fn sidecar_tracks_from_json(json: &serde_json::Value) -> Vec<SidecarTrack> {
    let Some(tracks) = json.get("tracks").and_then(|v| v.as_array()) else { return Vec::new() };
    tracks
        .iter()
        .filter_map(|t| {
            let id = t.get("id").and_then(|v| v.as_str())?;
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let file_name = t
                .get("fileName")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    t.get("filePath")
                        .and_then(|v| v.as_str())
                        .and_then(|p| p.rsplit(['\\', '/']).next())
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                });
            Some(SidecarTrack { id: id.to_string(), name: name.to_string(), file_name })
        })
        .collect()
}

/// Para cada archivo, el ID que el sidecar guardó para él. Se empareja por el NOMBRE DEL ARCHIVO, no por el de la
/// pista: la pista se guarda con el nombre del catálogo («Bajo») y el archivo conserva el suyo (`BASS.mp3`), así que
/// buscar el nombre del archivo entre los nombres de pista solo acertaba por casualidad (Click, Pad, Piano…) y el resto
/// perdía su ID en cada reescaneo. Primero por nombre de archivo exacto (sin distinguir mayúsculas) y, para sidecars
/// antiguos que nombraban la pista como el archivo, por nombre de pista igual al del archivo sin extensión. Cada pista
/// del sidecar se usa una sola vez.
pub fn match_sidecar_ids(sidecar: &[SidecarTrack], file_names: &[String]) -> Vec<Option<String>> {
    let mut claimed = vec![false; sidecar.len()];
    let mut out: Vec<Option<String>> = vec![None; file_names.len()];
    let stem = |f: &str| f.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| f.to_string());

    for (i, file) in file_names.iter().enumerate() {
        let wanted = file.to_lowercase();
        if let Some(k) = sidecar
            .iter()
            .enumerate()
            .position(|(k, t)| !claimed[k] && t.file_name.as_ref().is_some_and(|f| f.to_lowercase() == wanted))
        {
            claimed[k] = true;
            out[i] = Some(sidecar[k].id.clone());
        }
    }
    for (i, file) in file_names.iter().enumerate() {
        if out[i].is_some() {
            continue;
        }
        let wanted = stem(&file.to_lowercase());
        if let Some(k) = sidecar
            .iter()
            .enumerate()
            .position(|(k, t)| !claimed[k] && t.file_name.is_none() && t.name.to_lowercase() == wanted)
        {
            claimed[k] = true;
            out[i] = Some(sidecar[k].id.clone());
        }
    }
    out
}

/// IDs de los archivos de una carpeta o selección: los que el sidecar ya conoce conservan el suyo y los nuevos reciben
/// `stem-NN` saltando todos los IDs del sidecar.
pub fn ids_for_files(sidecar: &[SidecarTrack], file_names: &[String]) -> Vec<String> {
    let matched = match_sidecar_ids(sidecar, file_names);
    let reserved: Vec<String> = sidecar.iter().map(|t| t.id.clone()).collect();
    assign_track_ids_reserving(&matched, &reserved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    fn todos_distintos(ids: &[String]) -> bool {
        ids.iter().collect::<HashSet<_>>().len() == ids.len()
    }

    #[test]
    fn test_a12_un_archivo_nuevo_no_reutiliza_el_id_de_una_pista_del_sidecar() {
        // La batería conserva stem-01 y se añade un bajo sin entrada en el sidecar.
        let ids = assign_track_ids(&[s("stem-01"), None]);
        assert_eq!(ids, vec!["stem-01".to_string(), "stem-02".to_string()]);
    }

    #[test]
    fn test_a12_el_orden_de_los_archivos_no_cambia_la_unicidad() {
        let ids = assign_track_ids(&[None, s("stem-01"), None, s("stem-02")]);
        assert!(todos_distintos(&ids), "{ids:?}");
        assert_eq!(ids[1], "stem-01");
        assert_eq!(ids[3], "stem-02");
        assert_eq!(ids[0], "stem-03");
        assert_eq!(ids[2], "stem-04");
    }

    #[test]
    fn test_a12_sidecar_con_ids_arbitrarios_y_huecos() {
        let ids = assign_track_ids(&[s("bateria"), None, None, s("stem-02")]);
        assert!(todos_distintos(&ids), "{ids:?}");
        assert_eq!(ids[0], "bateria");
        assert_eq!(ids[3], "stem-02");
        assert_eq!(ids[1], "stem-01");
        assert_eq!(ids[2], "stem-03");
    }

    #[test]
    fn test_a12_dos_archivos_que_reclaman_el_mismo_id_no_lo_comparten() {
        let ids = assign_track_ids(&[s("bajo"), s("bajo"), None]);
        assert!(todos_distintos(&ids), "{ids:?}");
        assert_eq!(ids[0], "bajo");
    }

    #[test]
    fn test_a12_sin_sidecar_numera_desde_uno() {
        let ids = assign_track_ids(&[None, None, None]);
        assert_eq!(ids, vec!["stem-01", "stem-02", "stem-03"]);
    }

    // ---- Sidecar: se empareja por nombre de archivo, no por nombre de pista (plan 4.7)

    fn pista(id: &str, name: &str, file: Option<&str>) -> SidecarTrack {
        SidecarTrack { id: id.to_string(), name: name.to_string(), file_name: file.map(str::to_string) }
    }

    fn nombres(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_47_el_sidecar_se_empareja_por_nombre_de_archivo_aunque_la_pista_tenga_otro_nombre() {
        // Como el sidecar real: la pista se llama «Bajo» y el archivo es BASS.mp3.
        let sidecar = [
            pista("stem-01", "Bajo", Some("BASS.mp3")),
            pista("stem-03", "Batería", Some("DRUMS.mp3")),
            pista("stem-9", "Click", Some("CLICK.mp3")),
        ];
        let archivos = nombres(&["BASS.mp3", "DRUMS.mp3", "CLICK.mp3", "NUEVO.mp3"]);
        let ids = ids_for_files(&sidecar, &archivos);
        assert_eq!(&ids[..3], ["stem-01", "stem-03", "stem-9"], "las pistas conocidas conservan su ID: {ids:?}");
        assert!(todos_distintos(&ids), "{ids:?}");
        assert!(!["stem-01", "stem-03", "stem-9"].contains(&ids[3].as_str()), "el archivo nuevo recibe uno nuevo: {ids:?}");
    }

    #[test]
    fn test_47_mayusculas_y_ruta_de_respaldo() {
        let sidecar = [
            pista("a", "Bajo", Some("Bass.MP3")),
            pista("b", "Batería", Some("drums.mp3")),
        ];
        assert_eq!(match_sidecar_ids(&sidecar, &nombres(&["bass.mp3", "DRUMS.MP3"])), vec![Some("a".into()), Some("b".into())]);

        let json: serde_json::Value = serde_json::from_str(
            r#"{"tracks":[{"id":"x","name":"Bajo","filePath":"C:\\musica\\Cancion\\BASS.mp3"},{"id":"y","name":"Voz","fileName":"VOZ.wav","filePath":"D:/otro/lugar.wav"},{"name":"sin id"}]}"#,
        )
        .unwrap();
        let pistas = sidecar_tracks_from_json(&json);
        assert_eq!(pistas.len(), 2, "la pista sin ID se ignora");
        assert_eq!(pistas[0].file_name.as_deref(), Some("BASS.mp3"), "sin fileName, el último tramo de filePath");
        assert_eq!(pistas[1].file_name.as_deref(), Some("VOZ.wav"), "fileName manda sobre filePath");
        assert!(sidecar_tracks_from_json(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn test_47_un_sidecar_antiguo_que_nombraba_la_pista_como_el_archivo_sigue_valiendo() {
        let sidecar = [pista("v1", "bajo", None), pista("v2", "bateria", None)];
        let ids = match_sidecar_ids(&sidecar, &nombres(&["Bajo.wav", "Bateria.wav", "otro.wav"]));
        assert_eq!(ids, vec![Some("v1".to_string()), Some("v2".to_string()), None]);
        // Una pista con nombre de archivo guardado no se empareja por nombre de pista con otro archivo.
        let con_archivo = [pista("v1", "Bajo", Some("BASS.mp3"))];
        assert_eq!(match_sidecar_ids(&con_archivo, &nombres(&["Bajo.wav"])), vec![None]);
    }

    #[test]
    fn test_47_cada_pista_del_sidecar_se_usa_una_sola_vez() {
        let sidecar = [pista("v1", "bajo", None)];
        let ids = match_sidecar_ids(&sidecar, &nombres(&["bajo.wav", "bajo.mp3"]));
        assert_eq!(ids.iter().filter(|i| i.is_some()).count(), 1, "{ids:?}");
        let finales = ids_for_files(&sidecar, &nombres(&["bajo.wav", "bajo.mp3"]));
        assert!(todos_distintos(&finales), "{finales:?}");
    }

    #[test]
    fn test_47_un_archivo_nuevo_no_hereda_el_id_de_una_pista_conocida_cuyo_archivo_falta() {
        // «stem-01» era un archivo que ya no está en la carpeta, pero su caché PCM sigue bajo ese ID.
        let sidecar = [pista("stem-01", "Bajo", Some("BASS.mp3")), pista("stem-02", "Pad", Some("PAD.mp3"))];
        let ids = ids_for_files(&sidecar, &nombres(&["PAD.mp3", "NUEVO.mp3"]));
        assert_eq!(ids[0], "stem-02");
        assert_eq!(ids[1], "stem-03", "salta stem-01 aunque su archivo no esté: {ids:?}");
    }
}
