use std::sync::atomic::Ordering;
use std::time::Instant;

use crate::audio::output::AudioEngineState;

use super::fade::FADE_MS;
use super::types::{LevelPair, MetersSnapshotDto, PlaybackStateSnapshot, TrackLevel};
use super::PlaybackEngine;

impl PlaybackEngine {
    pub async fn reopen_stream(&self, engine_state: &AudioEngineState) -> Result<(), String> {
        {
            let mut stream_guard = self.stream.lock().await;
            *stream_guard = None;
        }
        self.device_disconnected.store(false, Ordering::SeqCst);
        self.ensure_stream(engine_state).await?;
        tracing::info!("[NativeEngine] Audio stream reopened successfully");
        Ok(())
    }

    pub async fn play(&self, state: &AudioEngineState) -> Result<(), String> {
        {
            let loaded = self.loaded_project_id.lock().await;
            if loaded.is_none() {
                return Err("No hay proyecto cargado en el motor nativo".to_string());
            }
        }

        if self.is_playing.load(Ordering::SeqCst) {
            return Ok(());
        }

        let tot = self.total_frames.load(Ordering::SeqCst);
        if tot > 0 && self.current_frame.load(Ordering::SeqCst) >= tot {
            self.seek(0.0).await;
        }

        // Start 8 ms fade-in
        self.fade.lock().unwrap().start_fade_in();
        self.is_playing.store(true, Ordering::SeqCst);

        // Ensure CPAL output stream is active
        self.ensure_stream(state).await?;
        Ok(())
    }

    pub async fn pause(&self) {
        if !self.is_playing.load(Ordering::SeqCst) {
            return;
        }

        // Apply 8 ms fade-out before pausing to avoid clicks
        self.fade.lock().unwrap().start_fade_out();
        tokio::time::sleep(std::time::Duration::from_millis((FADE_MS * 1.5) as u64)).await;

        self.is_playing.store(false, Ordering::SeqCst);
    }

