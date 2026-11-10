fn main() {
    #[cfg(feature = "shell")]
    {
        let manifest = tauri_build::AppManifest::new().commands(&[
            "remote_status",
            "remote_start",
            "remote_stop",
            "remote_kick",
            "remote_exchange",
            "desktop_update_check",
            "desktop_update_download",
            "desktop_update_install",
        ]);
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
            .expect("Tauri build configuration");
    }
}
