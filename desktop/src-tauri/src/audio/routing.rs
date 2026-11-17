//! Ruteo de salidas: de las fuentes lógicas (música, click, guía) a los canales físicos del dispositivo.
//!
//! El motor no conoce modelos de interfaz: conoce una **matriz** `salida × fuente`. Lo único que depende del
//! hardware es cuántos canales de salida independientes expone el dispositivo, y de eso sale una propuesta
//! ([`propose`]) que el usuario puede editar y que se guarda **por dispositivo** ([`RoutingStore`]).
//!
//! Reglas de seguridad (un directo no puede fallar por aquí):
//! - el click y la guía nunca comparten canal con la música salvo que el usuario lo confirme (`allow_mixed`);
//! - un ruteo que no encaja con el dispositivo (otra cantidad de canales, canal fuera de rango, click sin
//!   destino) se rechaza con un error explícito antes de reproducir: nada se redirige en silencio;
//! - el callback solo lee una matriz copiada a la pila (sin asignaciones, sin bloqueos).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};

/// Máximo de canales de salida que maneja la matriz (más que cualquier interfaz habitual).
pub const MAX_OUTPUTS: usize = 32;
/// Cantidad de fuentes lógicas.
pub const N_SOURCES: usize = 6;
/// Ganancia de la suma a mono: `(L + R) / 2`. El resultado nunca supera el pico de los canales originales, así que
/// pasar a mono no empuja la mezcla contra el limitador. Lo que está al centro queda al mismo nivel que tenía cada
/// lado en estéreo; lo que está en un solo canal baja 6 dB (como al pulsar «mono» en una consola).
/// Antes era 1/√2: lo del centro subía 3 dB y las mezclas fuertes pasaban casi siempre por el limitador.
pub const MONO_SUM_GAIN: f32 = 0.5;

/// Fuente lógica que se puede enviar a una salida.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    MusicL,
    MusicR,
    /// Música convertida a mono durante la reproducción (nunca se modifica ni se duplica el archivo).
    MusicMono,
    Click,
    Guide,
    /// Las pistas que el usuario marcó para oírse en los auriculares («Aur.»), sumadas en mono. Es una fuente de
    /// auriculares: nunca comparte salida con la música salvo confirmación.
    Monitor,
}

impl Source {
    pub const ALL: [Source; N_SOURCES] =
        [Source::MusicL, Source::MusicR, Source::MusicMono, Source::Click, Source::Guide, Source::Monitor];

    #[inline]
    pub fn index(self) -> usize {
        self as usize
    }

    pub fn is_music(self) -> bool {
        matches!(self, Source::MusicL | Source::MusicR | Source::MusicMono)
    }

    pub fn is_cue(self) -> bool {
        matches!(self, Source::Click | Source::Guide | Source::Monitor)
    }

    pub fn label(self) -> &'static str {
        match self {
            Source::MusicL => "música izquierda",
            Source::MusicR => "música derecha",
            Source::MusicMono => "música (mono)",
            Source::Click => "click",
            Source::Guide => "guía",
            Source::Monitor => "monitor",
        }
    }

    /// Con artículo, para los mensajes («el click», «la guía»).
    pub fn with_article(self) -> &'static str {
        match self {
            Source::MusicL => "la música izquierda",
            Source::MusicR => "la música derecha",
            Source::MusicMono => "la música (mono)",
            Source::Click => "el click",
            Source::Guide => "la guía",
            Source::Monitor => "el monitor",
        }
    }
}

