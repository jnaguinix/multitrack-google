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
//! Reglas sobre el audio renderizado (parte 3), vigiladas en cada bloque de toda la sesión:
//!  - sin escalones: dos muestras seguidas del mismo canal no se separan más de `ESCALON_MAXIMO` (un clic sería
//!    un salto de décimas; los fundidos y el suavizado de fader mueven milésimas). Se mide también entre bloques
//!    y al reanudar tras pausa, parada, seek o cambio de canción (debe empezar desde silencio);
//!  - sin recorte inesperado: a nivel normal la salida no pasa de `LIMITER_KNEE`; solo el paso de ganancias al
//!    máximo deja actuar al limitador, que debe contar muestras limitadas y no superar 1,0;
//!  - ganancias NaN o infinitas: se ignoran y el audio sigue sano;
//!  - pistas alineadas entre sí: cada pista sola se mide contra el reloj y ninguna se aparta de las demás;
//!  - cero asignaciones de memoria en `simulate_callback_block` durante toda la sesión (menos el primer bloque,
//!    que crea el mezclador).
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
/// Salto máximo entre dos muestras seguidas del mismo canal. Las rampas, los micro-fundidos de 8 ms y el suavizado
/// del fader cambian la salida en milésimas por muestra; un corte brusco (un clic) la cambia en décimas.
const ESCALON_MAXIMO: f32 = 0.01;

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
    /// Última muestra (izquierda y derecha) del bloque anterior, para vigilar los escalones entre bloques.
    previo: Option<[f32; 2]>,
    /// Mayor escalón visto desde que se creó el ensayo (informativo).
    escalon_mayor: f32,
    /// Asignaciones de memoria contadas dentro del callback simulado (la regla exige 0).
    asignaciones: u64,
    /// El primer bloque crea el mezclador y reserva sus búferes (como al abrir el stream): no cuenta.
    mezclador_creado: bool,
    /// Si el limitador puede actuar en el paso actual (solo en el paso de ganancias al máximo).
    permitir_limitador: bool,
    stats: Arc<AudioStreamStats>,
}

