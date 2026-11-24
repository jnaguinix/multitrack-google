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
/// Doce osciladores por voz (seis pares estéreo: tónica, quinta, octava, color armónico x2 y aire).
const VOICE_PAIRS: usize = 6;
const VOICE_OSCS: usize = VOICE_PAIRS * 2;
/// Capacidad fija por línea de retardo de la reverb estéreo (soporta hasta ~192 kHz sin reasignar).
const REVERB_BUF_LEN: usize = 8192;
/// Duración del fundido cruzado al cambiar de nota o armonía (segundos).
const CROSSFADE_SEC: f32 = 0.45;
/// Entrada progresiva del pad al pulsar Play o encenderlo (segundos).
pub const PAD_FADE_IN_SEC: f32 = 2.5;
/// Salida decreciente del pad al apagarlo, pausar o parar (segundos).
pub const PAD_FADE_OUT_SEC: f32 = 3.0;
/// Corte rápido de emergencia (doble Stop o cambio a canción normal): 8 ms sin chasquido.
const PAD_FAST_CUT_SEC: f32 = 0.008;
/// Escala de salida conservadora: deja margen amplio bajo `LIMITER_KNEE` (0.9) y evita saturación.
const PAD_OUTPUT_SCALE: f32 = 0.24;

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
    /// Caracter armonico (0 = Abierto 1 = Mayor 2 = Menor)
    #[serde(default)]
    pub harmony: u8,
    /// Timbre del pad (0 = Calido 1 = Ambiente 2 = Cuerdas)
    #[serde(default)]
    pub style: u8,
}

