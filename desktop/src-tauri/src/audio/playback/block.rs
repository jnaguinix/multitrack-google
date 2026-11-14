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
/// - Una pista terminada (`eof`) no impide salir: no va a recibir más audio y exigirle 150 ms dejaría
///   toda la canción en buffering (p. ej. una guía corta tras un seek más allá de su final).
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
///   terminada (`eof`) no acumula: no va a llegar nada más.
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