fn one() -> f32 {
    1.0
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteEntry {
    pub source: Source,
    #[serde(default = "one")]
    pub gain: f32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputAssign {
    #[serde(default)]
    pub sources: Vec<RouteEntry>,
}

impl OutputAssign {
    fn of(sources: &[Source]) -> Self {
        Self { sources: sources.iter().map(|&source| RouteEntry { source, gain: 1.0 }).collect() }
    }

    pub fn has(&self, source: Source) -> bool {
        self.sources.iter().any(|e| e.source == source && e.gain > 0.0)
    }
}

/// Asignación completa de un dispositivo: una entrada por canal de salida.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingConfig {
    /// Cantidad de canales del dispositivo para la que se hizo esta configuración.
    pub channels: u16,
    pub outputs: Vec<OutputAssign>,
    /// El usuario confirmó que música y click/guía compartan canal (p. ej. un mezclador de una sola salida).
    #[serde(default)]
    pub allow_mixed: bool,
    /// `false` = propuesta automática; `true` = editada a mano.
    #[serde(default)]
    pub custom: bool,
}

/// Propuesta automática según los canales independientes que expone el dispositivo.
///
/// - 1 salida: todo mezclado (inválido hasta que el usuario lo confirme: el click llegaría al público).
/// - 2 salidas: click, guía y monitor juntos en la 1 (izquierda) y la música en mono en la 2 (derecha), como traen
///   los multitracks comerciales (clic y guía a la izquierda, mezcla a la derecha).
/// - 3 salidas: música L y R en 1 y 2; click, guía y monitor en la 3.
/// - 4 o más: música L, música R, click, guía con el monitor; el resto queda libre.
///
/// «Monitor» son las pistas que el usuario marca con «Aur.» para oírlas también en los auriculares.
pub fn propose(channels: u16) -> RoutingConfig {
    let n = channels as usize;
    let mut outputs = vec![OutputAssign::default(); n];
    match n {
        0 => {}
        1 => outputs[0] = OutputAssign::of(&[Source::MusicMono, Source::Click, Source::Guide, Source::Monitor]),
        2 => {
            outputs[0] = OutputAssign::of(&[Source::Click, Source::Guide, Source::Monitor]);
            outputs[1] = OutputAssign::of(&[Source::MusicMono]);
        }
        3 => {
            outputs[0] = OutputAssign::of(&[Source::MusicL]);
            outputs[1] = OutputAssign::of(&[Source::MusicR]);
            outputs[2] = OutputAssign::of(&[Source::Click, Source::Guide, Source::Monitor]);
        }
        _ => {
            outputs[0] = OutputAssign::of(&[Source::MusicL]);
            outputs[1] = OutputAssign::of(&[Source::MusicR]);
            outputs[2] = OutputAssign::of(&[Source::Click]);
            outputs[3] = OutputAssign::of(&[Source::Guide, Source::Monitor]);
        }
    }
    RoutingConfig { channels, outputs, allow_mixed: false, custom: false }
}

/// Descripción corta de lo que hace una propuesta (para la interfaz).
pub fn describe(config: &RoutingConfig) -> String {
    let parts: Vec<String> = config
        .outputs
        .iter()
        .enumerate()
        .filter(|(_, o)| !o.sources.is_empty())
        .map(|(i, o)| {
            let names: Vec<&str> = o.sources.iter().map(|e| e.source.label()).collect();
            format!("salida {}: {}", i + 1, names.join(" + "))
        })
        .collect();
    parts.join(" · ")
}

// ---------------------------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum RoutingIssue {
    /// La configuración se hizo para otra cantidad de canales que la del dispositivo.
    ChannelCountMismatch { configured: u16, device: u16 },
    /// El dispositivo expone más canales de los que maneja la matriz.
    TooManyOutputs { device: u16 },
    /// Una fuente que debe sonar no tiene ninguna salida.
    SourceUnrouted(Source),
    /// Música y click/guía comparten canal sin confirmación.
    CueMixedWithMusic { output: usize, music: Source, cue: Source },
    /// No hay ningún canal de salida.
    NoOutputs,
}

impl RoutingIssue {
    pub fn message(&self) -> String {
        match self {
            RoutingIssue::ChannelCountMismatch { configured, device } => format!(
                "Este ruteo se hizo para {configured} salidas y el dispositivo actual tiene {device}. Revisa la asignación en Ajustes de audio."
            ),
            RoutingIssue::TooManyOutputs { device } => {
                format!("El dispositivo expone {device} canales; OmniTracks maneja hasta {MAX_OUTPUTS}.")
            }
            RoutingIssue::SourceUnrouted(s) => format!(
                "«{}» no tiene ninguna salida asignada: se perdería. Asígnale una en Ajustes de audio.",
                s.label()
            ),
            RoutingIssue::CueMixedWithMusic { output, music, cue } => format!(
                "La salida {} mezcla {} con {}: {} llegaría al público. Sepáralos en otra salida o confirma la mezcla en Ajustes de audio.",
                output + 1,
                music.with_article(),
                cue.with_article(),
                cue.with_article()
            ),
            RoutingIssue::NoOutputs => "El dispositivo no expone ninguna salida.".to_string(),
        }
    }
}

