use omnitracks_desktop::audio::import;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

fn write_dummy_wav_4min(path: &Path, sample_rate: u32, channels: u16, duration_sec: u32) {
    let mut f = File::create(path).unwrap();
    let bytes_per_sample = 2u16;
    let block_align = channels * bytes_per_sample;
    let byte_rate = sample_rate * block_align as u32;
    let total_frames = (sample_rate * duration_sec) as usize;
    let data_len = (total_frames * block_align as usize) as u32;
    let total_len = 36 + data_len;

    f.write_all(b"RIFF").unwrap();
    f.write_all(&(total_len.to_le_bytes())).unwrap();
    f.write_all(b"WAVE").unwrap();

    f.write_all(b"fmt ").unwrap();
    f.write_all(&(16u32.to_le_bytes())).unwrap();
    f.write_all(&(1u16.to_le_bytes())).unwrap();
    f.write_all(&(channels.to_le_bytes())).unwrap();
    f.write_all(&(sample_rate.to_le_bytes())).unwrap();
    f.write_all(&(byte_rate.to_le_bytes())).unwrap();
    f.write_all(&(block_align.to_le_bytes())).unwrap();
    f.write_all(&(16u16.to_le_bytes())).unwrap();

    f.write_all(b"data").unwrap();
    f.write_all(&(data_len.to_le_bytes())).unwrap();

    // Write audio in chunks (1 kHz tone)
    let chunk_frames = 4096;
    let mut chunk = vec![0i16; chunk_frames * (channels as usize)];
    let freq = 1000.0f32;
    let mut frame_idx = 0usize;

    while frame_idx < total_frames {
        let n = (total_frames - frame_idx).min(chunk_frames);
        for i in 0..n {
            let t = (frame_idx + i) as f32 / sample_rate as f32;
            let val = ((t * freq * 2.0 * std::f32::consts::PI).sin() * 16000.0) as i16;
            for ch in 0..(channels as usize) {
                chunk[i * (channels as usize) + ch] = val;
            }
        }
        let byte_slice = unsafe {
            std::slice::from_raw_parts(
                chunk.as_ptr() as *const u8,
                n * (channels as usize) * 2,
            )
        };
        f.write_all(byte_slice).unwrap();
        frame_idx += n;
    }
}

