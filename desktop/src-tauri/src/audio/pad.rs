//! Sintetizador de pad continuo en tiempo real para canciones sin secuencia.
//!
//! Corre en el hilo del callback de audio: memoria fija en la pila, sin asignaciones dinámicas,
//! sin bloqueos (`Mutex`) ni registro. Cambia de nota con fundido cruzado suave y suaviza volumen y mute.

use std::f32::consts::TAU;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use serde::{Deserialize, Serialize};

use crate::audio::playback::block::{sanitize_gain, smooth_toward, smoothing_alpha};
use crate::audio::playback::types::PeakMeter;

/// Máximo de voces simultáneas durante cambios rápidos de nota con fundido cruzado.
const MAX_PAD_VOICES: usize = 4;
/// Ocho osciladores por voz (cuatro pares estéreo: tónica, quinta, octava y duodécima).
const VOICE_OSCS: usize = 8;
/// Duración del fundido cruzado al cambiar de nota o transponer (segundos).
const CROSSFADE_SEC: f32 = 0.45;
/// Entrada progresiva del pad al pulsar Play o encenderlo (segundos).
pub const PAD_FADE_IN_SEC: f32 = 2.5;
/// Salida decreciente del pad al apagarlo, pausar o parar (segundos).
pub const PAD_FADE_OUT_SEC: f32 = 3.0;
/// Corte rápido de emergencia (doble Stop o cambio a canción normal): 8 ms sin chasquido.
const PAD_FAST_CUT_SEC: f32 = 0.008;
/// Escala de salida conservadora: deja margen amplio bajo `LIMITER_KNEE` (0.9) y evita saturación.
const PAD_OUTPUT_SCALE: f32 = 0.25;

/// Configuración del pad recibida desde la interfaz o incluida en el estado del motor.
/// Sin comas en estos comentarios: `scripts/verify-ipc.ts` analiza los campos de la struct.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PadConfig {
    pub active_mode: bool,
    pub enabled: bool,
    pub note: u8,
    pub gain: f32,
    #[serde(default)]
    pub monitor: bool,
}

impl PadConfig {
    pub const fn inactive() -> Self {
        Self {
            active_mode: false,
            enabled: false,
            note: 0,
            gain: 0.0,
            monitor: false,
        }
    }
}

impl Default for PadConfig {
    fn default() -> Self {
        Self::inactive()
    }
}

/// Convierte un nombre de tono (`"G Major"`, `"Bb"`, `"F#m"`, `"Am"`) al índice cromático `0..=11` (`C=0`).
pub fn parse_key_note(key: &str) -> u8 {
    let trimmed = key.trim();
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return 0;
    };
    let base: i32 = match first.to_ascii_uppercase() {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return 0,
    };
    let offset = match chars.next() {
        Some('#' | '♯') => 1,
        Some('b' | '♭') => -1,
        _ => 0,
    };
    (base + offset).rem_euclid(12) as u8
}

/// Transpone una nota `0..=11` un número de semitonos (`-6..=+6`), manteniendo el rango `0..=11`.
#[inline]
pub fn transpose_note(note: u8, semitones: i32) -> u8 {
    ((note as i32 + semitones).rem_euclid(12)) as u8
}

/// Estado atómico compartido entre los comandos de control y el callback de audio (sin bloqueos).
pub struct PadControl {
    active_mode: AtomicBool,
    enabled: AtomicBool,
    note: AtomicU8,
    gain: AtomicU32,
    monitor: AtomicBool,
    generation: AtomicU64,
    fast_cut_gen: AtomicU64,
    tail_active: AtomicBool,
    pub meter: PeakMeter,
}

impl Default for PadControl {
    fn default() -> Self {
        Self::new()
    }
}

impl PadControl {
    pub fn new() -> Self {
        Self {
            active_mode: AtomicBool::new(false),
            enabled: AtomicBool::new(false),
            note: AtomicU8::new(0),
            gain: AtomicU32::new(0.8f32.to_bits()),
            monitor: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            fast_cut_gen: AtomicU64::new(0),
            tail_active: AtomicBool::new(false),
            meter: PeakMeter::default(),
        }
    }

