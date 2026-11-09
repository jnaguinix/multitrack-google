fn main() {
    #[cfg(feature = "shell")]
    {
        let manifest = tauri_build::AppManifest::new().commands(&[
            "remote_status",
            "remote_start",
            "remote_stop",
            "remote_kick",
            "remote_exchange",
        ]);
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
            .expect("Tauri build configuration");
    }
}
