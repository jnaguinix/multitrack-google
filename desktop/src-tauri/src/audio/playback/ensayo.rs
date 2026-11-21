//! Ensayo del motor sin hardware (plan de correcciones, «Transversal — ensayo», parte 2).
//!
//! Un recorrido de una sesión completa con audio sintético, como la haría quien toca en directo: cargar una
//! canción con su mezcla, Play, mover el fader, mute y solo, saltar de posición, saltar de sección, activar y
//! quitar el vamp, cambiar el tono, pausar y reanudar, cambiar de canción mientras suena, parar y llegar al
//! final. No abre ningún dispositivo: el callback es el mismo `BlockMixer` que el de CPAL, ejecutado con
//! `simulate_callback_block`, y los hilos de lectura son los reales.
//!
//! Qué comprueba en cada paso:
//!  - lo que suena coincide con el reloj de la canción: cada pista es una rampa (valor = fotograma /
//!    `PASO_RAMPA`), así que de la salida se lee en qué punto de la canción está el audio. Como la salida es la
//!    suma de las pistas audibles, también se comprueba la mezcla: si el motor suma una pista que debía estar
//!    en mute, la posición leída no coincide con el reloj;
//!  - la salida es siempre finita y nunca pasa de ±1;
//!  - lo que el motor informa de cada pista (`trackControls`) es lo que se pidió;
//!  - tras pausar o parar hay silencio y el reloj no avanza.
//!
//! No sustituye a las pruebas puntuales de `tests.rs` (cada una persigue un fallo concreto): comprueba que el
//! conjunto sigue funcionando junto. Cada hallazgo nuevo del plan puede añadir aquí su paso. Sin medir: oído,
//! dispositivo real, tiempos del callback.

use super::*;
use crate::audio::cache::{write_track_pcm_and_metadata, TrackPcmMetadata};

const SR: u32 = 48_000;
/// Fotogramas por unidad de rampa. Con 12 s el valor máximo es 9 600: tres pistas sumadas quedan por debajo de
/// 0,65 y no activan el limitador (que cambiaría la amplitud y haría ilegible la posición).
const PASO_RAMPA: usize = 60;
/// Ganancia de una pista centrada (pan 0, ganancia 1): cos(π/4).
const CENTRO: f32 = 0.707_106_78;
const BLOQUE: usize = 480;
/// Bloques que se dejan pasar tras un cambio de mezcla antes de leer la posición (la rampa de ganancia de 10 ms
/// de constante de tiempo tarda unas decenas de ms en asentarse).
const ASENTAR: u32 = 12;

fn seccion(id: &str, inicio: f64, fin: f64) -> NativeSongSection {
    NativeSongSection { id: id.to_string(), name: id.to_string(), code: None, start_sec: inicio, end_sec: fin }
}

/// Escribe una caché PCM sintética de rampas estéreo (una por pista) y devuelve su carpeta base.
fn escribir_cache(nombre: &str, pistas: &[&str], frames: usize) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("omnitracks_ensayo_{nombre}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for id in pistas {
        let mut muestras = Vec::with_capacity(frames * 2);
        for f in 0..frames {
            let v = (f / PASO_RAMPA) as i16;
            muestras.push(v);
            muestras.push(v);
        }
        let meta = TrackPcmMetadata {
            format_version: 1,
            track_id: id.to_string(),
            target_sample_rate: SR,
            original_sample_rate: SR,
            original_channels: 2,
            original_path: format!("{nombre}/{id}.wav"),
            original_file_size: (frames * 4) as u64,
            original_modified_ms: 1000,
            channels: 2,
            is_effectively_mono: false,
            frame_count: frames as u64,
            duration_sec: frames as f64 / SR as f64,
            peaks: vec![0.5; 16],
            created_at: "1000".to_string(),
        };
        write_track_pcm_and_metadata(&dir, nombre, &meta, &muestras).unwrap();
    }
    dir
}