    /// Aplica una configuración nueva descartando ganancias no finitas (`NaN`/infinito).
    pub fn apply(&self, cfg: PadConfig) {
        self.active_mode.store(cfg.active_mode, Ordering::SeqCst);
        self.enabled.store(cfg.enabled, Ordering::SeqCst);
        self.note.store(cfg.note % 12, Ordering::SeqCst);
        if let Some(g) = sanitize_gain(cfg.gain) {
            self.gain.store(g.to_bits(), Ordering::SeqCst);
        }
        self.monitor.store(cfg.monitor, Ordering::SeqCst);
    }

    /// Marca el inicio de una canción nueva en modo pad para reiniciar fases y rampa de entrada.
    pub fn reset_for_load(&self, cfg: PadConfig) {
        self.apply(cfg);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// Desactiva el modo pad al cambiar a una canción normal o descargar, cortando limpio en 8 ms si quedaba cola.
    pub fn deactivate_for_song_change(&self) {
        self.active_mode.store(false, Ordering::SeqCst);
        self.enabled.store(false, Ordering::SeqCst);
        self.monitor.store(false, Ordering::SeqCst);
        self.request_fast_cut();
    }

    /// Solicita cortar rápido en 8 ms una cola de salida activa (segundo Stop de emergencia o cambio de canción).
    pub fn request_fast_cut(&self) {
        self.fast_cut_gen.fetch_add(1, Ordering::SeqCst);
    }

    #[inline]
    pub fn fast_cut_generation(&self) -> u64 {
        self.fast_cut_gen.load(Ordering::Relaxed)
    }

    #[inline]
    pub fn set_tail_active(&self, active: bool) {
        self.tail_active.store(active, Ordering::Relaxed);
    }

    #[inline]
    pub fn is_tail_active(&self) -> bool {
        self.tail_active.load(Ordering::Relaxed)
    }

    #[inline]
    pub fn is_active_mode(&self) -> bool {
        self.active_mode.load(Ordering::Relaxed)
    }

    #[inline]
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    #[inline]
    pub fn note(&self) -> u8 {
        self.note.load(Ordering::Relaxed) % 12
    }

    #[inline]
    pub fn gain(&self) -> f32 {
        f32::from_bits(self.gain.load(Ordering::Relaxed))
    }

    #[inline]
    pub fn is_monitor(&self) -> bool {
        self.monitor.load(Ordering::Relaxed)
    }

    #[inline]
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    pub fn snapshot(&self) -> PadConfig {
        PadConfig {
            active_mode: self.is_active_mode(),
            enabled: self.is_enabled(),
            note: self.note(),
            gain: self.gain(),
            monitor: self.is_monitor(),
        }
    }
}

#[derive(Clone, Copy)]
struct PadVoice {
    note: u8,
    sample_rate: u32,
    level: f32,
    target_level: f32,
    phases: [f32; VOICE_OSCS],
    phase_inc: [f32; VOICE_OSCS],
}

impl Default for PadVoice {
    fn default() -> Self {
        Self {
            note: 0,
            sample_rate: 0,
            level: 0.0,
            target_level: 0.0,
            phases: [0.0; VOICE_OSCS],
            phase_inc: [0.0; VOICE_OSCS],
        }
    }
}

/// Desafines en cents y amplitudes de los 4 pares estéreo (sin tercera fija: funciona en mayor y menor).
const PAIR_SPECS: [(f32, f32, f32); 4] = [
    (0.0, 5.0, 0.40),   // Tónica
    (7.0, -6.0, 0.26),  // Quinta
    (12.0, 9.0, 0.24),  // Octava
    (19.0, -7.0, 0.10), // Octava + quinta suave
];

impl PadVoice {
    fn configure(&mut self, note: u8, sample_rate: u32, reset_phases: bool) {
        let safe_note = note % 12;
        let sr = sample_rate.max(1) as f32;
        // Mantiene la raíz en un registro cálido (G2..F#3) para las 12 tonalidades.
        let base_midi = if safe_note >= 7 {
            48.0 + safe_note as f32 - 12.0
        } else {
            48.0 + safe_note as f32
        };
        for (pair_idx, &(semitones, cents, _)) in PAIR_SPECS.iter().enumerate() {
            let midi = base_midi + semitones;
            let hz = 440.0 * 2.0_f32.powf((midi - 69.0) / 12.0);
            let hz_l = hz * 2.0_f32.powf(-cents / 1200.0);
            let hz_r = hz * 2.0_f32.powf(cents / 1200.0);
            self.phase_inc[pair_idx * 2] = TAU * hz_l / sr;
            self.phase_inc[pair_idx * 2 + 1] = TAU * hz_r / sr;
        }
        self.note = safe_note;
        self.sample_rate = sample_rate;
        if reset_phases {
            self.phases = [0.0; VOICE_OSCS];
        }
    }

