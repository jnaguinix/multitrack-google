#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackBus {
    Main = 0,
    CueClick = 1,
    Both = 2,
    /// Guía hablada: tiene su propia fuente de ruteo (puede ir a una salida distinta del click).
    Guide = 3,
}

impl TrackBus {
    /// Nombre con el que la interfaz reconoce el bus (el mismo que acepta `from_str`).
    pub fn name(self) -> &'static str {
        match self {
            TrackBus::Main => "main",
            TrackBus::CueClick => "click",
            TrackBus::Both => "both",
            TrackBus::Guide => "guide",
        }
    }

    /// Si el cambio de tono afecta a las pistas de este bus: la música sí; el click y la guía no (un click o una voz
    /// de guía transpuestos no sirven: la guía debe seguir sonando natural y el click es solo un pulso).
    pub fn transposes(self) -> bool {
        matches!(self, TrackBus::Main | TrackBus::Both)
    }

    pub fn from_u8(val: u8) -> Self {
        match val {
            1 => TrackBus::CueClick,
            2 => TrackBus::Both,
            3 => TrackBus::Guide,
            _ => TrackBus::Main,
        }
    }

    pub fn from_str(s: &str) -> Self {
        let lower = s.to_ascii_lowercase();
        match lower.as_str() {
            "guide" | "guia" => TrackBus::Guide,
            "cue-click" | "cue" | "click" | "in-ear" | "inear" => TrackBus::CueClick,
            "both" => TrackBus::Both,
            _ => TrackBus::Main,
        }
    }
}
