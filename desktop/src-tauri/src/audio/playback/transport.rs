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

    /// Reposiciona el metrónomo en `song_frame` y descarta los clics en curso.
    pub(super) fn reposition_metronome(&self, song_frame: u64) {
        let sr = self.sample_rate.load(Ordering::SeqCst).max(1);
        self.metronome.lock().unwrap().seek_to_frame(song_frame, sr);
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

        self.begin_playback(|| self.ensure_stream(state)).await
    }

    /// Marca el motor como reproduciendo y abre la salida de audio con `open_output`. Si abrirla falla,
    /// deshace el estado: de lo contrario el motor quedaría «reproduciendo» sin salida y los siguientes
    /// Play devolverían Ok sin reintentar abrir el dispositivo.
    pub(super) async fn begin_playback<F, Fut>(&self, open_output: F) -> Result<(), String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<(), String>>,
    {
        // Start 8 ms fade-in
        self.fade.lock().unwrap().start_fade_in();
        self.is_playing.store(true, Ordering::SeqCst);

        // Ensure CPAL output stream is active
        if let Err(error) = open_output().await {
            self.is_playing.store(false, Ordering::SeqCst);
            return Err(error);
        }
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
        // El metrónomo vuelve al inicio junto con el transporte; si no, no sonaría ningún clic hasta
        // alcanzar de nuevo la posición anterior.
        self.reposition_metronome(0);
        self.clock_jumps.cancel_jump();
        *self.queued_jump.lock().unwrap() = None;
        let generation = self.seek_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.rewind_tracks(0, generation).await;
    }

    pub async fn seek(&self, target_sec: f64) {
        let sr = self.sample_rate.load(Ordering::SeqCst);
        let target_frame = (target_sec * sr as f64).round().max(0.0) as i64;

        let was_playing = self.is_playing.load(Ordering::SeqCst);
        if was_playing {
            self.fade.lock().unwrap().start_fade_out();
            tokio::time::sleep(std::time::Duration::from_millis((FADE_MS * 1.2) as u64)).await;
        }

        // Enter buffering/preparation state. La generación sube antes de activar buffering: el callback
        // no debe ver buffering activo con la generación anterior, o daría por bueno el audio viejo.
        let generation = self.seek_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.is_buffering.store(true, Ordering::SeqCst);
        *self.buffering_start_time.lock().unwrap() = Some(Instant::now());

        self.current_frame.store(target_frame as u64, Ordering::SeqCst);
        self.reposition_metronome(target_frame as u64);
        self.clock_jumps.cancel_jump();
        *self.queued_jump.lock().unwrap() = None;

        self.rewind_tracks(target_frame, generation).await;

        tracing::info!("[NativeEngine] seek to target_sec={:.2} (frame {})", target_sec, target_frame);
    }

    /// Reposiciona todas las pistas en `target_frame` de forma coordinada con sus feeders:
    ///
    /// 1. Pide a cada feeder que se reposicione (`seek_request`).
    /// 2. Espera a que lo confirme (`seek_ack >= generation`). Desde ese momento el feeder ya no
    ///    empuja audio de la posición anterior y se queda quieto hasta el paso 4.
    /// 3. Vacía el anillo: ahora solo puede contener audio viejo.
    /// 4. Marca `flush_done = generation`. El feeder empieza a producir desde el destino y el callback
    ///    ya puede salir de buffering con ese audio.
    ///
    /// Sin esta espera, vaciar el anillo y reposicionar el feeder son dos acciones independientes y
    /// pueden intercalarse con un empuje del feeder o con el callback (audio viejo tras el seek).
    async fn rewind_tracks(&self, target_frame: i64, generation: u64) {
        let tracks = self.tracks.lock().await;
        for trk in tracks.iter() {
            trk.eof.store(false, Ordering::SeqCst);
            *trk.jump_request.lock().unwrap() = None;
            trk.seek_request.store(target_frame, Ordering::SeqCst);
        }

        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        for trk in tracks.iter() {
            while trk.seek_ack.load(Ordering::SeqCst) < generation
                && trk.feeder_alive.load(Ordering::SeqCst)
                && Instant::now() < deadline
            {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
            if trk.seek_ack.load(Ordering::SeqCst) < generation {
                // El feeder terminó (no pudo abrir el archivo, falló) o no responde. Sin él no llegará
                // audio de esta pista: se da por terminada para no dejar toda la canción en buffering.
                tracing::warn!(
                    "[NativeEngine] La pista '{}' no confirmó el seek a {} (feeder activo: {}); se da por terminada",
                    trk.track_id,
                    target_frame,
                    trk.feeder_alive.load(Ordering::SeqCst)
                );
                trk.eof.store(true, Ordering::SeqCst);
            }
            if let Ok(mut c) = trk.consumer.lock() {
                while c.pop().is_ok() {}
            }
            // El hueco anterior pertenece a la posición que se abandona.
            trk.skip_frames.store(0, Ordering::SeqCst);
            trk.flush_done.store(generation, Ordering::SeqCst);
        }
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
            // El salto ya se aplicó si el reloj lo alcanzó o si dejó de estar pendiente (tras un salto
            // hacia atrás el reloj queda por debajo de `transition_frame`).
            if cur >= q.transition_frame || !self.clock_jumps.jump_pending() {
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