/// Comprueba que `config` es segura para un dispositivo con `device_channels` salidas. Lista vacía = válida.
pub fn validate(config: &RoutingConfig, device_channels: u16) -> Vec<RoutingIssue> {
    let mut issues = Vec::new();
    if device_channels == 0 {
        return vec![RoutingIssue::NoOutputs];
    }
    if device_channels as usize > MAX_OUTPUTS {
        issues.push(RoutingIssue::TooManyOutputs { device: device_channels });
        return issues;
    }
    if config.channels != device_channels || config.outputs.len() != device_channels as usize {
        issues.push(RoutingIssue::ChannelCountMismatch { configured: config.channels, device: device_channels });
        return issues;
    }

    // Toda fuente que existe en la mezcla necesita al menos un destino.
    let routed = |pred: &dyn Fn(Source) -> bool| config.outputs.iter().any(|o| o.sources.iter().any(|e| e.gain > 0.0 && pred(e.source)));
    if !routed(&|s| s.is_music()) {
        issues.push(RoutingIssue::SourceUnrouted(Source::MusicMono));
    }
    for cue in [Source::Click, Source::Guide, Source::Monitor] {
        if !routed(&|s| s == cue) {
            issues.push(RoutingIssue::SourceUnrouted(cue));
        }
    }

    // El click y la guía no se mezclan con la música salvo confirmación explícita.
    if !config.allow_mixed {
        for (i, out) in config.outputs.iter().enumerate() {
            let music = out.sources.iter().find(|e| e.gain > 0.0 && e.source.is_music()).map(|e| e.source);
            let cue = out.sources.iter().find(|e| e.gain > 0.0 && e.source.is_cue()).map(|e| e.source);
            if let (Some(music), Some(cue)) = (music, cue) {
                issues.push(RoutingIssue::CueMixedWithMusic { output: i, music, cue });
            }
        }
    }
    issues
}

/// Un ruteo guardado antes de que existiera el Monitor no lo tiene: se añade a la salida del click (o de la guía) para
/// que no quede inválido ni deje sin salida a las pistas marcadas con «Aur.». No modifica el resto del ruteo.
pub fn ensure_monitor(config: &mut RoutingConfig) {
    if config.outputs.iter().any(|o| o.has(Source::Monitor)) {
        return;
    }
    let target = config
        .outputs
        .iter()
        .position(|o| o.has(Source::Click))
        .or_else(|| config.outputs.iter().position(|o| o.has(Source::Guide)))
        .or_else(|| config.outputs.iter().position(|o| o.sources.iter().any(|e| e.source.is_cue())));
    if let Some(i) = target {
        config.outputs[i].sources.push(RouteEntry { source: Source::Monitor, gain: 1.0 });
    }
}

// ---------------------------------------------------------------------------------------------
// Matriz para el callback
// ---------------------------------------------------------------------------------------------

/// Matriz `salida × fuente` en la pila: se copia una vez por bloque y se aplica muestra a muestra.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RouteTable {
    pub channels: usize,
    pub gains: [[f32; N_SOURCES]; MAX_OUTPUTS],
}

impl RouteTable {
    pub fn silent(channels: usize) -> Self {
        Self { channels: channels.min(MAX_OUTPUTS), gains: [[0.0; N_SOURCES]; MAX_OUTPUTS] }
    }

    pub fn from_config(config: &RoutingConfig) -> Self {
        let mut t = Self::silent(config.outputs.len());
        for (ch, out) in config.outputs.iter().take(MAX_OUTPUTS).enumerate() {
            for e in &out.sources {
                t.gains[ch][e.source.index()] += e.gain;
            }
        }
        t
    }

    /// Mezcla completa en estéreo, sin separar nada: era el único modo antes del ruteo por dispositivo. Es el
    /// valor inicial del motor y el de las pruebas; con un dispositivo real siempre se sustituye por el ruteo
    /// validado de ese dispositivo.
    pub fn legacy_stereo() -> Self {
        let mut t = Self::silent(2);
        t.gains[0][Source::MusicL.index()] = 1.0;
        t.gains[0][Source::Click.index()] = 1.0;
        t.gains[0][Source::Guide.index()] = 1.0;
        t.gains[0][Source::Monitor.index()] = 1.0;
        t.gains[1][Source::MusicR.index()] = 1.0;
        t.gains[1][Source::Click.index()] = 1.0;
        t.gains[1][Source::Guide.index()] = 1.0;
        t.gains[1][Source::Monitor.index()] = 1.0;
        t
    }

    /// Escribe una muestra de cada canal de salida a partir de las fuentes de ese instante. Sin asignaciones.
    /// `out.len()` es la cantidad de canales del dispositivo; los canales sin asignar quedan en silencio.
    #[inline]
    pub fn mix_frame(&self, src: &[f32; N_SOURCES], out: &mut [f32]) {
        for (ch, slot) in out.iter_mut().enumerate() {
            if ch >= self.channels {
                *slot = 0.0;
                continue;
            }
            let g = &self.gains[ch];
            *slot = g[0] * src[0] + g[1] * src[1] + g[2] * src[2] + g[3] * src[3] + g[4] * src[4] + g[5] * src[5];
        }
    }
}