impl PadConfig {
    pub const fn inactive() -> Self {
        Self {
            active_mode: false,
            enabled: false,
            note: 0,
            gain: 0.0,
            monitor: false,
            harmony: 0,
            style: 0,
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
    harmony: AtomicU8,
    style: AtomicU8,
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
            harmony: AtomicU8::new(0),
            style: AtomicU8::new(0),
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
        self.harmony.store(cfg.harmony.min(2), Ordering::SeqCst);
        self.style.store(cfg.style.min(2), Ordering::SeqCst);
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
    pub fn harmony(&self) -> u8 {
        self.harmony.load(Ordering::Relaxed).min(2)
    }

    #[inline]
    pub fn style(&self) -> u8 {
        self.style.load(Ordering::Relaxed).min(2)
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
            harmony: self.harmony(),
            style: self.style(),
        }
    }
}

#[derive(Clone, Copy)]
struct PadVoice {
    note: u8,
    harmony: u8,
    air_mode: u8,
    sample_rate: u32,
    level: f32,
    target_level: f32,
    phases: [f32; VOICE_OSCS],
    phase_inc: [f32; VOICE_OSCS],
    pair_amps: [f32; VOICE_PAIRS],
}

impl Default for PadVoice {
    fn default() -> Self {
        Self {
            note: 0,
            harmony: 0,
            air_mode: 0,
            sample_rate: 0,
            level: 0.0,
            target_level: 0.0,
            phases: [0.0; VOICE_OSCS],
            phase_inc: [0.0; VOICE_OSCS],
            pair_amps: [0.0; VOICE_PAIRS],
        }
    }
}

/// Especificación armónica de los 6 pares estéreo según carácter (`harmony`: 0=Abierto, 1=Mayor, 2=Menor)
/// y modo aéreo (`air_mode`: 0=Cálido/Ambiente con doble octava, 1=Cuerdas en registro medio).
fn voice_pair_specs(harmony: u8, air_mode: u8) -> [(f32, f32, f32); VOICE_PAIRS] {
    // Par 3 y Par 4 definen el carácter armónico; sin tercera en modo Abierto para encajar en cualquier acorde.
    let (p3_st, p3_cents, p3_amp, p4_st, p4_cents, p4_amp) = match harmony {
        1 => (14.0, 10.0, 0.14, 16.0, -11.0, 0.08), // Mayor: 9ª cálida + 3ª mayor filtrada arriba
        2 => (15.0, 9.0, 0.14, 10.0, -11.0, 0.07),  // Menor: 3ª menor cálida + 7ª menor muy sutil
        _ => (19.0, -8.0, 0.13, 12.0, 15.0, 0.09),  // Abierto: 12ª + octava ancha (neutro)
    };
    let (p5_st, p5_cents, p5_amp) = if air_mode == 1 {
        (19.0, 13.0, 0.13) // Cuerdas: más cuerpo en medios-agudos
    } else {
        (24.0, 12.0, 0.10) // Cálido / Ambiente: velo aéreo en doble octava
    };

    [
        (0.0, 4.5, 0.30),  // Tónica grave cálida
        (7.0, -6.0, 0.21), // Quinta abierta
        (12.0, 8.5, 0.19), // Octava central
        (p3_st, p3_cents, p3_amp),
        (p4_st, p4_cents, p4_amp),
        (p5_st, p5_cents, p5_amp),
    ]
}

impl PadVoice {
    fn configure(&mut self, note: u8, harmony: u8, air_mode: u8, sample_rate: u32, reset_phases: bool) {
        let safe_note = note % 12;
        let safe_harmony = harmony.min(2);
        let safe_air = air_mode.min(1);
        let sr = sample_rate.max(1) as f32;
        // Mantiene la raíz en un registro cálido (G2..F#3) para las 12 tonalidades.
        let base_midi = if safe_note >= 7 {
            48.0 + safe_note as f32 - 12.0
        } else {
            48.0 + safe_note as f32
        };
        let specs = voice_pair_specs(safe_harmony, safe_air);
        for (pair_idx, &(semitones, cents, amp)) in specs.iter().enumerate() {
            let midi = base_midi + semitones;
            let hz = 440.0 * 2.0_f32.powf((midi - 69.0) / 12.0);
            let hz_l = hz * 2.0_f32.powf(-cents / 1200.0);
            let hz_r = hz * 2.0_f32.powf(cents / 1200.0);
            self.phase_inc[pair_idx * 2] = TAU * hz_l / sr;
            self.phase_inc[pair_idx * 2 + 1] = TAU * hz_r / sr;
            self.pair_amps[pair_idx] = amp;
        }
        self.note = safe_note;
        self.harmony = safe_harmony;
        self.air_mode = safe_air;
        self.sample_rate = sample_rate;
        if reset_phases {
            self.phases = [0.0; VOICE_OSCS];
        }
    }

    #[inline]
    fn next_stereo(&mut self, mid_breath: f32, air_breath: f32, third_harm_boost: f32) -> (f32, f32) {
        let mut sum_l = 0.0f32;
        let mut sum_r = 0.0f32;
        for pair_idx in 0..VOICE_PAIRS {
            let i_l = pair_idx * 2;
            let i_r = i_l + 1;

            let p_l = self.phases[i_l] + self.phase_inc[i_l];
            self.phases[i_l] = if p_l >= TAU { p_l - TAU } else { p_l };

            let p_r = self.phases[i_r] + self.phase_inc[i_r];
            self.phases[i_r] = if p_r >= TAU { p_r - TAU } else { p_r };

            // Oscilador cálido con leve 2º y 3º armónico (en estilo Cuerdas se realza un poco la textura).
            let h2 = 0.18;
            let h3 = 0.05 + third_harm_boost;
            let osc_l = p_l.sin() + h2 * (2.0 * p_l).sin() + h3 * (3.0 * p_l).sin();
            let osc_r = p_r.sin() + h2 * (2.0 * p_r).sin() + h3 * (3.0 * p_r).sin();

            let amp = match pair_idx {
                1 | 2 => self.pair_amps[pair_idx] * mid_breath,
                3 | 4 => self.pair_amps[pair_idx] * (0.75 + 0.35 * mid_breath),
                5 => self.pair_amps[pair_idx] * air_breath,
                _ => self.pair_amps[pair_idx],
            };

            sum_l += osc_l * amp;
            sum_r += osc_r * amp;
        }
        (sum_l, sum_r)
    }
}

/// Reverb difusa FDN de 4 líneas de retardo en memoria fija preasignada (0 asignaciones en tiempo real).
struct PadReverb {
    lines: Box<[[f32; REVERB_BUF_LEN]; 4]>,
    idx: [usize; 4],
    damp: [f32; 4],
    dirty: bool,
}

impl PadReverb {
    fn new() -> Self {
        Self {
            lines: Box::new([[0.0; REVERB_BUF_LEN]; 4]),
            idx: [0; 4],
            damp: [0.0; 4],
            dirty: false,
        }
    }

