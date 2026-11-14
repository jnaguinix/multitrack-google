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
    let mut used: HashSet<String> = HashSet::new();
    let mut keeps: Vec<bool> = Vec::with_capacity(matched.len());
    for m in matched {
        keeps.push(match m {
            Some(id) => used.insert(id.clone()),
            None => false,
        });
    }
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
}