/// Lo que el ensayo cree que hay en cada pista: el modelo contra el que se compara al motor.
#[derive(Clone)]
struct Pista {
    id: &'static str,
    gain: f32,
    muted: bool,
    solo: bool,
}

struct Bloque {
    /// Posición de la canción que suena en el último fotograma (`None` si salió en silencio o no se puede leer).
    pos: Option<i64>,
    reloj: u64,
    silencio: bool,
}

#[derive(Default, Debug)]
struct Resumen {
    bloques: u32,
    con_audio: u32,
    desajustes: u32,
}

struct Ensayo {
    engine: PlaybackEngine,
    pistas: Vec<Pista>,
    paso: String,
    asentando: u32,
    total_bloques: u64,
}

impl Ensayo {
    fn nuevo(engine: PlaybackEngine, pistas: &[&'static str]) -> Self {
        Ensayo {
            engine,
            pistas: pistas.iter().map(|id| Pista { id, gain: 1.0, muted: false, solo: false }).collect(),
            paso: "inicio".into(),
            asentando: 0,
            total_bloques: 0,
        }
    }

    fn paso(&mut self, nombre: &str) {
        self.paso = nombre.to_string();
    }

    fn pista(&mut self, id: &str) -> &mut Pista {
        self.pistas.iter_mut().find(|p| p.id == id).unwrap_or_else(|| panic!("el ensayo no tiene la pista {id}"))
    }

    /// Suma de ganancias de las pistas que deben sonar según el modelo.
    fn suma_audible(&self) -> f32 {
        let hay_solo = self.pistas.iter().any(|p| p.solo);
        self.pistas.iter().filter(|p| !p.muted && (!hay_solo || p.solo)).map(|p| p.gain).sum()
    }

    /// Pide al motor un cambio de la pista y lo anota en el modelo. Deja asentar la rampa antes de leer la posición.
    async fn mezcla(&mut self, id: &'static str, gain: Option<f32>, muted: Option<bool>, solo: Option<bool>) {
        self.engine.set_track_controls(id, gain, None, muted, solo, None).await;
        let p = self.pista(id);
        if let Some(g) = gain {
            p.gain = g;
        }
        if let Some(m) = muted {
            p.muted = m;
        }
        if let Some(s) = solo {
            p.solo = s;
        }
        self.asentando = ASENTAR;
    }

    /// Un bloque de 480 fotogramas del callback simulado (con una pausa para dejar trabajar a los hilos de lectura).
    /// Aplica las reglas que valen siempre: salida finita y dentro de ±1.
    fn bloque(&mut self) -> Bloque {
        let mut buf = vec![0.0f32; BLOQUE * 2];
        self.engine.simulate_callback_block(&mut buf, 2);
        std::thread::sleep(std::time::Duration::from_millis(5));
        self.total_bloques += 1;
        for (i, v) in buf.iter().enumerate() {
            assert!(v.is_finite(), "[{}] muestra no finita ({v}) en el bloque {} posición {i}", self.paso, self.total_bloques);
            assert!(v.abs() <= 1.0 + 1e-6, "[{}] muestra fuera de ±1 ({v}) en el bloque {}", self.paso, self.total_bloques);
        }
        let silencio = buf.iter().all(|v| *v == 0.0);
        let ultimo = buf[(BLOQUE - 1) * 2];
        let suma = self.suma_audible();
        let pos = if self.asentando > 0 || suma <= 0.0 || ultimo.abs() < 1e-6 {
            None
        } else {
            Some((ultimo / (suma * CENTRO) * 32768.0 * PASO_RAMPA as f32).round() as i64)
        };
        self.asentando = self.asentando.saturating_sub(1);
        Bloque { pos, reloj: self.engine.current_frame.load(Ordering::SeqCst), silencio }
    }

    /// Renderiza `n` bloques comprobando que lo que suena coincide con el reloj (los bloques en buffering no cuentan).
    fn correr(&mut self, n: u32) -> Resumen {
        let mut r = Resumen::default();
        for _ in 0..n {
            let b = self.bloque();
            if self.engine.is_buffering.load(Ordering::SeqCst) {
                continue;
            }
            r.bloques += 1;
            if let Some(p) = b.pos {
                r.con_audio += 1;
                if (p - b.reloj as i64).abs() > 1000 {
                    r.desajustes += 1;
                }
            }
        }
        r
    }

    /// Exige `n` bloques con audio y, como mucho, `tolerancia` desajustados.
    fn correr_alineado(&mut self, n: u32, tolerancia: u32) -> Resumen {
        let r = self.correr(n);
        assert!(
            r.con_audio * 2 >= r.bloques && r.con_audio > 0,
            "[{}] casi no sonó audio: {r:?} (bloques totales {})",
            self.paso,
            self.total_bloques
        );
        assert!(r.desajustes <= tolerancia, "[{}] lo que suena no coincide con el reloj o con la mezcla pedida: {r:?}", self.paso);
        r
    }

    /// Renderiza hasta que se cumpla `cond` o pasen `max_s` segundos de reloj de pared.
    fn hasta(&mut self, descripcion: &str, max_s: u64, cond: impl Fn(&PlaybackEngine) -> bool) {
        let limite = Instant::now() + std::time::Duration::from_secs(max_s);
        while Instant::now() < limite {
            if cond(&self.engine) {
                return;
            }
            self.bloque();
        }
        panic!("[{}] no se cumplió «{descripcion}» en {max_s} s", self.paso);
    }

    fn esperar_listo(&mut self) {
        self.hasta("salir de buffering", 5, |e| !e.is_buffering.load(Ordering::SeqCst));
    }

    async fn reproducir(&mut self) {
        self.engine.begin_playback(|| async { Ok::<(), String>(()) }).await.unwrap();
    }

    fn reloj(&self) -> u64 {
        self.engine.current_frame.load(Ordering::SeqCst)
    }

    /// Lo que el motor informa de cada pista es lo que el modelo pidió.
    fn comprobar_estado_de_pistas(&self) {
        let estado = self.engine.get_playback_state();
        for p in &self.pistas {
            let t = estado
                .track_controls
                .iter()
                .find(|t| t.track_id == p.id)
                .unwrap_or_else(|| panic!("[{}] el motor no informa de la pista {}", self.paso, p.id));
            assert!((t.gain - p.gain).abs() < 1e-6, "[{}] {}: ganancia {} en el motor, {} pedida", self.paso, p.id, t.gain, p.gain);
            assert_eq!(t.muted, p.muted, "[{}] {}: mute", self.paso, p.id);
            assert_eq!(t.soloed, p.solo, "[{}] {}: solo", self.paso, p.id);
            assert!(t.feeder_alive, "[{}] {}: el hilo de lectura murió", self.paso, p.id);
        }
    }

    /// Reloj parado y silencio durante `n` bloques (pausa, parada).
    fn exigir_silencio_y_reloj_parado(&mut self, n: u32) {
        let reloj = self.reloj();
        for _ in 0..n {
            let b = self.bloque();
            assert!(b.silencio, "[{}] sigue sonando audio con el motor parado o en pausa", self.paso);
            assert_eq!(b.reloj, reloj, "[{}] el reloj avanza con el motor parado o en pausa", self.paso);
        }
    }
}

fn control_inicial(id: &str, muted: bool) -> InitialTrackControl {
    InitialTrackControl {
        track_id: id.to_string(),
        gain: Some(1.0),
        pan: Some(0),
        muted: Some(muted),
        soloed: Some(false),
        bus: Some("main".to_string()),
        monitor: None,
        split_sequence: None,
        cue_gain: None,
        cue_muted: None,
    }
}

#[tokio::test]
async fn ensayo_de_una_sesion_completa_sin_hardware() {
    // Canción A: tres pistas de 12 s con tres secciones de 4 s. La pista «c» nace en mute.
    let frames = 12 * SR as usize;
    let ids = ["pista-a", "pista-b", "pista-c"];
    let dir = escribir_cache("sesion_a", &ids, frames);
    let engine = PlaybackEngine::new(Arc::new(AudioStreamStats::default()));
    engine.metronome.lock().unwrap().config.enabled = false;
    let controles = vec![control_inicial("pista-a", false), control_inicial("pista-b", false), control_inicial("pista-c", true)];
    let secciones = vec![seccion("a", 0.0, 4.0), seccion("b", 4.0, 8.0), seccion("c", 8.0, 12.0)];
    let info = engine
        .load_project_with_controls(&dir, "sesion_a", SR, Some(120.0), Some(4), Some(secciones.clone()), Some("1-bar".to_string()), Some(controles))
        .await
        .expect("cargar la canción");
    assert_eq!(info.track_count, 3);
    assert_eq!(info.total_frames, frames as u64);

    let mut e = Ensayo::nuevo(engine, &ids);
    e.pista("pista-c").muted = true;

    // --- 1. Cargada pero sin Play: silencio y reloj en 0 -------------------------------------------------
    e.paso("cargada, sin Play");
    // Sin Play no hay callback real: el motor queda en buffering hasta que alguien le da Play, y eso es lo esperado.
    e.comprobar_estado_de_pistas();
    e.exigir_silencio_y_reloj_parado(5);
    assert_eq!(e.reloj(), 0);

    // --- 2. Play: audio alineado con el reloj y sin la pista en mute ----------------------------------------
    e.paso("Play");
    e.reproducir().await;
    e.correr_alineado(150, 3);
    assert!(e.reloj() > 40_000, "el reloj apenas avanzó: {}", e.reloj());
    e.comprobar_estado_de_pistas();

    // --- 3. Fader ----------------------------------------------------------------------------------------
    e.paso("fader de la pista a a 0,5");
    e.mezcla("pista-a", Some(0.5), None, None).await;
    e.correr_alineado(60, 3);
    e.comprobar_estado_de_pistas();

    // --- 4. Mute y desmute (la pista c deja de estar en mute: ahora suenan las tres) -------------------------
    e.paso("quitar el mute de la pista c");
    e.mezcla("pista-c", None, Some(false), None).await;
    e.correr_alineado(60, 3);
    e.paso("mute de la pista b");
    e.mezcla("pista-b", None, Some(true), None).await;
    e.correr_alineado(60, 3);
    e.comprobar_estado_de_pistas();
    e.paso("quitar el mute de la pista b");
    e.mezcla("pista-b", None, Some(false), None).await;
    e.correr_alineado(60, 3);

    // --- 5. Solo ----------------------------------------------------------------------------------------
    e.paso("solo de la pista a");
    e.mezcla("pista-a", None, None, Some(true)).await;
    e.correr_alineado(60, 3);
    e.comprobar_estado_de_pistas();
    e.paso("quitar el solo");
    e.mezcla("pista-a", None, None, Some(false)).await;
    e.correr_alineado(60, 3);

    // --- 6. Seek con la canción sonando -------------------------------------------------------------------
    e.paso("seek a 5 s");
    e.engine.seek(5.0).await;
    e.esperar_listo();
    e.correr(10);
    let r = e.correr_alineado(60, 3);
    assert!(r.bloques > 0);
    let reloj = e.reloj();
    assert!((reloj as i64 - 5 * SR as i64).abs() < SR as i64, "tras el seek a 5 s el reloj está en {reloj}");

    // --- 7. Salto de sección cuantizado (de B a C) -------------------------------------------------------
    e.paso("salto a la sección c");
    let salto = e.engine.queue_section_jump("c", None).await.expect("encolar el salto");
    assert_eq!(salto.target_section_id, "c");
    let objetivo = (8.0 * SR as f64) as u64;
    e.hasta("llegar a la sección c", 10, |en| en.current_frame.load(Ordering::SeqCst) >= objetivo);
    e.esperar_listo();
    e.correr_alineado(60, 3);
    assert!(e.reloj() >= objetivo && e.reloj() < 12 * SR as u64, "tras el salto el reloj está en {}", e.reloj());
    let estado = e.engine.get_playback_state();
    assert_eq!(estado.active_section_id.as_deref(), Some("c"), "la sección activa informada no es la que suena");
    assert!(estado.queued_section_id.is_none(), "el salto sigue en cola después de hacerlo");

    // --- 8. Vamp sobre la sección c ----------------------------------------------------------------------
    e.paso("vamp en la sección c");
    assert!(e.engine.toggle_vamp(Some(true)).await, "el vamp no se activó con la sección c sonando");
    let (mut vueltas, mut previo) = (0, e.reloj());
    for _ in 0..560 {
        // 5,6 s de audio: más que la vuelta de 4 s de la sección.
        let b = e.bloque();
        assert!(b.reloj < 12 * SR as u64, "[vamp] el reloj salió de la sección c: {}", b.reloj);
        assert!(e.engine.is_playing.load(Ordering::SeqCst), "[vamp] el vamp detuvo la reproducción");
        if b.reloj + 20_000 < previo {
            vueltas += 1;
        }
        previo = b.reloj;
    }
    assert!(vueltas >= 1, "[vamp] el reloj nunca dio la vuelta del bucle");
    e.paso("quitar el vamp");
    assert!(!e.engine.toggle_vamp(Some(false)).await);
    e.correr_alineado(60, 4);

    // --- 9. Cambio de tono sin cambiar la velocidad --------------------------------------------------------
    e.paso("volver a 1 s");
    e.engine.seek(1.0).await;
    e.esperar_listo();
    e.correr(10);
    e.paso("tono +2");
    e.engine.set_pitch(2).await;
    e.esperar_listo();
    e.correr(10);
    let (mut por_bloque, mut bloques) = (0u32, 0u32);
    for _ in 0..120 {
        let antes = e.reloj();
        let b = e.bloque();
        if b.reloj > antes {
            assert_eq!(b.reloj - antes, BLOQUE as u64, "[tono +2] el reloj debe avanzar lo que dura el bloque");
            por_bloque += 1;
        }
        if !b.silencio {
            bloques += 1;
        }
    }
    assert!(por_bloque >= 100, "[tono +2] el reloj no avanzó con el tono cambiado ({por_bloque} bloques)");
    assert!(bloques >= 80, "[tono +2] casi no sonó audio ({bloques} bloques)");
    e.paso("tono 0");
    e.engine.set_pitch(0).await;
    e.esperar_listo();
    e.correr(20);
    e.correr_alineado(60, 3);

    // --- 10. Pausa y reanudación -------------------------------------------------------------------------
    e.paso("pausa");
    let antes_de_pausar = e.reloj();
    e.engine.pause().await;
    assert!(!e.engine.is_playing.load(Ordering::SeqCst));
    e.exigir_silencio_y_reloj_parado(10);
    assert!(e.reloj().abs_diff(antes_de_pausar) < 2_000, "la pausa movió el reloj: {antes_de_pausar} → {}", e.reloj());
    e.paso("reanudar tras la pausa");
    let en_pausa = e.reloj();
    e.reproducir().await;
    e.correr_alineado(80, 4);
    assert!(e.reloj() > en_pausa, "tras reanudar el reloj no avanza");

    // --- 11. Cambio de canción con la anterior sonando --------------------------------------------------------
    e.paso("cambio de canción mientras suena");
    let dir_b = escribir_cache("sesion_b", &["pista-x", "pista-y"], 6 * SR as usize);
    e.engine
        .load_project_with_controls(
            &dir_b,
            "sesion_b",
            SR,
            Some(100.0),
            Some(4),
            Some(vec![seccion("a", 0.0, 6.0)]),
            Some("1-bar".to_string()),
            Some(vec![control_inicial("pista-x", false), control_inicial("pista-y", false)]),
        )
        .await
        .expect("cargar la segunda canción");
    assert!(!e.engine.is_playing.load(Ordering::SeqCst), "cargar otra canción debe detener la anterior");
    assert_eq!(e.engine.loaded_project_id.lock().await.as_deref(), Some("sesion_b"));
    assert_eq!(e.reloj(), 0, "la canción nueva debe empezar en 0");
    e.pistas = vec![Pista { id: "pista-x", gain: 1.0, muted: false, solo: false }, Pista { id: "pista-y", gain: 1.0, muted: false, solo: false }];
    e.asentando = 0;
    e.comprobar_estado_de_pistas();
    let estado = e.engine.get_playback_state();
    assert_eq!(estado.track_controls.len(), 2, "el motor sigue informando de las pistas de la canción anterior");
    e.reproducir().await;
    e.esperar_listo();
    e.correr_alineado(100, 3);

    // --- 12. Parar ----------------------------------------------------------------------------------------
    e.paso("stop");
    e.engine.stop().await;
    assert!(!e.engine.is_playing.load(Ordering::SeqCst));
    assert_eq!(e.reloj(), 0, "parar debe volver al inicio");
    e.exigir_silencio_y_reloj_parado(10);

    // --- 13. Llegar al final de la canción ------------------------------------------------------------------
    e.paso("final de la canción");
    e.engine.seek(6.0 - 1.0).await;
    e.reproducir().await;
    e.esperar_listo();
    e.hasta("terminar la reproducción al llegar al final", 8, |en| !en.is_playing.load(Ordering::SeqCst));
    assert!(e.reloj() >= 6 * SR as u64, "terminó sin llegar al final: {}", e.reloj());
    e.paso("silencio tras el final");
    for _ in 0..10 {
        let b = e.bloque();
        assert!(b.silencio, "[silencio tras el final] sigue sonando audio");
    }
    assert!(!e.engine.is_buffering.load(Ordering::SeqCst), "[final] el motor se quedó en buffering");
    let _ = e.engine.get_playback_state();
}

#[tokio::test]
async fn ensayo_una_cancion_cargada_sin_play_no_cuenta_como_buffering_atascado() {
    // Hallazgo del ensayo: sin Play no hay salida abierta ni callback que saque al motor de buffering, así que
    // `is_buffering` sigue en true tras cargar. La interfaz avisa «la canción tarda demasiado en prepararse»
    // cuando `bufferingMs` pasa de 5 s: con la canción solo cargada (el DAW siempre montado la carga al abrir la
    // app) ese aviso saldría siempre. `buffering_ms` solo debe contar con la reproducción pedida.
    let dir = escribir_cache("sin_play", &["pista-a"], 6 * SR as usize);
    let engine = PlaybackEngine::new(Arc::new(AudioStreamStats::default()));
    engine.metronome.lock().unwrap().config.enabled = false;
    engine
        .load_project(&dir, "sin_play", SR, Some(120.0), Some(4), Some(vec![seccion("a", 0.0, 6.0)]), Some("1-bar".to_string()))
        .await
        .expect("cargar");
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let cargada = engine.get_playback_state();
    assert!(!cargada.is_playing);
    assert_eq!(cargada.buffering_ms, 0, "cargada sin Play no está esperando audio: no debe contar como buffering atascado");

    // Con Play pedido y sin callback que lo atienda (una salida que no arranca), sí cuenta: ahí está el atasco real.
    engine.begin_playback(|| async { Ok::<(), String>(()) }).await.unwrap();
    // La espera se cuenta desde el Play, no desde que se cargó la canción (si no, pulsar Play tras un rato
    // avisaría de un atasco antes de que arranque la salida).
    let recien_pedido = engine.get_playback_state();
    assert!(recien_pedido.buffering_ms < 100, "la espera debe contarse desde el Play: {} ms", recien_pedido.buffering_ms);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let esperando = engine.get_playback_state();
    assert!(esperando.is_buffering && esperando.is_playing);
    assert!(esperando.buffering_ms >= 100, "con Play pedido y sin audio el atasco debe contarse: {} ms", esperando.buffering_ms);
}