    fn clear(&mut self) {
        if self.dirty {
            for line in self.lines.iter_mut() {
                line.fill(0.0);
            }
            self.damp = [0.0; 4];
            self.idx = [0; 4];
            self.dirty = false;
        }
    }

    /// Calcula las longitudes de retardo (primas relativas) escaladas a la frecuencia de muestreo.
    #[inline]
    fn delay_lengths(sample_rate: u32) -> [usize; 4] {
        const BASE_48K: [u32; 4] = [1487, 1993, 2657, 3389];
        let sr = sample_rate.max(8_000) as u64;
        [
            ((BASE_48K[0] as u64 * sr) / 48_000).clamp(32, (REVERB_BUF_LEN - 1) as u64) as usize,
            ((BASE_48K[1] as u64 * sr) / 48_000).clamp(32, (REVERB_BUF_LEN - 1) as u64) as usize,
            ((BASE_48K[2] as u64 * sr) / 48_000).clamp(32, (REVERB_BUF_LEN - 1) as u64) as usize,
            ((BASE_48K[3] as u64 * sr) / 48_000).clamp(32, (REVERB_BUF_LEN - 1) as u64) as usize,
        ]
    }

    #[inline]
    fn process_sample(&mut self, in_l: f32, in_r: f32, lengths: [usize; 4], feedback: f32) -> (f32, f32) {
        self.dirty = true;
        let mut y = [0.0f32; 4];
        for i in 0..4 {
            let pos = self.idx[i];
            let delayed = self.lines[i][pos];
            // Filtro paso bajo sedoso en la cola para que nunca suene metálica.
            self.damp[i] += 0.42 * (delayed - self.damp[i]);
            y[i] = self.damp[i];
        }

        // Matriz Hadamard ortogonal 4×4 (0.5 * [1,1,1,1; ...]) para difusión envolvente sin ganancia extra.
        let sum = (y[0] + y[1] + y[2] + y[3]) * 0.5;
        let fb = [
            (sum - y[0]) * feedback + in_l * 0.35,
            (sum - y[1]) * feedback + in_r * 0.35,
            (sum - y[2]) * feedback + (in_l - in_r) * 0.25,
            (sum - y[3]) * feedback + (in_l + in_r) * 0.25,
        ];

        for i in 0..4 {
            let pos = self.idx[i];
            self.lines[i][pos] = fb[i];
            let next = pos + 1;
            self.idx[i] = if next >= lengths[i] { 0 } else { next };
        }

        let wet_l = (y[0] - y[1] + y[2] - y[3]) * 0.55;
        let wet_r = (y[0] + y[1] - y[2] - y[3]) * 0.55;
        (wet_l, wet_r)
    }
}

#[derive(Clone, Copy)]
struct StyleParams {
    cutoff_min: f32,
    cutoff_span: f32,
    air_boost: f32,
    reverb_wet: f32,
    reverb_fb: f32,
    third_harm: f32,
}

#[inline]
fn style_params(style: u8) -> StyleParams {
    match style {
        // 1 = Ambiente / Shimmer: nube amplia con brillo de doble octava respirando
        1 => StyleParams {
            cutoff_min: 560.0,
            cutoff_span: 520.0,
            air_boost: 1.55,
            reverb_wet: 0.48,
            reverb_fb: 0.84,
            third_harm: 0.0,
        },
        // 2 = Cuerdas: más presencia en medios y articulación armónica clara
        2 => StyleParams {
            cutoff_min: 720.0,
            cutoff_span: 560.0,
            air_boost: 1.0,
            reverb_wet: 0.30,
            reverb_fb: 0.74,
            third_harm: 0.05,
        },
        // 0 = Cálido (por defecto): redondo, oscuro y envolvente
        _ => StyleParams {
            cutoff_min: 440.0,
            cutoff_span: 240.0,
            air_boost: 0.55,
            reverb_wet: 0.35,
            reverb_fb: 0.78,
            third_harm: 0.0,
        },
    }
}

/// Estado interno del sintetizador, propiedad exclusiva de `BlockMixer` (hilo de audio).
pub struct PadSynth {
    voices: [PadVoice; MAX_PAD_VOICES],
    reverb: PadReverb,
    current_note: u8,
    current_harmony: u8,
    current_air_mode: u8,
    last_generation: u64,
    last_fast_cut_gen: u64,
    fast_cutting: bool,
    /// Envolvente musical lenta (`0.0..=1.0`): sube en `PAD_FADE_IN_SEC` y baja en `PAD_FADE_OUT_SEC`.
    env_level: f32,
    /// Ganancia suavizada del fader de volumen (rampa rápida de ~10 ms sin clics).
    smooth_gain: f32,
    /// Filtro paso bajo de 2 polos en cascada para sonido cálido sin aspereza digital.
    lp1_l: f32,
    lp1_r: f32,
    lp2_l: f32,
    lp2_r: f32,
    /// Tres LFOs a ritmos inconmensurables para que el pad respire sin bucle audible.
    lfo_filter: f32,
    lfo_breath: f32,
    lfo_air: f32,
    /// Mezcla suavizada del estilo elegido (evita saltos al cambiar entre Cálido / Ambiente / Cuerdas).
    smooth_cutoff_min: f32,
    smooth_cutoff_span: f32,
    smooth_air_boost: f32,
    smooth_reverb_wet: f32,
    smooth_reverb_fb: f32,
    smooth_third_harm: f32,
}

impl Default for PadSynth {
    fn default() -> Self {
        Self::new()
    }
}

impl PadSynth {
    pub fn new() -> Self {
        let def = style_params(0);
        Self {
            voices: [PadVoice::default(); MAX_PAD_VOICES],
            reverb: PadReverb::new(),
            current_note: 0,
            current_harmony: 0,
            current_air_mode: 0,
            last_generation: u64::MAX,
            last_fast_cut_gen: 0,
            fast_cutting: false,
            env_level: 0.0,
            smooth_gain: 0.0,
            lp1_l: 0.0,
            lp1_r: 0.0,
            lp2_l: 0.0,
            lp2_r: 0.0,
            lfo_filter: 0.0,
            lfo_breath: 1.1,
            lfo_air: 2.3,
            smooth_cutoff_min: def.cutoff_min,
            smooth_cutoff_span: def.cutoff_span,
            smooth_air_boost: def.air_boost,
            smooth_reverb_wet: def.reverb_wet,
            smooth_reverb_fb: def.reverb_fb,
            smooth_third_harm: def.third_harm,
        }
    }