    pub async fn stop(&self) {
        if self.is_playing.load(Ordering::SeqCst) {
            self.fade.lock().unwrap().start_fade_out();
            tokio::time::sleep(std::time::Duration::from_millis((FADE_MS * 1.5) as u64)).await;
            self.is_playing.store(false, Ordering::SeqCst);
        }

        self.is_buffering.store(false, Ordering::SeqCst);
        *self.buffering_start_time.lock().unwrap() = None;
        self.current_frame.store(0, Ordering::SeqCst);
        *self.queued_jump.lock().unwrap() = None;
        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            trk.seek_request.store(0, Ordering::SeqCst);
            *trk.jump_request.lock().unwrap() = None;
            if let Ok(mut c) = trk.consumer.lock() {
                while c.pop().is_ok() {}
            }
        }
    }

    pub async fn seek(&self, target_sec: f64) {
        let sr = self.sample_rate.load(Ordering::SeqCst);
        let target_frame = (target_sec * sr as f64).round().max(0.0) as i64;

        let was_playing = self.is_playing.load(Ordering::SeqCst);
        if was_playing {
            self.fade.lock().unwrap().start_fade_out();
            tokio::time::sleep(std::time::Duration::from_millis((FADE_MS * 1.2) as u64)).await;
        }

        // Enter buffering/preparation state:
        self.seek_generation.fetch_add(1, Ordering::SeqCst);
        self.is_buffering.store(true, Ordering::SeqCst);
        *self.buffering_start_time.lock().unwrap() = Some(Instant::now());

        self.current_frame.store(target_frame as u64, Ordering::SeqCst);
        *self.queued_jump.lock().unwrap() = None;

        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            trk.seek_request.store(target_frame, Ordering::SeqCst);
            *trk.jump_request.lock().unwrap() = None;
            if let Ok(mut c) = trk.consumer.lock() {
                while c.pop().is_ok() {}
            }
        }

        tracing::info!("[NativeEngine] seek to target_sec={:.2} (frame {})", target_sec, target_frame);
    }

    pub fn get_playback_state(&self) -> PlaybackStateSnapshot {
        let sr = self.sample_rate.load(Ordering::SeqCst).max(1);
        let cur = self.current_frame.load(Ordering::SeqCst);
        let tot = self.total_frames.load(Ordering::SeqCst);
        let cur_sec = cur as f64 / sr as f64;

        let sections_guard = self.sections.lock().unwrap();
        let active_section_id = sections_guard
            .iter()
            .find(|s| cur_sec >= s.start_sec && cur_sec < s.end_sec)
            .map(|s| s.id.clone());

        let mut queued_guard = self.queued_jump.lock().unwrap();
        if let Some(q) = queued_guard.as_ref() {
            if cur >= q.transition_frame {
                *queued_guard = None;
            }
        }
        let queued_section_id = queued_guard.as_ref().map(|q| q.target_section_id.clone());

        let met = self.metronome.lock().unwrap();
        let meters = self.take_meters();

        PlaybackStateSnapshot {
            is_playing: self.is_playing.load(Ordering::SeqCst),
            is_buffering: self.is_buffering.load(Ordering::SeqCst),
            prefill_duration_ms: self.last_prefill_duration_ms.load(Ordering::Relaxed),
            device_disconnected: self.device_disconnected.load(Ordering::Relaxed),
            position_sec: cur_sec,
            duration_sec: tot as f64 / sr as f64,
            current_frame: cur,
            total_frames: tot,
            underruns: self.stats.underruns.load(Ordering::Relaxed),
            callbacks: self.stats.callbacks.load(Ordering::Relaxed),
            max_callback_duration_us: self.stats.max_callback_duration_us.load(Ordering::Relaxed),
            max_feeder_block_duration_us: self.stats.max_feeder_block_duration_us.load(Ordering::Relaxed),
            min_ring_buffer_level_ms: {
                let m = self.stats.min_ring_buffer_level_ms.load(Ordering::Relaxed);
                if m == u64::MAX {
                    None
                } else {
                    Some(m)
                }
            },
            active_section_id,
            queued_section_id,
            is_vamping: self.is_vamping.load(Ordering::SeqCst),
            pitch_semitones: self.pitch_semitones.load(Ordering::SeqCst),
            click_enabled: met.config.enabled,
            click_gain: met.config.gain,
            click_subdivision: met.config.subdivision,
            quantize_mode: self.quantize_mode.lock().unwrap().clone(),
            split_mono: self.split_mono.load(Ordering::SeqCst),
            master_gain: f32::from_bits(self.master_gain.load(Ordering::Relaxed)),
            cue_master_gain: f32::from_bits(self.cue_master_gain.load(Ordering::Relaxed)),
            meters,
        }
    }

    /// Lee y pone a cero los picos de pistas y buses (pico desde la lectura anterior).
    /// Nunca bloquea `stream_tracks` (el callback hace `try_lock` sobre él y emitiría silencio):
    /// recorre la lista de control `tracks`. Si está ocupada (carga en curso), devuelve solo los
    /// buses; los picos de pista no se pierden, se leen en la siguiente consulta.
    pub fn take_meters(&self) -> MetersSnapshotDto {
        let tracks = match self.tracks.try_lock() {
            Ok(guard) => guard
                .iter()
                .map(|t| {
                    let (l, r) = t.meter.take();
                    TrackLevel { track_id: t.track_id.clone(), l, r }
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        let out: LevelPair = self.bus_meters.out.take().into();
        MetersSnapshotDto {
            tracks,
            main: self.bus_meters.main.take().into(),
            cue: self.bus_meters.cue.take().into(),
            click: self.bus_meters.click.take().into(),
            guide: self.bus_meters.guide.take().into(),
            clipped: out.l > 1.0 || out.r > 1.0,
            out,
        }
    }
}