impl Ensayo {
    fn nuevo(engine: PlaybackEngine, pistas: &[&'static str]) -> Self {
        let stats = Arc::clone(&engine.stats);
        Ensayo {
            engine,
            previo: None,
            escalon_mayor: 0.0,
            asignaciones: 0,
            mezclador_creado: false,
            permitir_limitador: false,
            stats,
            pistas: pistas.iter().map(|id| Pista { id, gain: 1.0, muted: false, solo: false }).collect(),
            paso: "inicio".into(),
            asentando: 0,
            total_bloques: 0,
        }
    }

    fn paso(&mut self, nombre: &str) {
        self.paso = nombre.to_string();
    }

    /// Tras pausar, parar, hacer seek, cambiar el tono o cargar otra canción el motor espera a que el callback
    /// termine el micro-fundido de salida. Aquí no hay callback real que lo renderice, así que se da por hecho
    /// y se exige que el audio vuelva a empezar desde silencio (sin clic al reanudar).
    fn corte(&mut self) {
        self.previo = Some([0.0, 0.0]);
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
        if self.mezclador_creado {
            let engine = &self.engine;
            self.asignaciones += crate::alloc_probe::count_allocs(|| engine.simulate_callback_block(&mut buf, 2));
        } else {
            self.engine.simulate_callback_block(&mut buf, 2);
            self.mezclador_creado = true;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
        self.total_bloques += 1;
        for (i, v) in buf.iter().enumerate() {
            assert!(v.is_finite(), "[{}] muestra no finita ({v}) en el bloque {} posición {i}", self.paso, self.total_bloques);
            assert!(v.abs() <= 1.0 + 1e-6, "[{}] muestra fuera de ±1 ({v}) en el bloque {}", self.paso, self.total_bloques);
        }
        // Escalones: dos muestras seguidas del mismo canal no pueden distanciarse más que el fundido más rápido.
        // Un bloque en buffering sale en silencio sin fundido: ahí no hay continuidad que vigilar.
        let en_buffering = self.engine.is_buffering.load(Ordering::SeqCst);
        let mut escalon = 0.0f32;
        let mut anterior = if en_buffering { None } else { self.previo };
        for f in 0..BLOQUE {
            let ahora = [buf[f * 2], buf[f * 2 + 1]];
            if let Some(a) = anterior {
                escalon = escalon.max((ahora[0] - a[0]).abs()).max((ahora[1] - a[1]).abs());
            }
            anterior = Some(ahora);
        }
        self.previo = anterior;
        self.escalon_mayor = self.escalon_mayor.max(escalon);
        assert!(
            escalon <= ESCALON_MAXIMO,
            "[{}] escalón de {escalon} entre muestras seguidas en el bloque {} (máximo {ESCALON_MAXIMO}): sonaría un clic",
            self.paso,
            self.total_bloques
        );
        // Recorte: a nivel normal el limitador no actúa; en el paso que lo provoca debe contenerlo sin recorte duro.
        if !self.permitir_limitador {
            let techo = crate::audio::routing::LIMITER_KNEE;
            assert!(buf.iter().all(|v| v.abs() <= techo), "[{}] la salida pasó de {techo} sin que el paso lo pidiera", self.paso);
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

    /// Alineación entre pistas: cada pista suena sola y se mide cuánto se aparta lo que suena del reloj. Todas
    /// llevan la misma rampa, así que si una está desplazada (un retardo de remuestreo o de cambio de tono que no
    /// se compensó) su desfase difiere del de las demás. Devuelve el desfase mediano de cada pista y deja los solos
    /// como estaban.
    async fn desfases_por_pista(&mut self) -> Vec<(&'static str, i64)> {
        let solos: Vec<(&'static str, bool)> = self.pistas.iter().map(|p| (p.id, p.solo)).collect();
        let ids: Vec<&'static str> = self.pistas.iter().map(|p| p.id).collect();
        let mut out = Vec::new();
        for solo_id in &ids {
            for id in &ids {
                self.mezcla(id, None, None, Some(id == solo_id)).await;
            }
            self.correr(ASENTAR);
            let mut desfases = Vec::new();
            for _ in 0..40 {
                let b = self.bloque();
                if self.engine.is_buffering.load(Ordering::SeqCst) {
                    continue;
                }
                if let Some(p) = b.pos {
                    desfases.push(p - b.reloj as i64);
                }
            }
            assert!(desfases.len() >= 20, "[{}] la pista {solo_id} sola casi no sonó ({} bloques)", self.paso, desfases.len());
            desfases.sort_unstable();
            out.push((*solo_id, desfases[desfases.len() / 2]));
        }
        for (id, solo) in solos {
            self.mezcla(id, None, None, Some(solo)).await;
        }
        self.correr(ASENTAR);
        out
    }

    /// Exige que ninguna pista se aparte de las demás más de `tolerancia` fotogramas.
    fn exigir_pistas_alineadas(&self, desfases: &[(&'static str, i64)], tolerancia: i64) {
        let menor = desfases.iter().map(|d| d.1).min().unwrap();
        let mayor = desfases.iter().map(|d| d.1).max().unwrap();
        assert!(mayor - menor <= tolerancia, "[{}] las pistas no están alineadas entre sí: desfases {desfases:?}", self.paso);
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

    // --- 4b. Pistas alineadas entre sí (con las tres sonando) ---------------------------------------------------
    e.paso("alineación de las pistas entre sí");
    let desfases = e.desfases_por_pista().await;
    e.exigir_pistas_alineadas(&desfases, 2 * PASO_RAMPA as i64);
    e.comprobar_estado_de_pistas();

    // --- 5. Solo ----------------------------------------------------------------------------------------
    e.paso("solo de la pista a");
    e.mezcla("pista-a", None, None, Some(true)).await;
    e.correr_alineado(60, 3);
    e.comprobar_estado_de_pistas();
    e.paso("quitar el solo");
    e.mezcla("pista-a", None, None, Some(false)).await;
    e.correr_alineado(60, 3);

    // --- 5b. Ganancias que no son un número y ganancias al máximo -----------------------------------------------
    e.paso("ganancias no finitas");
    for malo in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        // El motor las ignora: la pista conserva la ganancia que tenía y la salida sigue siendo audio sano.
        e.engine.set_track_controls("pista-a", Some(malo), None, None, None, None).await;
        e.correr_alineado(30, 3);
        e.comprobar_estado_de_pistas();
    }
    e.paso("ganancias al máximo (el limitador actúa)");
    e.permitir_limitador = true;
    let limitadas_antes = e.stats.limited_samples.load(Ordering::Relaxed);
    for id in ids {
        e.mezcla(id, Some(MAX_GAIN), None, None).await;
    }
    e.correr(60);
    assert!(e.stats.limited_samples.load(Ordering::Relaxed) > limitadas_antes, "[{}] con todo al máximo el limitador no actuó", e.paso);
    e.paso("ganancias de vuelta a 1");
    for id in ids {
        e.mezcla(id, Some(1.0), None, None).await;
    }
    e.correr(ASENTAR + 5);
    e.permitir_limitador = false;
    e.correr_alineado(60, 3);
    e.comprobar_estado_de_pistas();

    // --- 6. Seek con la canción sonando -------------------------------------------------------------------
    e.paso("seek a 5 s");
    e.engine.seek(5.0).await;
    e.corte();
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

    // --- 8b. Entrar en vamp en la última parte de la sección (plan 6.1) ------------------------------------
    // Con los feeders ya por delante del reloj, activarlo a menos de ~0,55 s del final dejaba el audio siguiendo hacia
    // la sección siguiente mientras el reloj volvía al inicio del bucle.
    e.paso("seek a 11,6 s (sección c, cerca de su final)");
    e.engine.seek(11.6).await;
    e.corte();
    e.esperar_listo();
    e.correr(5);
    std::thread::sleep(std::time::Duration::from_millis(400)); // los feeders llenan el anillo
    e.paso("vamp a 0,4 s del final de la sección");
    assert!(e.engine.toggle_vamp(Some(true)).await, "el vamp no se activó cerca del final de la sección c");
    e.corte();
    e.esperar_listo();
    e.correr_alineado(100, 4);
    assert!(e.reloj() < 12 * SR as u64, "[vamp 6.1] el reloj salió de la sección c: {}", e.reloj());
    e.paso("quitar el vamp (entrada tardía)");
    assert!(!e.engine.toggle_vamp(Some(false)).await); // el reloj ya dio la vuelta: no reposiciona, sin corte
    e.correr_alineado(60, 4);

    // --- 9. Cambio de tono sin cambiar la velocidad --------------------------------------------------------
    e.paso("volver a 1 s");
    e.engine.seek(1.0).await;
    e.corte();
    e.esperar_listo();
    e.correr(10);
    e.paso("tono +2");
    e.engine.set_pitch(2).await;
    e.corte();
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
    // La alineación de las pistas con el tono cambiado no se mide aquí: la rampa no es una señal que el cambio de
    // tono conserve (su nivel depende del instante, no solo de la posición), así que no sirve de sonda. Lo cubren
    // las pruebas de `tests.rs` con senos y con un golpe.
    e.paso("tono 0");
    e.engine.set_pitch(0).await;
    e.corte();
    e.esperar_listo();
    e.correr(20);
    e.correr_alineado(60, 3);

    // --- 10. Pausa y reanudación -------------------------------------------------------------------------
    e.paso("pausa");
    let antes_de_pausar = e.reloj();
    e.engine.pause().await;
    e.corte();
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
    e.corte();
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
    e.corte();
    assert!(!e.engine.is_playing.load(Ordering::SeqCst));
    assert_eq!(e.reloj(), 0, "parar debe volver al inicio");
    e.exigir_silencio_y_reloj_parado(10);

    // --- 13. Llegar al final de la canción ------------------------------------------------------------------
    e.paso("final de la canción");
    e.engine.seek(6.0 - 1.0).await;
    e.corte();
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

    // --- Reglas de toda la sesión ---------------------------------------------------------------------------
    assert!(e.total_bloques > 1_500, "la sesión renderizó menos bloques de los esperados: {}", e.total_bloques);
    assert!(e.escalon_mayor <= ESCALON_MAXIMO, "el mayor escalón de la sesión fue {}", e.escalon_mayor);
    assert_eq!(
        e.asignaciones, 0,
        "el callback asignó memoria durante {} bloques de la sesión (regla de tiempo real)",
        e.total_bloques
    );
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

#[tokio::test]
async fn ensayo_modo_sin_pista_pad_y_click() {
    use crate::audio::metronome::MetronomeConfig;
    use crate::audio::pad::PadConfig;
    use crate::audio::routing::{propose, RouteTable};

    let engine = PlaybackEngine::new(Arc::new(AudioStreamStats::default()));
    engine.routing.store(&RouteTable::from_config(&propose(2)));

    let info = engine
        .load_pad_project(
            "pad-ensayo",
            SR,
            Some(120.0),
            Some(4),
            PadConfig { active_mode: true, enabled: true, note: 7, gain: 0.9, monitor: false, harmony: 0, style: 0 },
        )
        .await
        .expect("cargar canción sin secuencia");
    assert_eq!(info.track_count, 0);
    assert_eq!(info.total_frames, 0);

    engine.set_metronome(MetronomeConfig {
        enabled: true,
        bpm: 120.0,
        beats_per_bar: 4,
        subdivision: 4,
        gain: 0.9,
        split_mono: false,
    });

    let estado = engine.get_playback_state();
    assert!(estado.pad_active && estado.pad_enabled && estado.pad_note == 7);
    assert_eq!(estado.click_subdivision, 4);
    assert!(estado.track_controls.is_empty());

    engine.begin_playback(|| async { Ok::<(), String>(()) }).await.unwrap();

    let mut buf = vec![0.0f32; BLOQUE * 2];
    // El primer bloque crea el BlockMixer (igual que al abrir la salida).
    engine.simulate_callback_block(&mut buf, 2);

    let mut prev_music = buf[(BLOQUE - 1) * 2 + 1];
    let mut asignaciones = 0u64;
    let mut max_step_music = 0.0f32;

    let mut correr = |bloques: usize, reset_prev: bool, engine: &PlaybackEngine, prev: &mut f32, max_step: &mut f32, allocs: &mut u64| -> (f32, f32) {
        if reset_prev {
            *prev = 0.0;
        }
        let mut pk_ch0 = 0.0f32;
        let mut pk_ch1 = 0.0f32;
        for _ in 0..bloques {
            *allocs += crate::alloc_probe::count_allocs(|| engine.simulate_callback_block(&mut buf, 2));
            for f in 0..BLOQUE {
                let c0 = buf[f * 2];
                let c1 = buf[f * 2 + 1];
                assert!(c0.is_finite() && c1.is_finite(), "muestra no finita");
                assert!(c0.abs() <= 1.0 && c1.abs() <= 1.0, "muestra fuera de ±1");
                *max_step = (*max_step).max((c1 - *prev).abs());
                *prev = c1;
                pk_ch0 = pk_ch0.max(c0.abs());
                pk_ch1 = pk_ch1.max(c1.abs());
            }
        }
        (pk_ch0, pk_ch1)
    };

    // 1. Entrada progresiva (2,5 s) y sonido continuo sin parar solo.
    let (ch0_ini, ch1_ini) = correr(30, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    let _ = correr(230, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    let (ch0, ch1) = correr(40, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert!(ch0_ini > 0.1 && ch0 > 0.1, "canal 0 debe llevar el click");
    assert!(ch1_ini < ch1 * 0.4, "el pad debe entrar progresivo, no de golpe: ini={ch1_ini}, lleno={ch1}");
    assert!(ch1 > 0.05, "canal 1 debe llevar el pad");
    assert!(engine.is_playing.load(Ordering::SeqCst), "la canción sin pista no debe pararse sola");

    // 1b. Bajar subdivisión del metrónomo ×4 -> ×2 -> ×1 sin parar: nunca debe quedarse mudo.
    engine.set_metronome(MetronomeConfig { enabled: true, bpm: 120.0, beats_per_bar: 4, subdivision: 2, gain: 0.9, split_mono: false });
    let (ch0_x2, _) = correr(60, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert!(ch0_x2 > 0.1, "al bajar de ×4 a ×2 sin parar el click debe seguir sonando: {ch0_x2}");

    engine.set_metronome(MetronomeConfig { enabled: true, bpm: 120.0, beats_per_bar: 4, subdivision: 1, gain: 0.9, split_mono: false });
    let (ch0_x1, _) = correr(70, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert!(ch0_x1 > 0.1, "al bajar de ×2 a ×1 sin parar el click debe seguir sonando: {ch0_x1}");

    // 2. Cambio de nota, armonía, timbre y transposición en vivo sin escalones (el click sigue en el canal 0).
    engine.set_pad(PadConfig { active_mode: true, enabled: true, note: 2, gain: 0.9, monitor: false, harmony: 1, style: 1 });
    let (_, ch1_nota) = correr(60, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert!(ch1_nota > 0.05);

    engine.set_pad(PadConfig { active_mode: true, enabled: true, note: 2, gain: 0.9, monitor: false, harmony: 2, style: 2 });
    let _ = correr(40, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);

    engine.set_pitch(2).await;
    let (_, ch1_pitch) = correr(50, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert!(ch1_pitch > 0.05);

    // 3. Apagar el pad (`enabled: false`): decrece progresivamente en ~3 s mientras el click sigue sonando.
    engine.set_pad(PadConfig { active_mode: true, enabled: false, note: 2, gain: 0.9, monitor: false, harmony: 2, style: 2 });
    let _ = correr(50, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    // 55 bloques = 0,55 s (> 0,5 s de una negra a 120 BPM en ×1) para garantizar al menos un pulso en la ventana.
    let (ch0_mid1, ch1_mid1) = correr(55, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    let _ = correr(95, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    let (ch0_mid2, ch1_mid2) = correr(55, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert!(ch0_mid1 > 0.1 && ch0_mid2 > 0.1, "el click debe seguir sonando mientras el pad baja");
    assert!(ch1_mid1 > ch1_mid2 && ch1_mid2 > 0.005, "el pad debe bajar suavemente, no de golpe: {ch1_mid1} -> {ch1_mid2}");
    let _ = correr(75, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    let (ch0_mute, ch1_mute) = correr(55, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert!(ch0_mute > 0.1, "el click debe seguir sonando con el pad silenciado");
    assert!(ch1_mute < 1e-4, "el pad silenciado debe quedar en silencio tras 3 s: {ch1_mute}");

    // 4. Encender pad con envío a auriculares («Aur.») y ganancia NaN ignorada (sube progresivo).
    engine.set_pad(PadConfig { active_mode: true, enabled: true, note: 2, gain: f32::NAN, monitor: true, harmony: 1, style: 0 });
    let _ = correr(240, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    let (ch0_mon, ch1_mon) = correr(55, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert!(ch1_mon > 0.05, "ganancia NaN no debe borrar la ganancia válida del pad");
    assert!(ch0_mon > 0.05);

    // 5. Pausa: el click calla de inmediato y el reloj se detiene, mientras el pad decrece suavemente.
    engine.set_pad(PadConfig { active_mode: true, enabled: true, note: 2, gain: 0.9, monitor: false, harmony: 1, style: 0 });
    let _ = correr(10, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    engine.pause().await;
    assert!(!engine.is_playing.load(Ordering::SeqCst));
    let reloj_pausa = engine.current_frame.load(Ordering::SeqCst);
    let (p0_a, p1_a) = correr(50, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    let (p0_b, p1_b) = correr(120, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert!(p0_a == 0.0 && p0_b == 0.0, "el click debe silenciarse al instante en pausa: {p0_a}, {p0_b}");
    assert!(p1_a > p1_b && p1_b > 0.005, "el pad debe decrecer suavemente en pausa: {p1_a} -> {p1_b}");
    assert_eq!(engine.current_frame.load(Ordering::SeqCst), reloj_pausa, "el reloj debe quedar quieto en pausa");

    // Reanudar con Play durante la bajada retoma suavemente sin escalones.
    engine.begin_playback(|| async { Ok::<(), String>(()) }).await.unwrap();
    let _ = correr(200, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    let (_, p1_retoma) = correr(20, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert!(p1_retoma > p1_b, "al volver a dar Play durante la bajada el pad debe volver a subir");

    // 6. Stop inicia la bajada suave del pad con el reloj en 0; un segundo Stop (emergencia) corta en < 20 ms.
    engine.stop().await;
    assert_eq!(engine.current_frame.load(Ordering::SeqCst), 0, "stop debe reiniciar el reloj a 0");
    let (s0, s1) = correr(20, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert_eq!(s0, 0.0, "el click debe callar en Stop");
    assert!(s1 > 0.05 && engine.pad.is_tail_active(), "tras el primer Stop el pad debe seguir bajando suave");
    engine.stop().await;
    let _ = correr(2, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    let (e0, e1) = correr(10, false, &engine, &mut prev_music, &mut max_step_music, &mut asignaciones);
    assert!(e0 == 0.0 && e1 == 0.0, "el segundo Stop debe cortar el pad a silencio inmediato: {e0}, {e1}");

    // 6. Al montar después una canción normal con pistas, el modo pad se desactiva.
    let dir = escribir_cache("tras_pad", &["pista-a"], 2 * SR as usize);
    engine
        .load_project_with_controls(
            &dir,
            "tras_pad",
            SR,
            Some(120.0),
            Some(4),
            Some(vec![seccion("a", 0.0, 2.0)]),
            Some("1-bar".to_string()),
            Some(vec![control_inicial("pista-a", false)]),
        )
        .await
        .expect("cargar canción normal tras pad");
    assert!(!engine.pad.is_active_mode());
    assert!(!engine.get_playback_state().pad_active);

    assert!(max_step_music <= ESCALON_MAXIMO, "escalón en canal de música del pad: {max_step_music}");
    assert_eq!(asignaciones, 0, "el callback asignó memoria en modo pad: {asignaciones}");
}
