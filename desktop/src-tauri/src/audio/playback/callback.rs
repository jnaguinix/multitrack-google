//! El bloque del callback de audio: una sola implementación para el stream CPAL (`ensure_stream`) y para
//! `simulate_callback_block` (pruebas), de modo que las pruebas ejercitan exactamente lo que suena.
//!
//! Corre en el hilo de audio en tiempo real: sin asignaciones, sin registros y sin bloqueos que esperen
//! (solo `try_lock`; si un recurso está ocupado, ese bloque sale en silencio o la pista se resincroniza después).

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::audio::metronome::MetronomeEngine;
use crate::audio::output::AudioStreamStats;
use crate::audio::routing::{music_mono, soft_limit, RoutingSlot, LIMITER_KNEE};

use super::block::{
    apply_pan, buffering_ready, consume_track_block, end_of_song_gain, pan_law, smooth_toward, smoothing_alpha, PanLaw,
    END_FADE_GUARD_FRAMES,
};
use super::clock::{advance_clock, ClockJumps};
use super::fade::FadeEnvelope;
use super::bus::TrackBus;
use super::types::{BusMeters, StreamTrackHandle};

/// Fotogramas máximos por bloque del callback. Los búferes de mezcla se reservan con este tamaño al crear el
/// mezclador; WASAPI en modo compartido entrega bloques de unos pocos miles como mucho.
pub const MAX_CALLBACK_FRAMES: usize = 32_768;

/// Pistas con volumen y paneo suavizados (estado preasignado; una pista más allá de este número se aplica sin rampa).
const MAX_SMOOTH_TRACKS: usize = 64;

/// Volumen y paneo que la pista tenía al final del bloque anterior. `key` identifica a la pista (la dirección de su
/// `Arc` de ganancia): si en esa posición hay otra pista (se cargó otra canción) el estado se descarta y se parte del
/// valor pedido, en vez de hacer una rampa desde el volumen de otra pista.
#[derive(Clone, Copy)]
struct TrackSmooth {
    key: usize,
    gain: f32,
    pan: f32,
}

/// Estado del motor que lee el callback. Son los mismos `Arc` de `PlaybackEngine`, clonados una vez al abrir la
/// salida: el motor cambia su contenido, nunca el `Arc`.
pub struct CallbackShared {
    pub stream_tracks: Arc<Mutex<Vec<StreamTrackHandle>>>,
    pub is_playing: Arc<AtomicBool>,
    pub is_buffering: Arc<AtomicBool>,
    pub buffering_start_time: Arc<Mutex<Option<Instant>>>,
    pub last_prefill_duration_ms: Arc<AtomicU64>,
    pub seek_generation: Arc<AtomicU64>,
    pub current_frame: Arc<AtomicU64>,
    pub clock_jumps: Arc<ClockJumps>,
    pub total_frames: Arc<AtomicU64>,
    pub fade: Arc<Mutex<FadeEnvelope>>,
    pub stats: Arc<AudioStreamStats>,
    pub metronome: Arc<Mutex<MetronomeEngine>>,
    pub master_gain: Arc<AtomicU32>,
    pub cue_master_gain: Arc<AtomicU32>,
    pub monitor_gain: Arc<AtomicU32>,
    pub is_vamping: Arc<AtomicBool>,
    pub routing: Arc<RoutingSlot>,
    pub bus_meters: Arc<BusMeters>,
}

/// Búferes de mezcla preasignados y el estado que el callback conserva entre bloques.
pub struct BlockMixer {
    shared: CallbackShared,
    main_l: Vec<f32>,
    main_r: Vec<f32>,
    cue_l: Vec<f32>,
    cue_r: Vec<f32>,
    both_l: Vec<f32>,
    both_r: Vec<f32>,
    guide_l: Vec<f32>,
    guide_r: Vec<f32>,
    mon_l: Vec<f32>,
    mon_r: Vec<f32>,
    click_buf: Vec<f32>,
    /// Fotograma de la canción donde debería empezar el siguiente bloque si el reloj fuera continuo. Si no
    /// coincide (seek, salto de sección, vuelta de vamp) el metrónomo se recoloca.
    expected_start_frame: u64,
    /// Suavizado de volumen y paneo por pista (sin asignar en el callback: se crea lleno al abrir la salida).
    track_smooth: Vec<TrackSmooth>,
    /// Volúmenes maestros del bloque anterior (NaN = sin inicializar).
    smooth_master: f32,
    smooth_cue: f32,
    smooth_monitor: f32,
}

