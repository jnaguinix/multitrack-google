//! Diagnóstico: mide la generación de caché PCM con la misma función y la misma
//! concurrencia que `audio_import_tracks`, sobre archivos reales, sin la interfaz.
//!
//! Uso (release):
//!   cargo run --release --example medir_cache -- [--hilos N] [--sr 48000] <carpeta o archivos...>
//!
//! Escribe la caché en una carpeta temporal propia (no toca la caché de la app) y la borra al final.

use omnitracks_desktop::audio::import;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(
            "info,symphonia=warn,symphonia_bundle_mp3=warn,symphonia_core=warn",
        ))
        .with_target(false)
        .with_ansi(false)
        .init();

    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut hilos: Option<usize> = None;
    let mut sr: u32 = 48000;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--hilos" => {
                hilos = args.get(i + 1).and_then(|v| v.parse().ok());
                args.drain(i..i + 2);
            }
            "--sr" => {
                sr = args.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(48000);
                args.drain(i..i + 2);
            }
            _ => i += 1,
        }
    }

    let mut files: Vec<PathBuf> = Vec::new();
    for a in &args {
        let p = PathBuf::from(a);
        if p.is_dir() {
            let mut entries: Vec<PathBuf> = std::fs::read_dir(&p)
                .expect("no se pudo leer la carpeta")
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    matches!(
                        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
                        Some("mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "aif" | "aiff")
                    )
                })
                .collect();
            entries.sort();
            files.extend(entries);
        } else {
            files.push(p);
        }
    }
    if files.is_empty() {
        eprintln!("Sin archivos de audio. Uso: medir_cache [--hilos N] [--sr 48000] <carpeta|archivos>");
        std::process::exit(2);
    }

    // Misma fórmula que audio_import_tracks (desktop/src-tauri/src/audio/mod.rs).
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    let app_concurrency = std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(2, 4))
        .unwrap_or(2);
    let concurrency = hilos.unwrap_or(app_concurrency);

    let base = std::env::temp_dir().join(format!("omnitracks-medir-cache-{}", std::process::id()));
    std::fs::create_dir_all(&base).expect("no se pudo crear carpeta temporal");
    let project_id = "medicion";

    println!(
        "CPU lógicas={cpus} | hilos app={app_concurrency} | hilos usados={concurrency} | destino={sr} Hz | pistas={}",
        files.len()
    );

    let queue: Arc<Mutex<VecDeque<(usize, PathBuf)>>> =
        Arc::new(Mutex::new(files.iter().cloned().enumerate().collect()));
    let results: Arc<Mutex<Vec<(usize, String, f64, Result<(), String>)>>> = Arc::new(Mutex::new(Vec::new()));

    let t0 = Instant::now();
    let mut handles = Vec::new();
    for _ in 0..concurrency {
        let q = Arc::clone(&queue);
        let r = Arc::clone(&results);
        let base = base.clone();
        handles.push(std::thread::spawn(move || loop {
            let next = q.lock().expect("cola envenenada").pop_front();
            let Some((idx, path)) = next else { break };
            let track_id = format!("t{idx:02}");
            let t = Instant::now();
            let res = import::decode_and_cache_track(&base, project_id, &track_id, &path, sr, None)
                .map(|_| ());
            let secs = t.elapsed().as_secs_f64();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            r.lock().expect("resultados envenenados").push((idx, name, secs, res));
        }));
    }
    for h in handles {
        if let Err(e) = h.join() {
            eprintln!("Un hilo de medición falló: {e:?}");
        }
    }
    let total = t0.elapsed().as_secs_f64();

    let mut res = results.lock().expect("resultados envenenados").clone();
    res.sort_by_key(|r| r.0);
    println!("\n--- Resumen ---");
    for (idx, name, secs, r) in &res {
        match r {
            Ok(()) => println!("t{idx:02}  {secs:7.2} s  {name}"),
            Err(e) => println!("t{idx:02}  ERROR  {name}: {e}"),
        }
    }
    println!("TOTAL canción (reloj de pared): {total:.2} s con {concurrency} hilos");

    if let Err(e) = std::fs::remove_dir_all(&base) {
        eprintln!("No se pudo borrar la carpeta temporal {:?}: {e}", base);
    }
}
