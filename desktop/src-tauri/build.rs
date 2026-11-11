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
            "audio_list_hosts",
            "audio_list_devices",
            "audio_get_config",
            "audio_set_config",
            "audio_get_stats",
            "audio_test_tone",
            "audio_import_tracks",
            "audio_import_track_bytes",
            "audio_import_folder",
            "audio_cancel_import",
            "audio_get_project_cache_status",
            "audio_load_project",
            "audio_play",
            "audio_pause",
            "audio_stop",
            "audio_seek",
            "audio_get_playback_state",
            "audio_set_track_controls",
        ]);
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
            .expect("Tauri build configuration");
    }
}
