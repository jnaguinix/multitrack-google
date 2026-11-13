//! Flujo aprobado Biblioteca/Setlist sobre una carpeta real de 7 pistas MP3:
//! importar a la biblioteca = solo escanear (no crea `pcm/<id>`); añadir al setlist = decodificar
//! y crear la caché; quitar del setlist = borrarla; volver a añadir = regenerarla; reproducir.
//! Imprime tiempos con el prefijo `[NativeImport]`.

use omnitracks_desktop::audio::cache::get_project_cache_dir;
use omnitracks_desktop::audio::import;
use omnitracks_desktop::audio::output::AudioStreamStats;
use omnitracks_desktop::audio::playback::PlaybackEngine;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

const SAMPLE_RATE: u32 = 48000;

async fn decode_all(
    cache_base: &Path,
    project_id: &str,
    files: &[(String, String)],
) -> std::time::Duration {
    let t0 = Instant::now();
    let sem = Arc::new(tokio::sync::Semaphore::new(3)); // misma concurrencia que audio_import_tracks
    let mut tasks = Vec::new();
    for (path, track_id) in files.iter().cloned() {
        let sem = Arc::clone(&sem);
        let cache_base = cache_base.to_path_buf();
        let project_id = project_id.to_string();
        tasks.push(tokio::spawn(async move {
            let permit = sem.acquire_owned().await.unwrap();
            tokio::task::spawn_blocking(move || {
                let _p = permit;
                import::decode_and_cache_track(
                    &cache_base,
                    &project_id,
                    &track_id,
                    Path::new(&path),
                    SAMPLE_RATE,
                    None,
                )
            })
            .await
            .unwrap()
        }));
    }
    for t in tasks {
        t.await.unwrap().expect("decodificación correcta");
    }
    t0.elapsed()
}

#[tokio::test]
async fn library_import_defers_pcm_until_setlist() {
    let folder = PathBuf::from(r"C:\Users\jpuerta\Downloads\Eres Bendigo - Jaime Murrel");
    assert!(folder.exists(), "carpeta de 7 pistas MP3 requerida");

    let cache_base = std::env::temp_dir().join(format!("omnitracks_import_flow_{}", std::process::id()));
    std::fs::create_dir_all(&cache_base).unwrap();
    let project_id = "song-import-flow";
    let pcm_root = cache_base.join("pcm").join(project_id);

    // 1. IMPORTAR A LA BIBLIOTECA = solo escanear
    let t_scan = Instant::now();
    let scanned = omnitracks_desktop::audio::audio_scan_folder(folder.to_string_lossy().to_string())
        .await
        .expect("escaneo correcto");
    let scan_ms = t_scan.elapsed();
    assert_eq!(scanned.files.len(), 7);
    println!(
        "[NativeImport] \"{}\" importada en biblioteca en {:.1?} ({} pistas, solo metadatos; caché PCM diferida)",
        scanned.title,
        scan_ms,
        scanned.files.len()
    );
    assert!(!pcm_root.exists(), "importar a la biblioteca NO debe crear pcm/<id>");
    println!("[Verificación 1] pcm/{} no existe tras importar: OK", project_id);

    let files: Vec<(String, String)> = scanned
        .files
        .iter()
        .map(|f| (f.file_path.clone(), f.track_id.clone()))
        .collect();

    // 2. AÑADIR AL SETLIST = decodificar y crear la caché
    let t_add = decode_all(&cache_base, project_id, &files).await;
    let cache_dir = get_project_cache_dir(&cache_base, project_id, SAMPLE_RATE);
    assert!(cache_dir.exists(), "añadir al setlist debe crear la caché");
    let pcm_count = std::fs::read_dir(&cache_dir)
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "pcm").unwrap_or(false))
        .count();
    assert_eq!(pcm_count, 7);
    println!(
        "[NativeImport] \"{}\" caché generada al añadir al setlist: 7 pistas en {:.1?}",
        scanned.title, t_add
    );
    println!("[Verificación 2] {} existe con {} archivos .pcm: OK", cache_dir.display(), pcm_count);

    // 3. QUITAR DEL SETLIST = borrar la caché
    std::fs::remove_dir_all(&pcm_root).unwrap();
    assert!(!pcm_root.exists());
    println!("[Verificación 3] caché borrada al quitar del setlist: OK");

    // 4. VOLVER A AÑADIR = se regenera
    let t_readd = decode_all(&cache_base, project_id, &files).await;
    assert!(cache_dir.exists(), "volver a añadir debe regenerar la caché");
    println!("[NativeImport] caché regenerada al volver a añadir: 7 pistas en {:.1?}", t_readd);
    println!("[Verificación 4] caché regenerada: OK");

    // 5. REPRODUCIR
    let stats = Arc::new(AudioStreamStats::default());
    let playback = PlaybackEngine::new(stats);
    let info = playback
        .load_project(&cache_base, project_id, SAMPLE_RATE, Some(108.0), Some(4), None, Some("1-bar".to_string()))
        .await
        .expect("load_project tras regenerar");
    assert_eq!(info.track_count, 7);
    assert!(info.duration_sec > 200.0);
    playback.is_playing.store(true, std::sync::atomic::Ordering::SeqCst);
    println!(
        "[Verificación 5] proyecto cargado ({} pistas, {:.1}s) y reproduciendo: OK",
        info.track_count, info.duration_sec
    );

    let _ = std::fs::remove_dir_all(&cache_base);
}