    #[inline]
    fn next_stereo(&mut self) -> (f32, f32) {
        let mut sum_l = 0.0f32;
        let mut sum_r = 0.0f32;
        for (pair_idx, &(_, _, amp)) in PAIR_SPECS.iter().enumerate() {
            let i_l = pair_idx * 2;
            let i_r = i_l + 1;

            let p_l = self.phases[i_l] + self.phase_inc[i_l];
            self.phases[i_l] = if p_l >= TAU { p_l - TAU } else { p_l };

            let p_r = self.phases[i_r] + self.phase_inc[i_r];
            self.phases[i_r] = if p_r >= TAU { p_r - TAU } else { p_r };

            let osc_l = p_l.sin() + 0.22 * (2.0 * p_l).sin() + 0.08 * (3.0 * p_l).sin();
            let osc_r = p_r.sin() + 0.22 * (2.0 * p_r).sin() + 0.08 * (3.0 * p_r).sin();

            sum_l += osc_l * amp;
            sum_r += osc_r * amp;
        }
        (sum_l, sum_r)
    }
}

/// Estado interno del sintetizador, propiedad exclusiva de `BlockMixer` (hilo de audio).
pub struct PadSynth {
    voices: [PadVoice; MAX_PAD_VOICES],
    current_note: u8,
    last_generation: u64,
    last_fast_cut_gen: u64,
    fast_cutting: bool,
    /// Envolvente musical lenta (`0.0..=1.0`): sube en `PAD_FADE_IN_SEC` y baja en `PAD_FADE_OUT_SEC`.
    env_level: f32,
    /// Ganancia suavizada del fader de volumen (rampa rápida de ~10 ms sin clics).
    smooth_gain: f32,
    lp_l: f32,
    lp_r: f32,
    lfo_phase: f32,
}

impl Default for PadSynth {
    fn default() -> Self {
        Self::new()
    }
}

impl PadSynth {
    pub fn new() -> Self {
        Self {
            voices: [PadVoice::default(); MAX_PAD_VOICES],
            current_note: 0,
            last_generation: u64::MAX,
            last_fast_cut_gen: 0,
            fast_cutting: false,
            env_level: 0.0,
            smooth_gain: 0.0,
            lp_l: 0.0,
            lp_r: 0.0,
            lfo_phase: 0.0,
        }
    }

    /// Indica si el pad aún tiene energía sonando (p. ej. bajando suavemente tras pausar o parar).
    #[inline]
    pub fn has_active_tail(&self) -> bool {
        self.env_level > 0.0
    }

    /// Silencia y limpia el estado del sintetizador al pasar a una canción normal con pistas.
    pub fn silence_reset(&mut self) {
        for v in &mut self.voices {
            v.level = 0.0;
            v.target_level = 0.0;
        }
        self.env_level = 0.0;
        self.fast_cutting = false;
        self.smooth_gain = 0.0;
        self.lp_l = 0.0;
        self.lp_r = 0.0;
        self.last_generation = u64::MAX;
    }