/// Guarda `value` en `slot` si es menor (mínimo atómico sin bloqueos).
fn store_min(slot: &AtomicU64, value: u64) {
    let mut current = slot.load(Ordering::Relaxed);
    while value < current {
        match slot.compare_exchange_weak(current, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(actual) => current = actual,
        }
    }
}

/// Guarda `value` en `slot` si es mayor (máximo atómico sin bloqueos).
fn store_max(slot: &AtomicU64, value: u64) {
    let mut current = slot.load(Ordering::Relaxed);
    while value > current {
        match slot.compare_exchange_weak(current, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(actual) => current = actual,
        }
    }
}

impl BlockMixer {
    /// Reserva los búferes (fuera del hilo de audio: se llama al abrir la salida).
    pub fn new(shared: CallbackShared) -> Self {
        let buf = || vec![0.0f32; MAX_CALLBACK_FRAMES];
        Self {
            shared,
            main_l: buf(),
            main_r: buf(),
            cue_l: buf(),
            cue_r: buf(),
            both_l: buf(),
            both_r: buf(),
            guide_l: buf(),
            guide_r: buf(),
            mon_l: buf(),
            mon_r: buf(),
            click_buf: buf(),
            expected_start_frame: u64::MAX,
            track_smooth: vec![TrackSmooth { key: 0, gain: 1.0, pan: 0.0 }; MAX_SMOOTH_TRACKS],
            smooth_master: f32::NAN,
            smooth_cue: f32::NAN,
            smooth_monitor: f32::NAN,
        }
    }