    /// Indica si el pad aún tiene energía sonando (p. ej. bajando suavemente tras pausar o parar).
    #[inline]
    pub fn has_active_tail(&self) -> bool {
        self.env_level > 0.0
    }

    fn clear_filters_and_reverb(&mut self) {
        self.lp1_l = 0.0;
        self.lp1_r = 0.0;
        self.lp2_l = 0.0;
        self.lp2_r = 0.0;
        self.reverb.clear();
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
        self.clear_filters_and_reverb();
        self.last_generation = u64::MAX;
    }

    fn switch_voice(&mut self, note: u8, harmony: u8, air_mode: u8, sample_rate: u32) {
        let target_note = note % 12;
        let target_harmony = harmony.min(2);
        let target_air = air_mode.min(1);
        self.current_note = target_note;
        self.current_harmony = target_harmony;
        self.current_air_mode = target_air;

        // Si alguna voz aún activa ya toca exactamente esa nota + armonía + registro, se reactiva sin cortes.
        let existing = self.voices.iter().position(|v| {
            v.note == target_note
                && v.harmony == target_harmony
                && v.air_mode == target_air
                && (v.level > 0.0 || v.target_level > 0.0)
        });
        if let Some(idx) = existing {
            for (i, v) in self.voices.iter_mut().enumerate() {
                v.target_level = if i == idx { 1.0 } else { 0.0 };
                if i == idx && v.sample_rate != sample_rate {
                    v.configure(target_note, target_harmony, target_air, sample_rate, false);
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
                v.configure(target_note, target_harmony, target_air, sample_rate, true);
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
        let target_harmony = ctl.harmony();
        let target_style = ctl.style();
        let target_air_mode = u8::from(target_style == 2);
        let sp = style_params(target_style);
        let gen = ctl.generation();
        if gen != self.last_generation {
            self.last_generation = gen;
            if self.env_level == 0.0 {
                self.current_note = target_note;
                self.current_harmony = target_harmony;
                self.current_air_mode = target_air_mode;
                self.smooth_gain = sanitize_gain(ctl.gain()).unwrap_or(0.0);
                self.smooth_cutoff_min = sp.cutoff_min;
                self.smooth_cutoff_span = sp.cutoff_span;
                self.smooth_air_boost = sp.air_boost;
                self.smooth_reverb_wet = sp.reverb_wet;
                self.smooth_reverb_fb = sp.reverb_fb;
                self.smooth_third_harm = sp.third_harm;
                self.clear_filters_and_reverb();
                self.fast_cutting = false;
                for (i, v) in self.voices.iter_mut().enumerate() {
                    if i == 0 {
                        v.configure(target_note, target_harmony, target_air_mode, sample_rate, true);
                        v.level = 1.0;
                        v.target_level = 1.0;
                    } else {
                        v.level = 0.0;
                        v.target_level = 0.0;
                    }
                }
            } else if active_mode
                && (self.current_note != target_note
                    || self.current_harmony != target_harmony
                    || self.current_air_mode != target_air_mode)
            {
                self.switch_voice(target_note, target_harmony, target_air_mode, sample_rate);
            }
        } else if active_mode
            && (self.current_note != target_note
                || self.current_harmony != target_harmony
                || self.current_air_mode != target_air_mode)
        {
            self.switch_voice(target_note, target_harmony, target_air_mode, sample_rate);
        } else {
            for v in &mut self.voices {
                if (v.level > 0.0 || v.target_level > 0.0) && v.sample_rate != sample_rate {
                    v.configure(v.note, v.harmony, v.air_mode, sample_rate, false);
                }
            }
        }

        if !want_on && self.env_level == 0.0 {
            self.clear_filters_and_reverb();
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
            self.clear_filters_and_reverb();
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

        // Suavizado al cambiar de timbre para que el filtro y la reverb evolucionen sin saltos.
        let style_alpha = (alpha * 0.35).clamp(0.01, 0.5);
        self.smooth_cutoff_min = smooth_toward(self.smooth_cutoff_min, sp.cutoff_min, style_alpha);
        self.smooth_cutoff_span = smooth_toward(self.smooth_cutoff_span, sp.cutoff_span, style_alpha);
        self.smooth_air_boost = smooth_toward(self.smooth_air_boost, sp.air_boost, style_alpha);
        self.smooth_reverb_wet = smooth_toward(self.smooth_reverb_wet, sp.reverb_wet, style_alpha);
        self.smooth_reverb_fb = smooth_toward(self.smooth_reverb_fb, sp.reverb_fb, style_alpha);
        self.smooth_third_harm = smooth_toward(self.smooth_third_harm, sp.third_harm, style_alpha);

        // Tres LFOs lentos inconmensurables (~14 s, ~23 s y ~34 s) para respiración orgánica sin bucles obvios.
        let lfo_f_val = 0.5 + 0.5 * self.lfo_filter.sin();
        let lfo_b_val = 0.5 + 0.5 * self.lfo_breath.sin();
        let lfo_a_val = 0.5 + 0.5 * self.lfo_air.sin();
        let dt_block = frames as f32 / sr;
        self.lfo_filter = (self.lfo_filter + TAU * 0.071 * dt_block) % TAU;
        self.lfo_breath = (self.lfo_breath + TAU * 0.043 * dt_block) % TAU;
        self.lfo_air = (self.lfo_air + TAU * 0.029 * dt_block) % TAU;

        let cutoff = self.smooth_cutoff_min + self.smooth_cutoff_span * (0.65 * lfo_f_val + 0.35 * lfo_b_val);
        let lp_alpha = (1.0 - (-TAU * cutoff / sr).exp()).clamp(0.01, 0.99);
        let mid_breath = 0.80 + 0.28 * lfo_b_val;
        let air_breath = (0.45 + 0.75 * lfo_a_val) * self.smooth_air_boost;
        let reverb_lens = PadReverb::delay_lengths(sample_rate);
        let wet_mix = self.smooth_reverb_wet;
        let dry_mix = 1.0 - 0.35 * wet_mix;
        let reverb_fb = self.smooth_reverb_fb;
        let third_harm = self.smooth_third_harm;

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
                let (vl, vr) = v.next_stereo(mid_breath, air_breath, third_harm);
                sum_l += vl * curve;
                sum_r += vr * curve;
            }

            // Filtro paso bajo de 2 polos en cascada + calidez analógica suave.
            self.lp1_l += lp_alpha * (sum_l - self.lp1_l);
            self.lp1_r += lp_alpha * (sum_r - self.lp1_r);
            self.lp2_l += lp_alpha * (self.lp1_l - self.lp2_l);
            self.lp2_r += lp_alpha * (self.lp1_r - self.lp2_r);

            let warm_l = self.lp2_l / (1.0 + 0.14 * self.lp2_l.abs());
            let warm_r = self.lp2_r / (1.0 + 0.14 * self.lp2_r.abs());
            let (rev_l, rev_r) = self.reverb.process_sample(warm_l, warm_r, reverb_lens, reverb_fb);

            let mixed_l = warm_l * dry_mix + rev_l * wet_mix;
            let mixed_r = warm_r * dry_mix + rev_r * wet_mix;

            let g = (g0 + d_gain * (f + 1) as f32) * env;
            let raw_l = mixed_l * PAD_OUTPUT_SCALE * g;
            let raw_r = mixed_r * PAD_OUTPUT_SCALE * g;
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
            self.clear_filters_and_reverb();
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
            harmony: 0,
            style: 0,
        });
        let mut synth = PadSynth::new();
        let mut out_l = vec![0.0f32; 480];
        let mut out_r = vec![0.0f32; 480];
        let mut mon_l = vec![0.0f32; 480];
        let mut mon_r = vec![0.0f32; 480];

        let asignaciones = crate::alloc_probe::count_allocs(|| {
            for b in 0..400u32 {
                if b == 50 {
                    ctl.apply(PadConfig { active_mode: true, enabled: true, note: 2, gain: 0.6, monitor: true, harmony: 1, style: 1 });
                } else if b == 120 {
                    ctl.apply(PadConfig { active_mode: true, enabled: false, note: 2, gain: 0.6, monitor: true, harmony: 2, style: 2 });
                } else if b == 200 {
                    ctl.apply(PadConfig { active_mode: true, enabled: true, note: 9, gain: 1.2, monitor: false, harmony: 0, style: 1 });
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
            harmony: 0,
            style: 0,
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

        for b in 0..560 {
            if b == 120 {
                ctl.apply(PadConfig { active_mode: true, enabled: true, note: 7, gain: 1.0, monitor: false, harmony: 1, style: 1 });
            } else if b == 200 {
                ctl.apply(PadConfig { active_mode: true, enabled: true, note: 5, gain: 0.4, monitor: false, harmony: 2, style: 2 });
            } else if b == 280 {
                ctl.apply(PadConfig { active_mode: true, enabled: false, note: 5, gain: 0.4, monitor: false, harmony: 2, style: 2 });
            } else if b == 380 {
                ctl.apply(PadConfig { active_mode: true, enabled: true, note: 11, gain: 1.0, monitor: false, harmony: 0, style: 0 });
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
            harmony: 1,
            style: 1,
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
            harmony: 0,
            style: 0,
        });
        ctl.apply(PadConfig {
            active_mode: true,
            enabled: true,
            note: 4,
            gain: f32::NAN,
            monitor: false,
            harmony: 0,
            style: 0,
        });
        assert_eq!(ctl.gain(), 0.75, "una ganancia NaN no debe pisar la anterior");
        ctl.apply(PadConfig {
            active_mode: true,
            enabled: true,
            note: 4,
            gain: f32::INFINITY,
            monitor: false,
            harmony: 0,
            style: 0,
        });
        assert_eq!(ctl.gain(), 0.75, "una ganancia infinita no debe pisar la anterior");
    }

    #[test]
    fn test_pad_armonias_y_timbres_distintos_y_limpios() {
        let mut rms_por_estilo = [0.0f32; 3];
        for (idx, style) in [0u8, 1, 2].into_iter().enumerate() {
            for harmony in [0u8, 1, 2] {
                let ctl = PadControl::new();
                ctl.reset_for_load(PadConfig {
                    active_mode: true,
                    enabled: true,
                    note: 0,
                    gain: 1.0,
                    monitor: false,
                    harmony,
                    style,
                });
                let mut synth = PadSynth::new();
                let mut out_l = vec![0.0f32; 480];
                let mut out_r = vec![0.0f32; 480];
                let mut mon_l = vec![0.0f32; 480];
                let mut mon_r = vec![0.0f32; 480];
                let mut sq = 0.0f64;
                let mut max_step = 0.0f32;
                let mut prev = 0.0f32;
                let mut n = 0usize;
                for b in 0..300 {
                    out_l.fill(0.0);
                    out_r.fill(0.0);
                    synth.render_block(&ctl, 0, 480, 48_000, &mut out_l, &mut out_r, &mut mon_l, &mut mon_r, true);
                    for &s in &out_l {
                        assert!(s.is_finite() && s.abs() < 0.9, "fuera de rango: {s}");
                        max_step = max_step.max((s - prev).abs());
                        prev = s;
                        if b >= 260 {
                            sq += (s as f64) * (s as f64);
                            n += 1;
                        }
                    }
                }
                assert!(max_step <= 0.01, "escalón en armonía {harmony} / estilo {style}: {max_step}");
                let rms = (sq / n.max(1) as f64).sqrt() as f32;
                assert!(rms > 0.02, "rms demasiado bajo en armonía {harmony} / estilo {style}: {rms}");
                if harmony == 0 {
                    rms_por_estilo[idx] = rms;
                }
            }
        }
        assert!(
            rms_por_estilo[0] != rms_por_estilo[1] && rms_por_estilo[1] != rms_por_estilo[2],
            "los tres timbres deben producir perfiles distintos: {:?}",
            rms_por_estilo
        );
    }
}