    fn switch_note(&mut self, note: u8, sample_rate: u32) {
        let target = note % 12;
        self.current_note = target;

        // Si alguna voz aún activa ya toca esa nota, se reactiva sin cortes.
        let existing = self
            .voices
            .iter()
            .position(|v| v.note == target && (v.level > 0.0 || v.target_level > 0.0));
        if let Some(idx) = existing {
            for (i, v) in self.voices.iter_mut().enumerate() {
                v.target_level = if i == idx { 1.0 } else { 0.0 };
                if i == idx && v.sample_rate != sample_rate {
                    v.configure(target, sample_rate, false);
                }
            }
            return;
        }

        // Busca una voz libre o, si todas suenan, la más silenciosa.
        let mut chosen = 0usize;
        let mut min_level = f32::MAX;
        for (i, v) in self.voices.iter().enumerate() {
            if v.level == 0.0 && v.target_level == 0.0 {
                chosen = i;
                break;
            }
            if v.level < min_level {
                min_level = v.level;
                chosen = i;
            }
        }

        for (i, v) in self.voices.iter_mut().enumerate() {
            if i == chosen {
                v.configure(target, sample_rate, true);
                v.level = 0.0;
                v.target_level = 1.0;
            } else {
                v.target_level = 0.0;
            }
        }
    }

