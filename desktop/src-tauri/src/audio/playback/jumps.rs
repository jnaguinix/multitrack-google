use std::sync::atomic::Ordering;

use super::fade::FADE_MS;
use super::types::{QueuedJumpInfo, QueuedJumpRequest};
use super::PlaybackEngine;

impl PlaybackEngine {
    /// `true` si hay un salto programado cuyo audio ya empalmó algún feeder.
    ///
    /// Los feeders cortan el audio unos 350 ms antes de que el reloj llegue a la transición. Desde ese
    /// momento el audio ya encolado pertenece a la sección destino: cancelar o reprogramar el salto solo
    /// movería el reloj y dejaría el sonido y la posición en secciones distintas. Se rechaza en su lugar.
    async fn jump_already_spliced(&self) -> bool {
        if !self.clock_jumps.jump_pending() {
            return false;
        }
        let tracks = self.tracks.lock().await;
        tracks.iter().any(|trk| trk.jump_request.lock().unwrap().is_none())
    }

    pub async fn queue_section_jump(
        &self,
        section_id: &str,
        quantize_mode_opt: Option<&str>,
    ) -> Result<QueuedJumpInfo, String> {
        let sr = self.sample_rate.load(Ordering::SeqCst) as f64;
        let cur_frame = self.current_frame.load(Ordering::SeqCst);
        let cur_sec_now = cur_frame as f64 / sr;

        tracing::info!("[NativeEngine] queue_section_jump: target='{}', cur_frame={}, cur_sec={:.2}", section_id, cur_frame, cur_sec_now);

        let (target_sec_obj, cur_sec_end) = {
            let sections_guard = self.sections.lock().unwrap();
            let target = sections_guard
                .iter()
                .find(|s| s.id == section_id)
                .ok_or_else(|| format!("Sección '{section_id}' no encontrada en las {} secciones registradas", sections_guard.len()))?
                .clone();
            let cur_end = sections_guard
                .iter()
                .find(|s| cur_sec_now >= s.start_sec && cur_sec_now < s.end_sec)
                .map(|s| s.end_sec);
            (target, cur_end)
        };

        let target_frame = (target_sec_obj.start_sec * sr).round() as u64;

        if self.jump_already_spliced().await {
            return Err("El salto anterior ya está en curso: espera a que termine para elegir otra sección".to_string());
        }

        // Un vamp activo en la sección que se abandona devolvería el reloj al inicio de su bucle justo
        // después del salto: se desactiva al encolar. El salto cuantizado sigue ocurriendo en su momento.
        if self.is_vamping.load(Ordering::SeqCst) {
            self.toggle_vamp(Some(false)).await;
        }

        let mode = quantize_mode_opt
            .map(|s| s.to_string())
            .unwrap_or_else(|| self.quantize_mode.lock().unwrap().clone());

        if mode == "immediate" {
            tracing::info!("[NativeEngine] Immediate jump to '{}' ({:.2}s)", section_id, target_sec_obj.start_sec);
            self.seek(target_sec_obj.start_sec).await;
            *self.queued_jump.lock().unwrap() = None;
            return Ok(QueuedJumpInfo {
                target_section_id: target_sec_obj.id,
                target_sec: target_sec_obj.start_sec,
                transition_sec: target_sec_obj.start_sec,
                target_frame,
                transition_frame: target_frame,
            });
        }

        let bpm = f32::from_bits(self.bpm.load(Ordering::SeqCst)).max(10.0) as f64;
        let bpb = self.beats_per_bar.load(Ordering::SeqCst).max(1) as f64;
        let sec_per_bar = (60.0 / bpm) * bpb;
        let frames_per_bar = (sec_per_bar * sr).max(1.0);

        // Ring buffer holds up to 500ms of audio. Add 100ms safety margin.
        let min_safe_ahead = (0.600 * sr).round() as u64;
        let min_transition_frame = cur_frame + min_safe_ahead;

        let cur_bar = (cur_frame as f64 / frames_per_bar).floor();
        let mut target_bar = cur_bar + 1.0;

        let transition_frame = if mode == "1-bar" {
            let mut trans = (target_bar * frames_per_bar).round() as u64;
            if trans < min_transition_frame || (trans as f64 - cur_frame as f64) < (0.25 * sr) {
                target_bar = ((min_transition_frame as f64 / frames_per_bar).ceil()).max(target_bar + 1.0);
                trans = (target_bar * frames_per_bar).round() as u64;
            }
            trans
        } else if mode == "2-bars" {
            let mut trans = ((cur_bar + 2.0) * frames_per_bar).round() as u64;
            if trans < min_transition_frame {
                target_bar = ((min_transition_frame as f64 / frames_per_bar).ceil()).max(cur_bar + 2.0);
                trans = (target_bar * frames_per_bar).round() as u64;
            }
            trans
        } else if mode == "section-end" {
            if let Some(end_sec) = cur_sec_end {
                let end_f = (end_sec * sr).round() as u64;
                if end_f >= min_transition_frame {
                    end_f
                } else {
                    ((target_bar + 1.0) * frames_per_bar).round() as u64
                }
            } else {
                ((target_bar + 1.0) * frames_per_bar).round() as u64
            }
        } else {
            ((target_bar + 1.0) * frames_per_bar).round() as u64
        };

        let transition_sec = transition_frame as f64 / sr;
        let crossfade_frames = ((FADE_MS / 1000.0) * sr as f32).round().max(1.0) as usize;

        tracing::info!(
            "[NativeEngine] Scheduled jump: target='{}' ({:.2}s), trans at {:.2}s (frame {}), mode='{}'",
            target_sec_obj.id,
            target_sec_obj.start_sec,
            transition_sec,
            transition_frame,
            mode
        );

        let jump_info = QueuedJumpInfo {
            target_section_id: target_sec_obj.id.clone(),
            target_sec: target_sec_obj.start_sec,
            transition_sec,
            target_frame,
            transition_frame,
        };

        // El reloj debe saltar en el mismo instante en que lo hace el audio. Se programa antes de
        // publicar el salto en cola: `get_playback_state` da por aplicado un salto sin programar.
        self.clock_jumps.schedule_jump(transition_frame, target_frame);
        *self.queued_jump.lock().unwrap() = Some(jump_info.clone());

        let req = QueuedJumpRequest {
            target_frame,
            transition_frame,
            crossfade_frames,
        };
        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            *trk.jump_request.lock().unwrap() = Some(req.clone());
        }

