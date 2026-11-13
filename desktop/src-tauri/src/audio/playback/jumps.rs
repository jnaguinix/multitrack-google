use std::sync::atomic::Ordering;

use super::fade::FADE_MS;
use super::types::{QueuedJumpInfo, QueuedJumpRequest};
use super::PlaybackEngine;

impl PlaybackEngine {
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

        let mode = quantize_mode_opt
            .map(|s| s.to_string())
            .unwrap_or_else(|| self.quantize_mode.lock().unwrap().clone());

        if mode == "immediate" {
            tracing::info!("[NativeEngine] Immediate jump to '{}' ({:.2}s)", section_id, target_sec_obj.start_sec);
            self.seek(target_sec_obj.start_sec).await;
            *self.queued_jump.lock().unwrap() = None;
            self.guide_cue.lock().unwrap().trigger_chime();
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

        *self.queued_jump.lock().unwrap() = Some(jump_info.clone());
        self.guide_cue.lock().unwrap().trigger_chime();

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
        tracing::info!("[NativeEngine] cancel_queued_jump");
        *self.queued_jump.lock().unwrap() = None;
        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            *trk.jump_request.lock().unwrap() = None;
        }
    }

    pub async fn toggle_vamp(&self, enable: Option<bool>) -> bool {
        let new_state = match enable {
            Some(e) => e,
            None => !self.is_vamping.load(Ordering::SeqCst),
        };
        self.is_vamping.store(new_state, Ordering::SeqCst);

        let cur_frame = self.current_frame.load(Ordering::SeqCst);
        let sr = self.sample_rate.load(Ordering::SeqCst) as f64;
        let cur_sec = cur_frame as f64 / sr;

        tracing::info!("[NativeEngine] toggle_vamp: new_state={new_state}, cur_frame={cur_frame}, cur_sec={cur_sec:.2}");

        if new_state {
            self.guide_cue.lock().unwrap().trigger_chime();
            let active_loop = {
                let sections_guard = self.sections.lock().unwrap();
                sections_guard
                    .iter()
                    .find(|s| cur_sec >= s.start_sec && cur_sec < s.end_sec)
                    .map(|sec| ((sec.start_sec * sr).round() as u64, (sec.end_sec * sr).round() as u64))
            };
            if let Some((loop_start, loop_end)) = active_loop {
                tracing::info!("[NativeEngine] Vamp active loop: frames {} -> {}", loop_start, loop_end);
                let tracks = self.tracks.lock().await;
                for trk in tracks.iter() {
                    trk.is_vamping.store(true, Ordering::Relaxed);
                    *trk.active_section_loop.lock().unwrap() = Some((loop_start, loop_end));
                }
            }
        } else {
            let tracks = self.tracks.lock().await;
            for trk in tracks.iter() {
                trk.is_vamping.store(false, Ordering::Relaxed);
                *trk.active_section_loop.lock().unwrap() = None;
            }
        }

        new_state
    }
}
