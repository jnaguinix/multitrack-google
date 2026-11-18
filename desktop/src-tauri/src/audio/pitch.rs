//! Cambio de tono real (sin tocar la velocidad) de una pista, con Signalsmith Stretch (MIT).
//!
//! Antes el tono se cambiaba como un disco de vinilo: se remuestreaba la pista, así que la canción sonaba más
//! rápida al subirlo (+1 tono ≈ 6 %). Aquí el tono sube o baja y la duración no cambia: cada fotograma que entra
//! produce uno de salida, y el reloj de la canción avanza al ritmo normal.
//!
//! Se usa solo desde el hilo feeder de cada pista (nunca desde el callback de audio).

use ssstretch::Stretch;

/// Cambio de tono para un tono dado, o `None` si el tono es 0 (la pista pasa tal cual, sin coste).
pub fn new_pitch_shifter(sample_rate: u32, channels: usize, semitones: i32) -> Option<PitchShifter> {
    (semitones != 0).then(|| PitchShifter::new(sample_rate, channels, semitones))
}

/// Cambia el tono de una pista (estéreo o mono), conservando la duración.
pub struct PitchShifter {
    stretch: Stretch,
    channels: usize,
    /// Fotogramas de salida aún por descartar: la salida va retrasada respecto a la entrada (`latency`), y se
    /// descartan los primeros para que cada fotograma de salida corresponda al de entrada de su misma posición.
    to_skip: usize,
    latency: usize,
    out: Vec<Vec<f32>>,
}

impl PitchShifter {
    pub fn new(sample_rate: u32, channels: usize, semitones: i32) -> Self {
        let mut stretch = Stretch::new();
        stretch.preset_default(channels as i32, sample_rate as f32);
        stretch.set_transpose_semitones(semitones as f32, None);
        let latency = (stretch.input_latency() + stretch.output_latency()).max(0) as usize;
        Self {
            stretch,
            channels,
            to_skip: latency,
            latency,
            out: vec![Vec::new(); channels],
        }
    }

    /// Retardo de la salida respecto a la entrada, en fotogramas (ya compensado: se descarta al empezar).
    pub fn latency_frames(&self) -> usize {
        self.latency
    }

    pub fn set_semitones(&mut self, semitones: i32) {
        self.stretch.set_transpose_semitones(semitones as f32, None);
    }

    /// Vuelve al estado inicial (tras un seek o un salto): se vuelve a compensar el retardo.
    pub fn reset(&mut self) {
        self.stretch.reset();
        self.to_skip = self.latency;
    }

    /// Procesa un bloque (un `Vec` por canal, todos del mismo largo) y devuelve el bloque con el tono cambiado.
    /// Al principio de un tramo devuelve menos fotogramas de los que entraron (el retardo del algoritmo); a partir de
    /// ahí entra y sale lo mismo.
    pub fn process(&mut self, input: &[Vec<f32>]) -> Vec<Vec<f32>> {
        let n = input.first().map_or(0, Vec::len);
        for ch in self.out.iter_mut() {
            ch.resize(n, 0.0);
        }
        if n > 0 {
            self.stretch.process_vec(input, n as i32, &mut self.out, n as i32);
        }
        let skip = self.to_skip.min(n);
        self.to_skip -= skip;
        self.out.iter().take(self.channels).map(|ch| ch[skip..n].to_vec()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    const SR: u32 = 48_000;

    fn sine(freq: f64, frames: usize) -> Vec<f32> {
        (0..frames).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / SR as f64).sin() as f32 * 0.5).collect()
    }

    /// Frecuencia estimada por cruces por cero ascendentes de una señal (suficiente para un seno limpio).
    fn estimate_freq(x: &[f32]) -> f64 {
        let mut crossings = Vec::new();
        for i in 1..x.len() {
            if x[i - 1] < 0.0 && x[i] >= 0.0 {
                let frac = -x[i - 1] / (x[i] - x[i - 1]);
                crossings.push(i as f64 - 1.0 + frac as f64);
            }
        }
        if crossings.len() < 2 {
            return 0.0;
        }
        let periods = (crossings.len() - 1) as f64;
        periods * SR as f64 / (crossings[crossings.len() - 1] - crossings[0])
    }

    fn run(shifter: &mut PitchShifter, x: &[f32], block: usize) -> Vec<f32> {
        let mut out = Vec::new();
        for chunk in x.chunks(block) {
            if chunk.len() < block {
                break;
            }
            let r = shifter.process(&[chunk.to_vec()]);
            out.extend_from_slice(&r[0]);
        }
        out
    }

    #[test]
    fn el_tono_cambia_y_la_duracion_no() {
        for semitones in [-6, -2, 2, 6] {
            let mut sh = PitchShifter::new(SR, 1, semitones);
            let input = sine(440.0, SR as usize * 4);
            let out = run(&mut sh, &input, 1024);
            // Misma duración (menos el retardo inicial compensado, ya descartado de la salida).
            let expected = input.len() - input.len() % 1024 - sh.latency_frames();
            assert_eq!(out.len(), expected, "{semitones} tonos: la duración no debe cambiar");
            let seg = &out[SR as usize..SR as usize * 3];
            let f = estimate_freq(seg);
            let want = 440.0 * 2f64.powf(semitones as f64 / 12.0);
            assert!((f - want).abs() / want < 0.01, "{semitones} tonos: {f:.1} Hz, se esperaba {want:.1} Hz");
        }
    }

    #[test]
    fn el_retardo_queda_compensado() {
        // Un impulso en el fotograma 20 000 debe salir (casi) en el mismo fotograma tras compensar el retardo.
        let mut sh = PitchShifter::new(SR, 1, 3);
        let mut input = vec![0.0f32; SR as usize * 2];
        // Un golpe corto de ruido tonal, para que el algoritmo lo reproduzca.
        for i in 0..200 {
            input[20_000 + i] = ((i as f32 * 0.37).sin()) * 0.9 * (1.0 - i as f32 / 200.0);
        }
        let out = run(&mut sh, &input, 1024);
        let peak = out.iter().enumerate().fold((0usize, 0.0f32), |a, (i, v)| if v.abs() > a.1 { (i, v.abs()) } else { a });
        let diff = peak.0 as i64 - 20_000;
        println!("retardo del pico: {diff} fotogramas ({:.2} ms), latencia {}", diff as f64 * 1000.0 / SR as f64, sh.latency_frames());
        assert!(diff.abs() < 480, "el golpe debe quedar en su sitio (±10 ms): {diff}");
    }

    #[test]
    #[ignore = "medición de procesador; ejecutar a mano con --ignored --nocapture"]
    fn mide_el_coste_de_15_pistas() {
        let tracks = 15usize;
        let seconds = 20usize;
        let mut shifters: Vec<PitchShifter> = (0..tracks).map(|_| PitchShifter::new(SR, 2, 2)).collect();
        let block = vec![sine(220.0, 1024), sine(330.0, 1024)];
        let blocks = SR as usize * seconds / 1024;
        let t = Instant::now();
        for _ in 0..blocks {
            for sh in shifters.iter_mut() {
                let _ = sh.process(&block);
            }
        }
        let elapsed = t.elapsed().as_secs_f64();
        println!("{tracks} pistas estéreo, {seconds} s de audio: {elapsed:.2} s (= {:.1} % de un núcleo, latencia {} fotogramas)", elapsed / seconds as f64 * 100.0, shifters[0].latency_frames());
    }
}
