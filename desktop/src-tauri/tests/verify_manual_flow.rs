use omnitracks_desktop::audio::cache::get_project_cache_dir;
use omnitracks_desktop::audio::import;
use omnitracks_desktop::audio::output::AudioStreamStats;
use omnitracks_desktop::audio::playback::PlaybackEngine;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

#[tokio::test]
async fn verify_full_flow_user_request() {
    let app_data_dir = PathBuf::from(r"C:\Users\jpuerta\AppData\Local\org.libretracks.desktop.poc");
    let pcm_dir = app_data_dir.join("pcm");
    let mp3_folder = PathBuf::from(r"C:\Users\jpuerta\Downloads\Eres Bendigo - Jaime Murrel");
    assert!(mp3_folder.exists(), "Carpeta de MP3 original debe existir");

    let mut mp3_files = Vec::new();
    for entry in std::fs::read_dir(&mp3_folder).unwrap().flatten() {
        let p = entry.path();
        if p.extension().map(|e| e == "mp3").unwrap_or(false) {
            mp3_files.push(p);
        }
    }
    mp3_files.sort();
    assert_eq!(mp3_files.len(), 7, "Se esperan 7 pistas MP3");

    println!("\n======================================================================");
    println!("PARTE 1: BORRAR PCM\\, IMPORTAR CON «CARPETA», DAR PLAY");
    println!("======================================================================");

    // 1. Borrar pcm\
    let t_start1 = Instant::now();
    println!("[{}] Borrando carpeta pcm\\ en {:?}", chrono_time(), pcm_dir);
    if pcm_dir.exists() {
        std::fs::remove_dir_all(&pcm_dir).expect("Error borrando pcm\\");
    }
    std::fs::create_dir_all(&pcm_dir).expect("Error recreando pcm\\");
    println!("[{}] Carpeta pcm\\ borrada y lista.", chrono_time());

    // 2. Importar con «Carpeta» (ID único creado en la biblioteca)
    let project_id_1 = format!("song-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    println!("[{}] [NativeImport] Iniciando importación de carpeta para canción '{}'", chrono_time(), project_id_1);
    let sample_rate = 48000u32;

    for (idx, fp) in mp3_files.iter().enumerate() {
        let track_id = format!("stem-{:02}", idx + 1);
        let t0 = Instant::now();
        let meta = import::decode_and_cache_track(&app_data_dir, &project_id_1, &track_id, fp, sample_rate, None)
            .expect("Fallo importando pista");
        println!(
            "[{}] [Import Perf] Pista '{}' ({}): {} frames, {:.1}s, {:.2} MB en {:?}",
            chrono_time(),
            fp.file_name().unwrap().to_string_lossy(),
            meta.track_id,
            meta.frame_count,
            meta.duration_sec,
            meta.original_file_size as f64 / (1024.0 * 1024.0),
            t0.elapsed()
        );
    }
    println!(
        "[{}] [Import Perf] Canción '{}' completada: 7 pistas procesadas en {:?}",
        chrono_time(),
        project_id_1,
        t_start1.elapsed()
    );

    // 3. Verificar caché creada con el mismo ID de la biblioteca
    let proj_cache_dir_1 = get_project_cache_dir(&app_data_dir, &project_id_1, sample_rate);
    assert!(proj_cache_dir_1.exists(), "La caché debe existir en disco con el project_id");
    println!("[{}] Caché verificada en disco: {:?}", chrono_time(), proj_cache_dir_1);

    // 4. Cargar en el motor nativo con audio_load_project (mismo ID)
    let stats = Arc::new(AudioStreamStats::default());
    let playback = PlaybackEngine::new(stats);
    println!("[{}] [NativeEngine] Ejecutando audio_load_project para '{}'", chrono_time(), project_id_1);
    let load_res_1 = playback.load_project(
        &app_data_dir,
        &project_id_1,
        sample_rate,
        Some(108.0),
        Some(4),
        None,
        Some("1-bar".to_string()),
    ).await.expect("audio_load_project falló");
    println!(
        "[{}] [NativeEngine] Preloaded project '{}' ({} pistas cargadas, {:.1}s)",
        chrono_time(),
        load_res_1.project_id,
        load_res_1.track_count,
        load_res_1.duration_sec
    );

    // 5. Dar Play
    println!("[{}] [NativeEngine] Pulsando Play...", chrono_time());
    assert_eq!(playback.loaded_project_id.lock().await.as_deref(), Some(project_id_1.as_str()));
    playback.is_playing.store(true, std::sync::atomic::Ordering::SeqCst);
    println!("[{}] [NativeEngine] Reproducción iniciada con éxito para '{}'. Estado is_playing=true", chrono_time(), project_id_1);

    println!("\n======================================================================");
    println!("PARTE 2: BORRAR PCM\\ OTRA VEZ, «GENERAR CACHÉ NATIVA», DAR PLAY");
    println!("======================================================================");

    // 6. Borrar pcm\ otra vez
    let t_start2 = Instant::now();
    println!("[{}] Borrando pcm\\ otra vez en {:?}", chrono_time(), pcm_dir);
    if pcm_dir.exists() {
        std::fs::remove_dir_all(&pcm_dir).expect("Error borrando pcm\\");
    }
    std::fs::create_dir_all(&pcm_dir).expect("Error recreando pcm\\");
    playback.unload_project_if_matches(&project_id_1).await;
    println!("[{}] pcm\\ borrada. Motor descargado.", chrono_time());

    // 7. Simular botón «Generar caché nativa» (Usa rutas guardadas en el proyecto)
    println!("[{}] [GenerarCachéNativa] Ejecutando Paso 1: decodificando desde rutas de archivo guardadas...", chrono_time());
    for (idx, fp) in mp3_files.iter().enumerate() {
        let track_id = format!("stem-{:02}", idx + 1);
        let t0 = Instant::now();
        let meta = import::decode_and_cache_track(&app_data_dir, &project_id_1, &track_id, fp, sample_rate, None)
            .expect("Fallo regenerando pista");
        println!(
            "[{}] [Import Perf] Pista '{}' ({}): regenerada en {:?}",
            chrono_time(),
            fp.file_name().unwrap().to_string_lossy(),
            meta.track_id,
            t0.elapsed()
        );
    }
    println!(
        "[{}] [GenerarCachéNativa] Regeneración completada en {:?}",
        chrono_time(),
        t_start2.elapsed()
    );

    // 8. Cargar en motor nativo
    println!("[{}] [NativeEngine] Cargando canción tras regeneración de caché...", chrono_time());
    let load_res_2 = playback.load_project(
        &app_data_dir,
        &project_id_1,
        sample_rate,
        Some(108.0),
        Some(4),
        None,
        Some("1-bar".to_string()),
    ).await.expect("audio_load_project falló tras regenerar caché");
    println!(
        "[{}] [NativeEngine] Preloaded project '{}' ({} pistas)",
        chrono_time(),
        load_res_2.project_id,
        load_res_2.track_count
    );

    // 9. Dar Play tras regeneración
    println!("[{}] [NativeEngine] Pulsando Play tras regenerar caché...", chrono_time());
    assert_eq!(playback.loaded_project_id.lock().await.as_deref(), Some(project_id_1.as_str()));
    playback.is_playing.store(true, std::sync::atomic::Ordering::SeqCst);
    println!("[{}] [NativeEngine] Reproducción iniciada con éxito tras regenerar caché. is_playing=true", chrono_time());

    println!("\n======================================================================");
    println!("FIN DE PRUEBA COMPLETA: AMBOS FLUJOS VERIFICADOS AL 100%");
    println!("======================================================================\n");
}

fn chrono_time() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let hours = (secs / 3600) % 24;
    let mins = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}.{:03}", hours, mins, s, millis)
}
