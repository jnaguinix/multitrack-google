//! Lógica por bloque del callback compartida con `simulate_callback_block`, para que las pruebas
//! ejerciten el mismo código que corre en el hilo de audio.

use std::sync::atomic::{AtomicU64, Ordering};

use super::types::StreamTrackHandle;

/// Nivel mínimo, en milisegundos de audio disponibles por pista, para salir de buffering.
pub const BUFFERING_EXIT_MS: u64 = 150;

/// Decide si el motor puede salir de buffering tras un seek, una carga o un arranque en frío.
///
/// - Una pista cuyo anillo aún no se vació para la generación de seek vigente (`flush_done`) impide
///   salir: puede contener audio de la posición anterior.
/// - Una pista sin hilo de lectura (`eof`: el transporte la marca si su feeder no confirmó el seek) no impide
///   salir: no va a recibir más audio y exigirle 150 ms dejaría toda la canción en buffering. Una pista más corta
///   que la canción no es `eof`: su feeder sigue empujando silencio pasado el final de su archivo.
/// - Las demás deben tener al menos [`BUFFERING_EXIT_MS`] disponibles.
///
/// Solo usa atómicos y `try_lock`: es seguro llamarla desde el callback de audio.
pub fn buffering_ready(tracks: &[StreamTrackHandle], generation: u64, sample_rate: u64) -> bool {
    let mut min_avail_frames = u64::MAX;
    for trk in tracks {
        if trk.flush_done.load(Ordering::SeqCst) < generation {
            return false;
        }
        if trk.eof.load(Ordering::SeqCst) {
            continue;
        }
        match trk.consumer.try_lock() {
            Ok(c) => min_avail_frames = min_avail_frames.min((c.slots() / 2) as u64),
            // El transporte está vaciando este anillo: se reintenta en el siguiente bloque.
            Err(_) => return false,
        }
    }
    min_avail_frames == u64::MAX || (min_avail_frames * 1000) / sample_rate.max(1) >= BUFFERING_EXIT_MS
}

/// Consume `frames` fotogramas del anillo de una pista y entrega cada uno a `sink(índice, l, r)`.
/// Devuelve `true` si faltaron datos (underrun).
///
/// - Solo se leen fotogramas completos (par L/R): el feeder empuja muestra a muestra y, con el anillo casi
///   vacío, el callback podría ver una L sin su R y desalinear los canales para siempre.
/// - Los fotogramas que faltan suenan como silencio y se anotan en `skip_frames`. Cuando el feeder se
///   recupera, entrega el audio que debía haber sonado durante el hueco: se descarta esa cantidad para que
///   la pista siga alineada con el reloj y con las demás, en lugar de quedarse atrasada. Una pista
///   sin hilo de lectura (`eof`) no acumula: no va a llegar nada más.
///
/// Sin memoria dinámica, sin bloqueos, sin registro: es seguro en el callback de audio.
#[inline]
pub fn consume_track_block<F: FnMut(usize, f32, f32)>(
    consumer: &mut rtrb::Consumer<f32>,
    skip_frames: &AtomicU64,
    eof: bool,
    frames: usize,
    mut sink: F,
) -> bool {
    let mut available_frames = consumer.slots() / 2;

    let pending_skip = skip_frames.load(Ordering::Relaxed) as usize;
    if pending_skip > 0 {
        let to_drop = pending_skip.min(available_frames);
        for _ in 0..to_drop * 2 {
            let _ = consumer.pop();
        }
        available_frames -= to_drop;
        skip_frames.store((pending_skip - to_drop) as u64, Ordering::Relaxed);
    }

    let readable = frames.min(available_frames);
    for f in 0..readable {
        let l = consumer.pop().unwrap_or(0.0);
        let r = consumer.pop().unwrap_or(0.0);
        sink(f, l, r);
    }

    let missed = frames - readable;
    if missed > 0 && !eof {
        skip_frames.fetch_add(missed as u64, Ordering::Relaxed);
    }
    missed > 0
}

/// Fotogramas de margen entre el final del fundido y el final nominal de la canción. El audio que sale del
/// remuestreador llega unos 32 fotogramas por delante del reloj, así que el corte real del archivo ocurre
/// antes de que el reloj llegue a `total_frames`; con este margen el fundido ya terminó cuando se corta.
pub const END_FADE_GUARD_FRAMES: u64 = 64;