/// Matriz compartida entre el hilo que la configura y el callback de audio. Todo atómico: el callback la
/// copia a la pila con [`RoutingSlot::load`] sin bloquear.
pub struct RoutingSlot {
    channels: AtomicUsize,
    gains: [AtomicU32; MAX_OUTPUTS * N_SOURCES],
}

impl RoutingSlot {
    pub fn new() -> Self {
        let slot = Self { channels: AtomicUsize::new(0), gains: std::array::from_fn(|_| AtomicU32::new(0)) };
        slot.store(&RouteTable::legacy_stereo());
        slot
    }

    pub fn store(&self, table: &RouteTable) {
        for ch in 0..MAX_OUTPUTS {
            for s in 0..N_SOURCES {
                self.gains[ch * N_SOURCES + s].store(table.gains[ch][s].to_bits(), Ordering::Relaxed);
            }
        }
        self.channels.store(table.channels, Ordering::Release);
    }

    #[inline]
    pub fn load(&self) -> RouteTable {
        let channels = self.channels.load(Ordering::Acquire);
        let mut t = RouteTable::silent(channels);
        for ch in 0..channels.min(MAX_OUTPUTS) {
            for s in 0..N_SOURCES {
                t.gains[ch][s] = f32::from_bits(self.gains[ch * N_SOURCES + s].load(Ordering::Relaxed));
            }
        }
        t
    }
}

impl Default for RoutingSlot {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------------------------
// Mezcla sin clipping
// ---------------------------------------------------------------------------------------------

/// Música en mono a partir de un par L/R: lo que existe en un solo canal se conserva (a −3 dB).
#[inline(always)]
pub fn music_mono(l: f32, r: f32) -> f32 {
    (l + r) * MONO_SUM_GAIN
}

/// Umbral desde el que el limitador empieza a actuar.
pub const LIMITER_KNEE: f32 = 0.9;

/// Limitador suave: transparente por debajo de [`LIMITER_KNEE`] y nunca supera 1,0 (sin recorte duro).
#[inline(always)]
pub fn soft_limit(x: f32) -> f32 {
    let a = x.abs();
    if a <= LIMITER_KNEE {
        return x;
    }
    let range = 1.0 - LIMITER_KNEE;
    let limited = LIMITER_KNEE + range * ((a - LIMITER_KNEE) / range).tanh();
    limited.copysign(x)
}

// ---------------------------------------------------------------------------------------------
// Almacén por dispositivo
// ---------------------------------------------------------------------------------------------

/// Identifica un dispositivo para guardar su ruteo.
pub fn device_key(host: &str, device_name: &str) -> String {
    format!("{}|{}", host.to_ascii_lowercase(), device_name)
}

/// Resultado de buscar el ruteo de un dispositivo.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolution {
    pub config: RoutingConfig,
    /// Hay una configuración guardada que se está usando.
    pub saved: bool,
    /// Había una configuración guardada, pero era para otra cantidad de canales: se propone una nueva.
    pub stale: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    devices: BTreeMap<String, RoutingConfig>,
}

#[derive(Debug)]
pub struct RoutingStore {
    path: PathBuf,
    devices: BTreeMap<String, RoutingConfig>,
}

static STORE_TMP: AtomicU64 = AtomicU64::new(0);

