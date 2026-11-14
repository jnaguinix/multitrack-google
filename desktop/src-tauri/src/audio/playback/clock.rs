//! Discontinuidades de la línea temporal (saltos de sección y vamp).
//!
//! Los hilos de lectura (feeders) cortan el audio de un punto a otro de la canción, pero el reloj
//! compartido (`current_frame`) solo lo avanza el callback, bloque a bloque. Sin corregirlo, tras un
//! salto cuantizado o una vuelta de vamp el reloj seguiría por la línea antigua: la posición, la
//! sección activa y la condición de fin de canción dejarían de coincidir con lo que suena.
//!
//! Aquí se guardan las discontinuidades ya decididas. El callback solo lee atómicos (sin bloqueos,
//! sin memoria dinámica) y, al avanzar el reloj, las aplica con [`ClockJumps::resolve`].

use std::sync::atomic::{AtomicU64, Ordering};

/// Valor de `remap_at` cuando no hay salto pendiente.
const NO_JUMP: u64 = u64::MAX;

#[derive(Debug)]
pub struct ClockJumps {
    /// Fotograma de la canción en el que se corta el audio (el instante de transición).
    remap_at: AtomicU64,
    /// Fotograma de la canción al que se salta.
    remap_to: AtomicU64,
    /// Bucle de vamp: `[loop_start, loop_end)`. `loop_end == 0` significa «sin bucle».
    loop_start: AtomicU64,
    loop_end: AtomicU64,
}

impl Default for ClockJumps {
    fn default() -> Self {
        Self::new()
    }
}

impl ClockJumps {
    pub fn new() -> Self {
        Self {
            remap_at: AtomicU64::new(NO_JUMP),
            remap_to: AtomicU64::new(0),
            loop_start: AtomicU64::new(0),
            loop_end: AtomicU64::new(0),
        }
    }

    /// Programa un salto: cuando el reloj llegue a `at`, pasa a `to`.
    pub fn schedule_jump(&self, at: u64, to: u64) {
        self.remap_to.store(to, Ordering::Release);
        self.remap_at.store(at, Ordering::Release);
    }

    pub fn cancel_jump(&self) {
        self.remap_at.store(NO_JUMP, Ordering::Release);
    }

    /// `true` mientras el salto programado no se haya aplicado ni cancelado.
    pub fn jump_pending(&self) -> bool {
        self.remap_at.load(Ordering::Acquire) != NO_JUMP
    }

    pub fn set_loop(&self, start: u64, end: u64) {
        self.loop_end.store(0, Ordering::Release);
        self.loop_start.store(start, Ordering::Release);
        self.loop_end.store(end, Ordering::Release);
    }

    pub fn clear_loop(&self) {
        self.loop_end.store(0, Ordering::Release);
    }

    pub fn reset(&self) {
        self.cancel_jump();
        self.clear_loop();
    }

    /// Dado el reloj ya avanzado, devuelve dónde debe quedar tras aplicar el salto o la vuelta de vamp.
    /// Si no hay discontinuidad devuelve `clock` sin cambios. El salto se consume al aplicarse.
    #[inline]
    pub fn resolve(&self, clock: u64, vamping: bool) -> u64 {
        let at = self.remap_at.load(Ordering::Acquire);
        if at != NO_JUMP && clock >= at {
            // Solo el que consigue cambiar `at` aplica el salto: si otro hilo lo canceló o lo
            // reprogramó entre medias, no se aplica el valor viejo.
            if self
                .remap_at
                .compare_exchange(at, NO_JUMP, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                let to = self.remap_to.load(Ordering::Acquire);
                return to + (clock - at);
            }
        }
        if vamping {
            let end = self.loop_end.load(Ordering::Acquire);
            if end > 0 && clock >= end {
                let start = self.loop_start.load(Ordering::Acquire);
                if end > start {
                    // El módulo cubre bloques más largos que el bucle.
                    return start + (clock - end) % (end - start);
                }
            }
        }
        clock
    }
}

/// Avanza el reloj compartido `delta` fotogramas y aplica las discontinuidades. Devuelve la posición
/// resultante. Si un `seek` escribió el reloj mientras tanto, su valor manda y el salto se descarta.
#[inline]
pub fn advance_clock(current_frame: &AtomicU64, jumps: &ClockJumps, delta: u64, vamping: bool) -> u64 {
    let advanced = current_frame.fetch_add(delta, Ordering::Relaxed) + delta;
    let resolved = jumps.resolve(advanced, vamping);
    if resolved == advanced {
        return advanced;
    }
    match current_frame.compare_exchange(advanced, resolved, Ordering::Relaxed, Ordering::Relaxed) {
        Ok(_) => resolved,
        Err(actual) => actual,
    }
}