    /// Suma `frames` muestras estéreo del pad en `out_l`/`out_r` (y en `mon_l`/`mon_r` si `monitor` está activo).
    /// Devuelve `true` si emitió audio en este bloque (incluyendo cola decreciente) y `false` si ya está en silencio.
    /// Cero asignaciones dinámicas, cero bloqueos, cero registro.
    #[allow(clippy::too_many_arguments)]
    pub fn render_block(
        &mut self,
        ctl: &PadControl,
        pitch_semitones: i32,
        frames: usize,
        sample_rate: u32,
        out_l: &mut [f32],
        out_r: &mut [f32],
        mon_l: &mut [f32],
        mon_r: &mut [f32],
        transport_playing: bool,
    ) -> bool {
        if frames == 0 {
            return false;
        }

        let active_mode = ctl.is_active_mode();
        let want_on = transport_playing && active_mode && ctl.is_enabled();

        let fc_gen = ctl.fast_cut_generation();
        if fc_gen != self.last_fast_cut_gen {
            self.last_fast_cut_gen = fc_gen;
            if !want_on && self.env_level > 0.0 {
                self.fast_cutting = true;
            }
        }
        if want_on {
            self.fast_cutting = false;
        }

        let target_note = transpose_note(ctl.note(), pitch_semitones);
        let gen = ctl.generation();
        if gen != self.last_generation {
            self.last_generation = gen;
            if self.env_level == 0.0 {
                self.current_note = target_note;
                self.smooth_gain = sanitize_gain(ctl.gain()).unwrap_or(0.0);
                self.lp_l = 0.0;
                self.lp_r = 0.0;
                self.fast_cutting = false;
                for (i, v) in self.voices.iter_mut().enumerate() {
                    if i == 0 {
                        v.configure(target_note, sample_rate, true);
                        v.level = 1.0;
                        v.target_level = 1.0;
                    } else {
                        v.level = 0.0;
                        v.target_level = 0.0;
                    }
                }
            } else if active_mode && self.current_note != target_note {
                self.switch_note(target_note, sample_rate);
            }
        } else if active_mode && self.current_note != target_note {
            self.switch_note(target_note, sample_rate);
        } else {
            for v in &mut self.voices {
                if (v.level > 0.0 || v.target_level > 0.0) && v.sample_rate != sample_rate {
                    v.configure(v.note, sample_rate, false);
                }
            }
        }

        if !want_on && self.env_level == 0.0 {
            self.lp_l = 0.0;
            self.lp_r = 0.0;
            self.fast_cutting = false;
            ctl.set_tail_active(false);
            ctl.meter.record(0.0, 0.0);
            return false;
        }

        // El fader de volumen se suaviza rápido (~10 ms); la entrada/salida musical la gobierna `env_level`.
        // Si el modo pad acaba de desactivarse (cambio de canción), conservamos la ganancia anterior para que
        // los 8 ms de bajada de `env_level` sean lisos sin saltos.
        let g_target = if active_mode {
            sanitize_gain(ctl.gain()).unwrap_or(self.smooth_gain)
        } else {
            self.smooth_gain
        };
        let g0 = self.smooth_gain;
        let alpha = smoothing_alpha(frames, sample_rate);
        let g1 = smooth_toward(g0, g_target, alpha);
        self.smooth_gain = g1;

        if g0 == 0.0 && g1 == 0.0 && !want_on {
            self.env_level = 0.0;
            self.fast_cutting = false;
            self.lp_l = 0.0;
            self.lp_r = 0.0;
            ctl.set_tail_active(false);
            ctl.meter.record(0.0, 0.0);
            return false;
        }

        let sr = sample_rate.max(1) as f32;
        let crossfade_step = 1.0 / (CROSSFADE_SEC * sr).max(1.0);
        let env_step_in = 1.0 / (PAD_FADE_IN_SEC * sr).max(1.0);
        let fade_out_sec = if self.fast_cutting { PAD_FAST_CUT_SEC } else { PAD_FADE_OUT_SEC };
        let env_step_out = 1.0 / (fade_out_sec * sr).max(1.0);
        let inv_frames = 1.0 / frames.max(1) as f32;
        let d_gain = (g1 - g0) * inv_frames;

        // Filtro paso bajo suave modulado por un LFO lento (~0.13 Hz) para dar movimiento cálido.
        let cutoff = 540.0 + 140.0 * self.lfo_phase.sin();
        let lp_alpha = (1.0 - (-TAU * cutoff / sr).exp()).clamp(0.01, 0.99);
        self.lfo_phase = (self.lfo_phase + TAU * 0.13 * frames as f32 / sr) % TAU;

        let monitor_on = ctl.is_monitor();
        let mut pk_l = 0.0f32;
        let mut pk_r = 0.0f32;

        for f in 0..frames {
            if want_on {
                self.env_level = (self.env_level + env_step_in).min(1.0);
            } else {
                self.env_level = (self.env_level - env_step_out).max(0.0);
            }
            let e = self.env_level;
            // Curva S suave: arranque y llegada progresivos sin escalones.
            let env = e * e * (3.0 - 2.0 * e);

            let mut sum_l = 0.0f32;
            let mut sum_r = 0.0f32;
            for v in &mut self.voices {
                if v.level == 0.0 && v.target_level == 0.0 {
                    continue;
                }
                if v.level < v.target_level {
                    v.level = (v.level + crossfade_step).min(v.target_level);
                } else if v.level > v.target_level {
                    v.level = (v.level - crossfade_step).max(v.target_level);
                }
                // Curva S suave: derivada nula en los extremos para cruces sin clic.
                let l = v.level;
                let curve = l * l * (3.0 - 2.0 * l);
                let (vl, vr) = v.next_stereo();
                sum_l += vl * curve;
                sum_r += vr * curve;
            }

            self.lp_l += lp_alpha * (sum_l - self.lp_l);
            self.lp_r += lp_alpha * (sum_r - self.lp_r);

            let g = (g0 + d_gain * (f + 1) as f32) * env;
            let raw_l = self.lp_l * PAD_OUTPUT_SCALE * g;
            let raw_r = self.lp_r * PAD_OUTPUT_SCALE * g;
            let sl = if raw_l.is_finite() { raw_l } else { 0.0 };
            let sr_out = if raw_r.is_finite() { raw_r } else { 0.0 };

            pk_l = pk_l.max(sl.abs());
            pk_r = pk_r.max(sr_out.abs());

            out_l[f] += sl;
            out_r[f] += sr_out;
            if monitor_on {
                mon_l[f] += sl;
                mon_r[f] += sr_out;
            }
        }

        if self.env_level == 0.0 {
            self.fast_cutting = false;
        }
        ctl.set_tail_active(!transport_playing && self.env_level > 0.0);
        ctl.meter.record(pk_l, pk_r);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pad_parse_y_transposicion() {
        assert_eq!(parse_key_note("C Major"), 0);
        assert_eq!(parse_key_note("C#"), 1);
        assert_eq!(parse_key_note("Db"), 1);
        assert_eq!(parse_key_note("G Major"), 7);
        assert_eq!(parse_key_note("Am"), 9);
        assert_eq!(parse_key_note("Bb"), 10);
        assert_eq!(parse_key_note("F#m"), 6);
        assert_eq!(parse_key_note(""), 0);

        assert_eq!(transpose_note(7, 2), 9);   // G + 2 -> A
        assert_eq!(transpose_note(0, -1), 11); // C - 1 -> B
        assert_eq!(transpose_note(11, 2), 1);  // B + 2 -> C#
    }

    #[test]
    fn test_pad_no_asigna_memoria() {
        let ctl = PadControl::new();
        ctl.reset_for_load(PadConfig {
            active_mode: true,
            enabled: true,
            note: 7,
            gain: 0.9,
            monitor: true,
        });
        let mut synth = PadSynth::new();
        let mut out_l = vec![0.0f32; 480];
        let mut out_r = vec![0.0f32; 480];
        let mut mon_l = vec![0.0f32; 480];
        let mut mon_r = vec![0.0f32; 480];

        let asignaciones = crate::alloc_probe::count_allocs(|| {
            for b in 0..400u32 {
                if b == 50 {
                    ctl.apply(PadConfig { active_mode: true, enabled: true, note: 2, gain: 0.6, monitor: true });
                } else if b == 120 {
                    ctl.apply(PadConfig { active_mode: true, enabled: false, note: 2, gain: 0.6, monitor: true });
                } else if b == 200 {
                    ctl.apply(PadConfig { active_mode: true, enabled: true, note: 9, gain: 1.2, monitor: false });
                }
                out_l.fill(0.0);
                out_r.fill(0.0);
                mon_l.fill(0.0);
                mon_r.fill(0.0);
                synth.render_block(&ctl, 1, 480, 48_000, &mut out_l, &mut out_r, &mut mon_l, &mut mon_r, true);
            }
            // Cola decreciente tras pausar/parar también con cero asignaciones.
            for _ in 0..320u32 {
                out_l.fill(0.0);
                out_r.fill(0.0);
                mon_l.fill(0.0);
                mon_r.fill(0.0);
                synth.render_block(&ctl, 1, 480, 48_000, &mut out_l, &mut out_r, &mut mon_l, &mut mon_r, false);
            }
        });
        assert_eq!(asignaciones, 0, "PadSynth asignó memoria dentro del bloque de audio");
    }

    #[test]
    fn test_pad_sin_escalones_al_cambiar_nota_y_mute() {
        let ctl = PadControl::new();
        ctl.reset_for_load(PadConfig {
            active_mode: true,
            enabled: true,
            note: 0,
            gain: 1.0,
            monitor: false,
        });
        let mut synth = PadSynth::new();
        let mut out_l = vec![0.0f32; 480];
        let mut out_r = vec![0.0f32; 480];
        let mut mon_l = vec![0.0f32; 480];
        let mut mon_r = vec![0.0f32; 480];

        let mut prev_l = 0.0f32;
        let mut prev_r = 0.0f32;
        let mut max_step = 0.0f32;
        let mut peak = 0.0f32;

        for b in 0..500 {
            if b == 120 {
                ctl.apply(PadConfig { active_mode: true, enabled: true, note: 7, gain: 1.0, monitor: false });
            } else if b == 200 {
                ctl.apply(PadConfig { active_mode: true, enabled: true, note: 5, gain: 0.4, monitor: false });
            } else if b == 280 {
                ctl.apply(PadConfig { active_mode: true, enabled: false, note: 5, gain: 0.4, monitor: false });
            } else if b == 380 {
                ctl.apply(PadConfig { active_mode: true, enabled: true, note: 11, gain: 1.0, monitor: false });
            }
            out_l.fill(0.0);
            out_r.fill(0.0);
            synth.render_block(&ctl, 0, 480, 48_000, &mut out_l, &mut out_r, &mut mon_l, &mut mon_r, true);
            for i in 0..480 {
                assert!(out_l[i].is_finite() && out_r[i].is_finite());
                max_step = max_step.max((out_l[i] - prev_l).abs()).max((out_r[i] - prev_r).abs());
                peak = peak.max(out_l[i].abs()).max(out_r[i].abs());
                prev_l = out_l[i];
                prev_r = out_r[i];
            }
        }
        assert!(peak > 0.05 && peak < 0.9, "nivel inesperado del pad: {peak}");
        assert!(max_step <= 0.01, "escalón demasiado grande en el pad: {max_step}");
    }

    #[test]
    fn test_pad_entrada_incremental_salida_decreciente_y_corte_rapido() {
        let ctl = PadControl::new();
        ctl.reset_for_load(PadConfig {
            active_mode: true,
            enabled: true,
            note: 7,
            gain: 1.0,
            monitor: false,
        });
        let mut synth = PadSynth::new();
        let mut out_l = vec![0.0f32; 480];
        let mut out_r = vec![0.0f32; 480];
        let mut mon_l = vec![0.0f32; 480];
        let mut mon_r = vec![0.0f32; 480];

        let mut prev_l = 0.0f32;
        let mut max_step = 0.0f32;
        let mut correr = |synth: &mut PadSynth, bloques: usize, playing: bool| -> f32 {
            let mut pk = 0.0f32;
            for _ in 0..bloques {
                out_l.fill(0.0);
                out_r.fill(0.0);
                mon_l.fill(0.0);
                mon_r.fill(0.0);
                synth.render_block(&ctl, 0, 480, 48_000, &mut out_l, &mut out_r, &mut mon_l, &mut mon_r, playing);
                for &x in &out_l {
                    max_step = max_step.max((x - prev_l).abs());
                    prev_l = x;
                    pk = pk.max(x.abs());
                }
            }
            pk
        };

        // Entrada incremental (2,5 s): primeros 0,3 s mucho más suaves que 1,0..1,3 s y que asentado tras 2,6 s.
        let pk_inicio = correr(&mut synth, 30, true);
        let _ = correr(&mut synth, 70, true);
        let pk_medio = correr(&mut synth, 30, true);
        let _ = correr(&mut synth, 130, true);
        let pk_lleno = correr(&mut synth, 30, true);
        assert!(pk_inicio < pk_medio * 0.4, "el pad debe entrar suave, no de golpe: inicio={pk_inicio}, medio={pk_medio}");
        assert!(pk_medio < pk_lleno * 0.85, "el pad debe seguir subiendo hasta 2,5 s: medio={pk_medio}, lleno={pk_lleno}");
        assert!(pk_lleno > 0.1, "el pad lleno debe sonar claro: {pk_lleno}");

        // Salida decreciente al pausar/parar (`playing = false`): a los 0,5 s aún suena, a los 1,8 s es más bajo, a los 3,1 s silencio.
        let _ = correr(&mut synth, 50, false);
        let pk_out_1 = correr(&mut synth, 20, false);
        assert!(ctl.is_tail_active(), "debe quedar cola activa durante la bajada");
        let _ = correr(&mut synth, 110, false);
        let pk_out_2 = correr(&mut synth, 20, false);
        assert!(pk_out_1 > pk_out_2 && pk_out_2 > 0.005, "la bajada debe ser progresiva: {pk_out_1} -> {pk_out_2}");
        let _ = correr(&mut synth, 120, false);
        let pk_silencio = correr(&mut synth, 10, false);
        assert!(pk_silencio == 0.0 && !synth.has_active_tail() && !ctl.is_tail_active(), "tras 3 s debe quedar en silencio: {pk_silencio}");

        // Freno de emergencia (`request_fast_cut`): vuelve a subir y luego corta en 8 ms sin escalones.
        let _ = correr(&mut synth, 260, true);
        let _ = correr(&mut synth, 5, false);
        assert!(ctl.is_tail_active());
        ctl.request_fast_cut();
        let _ = correr(&mut synth, 2, false); // 20 ms > 8 ms
        let pk_tras_corte = correr(&mut synth, 5, false);
        assert_eq!(pk_tras_corte, 0.0, "corte rápido debe silenciar en < 20 ms");
        assert!(max_step <= 0.01, "escalón demasiado grande durante entrada/salida/corte: {max_step}");
    }

    #[test]
    fn test_pad_ganancia_nan_ignorada() {
        let ctl = PadControl::new();
        ctl.apply(PadConfig {
            active_mode: true,
            enabled: true,
            note: 4,
            gain: 0.75,
            monitor: false,
        });
        ctl.apply(PadConfig {
            active_mode: true,
            enabled: true,
            note: 4,
            gain: f32::NAN,
            monitor: false,
        });
        assert_eq!(ctl.gain(), 0.75, "una ganancia NaN no debe pisar la anterior");
        ctl.apply(PadConfig {
            active_mode: true,
            enabled: true,
            note: 4,
            gain: f32::INFINITY,
            monitor: false,
        });
        assert_eq!(ctl.gain(), 0.75, "una ganancia infinita no debe pisar la anterior");
    }
}