/// Ganancia (0..1) del fundido de salida al final natural de la canción.
///
/// Una canción que termina alta (un master cortado sin fade-out) deja de golpe de sonar y la señal cae de un
/// valor alto a cero: un chasquido. Igual que al pausar o detener, se aplican `fade_frames` (8 ms) de fundido,
/// terminando [`END_FADE_GUARD_FRAMES`] antes del final. Antes de esa ventana la ganancia es exactamente 1.0.
///
/// Sin memoria dinámica ni bloqueos: es seguro en el callback de audio.
#[inline]
pub fn end_of_song_gain(position: u64, total_frames: u64, fade_frames: usize) -> f32 {
    if total_frames == 0 || fade_frames == 0 {
        return 1.0;
    }
    let fade = fade_frames as u64;
    let end = total_frames.saturating_sub(END_FADE_GUARD_FRAMES);
    let start = end.saturating_sub(fade);
    if position < start {
        1.0
    } else if position >= end {
        0.0
    } else {
        (end - position) as f32 / fade as f32
    }
}

/// Ley de paneo de una pista: ganancias por canal (`pan_l`, `pan_r`, ya con la ganancia de pista) y cuánto
/// del canal contrario se pasa al canal propio (`cross`, de 0 a 0,5).
///
/// Ley de paneo constante en potencia (`cos`/`sin`) con pasaje del canal contrario: al llevar una pista
/// estéreo a un lado, TODO su contenido va a ese lado (en el extremo, la media de L y R), en vez de quedarse
/// solo con su canal izquierdo o derecho. Con el pan al centro la imagen estéreo no se toca.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PanLaw {
    pub pan_l: f32,
    pub pan_r: f32,
    pub cross: f32,
}

/// `pan` de -1,0 (izquierda) a +1,0 (derecha) y `gain` lineal de la pista.
#[inline]
pub fn pan_law(pan: f32, gain: f32) -> PanLaw {
    let p = pan.clamp(-1.0, 1.0);
    let angle = (p + 1.0) * (std::f32::consts::PI / 4.0);
    PanLaw {
        pan_l: angle.cos() * gain,
        pan_r: angle.sin() * gain,
        cross: p.abs() * 0.5,
    }
}

/// Constante de tiempo del suavizado de volumen y paneo (segundos). Un salto de fader tarda unos 3 × esto en
/// asentarse (≈ 30 ms): suficiente para que no suene a clic y corto para que no se sienta lento.
pub const SMOOTH_TAU_S: f32 = 0.010;
/// Por debajo de esta diferencia el valor suavizado se pega al objetivo: en reposo la ganancia es EXACTAMENTE la
/// pedida (nada de 0,99999 eterno) y el bloque no paga rampa.
const SMOOTH_SNAP: f32 = 1e-4;

/// Fracción del camino hacia el objetivo que se recorre en un bloque de `frames` fotogramas (filtro de un polo).
/// Depende de la duración del bloque, no de su tamaño: con bloques pequeños o grandes se asienta en el mismo tiempo.
#[inline]
pub fn smoothing_alpha(frames: usize, sample_rate: u32) -> f32 {
    1.0 - (-(frames as f32) / (SMOOTH_TAU_S * sample_rate.max(1) as f32)).exp()
}

/// Valor suavizado del siguiente bloque. `current` no finito (estado sin inicializar) salta directo al objetivo.
#[inline]
pub fn smooth_toward(current: f32, target: f32, alpha: f32) -> f32 {
    if !current.is_finite() {
        return target;
    }
    let next = current + (target - current) * alpha;
    if (target - next).abs() < SMOOTH_SNAP {
        target
    } else {
        next
    }
}

/// Aplica el paneo a una muestra estéreo. Una fuente mono (`l == r`) suena igual que con el paneo clásico
/// (`l * pan_l`, `r * pan_r`); una estéreo se pliega hacia el lado elegido.
#[inline(always)]
pub fn apply_pan(l: f32, r: f32, law: PanLaw) -> (f32, f32) {
    let keep = 1.0 - law.cross;
    (
        (keep * l + law.cross * r) * law.pan_l,
        (keep * r + law.cross * l) * law.pan_r,
    )
}
