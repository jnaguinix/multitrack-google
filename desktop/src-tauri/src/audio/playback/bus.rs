#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackBus {
    Main = 0,
    CueClick = 1,
    Both = 2,
}

impl TrackBus {
    pub fn from_u8(val: u8) -> Self {
        match val {
            1 => TrackBus::CueClick,
            2 => TrackBus::Both,
            _ => TrackBus::Main,
        }
    }

    pub fn from_str(s: &str) -> Self {
        let lower = s.to_ascii_lowercase();
        match lower.as_str() {
            "cue-click" | "cue" | "click" | "in-ear" | "inear" => TrackBus::CueClick,
            "both" => TrackBus::Both,
            _ => TrackBus::Main,
        }
    }
}
