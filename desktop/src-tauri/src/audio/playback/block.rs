//! Lógica por bloque del callback compartida con `simulate_callback_block`, para que las pruebas
//! ejerciten el mismo código que corre en el hilo de audio.

use std::sync::atomic::Ordering;

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