        Ok(jump_info)
    }

    pub async fn cancel_queued_jump(&self) {
        if self.jump_already_spliced().await {
            tracing::warn!("[NativeEngine] cancel_queued_jump ignorado: el audio del salto ya está empalmado");
            return;
        }
        tracing::info!("[NativeEngine] cancel_queued_jump");
        self.clock_jumps.cancel_jump();
        *self.queued_jump.lock().unwrap() = None;
        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            *trk.jump_request.lock().unwrap() = None;
        }
    }

    /// Activa o desactiva el vamp (el bucle de la sección en la que está el reloj). Devuelve el estado resultante:
    /// `false` si se pidió activarlo y no hay una sección con un rango válido en la posición actual (un hueco entre
    /// secciones, un rango vacío): el motor no puede creerse en vamp sin bucle que repetir.
    pub async fn toggle_vamp(&self, enable: Option<bool>) -> bool {
        let (state, near_loop_end) = self.set_vamp_state(enable).await;
        // Salir del vamp cerca del final de la vuelta: ver `set_vamp_state`.
        if near_loop_end {
            self.seek_in_place().await;
        }
        state
    }

    /// Cambia el estado del vamp sin reposicionar nada (lo usa `seek`, que ya reposiciona). Devuelve el estado
    /// resultante y si se salió del vamp con el reloj en la zona final de la vuelta (el llamante decide si
    /// reposiciona: `toggle_vamp` sí; `seek` no hace falta).
    pub(super) async fn set_vamp_state(&self, enable: Option<bool>) -> (bool, bool) {
        let was_vamping = self.is_vamping.load(Ordering::SeqCst);
        let want = enable.unwrap_or(!was_vamping);

        let cur_frame = self.current_frame.load(Ordering::SeqCst);
        let sr = self.sample_rate.load(Ordering::SeqCst) as f64;
        let cur_sec = cur_frame as f64 / sr;

        tracing::info!("[NativeEngine] toggle_vamp: pedido={want}, cur_frame={cur_frame}, cur_sec={cur_sec:.2}");

        if want {
            let active_loop = {
                let sections_guard = self.sections.lock().unwrap();
                sections_guard
                    .iter()
                    .find(|s| cur_sec >= s.start_sec && cur_sec < s.end_sec)
                    .map(|sec| ((sec.start_sec * sr).round() as u64, (sec.end_sec * sr).round() as u64))
                    .filter(|(start, end)| end > start && *end > cur_frame)
            };
            let Some((loop_start, loop_end)) = active_loop else {
                tracing::warn!("[NativeEngine] Vamp rechazado: no hay una sección con rango válido en {cur_sec:.2} s");
                // Si ya estaba activo (otra sección) se deja como está; si no, queda apagado.
                return (was_vamping, false);
            };
            tracing::info!("[NativeEngine] Vamp active loop: frames {} -> {}", loop_start, loop_end);
            self.is_vamping.store(true, Ordering::SeqCst);
            self.clock_jumps.set_loop(loop_start, loop_end);
            let tracks = self.tracks.lock().await;
            for trk in tracks.iter() {
                trk.is_vamping.store(true, Ordering::Relaxed);
                *trk.active_section_loop.lock().unwrap() = Some((loop_start, loop_end));
            }
            return (true, false);
        }

        // Salir: los feeders van ~0,35 s por delante del reloj. Si el bucle está a punto de cerrar la vuelta, su
        // anillo ya trae el empalme hacia el inicio de la sección; quitar el bucle del reloj sin más lo dejaría
        // pasar al final de la sección mientras el audio sigue repitiendo. En esa zona `toggle_vamp` reposiciona en el
        // sitio (con su micro-fundido) para que audio y reloj sigan juntos hacia la sección siguiente.
        let near_loop_end = was_vamping
            && self
                .clock_jumps
                .loop_range()
                .is_some_and(|(_, end)| end > cur_frame && end - cur_frame <= (sr as u64) * 11 / 20);
        self.is_vamping.store(false, Ordering::SeqCst);
        self.clock_jumps.clear_loop();
        {
            let tracks = self.tracks.lock().await;
            for trk in tracks.iter() {
                trk.is_vamping.store(false, Ordering::Relaxed);
                *trk.active_section_loop.lock().unwrap() = None;
            }
        }
        (false, near_loop_end)
    }
}