impl RoutingStore {
    /// Carga el almacén. Un archivo ausente o ilegible da un almacén vacío (se propone según el dispositivo).
    pub fn load(path: &Path) -> Self {
        let devices = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<StoreFile>(&s).ok())
            .map(|f| f.devices)
            .unwrap_or_default();
        Self { path: path.to_path_buf(), devices }
    }

    /// Ruteo a usar con `device_channels` salidas: el guardado si encaja con el dispositivo; si no, la propuesta.
    /// Nunca devuelve el ruteo de un dispositivo con otra cantidad de canales.
    pub fn resolve(&self, key: &str, device_channels: u16) -> Resolution {
        match self.devices.get(key) {
            Some(saved) if saved.channels == device_channels => {
                let mut config = saved.clone();
                ensure_monitor(&mut config);
                Resolution { config, saved: true, stale: false }
            }
            Some(_) => Resolution { config: propose(device_channels), saved: false, stale: true },
            None => Resolution { config: propose(device_channels), saved: false, stale: false },
        }
    }

    pub fn set(&mut self, key: &str, config: RoutingConfig) -> Result<(), String> {
        self.devices.insert(key.to_string(), config);
        self.persist()
    }

    pub fn remove(&mut self, key: &str) -> Result<(), String> {
        self.devices.remove(key);
        self.persist()
    }

    fn persist(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&StoreFile { devices: self.devices.clone() })
            .map_err(|e| format!("Error serializando el ruteo: {e}"))?;
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension(format!("{}.{}.tmp", std::process::id(), STORE_TMP.fetch_add(1, Ordering::Relaxed)));
        std::fs::write(&tmp, json).map_err(|e| format!("Error escribiendo el ruteo: {e}"))?;
        if let Err(e) = std::fs::rename(&tmp, &self.path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("Error guardando el ruteo: {e}"));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Fuentes de una muestra: música L/R ya convertida, click y guía (sin monitor).
    fn sources(l: f32, r: f32, click: f32, guide: f32) -> [f32; N_SOURCES] {
        [l, r, music_mono(l, r), click, guide, 0.0]
    }

    /// Igual, con las pistas marcadas «Aur.» (monitor).
    fn sources_m(l: f32, r: f32, click: f32, guide: f32, monitor: f32) -> [f32; N_SOURCES] {
        [l, r, music_mono(l, r), click, guide, monitor]
    }

    fn render(config: &RoutingConfig, src: [f32; N_SOURCES]) -> Vec<f32> {
        let t = RouteTable::from_config(config);
        let mut out = vec![9.0f32; config.channels as usize];
        t.mix_frame(&src, &mut out);
        out
    }

    #[test]
    fn propone_el_ruteo_segun_los_canales_del_dispositivo() {
        assert_eq!(propose(2).outputs[0], OutputAssign::of(&[Source::Click, Source::Guide, Source::Monitor]), "salida 1 (izquierda): click, guía y monitor");
        assert_eq!(propose(2).outputs[1], OutputAssign::of(&[Source::MusicMono]), "salida 2 (derecha): la música en mono");
        let c3 = propose(3);
        assert_eq!(c3.outputs[0], OutputAssign::of(&[Source::MusicL]));
        assert_eq!(c3.outputs[1], OutputAssign::of(&[Source::MusicR]));
        assert_eq!(c3.outputs[2], OutputAssign::of(&[Source::Click, Source::Guide, Source::Monitor]));
        let c6 = propose(6);
        assert_eq!(c6.outputs.len(), 6);
        assert_eq!(c6.outputs[2], OutputAssign::of(&[Source::Click]));
        assert_eq!(c6.outputs[3], OutputAssign::of(&[Source::Guide, Source::Monitor]));
        assert!(c6.outputs[4].sources.is_empty() && c6.outputs[5].sources.is_empty(), "las salidas extra quedan libres");
        for n in [2u16, 3, 4, 6, 8] {
            assert!(validate(&propose(n), n).is_empty(), "la propuesta de {n} salidas debe ser válida");
        }
    }

    #[test]
    fn dos_salidas_convierten_a_mono_sin_perder_lo_que_hay_en_un_solo_canal() {
        let cfg = propose(2);
        // Un instrumento que existe únicamente en el canal derecho no debe desaparecer.
        let solo_r = render(&cfg, sources(0.0, 0.8, 0.0, 0.0));
        assert!((solo_r[1] - 0.4).abs() < 1e-6, "lo del canal R se conserva (−6 dB) en la salida de música: {}", solo_r[1]);
        let solo_l = render(&cfg, sources(0.8, 0.0, 0.0, 0.0));
        assert!((solo_l[1] - 0.4).abs() < 1e-6);
        // Ambos canales iguales (lo que está al centro) quedan exactamente al mismo nivel.
        let ambos = render(&cfg, sources(0.5, 0.5, 0.0, 0.0));
        assert!((ambos[1] - 0.5).abs() < 1e-6, "lo del centro no cambia de nivel: {}", ambos[1]);
    }

    #[test]
    fn la_suma_a_mono_nunca_supera_el_pico_del_estereo() {
        // Si la mezcla en estéreo no toca el limitador, en mono tampoco: |(L+R)/2| <= max(|L|, |R|).
        let mut x = 0x1234_5678u32;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x as f32 / u32::MAX as f32) * 2.0 - 1.0
        };
        for _ in 0..100_000 {
            let (l, r) = (next(), next());
            assert!(music_mono(l, r).abs() <= l.abs().max(r.abs()) + 1e-6, "({l}, {r})");
        }
        // Una mezcla fuerte al centro (0,89 por lado, justo debajo del umbral) no pasa por el limitador en mono.
        let m = music_mono(0.89, 0.89);
        assert!(m <= LIMITER_KNEE && soft_limit(m) == m, "con la suma anterior (1/√2) daba 1,26 y se aplastaba: {m}");
    }

    #[test]
    fn el_click_y_la_guia_no_se_filtran_a_las_salidas_de_musica() {
        for n in [2u16, 3, 4, 6] {
            let cfg = propose(n);
            let out = render(&cfg, sources(0.0, 0.0, 0.7, 0.4));
            let t = RouteTable::from_config(&cfg);
            for (ch, v) in out.iter().enumerate() {
                let carries_music = t.gains[ch][Source::MusicL.index()] + t.gains[ch][Source::MusicR.index()] + t.gains[ch][Source::MusicMono.index()] > 0.0;
                if carries_music {
                    assert_eq!(*v, 0.0, "con {n} salidas, el click/guía apareció en la salida de música {}", ch + 1);
                }
            }
            // …y la música no aparece en las salidas de click/guía.
            let out = render(&cfg, sources(0.9, 0.9, 0.0, 0.0));
            for (ch, v) in out.iter().enumerate() {
                if t.gains[ch][Source::Click.index()] + t.gains[ch][Source::Guide.index()] > 0.0 {
                    assert_eq!(*v, 0.0, "con {n} salidas, la música apareció en la salida de click/guía {}", ch + 1);
                }
            }
        }
    }

    #[test]
    fn tres_o_mas_salidas_conservan_los_dos_canales_de_la_musica() {
        for n in [3u16, 4, 8] {
            let out = render(&propose(n), sources(0.6, -0.3, 0.0, 0.0));
            assert_eq!(out[0], 0.6, "salida 1 = música izquierda intacta ({n} salidas)");
            assert_eq!(out[1], -0.3, "salida 2 = música derecha intacta ({n} salidas)");
        }
    }

    #[test]
    fn cuatro_o_mas_separan_click_y_guia() {
        let out = render(&propose(4), sources(0.0, 0.0, 0.7, 0.4));
        assert_eq!(out, vec![0.0, 0.0, 0.7, 0.4]);
        let out = render(&propose(3), sources(0.0, 0.0, 0.7, 0.4));
        assert!((out[2] - 1.1).abs() < 1e-6, "con 3 salidas click y guía van juntos: {}", out[2]);
    }

    #[test]
    fn los_canales_sin_asignar_quedan_en_silencio() {
        let out = render(&propose(8), sources(0.5, 0.5, 0.5, 0.5));
        assert_eq!(&out[4..], &[0.0, 0.0, 0.0, 0.0], "las salidas extra no deben recibir nada");
    }

    #[test]
    fn el_limitador_no_pasa_de_uno_y_es_transparente_por_debajo() {
        for x in [-0.9f32, -0.5, 0.0, 0.3, 0.9] {
            assert_eq!(soft_limit(x), x, "debajo del umbral no se toca ({x})");
        }
        for x in [0.95f32, 1.0, 1.5, 4.0, 100.0] {
            let y = soft_limit(x);
            assert!(y > LIMITER_KNEE && y <= 1.0, "{x} -> {y}");
            assert_eq!(soft_limit(-x), -y, "simétrico");
        }
        // Continuo y monótono alrededor del umbral.
        let mut prev = soft_limit(0.8);
        for i in 1..=400 {
            let v = soft_limit(0.8 + i as f32 * 0.005);
            assert!(v >= prev - 1e-6 && (v - prev).abs() < 0.01, "salto en {i}");
            prev = v;
        }
    }

    #[test]
    fn sumar_musica_y_downmix_no_produce_clipping_duro() {
        // Una mezcla que ya pasa de 1,0 (faders arriba): el limitador la deja por debajo de 1,0 sin recorte duro.
        let mono = music_mono(1.4, 1.3);
        assert!(mono > 1.0, "sin limitador esto recortaría ({mono})");
        assert!(soft_limit(mono) <= 1.0, "con limitador queda por debajo de 1,0");
    }

    // ---- Monitor («Aur.»): pistas elegidas para oírse en los auriculares

    #[test]
    fn el_monitor_sale_por_la_salida_de_auriculares_y_nunca_por_la_de_musica() {
        // Solo suenan las pistas marcadas «Aur.» (p. ej. el piano): deben salir por la salida de auriculares.
        for (n, cue_out) in [(2u16, 0usize), (3, 2), (4, 3), (6, 3)] {
            let out = render(&propose(n), sources_m(0.0, 0.0, 0.0, 0.0, 0.6));
            for (ch, v) in out.iter().enumerate() {
                if ch == cue_out {
                    assert_eq!(*v, 0.6, "con {n} salidas el monitor debe salir por la salida {}", cue_out + 1);
                } else {
                    assert_eq!(*v, 0.0, "con {n} salidas el monitor se coló en la salida {}", ch + 1);
                }
            }
        }
        // Con 4 o más, el monitor comparte salida con la guía y no con el click.
        let c4 = propose(4);
        assert!(c4.outputs[3].has(Source::Monitor) && !c4.outputs[2].has(Source::Monitor));
    }

    #[test]
    fn la_musica_sigue_saliendo_completa_aunque_haya_monitor() {
        // El piano marcado «Aur.» suena también en Main: el monitor es un envío adicional, no un desvío.
        let out = render(&propose(2), sources_m(0.5, 0.5, 0.0, 0.0, 0.5));
        assert!((out[1] - 0.5).abs() < 1e-6, "la música por la salida de música no cambia: {}", out[1]);
        assert_eq!(out[0], 0.5, "y el envío sale por la salida de auriculares (izquierda)");
    }

    #[test]
    fn mezclar_el_monitor_con_la_musica_exige_confirmacion() {
        let mut cfg = propose(4);
        cfg.outputs[0].sources.push(RouteEntry { source: Source::Monitor, gain: 1.0 });
        let issues = validate(&cfg, 4);
        assert!(issues.iter().any(|i| matches!(i, RoutingIssue::CueMixedWithMusic { output: 0, cue: Source::Monitor, .. })), "{issues:?}");
        assert!(issues.iter().all(|i| !i.message().is_empty()));
        let mut sin_destino = propose(4);
        sin_destino.outputs[3] = OutputAssign::of(&[Source::Guide]);
        assert!(validate(&sin_destino, 4).contains(&RoutingIssue::SourceUnrouted(Source::Monitor)), "el monitor necesita una salida");
    }

    #[test]
    fn un_ruteo_guardado_antes_del_monitor_lo_recibe_en_la_salida_del_click() {
        let path = tmp_file("monitor_migracion");
        let _ = std::fs::remove_file(&path);
        let key = device_key("WASAPI", "Interfaz vieja");
        // Ruteo de 4 salidas guardado con las fuentes antiguas (sin Monitor).
        let mut viejo = propose(4);
        for o in viejo.outputs.iter_mut() {
            o.sources.retain(|e| e.source != Source::Monitor);
        }
        viejo.custom = true;
        assert!(!viejo.outputs.iter().any(|o| o.has(Source::Monitor)));
        let mut store = RoutingStore::load(&path);
        store.set(&key, viejo).unwrap();

        let r = store.resolve(&key, 4);
        assert!(r.saved && !r.stale);
        assert!(r.config.outputs[2].has(Source::Click) && r.config.outputs[2].has(Source::Monitor), "el monitor se añade donde está el click");
        assert!(validate(&r.config, 4).is_empty(), "el ruteo migrado es válido y no bloquea la reproducción");
        let _ = std::fs::remove_file(&path);
    }

    // ---- Validación

    #[test]
    fn las_propuestas_validas_no_dan_errores_y_la_de_una_salida_exige_confirmar() {
        assert!(validate(&propose(2), 2).is_empty());
        let una = validate(&propose(1), 1);
        assert!(
            una.iter().any(|i| matches!(i, RoutingIssue::CueMixedWithMusic { .. })),
            "una sola salida mezclaría el click con la música: {una:?}"
        );
        let mut confirmada = propose(1);
        confirmada.allow_mixed = true;
        assert!(validate(&confirmada, 1).is_empty(), "con confirmación explícita se permite");
    }

    #[test]
    fn rechaza_click_o_guia_sin_destino_y_mezcla_con_musica() {
        let mut cfg = propose(4);
        cfg.outputs[3] = OutputAssign::default(); // la guía queda sin salida
        assert!(validate(&cfg, 4).contains(&RoutingIssue::SourceUnrouted(Source::Guide)));

        let mut mezcla = propose(4);
        mezcla.outputs[0].sources.push(RouteEntry { source: Source::Click, gain: 1.0 });
        let issues = validate(&mezcla, 4);
        assert!(
            issues.iter().any(|i| matches!(i, RoutingIssue::CueMixedWithMusic { output: 0, .. })),
            "{issues:?}"
        );
        assert!(issues.iter().all(|i| !i.message().is_empty()));

        let mut sin_musica = propose(4);
        sin_musica.outputs[0] = OutputAssign::default();
        sin_musica.outputs[1] = OutputAssign::default();
        assert!(validate(&sin_musica, 4).contains(&RoutingIssue::SourceUnrouted(Source::MusicMono)));
    }

    #[test]
    fn un_ruteo_hecho_para_otra_cantidad_de_canales_no_es_valido() {
        let issues = validate(&propose(4), 2);
        assert_eq!(issues, vec![RoutingIssue::ChannelCountMismatch { configured: 4, device: 2 }]);
        assert!(validate(&propose(2), 0).contains(&RoutingIssue::NoOutputs));
        assert!(matches!(validate(&propose(2), 64)[0], RoutingIssue::TooManyOutputs { .. }));
    }

    #[test]
    fn nunca_redirige_el_click_a_la_musica_al_pasar_a_menos_salidas() {
        // Ruteo de 4 salidas (click en la 3, guía en la 4) aplicado a un dispositivo de 2 por error.
        let cuatro = propose(4);
        assert!(!validate(&cuatro, 2).is_empty(), "debe rechazarse, no recortarse a las 2 primeras salidas");
    }

    // ---- Almacén por dispositivo

    fn tmp_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("omnitracks_routing_{name}_{}.json", std::process::id()))
    }

    #[test]
    fn el_ruteo_se_guarda_por_dispositivo_y_sobrevive_al_reinicio() {
        let path = tmp_file("persist");
        let _ = std::fs::remove_file(&path);
        let behringer = device_key("WASAPI", "Behringer 1204USB");
        let focusrite = device_key("WASAPI", "Focusrite 4 salidas");
        let mut store = RoutingStore::load(&path);
        let mut custom = propose(2);
        custom.outputs.swap(0, 1); // el usuario invierte las salidas
        custom.custom = true;
        store.set(&behringer, custom.clone()).unwrap();

        let reloaded = RoutingStore::load(&path);
        let r = reloaded.resolve(&behringer, 2);
        assert!(r.saved && !r.stale);
        assert_eq!(r.config, custom, "la preferencia guardada se conserva");
        // Otro dispositivo no hereda nada.
        let other = reloaded.resolve(&focusrite, 4);
        assert!(!other.saved);
        assert_eq!(other.config, propose(4));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cambiar_de_dispositivo_con_otra_cantidad_de_canales_nunca_reusa_el_ruteo_viejo() {
        let path = tmp_file("cambio");
        let _ = std::fs::remove_file(&path);
        let key = device_key("WASAPI", "Interfaz");
        let mut store = RoutingStore::load(&path);
        let mut cfg = propose(2);
        cfg.custom = true;
        store.set(&key, cfg).unwrap();

        // La misma interfaz ahora expone 4 canales (p. ej. otro modo del driver): se propone de nuevo.
        let r = store.resolve(&key, 4);
        assert!(!r.saved && r.stale, "aviso de que había un ruteo guardado para otra cantidad de canales");
        assert_eq!(r.config, propose(4));
        assert!(validate(&r.config, 4).is_empty(), "lo propuesto es válido para el dispositivo actual");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn un_almacen_ilegible_no_rompe_la_carga_y_propone() {
        let path = tmp_file("corrupto");
        std::fs::write(&path, "{ esto no es json").unwrap();
        let store = RoutingStore::load(&path);
        let r = store.resolve(&device_key("WASAPI", "X"), 2);
        assert_eq!(r.config, propose(2));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn la_matriz_compartida_se_copia_sin_perder_ganancias() {
        let slot = RoutingSlot::new();
        assert_eq!(slot.load(), RouteTable::legacy_stereo(), "valor inicial: mezcla estéreo completa");
        let t = RouteTable::from_config(&propose(4));
        slot.store(&t);
        let loaded = slot.load();
        assert_eq!(loaded.channels, 4);
        assert_eq!(loaded.gains[3][Source::Guide.index()], 1.0);
        assert_eq!(loaded.gains[0][Source::MusicL.index()], 1.0);
    }

    #[test]
    fn el_callback_no_asigna_memoria_al_mezclar_una_muestra() {
        // `mix_frame` y `soft_limit` trabajan sobre la pila: no deben tocar el asignador.
        let t = RouteTable::from_config(&propose(8));
        let mut out = [0.0f32; 8];
        let src = sources(0.4, 0.2, 0.1, 0.3);
        let allocs = crate::alloc_probe::count_allocs(|| {
            for _ in 0..1000 {
                t.mix_frame(&src, &mut out);
                for v in out.iter_mut() {
                    *v = soft_limit(*v);
                }
            }
        });
        assert_eq!(allocs, 0, "el mezclado por matriz no debe asignar memoria");
    }
}
