pub mod audio;
pub mod lan;
pub mod library;
pub mod protocol;

#[cfg(test)]
mod capability_tests {
    /// El frontend escucha `audio://import-progress` con `event.listen`. En Tauri v2 eso exige permisos
    /// explícitos de eventos; sin ellos `listen` falla y la interfaz no ve el avance de la caché.
    #[test]
    fn test_capabilities_permiten_escuchar_eventos() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop-remote.json")).expect("JSON de capacidades inválido");
        let perms: Vec<&str> = caps["permissions"]
            .as_array()
            .expect("falta la lista de permisos")
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        for needed in ["core:event:allow-listen", "core:event:allow-unlisten"] {
            assert!(perms.contains(&needed), "falta el permiso {needed} en capabilities/desktop-remote.json");
        }
    }
}