#[tokio::test]
async fn test_benchmark_7_track_mp3_and_wav() {
    let base_temp = std::env::temp_dir().join(format!("omnitracks_bench_{}", std::process::id()));
    let cache_dir = base_temp.join("cache");
    let wav_dir = base_temp.join("wav_sources");
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::create_dir_all(&wav_dir).unwrap();

    println!("\n========================================================");
    println!("   OMNITRACKS NATIVE ENGINE IMPORT BENCHMARK (TELEMETRY)");
    println!("========================================================\n");

    // -----------------------------------------------------------------
    // 1. BENCHMARK 7-TRACK MP3 (~4 min 20 s)
    // -----------------------------------------------------------------
    let mp3_folder = PathBuf::from(r"C:\Users\jpuerta\Downloads\Eres Bendigo - Jaime Murrel");
    if mp3_folder.exists() {
        println!(">>> [BENCHMARK 1] Canción MP3: 7 stems (~4m 20s cada uno) desde:");
        println!("    {:?}\n", mp3_folder);

        let entries = std::fs::read_dir(&mp3_folder).unwrap();
        let mut mp3_files = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().map(|e| e == "mp3").unwrap_or(false) {
                mp3_files.push(p);
            }
        }
        mp3_files.sort();

        println!("Archivos encontrados: {}", mp3_files.len());
        assert_eq!(mp3_files.len(), 7, "Se esperaban 7 pistas MP3");

        let project_id = "bench-mp3-7tracks";
        let target_rate = 48000;

        let start_all = Instant::now();
        let semaphore = Arc::new(tokio::sync::Semaphore::new(3));
        let mut tasks = Vec::new();

        for (idx, file_path) in mp3_files.into_iter().enumerate() {
            let sem = Arc::clone(&semaphore);
            let cache_dir_clone = cache_dir.clone();
            let proj_clone = project_id.to_string();
            let track_id = format!("stem-{:02}", idx + 1);

            tasks.push(tokio::spawn(async move {
                let _permit = sem.acquire_owned().await.unwrap();
                tokio::task::spawn_blocking(move || {
                    let _p = _permit;
                    import::decode_and_cache_track(
                        &cache_dir_clone,
                        &proj_clone,
                        &track_id,
                        &file_path,
                        target_rate,
                        None,
                    )
                })
                .await
                .unwrap()
            }));
        }

        let mut results = Vec::new();
        for t in tasks {
            results.push(t.await.unwrap().unwrap());
        }
        let total_mp3_time = start_all.elapsed();

        println!("\n--- RESULTADO MP3 (7 Pistas en Paralelo) ---");
        println!("Total pistas procesadas: {}", results.len());
        println!("Tiempo total de importación MP3: {:.2?}", total_mp3_time);
        println!("¿Cumple objetivo (< 15 s)?: {}", if total_mp3_time.as_secs_f64() < 15.0 { "SÍ (SUPERADO CON CRECES)" } else { "NO" });

        for r in &results {
            println!(
                "  Pista {}: frames={}, duración={:.1}s, canales={}, tamaño={:.2} MB",
                r.track_id,
                r.frame_count,
                r.duration_sec,
                r.channels,
                r.original_file_size as f64 / (1024.0 * 1024.0)
            );
        }
    } else {
        println!("Carpeta MP3 no encontrada en {:?}", mp3_folder);
    }

    // -----------------------------------------------------------------
    // 2. BENCHMARK 7-TRACK WAV (4 min cada uno, 44.1 kHz Stereo 16-bit)
    // -----------------------------------------------------------------
    println!("\n>>> [BENCHMARK 2] Generando 7 stems WAV (4 min, 44.1 kHz, 16-bit)...");
    let mut wav_files = Vec::new();
    for i in 1..=7 {
        let p = wav_dir.join(format!("track_{:02}.wav", i));
        write_dummy_wav_4min(&p, 44100, 2, 240); // 4 min = 240s
        wav_files.push(p);
    }
    println!("7 stems WAV generados (~42.3 MB cada uno, 296 MB total)\n");

    let project_id_wav = "bench-wav-7tracks";
    let target_rate = 48000;

    let start_all_wav = Instant::now();
    let semaphore_wav = Arc::new(tokio::sync::Semaphore::new(3));
    let mut tasks_wav = Vec::new();

    for (idx, file_path) in wav_files.into_iter().enumerate() {
        let sem = Arc::clone(&semaphore_wav);
        let cache_dir_clone = cache_dir.clone();
        let proj_clone = project_id_wav.to_string();
        let track_id = format!("wav-stem-{:02}", idx + 1);

        tasks_wav.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.unwrap();
            tokio::task::spawn_blocking(move || {
                let _p = _permit;
                import::decode_and_cache_track(
                    &cache_dir_clone,
                    &proj_clone,
                    &track_id,
                    &file_path,
                    target_rate,
                    None,
                )
            })
            .await
            .unwrap()
        }));
    }

    let mut results_wav = Vec::new();
    for t in tasks_wav {
        results_wav.push(t.await.unwrap().unwrap());
    }
    let total_wav_time = start_all_wav.elapsed();

    println!("\n--- RESULTADO WAV (7 Pistas en Paralelo) ---");
    println!("Total pistas procesadas: {}", results_wav.len());
    println!("Tiempo total de importación WAV (296 MB): {:.2?}", total_wav_time);
    for r in &results_wav {
        println!(
            "  Pista {}: frames={}, duración={:.1}s, canales={}, tamaño={:.2} MB",
            r.track_id,
            r.frame_count,
            r.duration_sec,
            r.channels,
            r.original_file_size as f64 / (1024.0 * 1024.0)
        );
    }

    // Cleanup temp
    let _ = std::fs::remove_dir_all(&base_temp);
    println!("\n========================================================");
    println!("   FIN DEL BENCHMARK DE IMPORTACIÓN");
    println!("========================================================\n");
}