    /// Mezcla un bloque intercalado de `channels` canales a `sample_rate` (la frecuencia del stream) y avanza el
    /// reloj de la canción.
    pub fn process(&mut self, data: &mut [f32], channels: usize, sample_rate: u32) {
        let Self {
            shared: s,
            main_l,
            main_r,
            cue_l,
            cue_r,
            both_l,
            both_r,
            guide_l,
            guide_r,
            mon_l,
            mon_r,
            click_buf,
            expected_start_frame,
            track_smooth,
            smooth_master,
            smooth_cue,
            smooth_monitor,
        } = self;

        let t0 = Instant::now();
        s.stats.callbacks.fetch_add(1, Ordering::Relaxed);

        if !s.is_playing.load(Ordering::Relaxed) || channels == 0 {
            data.fill(0.0);
            return;
        }

        let tracks_guard = match s.stream_tracks.try_lock() {
            Ok(g) => g,
            Err(_) => {
                data.fill(0.0);
                return;
            }
        };

        if tracks_guard.is_empty() {
            data.fill(0.0);
            return;
        }

        let frames = data.len() / channels;

        // Los búferes de mezcla se dimensionaron al crear el mezclador (MAX_CALLBACK_FRAMES): un bloque mayor no
        // se procesa (silencio y aviso en las estadísticas) en vez de reasignar aquí (A10).
        if frames > MAX_CALLBACK_FRAMES {
            data.fill(0.0);
            s.stats.underruns.fetch_add(1, Ordering::Relaxed);
            return;
        }
        for b in [&mut *main_l, &mut *main_r, &mut *cue_l, &mut *cue_r, &mut *both_l, &mut *both_r] {
            b[..frames].fill(0.0);
        }
        for b in [&mut *guide_l, &mut *guide_r, &mut *mon_l, &mut *mon_r, &mut *click_buf] {
            b[..frames].fill(0.0);
        }

        let mut fade = match s.fade.try_lock() {
            Ok(f) => f,
            Err(_) => {
                data.fill(0.0);
                return;
            }
        };

        // Estado de buffering ANTES de leer ningún fotograma de las pistas.
        if s.is_buffering.load(Ordering::SeqCst) {
            if !buffering_ready(&tracks_guard, s.seek_generation.load(Ordering::SeqCst), sample_rate as u64) {
                data.fill(0.0);
                return;
            }
            s.is_buffering.store(false, Ordering::SeqCst);
            let dur_ms = if let Ok(mut guard) = s.buffering_start_time.try_lock() {
                guard.take().map(|t| t.elapsed().as_millis() as u64).unwrap_or(0)
            } else {
                0
            };
            s.last_prefill_duration_ms.store(dur_ms, Ordering::Relaxed);
            s.stats.min_ring_buffer_level_ms.store(u64::MAX, Ordering::Relaxed);
            fade.start_fade_in();
        }

        let any_solo = tracks_guard.iter().any(|t| t.soloed.load(Ordering::Relaxed));
        let mut callback_min_track_frames = u64::MAX;
        // Fracción que recorre hacia su objetivo el volumen suavizado en este bloque.
        let alpha = smoothing_alpha(frames, sample_rate);
        let inv_frames = 1.0 / frames.max(1) as f32;

        for (index, trk) in tracks_guard.iter().enumerate() {
            let is_muted = trk.muted.load(Ordering::Relaxed);
            let is_solo = trk.soloed.load(Ordering::Relaxed);
            let track_bus = TrackBus::from_u8(trk.bus.load(Ordering::Relaxed));
            let monitor_on = trk.monitor.load(Ordering::Relaxed);
            let split_on = trk.split.load(Ordering::Relaxed);
            let solo_silent = any_solo && !is_solo;
            // Secuencia dividida: el mute de la pista apaga la música (canal derecho); el click y la guía del canal
            // izquierdo tienen su propio mute y volumen (fader Click). Una pista normal nunca tiene `cue_on`.
            let music_on = !is_muted && !solo_silent;
            let cue_on = split_on && !trk.cue_muted.load(Ordering::Relaxed) && !solo_silent;
            let cue_g_trk = f32::from_bits(trk.cue_gain.load(Ordering::Relaxed));

            if !music_on && !cue_on {
                // Una pista silenciada también avanza: se consume (y se resincroniza) igual.
                if let Ok(mut c) = trk.consumer.try_lock() {
                    callback_min_track_frames = callback_min_track_frames.min((c.slots() / 2) as u64);
                    consume_track_block(&mut c, &trk.skip_frames, trk.eof.load(Ordering::Relaxed), frames, |_, _, _| {});
                } else {
                    trk.skip_frames.fetch_add(frames as u64, Ordering::Relaxed);
                }
                continue;
            }

            // Volumen y paneo no saltan de un bloque al siguiente: se pasa del valor anterior al nuevo con una rampa
            // lineal dentro del bloque (si no, un cambio de fader suena a clic o a «zumbido» al arrastrar).
            let g_target = f32::from_bits(trk.gain.load(Ordering::Relaxed));
            let pan_target = trk.pan.load(Ordering::Relaxed) as f32 / 100.0;
            let (g0, p0, g1, p1) = match track_smooth.get_mut(index) {
                Some(st) => {
                    let key = Arc::as_ptr(&trk.gain) as usize;
                    if st.key != key {
                        *st = TrackSmooth { key, gain: g_target, pan: pan_target };
                    }
                    let (g0, p0) = (st.gain, st.pan);
                    st.gain = smooth_toward(g0, g_target, alpha);
                    st.pan = smooth_toward(p0, pan_target, alpha);
                    (g0, p0, st.gain, st.pan)
                }
                None => (g_target, pan_target, g_target, pan_target),
            };
            let law0 = pan_law(p0, g0);
            let law1 = pan_law(p1, g1);
            let (d_l, d_r, d_c) = (
                (law1.pan_l - law0.pan_l) * inv_frames,
                (law1.pan_r - law0.pan_r) * inv_frames,
                (law1.cross - law0.cross) * inv_frames,
            );

            if let Ok(mut c) = trk.consumer.try_lock() {
                callback_min_track_frames = callback_min_track_frames.min((c.slots() / 2) as u64);

                let track_eof = trk.eof.load(Ordering::Relaxed);
                let mut pk_l = 0.0f32;
                let mut pk_r = 0.0f32;
                let had_underrun = consume_track_block(&mut c, &trk.skip_frames, track_eof, frames, |f, l, r| {
                    let t = (f + 1) as f32;
                    let law = PanLaw { pan_l: law0.pan_l + d_l * t, pan_r: law0.pan_r + d_r * t, cross: law0.cross + d_c * t };
                    if split_on {
                        // Canal izquierdo (click y guía) → auriculares; canal derecho (instrumentos) → música.
                        if cue_on {
                            let cl = l * cue_g_trk;
                            cue_l[f] += cl;
                            cue_r[f] += cl;
                        }
                        if music_on {
                            let (ml, mr) = apply_pan(r, r, law);
                            pk_l = pk_l.max(ml.abs());
                            pk_r = pk_r.max(mr.abs());
                            main_l[f] += ml;
                            main_r[f] += mr;
                            if monitor_on {
                                mon_l[f] += ml;
                                mon_r[f] += mr;
                            }
                        }
                        return;
                    }
                    let (tl, tr) = apply_pan(l, r, law);
                    pk_l = pk_l.max(tl.abs());
                    pk_r = pk_r.max(tr.abs());
                    match track_bus {
                        TrackBus::Main => {
                            main_l[f] += tl;
                            main_r[f] += tr;
                        }
                        TrackBus::CueClick => {
                            cue_l[f] += tl;
                            cue_r[f] += tr;
                        }
                        TrackBus::Both => {
                            both_l[f] += tl;
                            both_r[f] += tr;
                        }
                        TrackBus::Guide => {
                            guide_l[f] += tl;
                            guide_r[f] += tr;
                        }
                    }
                    if monitor_on {
                        mon_l[f] += tl;
                        mon_r[f] += tr;
                    }
                });
                trk.meter.record(pk_l, pk_r);
                if had_underrun && !track_eof && !s.is_buffering.load(Ordering::Relaxed) {
                    s.stats.underruns.fetch_add(1, Ordering::Relaxed);
                }
            } else {
                // El transporte tiene el anillo: este bloque no se leyó, la pista queda un bloque atrás respecto
                // al reloj y se recupera descartando esa cantidad después.
                trk.skip_frames.fetch_add(frames as u64, Ordering::Relaxed);
            }
        }

        if callback_min_track_frames != u64::MAX {
            let sr = (sample_rate.max(1)) as u64;
            store_min(&s.stats.min_ring_buffer_level_ms, (callback_min_track_frames * 1000) / sr);
        }

        // Metrónomo sintético.
        let start_song_f = s.current_frame.load(Ordering::Relaxed);
        // El tono ya no altera la velocidad (lo cambia el feeder de cada pista sin tocar la duración): el reloj
        // de la canción avanza exactamente lo que dura el bloque.
        let song_frames = frames as u64;
        let end_song_f = start_song_f + song_frames;

        // Fundido de 8 ms al final natural de la canción (no en el vamp, que no termina).
        let total_song = s.total_frames.load(Ordering::Relaxed);
        let end_fade_frames = fade.fade_frames;
        let near_end = !s.is_vamping.load(Ordering::Relaxed)
            && total_song > 0
            && end_song_f + END_FADE_GUARD_FRAMES + end_fade_frames as u64 >= total_song;

        let mut metronome_pending_reposition = false;
        if let Ok(mut met) = s.metronome.try_lock() {
            if start_song_f != *expected_start_frame {
                met.seek_to_frame(start_song_f, sample_rate);
            }
            met.render_block(start_song_f, end_song_f, frames, sample_rate, &mut click_buf[..frames]);
        } else if start_song_f != *expected_start_frame {
            metronome_pending_reposition = true;
        }
        *expected_start_frame = if metronome_pending_reposition { u64::MAX } else { end_song_f };

        // Los volúmenes maestros también se acercan a su objetivo con una rampa por bloque.
        let master_t = f32::from_bits(s.master_gain.load(Ordering::Relaxed));
        let cue_t = f32::from_bits(s.cue_master_gain.load(Ordering::Relaxed));
        let monitor_t = f32::from_bits(s.monitor_gain.load(Ordering::Relaxed));
        let (master0, cue0, monitor0) = (
            if smooth_master.is_finite() { *smooth_master } else { master_t },
            if smooth_cue.is_finite() { *smooth_cue } else { cue_t },
            if smooth_monitor.is_finite() { *smooth_monitor } else { monitor_t },
        );
        *smooth_master = smooth_toward(master0, master_t, alpha);
        *smooth_cue = smooth_toward(cue0, cue_t, alpha);
        *smooth_monitor = smooth_toward(monitor0, monitor_t, alpha);
        let (d_master, d_cue, d_monitor) = (
            (*smooth_master - master0) * inv_frames,
            (*smooth_cue - cue0) * inv_frames,
            (*smooth_monitor - monitor0) * inv_frames,
        );
        // Matriz de ruteo del dispositivo: se copia a la pila una vez por bloque (sin bloqueos ni asignaciones).
        let route = s.routing.load();

        // Medidores de bus: acumuladores locales en la pila; se publican una vez por bloque.
        let (mut mk_l, mut mk_r, mut ck, mut ok_l, mut ok_r) = (0.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32);
        let mut clk_pk = 0.0f32;
        let mut mon_pk = 0.0f32;
        // Muestras que tocaron el limitador en este bloque (se publican una vez al final).
        let mut limited: u64 = 0;

        // Fuentes lógicas -> canales de salida según la matriz, con el micro-fundido y el limitador.
        for f in 0..frames {
            let end_g = if near_end {
                end_of_song_gain(start_song_f + f as u64, total_song, end_fade_frames)
            } else {
                1.0
            };
            let env_gain = fade.next_gain() * end_g;
            let t = (f + 1) as f32;
            let (master_g, cue_g, monitor_g) = (master0 + d_master * t, cue0 + d_cue * t, monitor0 + d_monitor * t);
            clk_pk = clk_pk.max((click_buf[f] * cue_g * env_gain).abs());

            let m_l = (main_l[f] + both_l[f]) * master_g;
            let m_r = (main_r[f] + both_r[f]) * master_g;
            let click_src = ((cue_l[f] + cue_r[f] + both_l[f] + both_r[f]) * 0.5 + click_buf[f]) * cue_g;
            let guide_src = (guide_l[f] + guide_r[f]) * 0.5 * cue_g;
            let monitor_src = (mon_l[f] + mon_r[f]) * 0.5 * monitor_g;
            let src = [m_l, m_r, music_mono(m_l, m_r), click_src, guide_src, monitor_src];

            let frame = &mut data[f * channels..(f + 1) * channels];
            route.mix_frame(&src, frame);

            mk_l = mk_l.max((m_l * env_gain).abs());
            mk_r = mk_r.max((m_r * env_gain).abs());
            ck = ck.max(click_src.abs().max(guide_src.abs()) * env_gain);
            mon_pk = mon_pk.max(monitor_src.abs() * env_gain);
            for (ch, v) in frame.iter_mut().enumerate() {
                let o = *v * env_gain;
                if ch == 0 {
                    ok_l = ok_l.max(o.abs());
                } else {
                    ok_r = ok_r.max(o.abs());
                }
                limited += (o.abs() > LIMITER_KNEE) as u64;
                *v = soft_limit(o);
            }
        }
        if limited > 0 {
            s.stats.limited_samples.fetch_add(limited, Ordering::Relaxed);
        }
        s.stats.output_samples.fetch_add((frames * channels) as u64, Ordering::Relaxed);
        s.bus_meters.main.record(mk_l, mk_r);
        s.bus_meters.cue.record(ck, ck);
        s.bus_meters.out.record(ok_l, ok_r);
        s.bus_meters.click.record(clk_pk, clk_pk);
        s.bus_meters.monitor.record(mon_pk, mon_pk);

        let vamping_now = s.is_vamping.load(Ordering::Relaxed);
        let clock_now = advance_clock(&s.current_frame, &s.clock_jumps, song_frames, vamping_now);
        if clock_now >= s.total_frames.load(Ordering::Relaxed) && !vamping_now {
            s.is_playing.store(false, Ordering::Relaxed);
        }

        store_max(&s.stats.max_callback_duration_us, t0.elapsed().as_micros() as u64);
    }
}
