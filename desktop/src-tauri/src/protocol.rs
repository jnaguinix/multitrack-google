use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Monitor,
    Mixer,
}

impl Role {
    pub fn path(self) -> &'static str {
        match self {
            Self::Monitor => "monitor",
            Self::Mixer => "mezclador",
        }
    }

    pub fn from_path(path: &str) -> Option<Self> {
        match path {
            "monitor" => Some(Self::Monitor),
            "mezclador" => Some(Self::Mixer),
            _ => None,
        }
    }

    pub fn cookie(self) -> &'static str {
        match self {
            Self::Monitor => "lt_monitor",
            Self::Mixer => "lt_mixer",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub title: String,
    pub key: String,
    pub bpm: f64,
    pub beats_per_bar: u32,
    pub beat_unit: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub name: String,
    pub start_sec: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Jump {
    pub section: Section,
    pub target_bar: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clock {
    pub position_sec: f64,
    pub duration_sec: f64,
    pub sampled_at_ms: u64,
    pub rate: f64,
    pub playing: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub name: String,
    pub color: String,
    pub gain: f64,
    pub muted: bool,
    pub pan: f64,
    pub soloed: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u32,
    pub accepting_commands: bool,
    pub current_song: Option<Song>,
    pub next_song: Option<Song>,
    pub setlist: Vec<Song>,
    pub current_section: Option<Section>,
    pub next_section: Option<Section>,
    pub queued_jump: Option<Jump>,
    pub vamping: bool,
    pub clock: Clock,
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub levels: Vec<u8>,
}

impl Snapshot {
    pub fn view(&self, role: Role) -> Map<String, Value> {
        let mut fields = json!({
            "currentSong": self.current_song,
            "nextSong": self.next_song,
            "setlist": self.setlist,
            "currentSection": self.current_section,
            "nextSection": self.next_section,
            "queuedJump": self.queued_jump,
            "vamping": self.vamping,
            "clock": self.clock,
        })
        .as_object()
        .expect("snapshot object")
        .clone();
        if role == Role::Mixer {
            fields.insert("revision".into(), self.revision.into());
            fields.insert("acceptingCommands".into(), self.accepting_commands.into());
            fields.insert("levels".into(), json!(self.levels));
            fields.insert(
                "tracks".into(),
                json!(self
                    .tracks
                    .iter()
                    .map(|track| json!({
                        "name": track.name,
                        "color": track.color,
                        "gain": track.gain,
                        "muted": track.muted,
                        "pan": track.pan,
                        "soloed": track.soloed,
                    }))
                    .collect::<Vec<_>>()),
            );
        }
        fields
    }
}

pub fn state_message(
    current: &Map<String, Value>,
    previous: Option<&Map<String, Value>>,
) -> Option<String> {
    let (kind, state) = match previous {
        None => ("snapshot", current.clone()),
        Some(previous) => {
            let changed: Map<String, Value> = current
                .iter()
                .filter(|(key, value)| previous.get(*key) != Some(*value))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            if changed.is_empty() {
                return None;
            }
            ("delta", changed)
        }
    };
    Some(json!({ "type": kind, "sentAtMs": unix_ms(), "state": state }).to_string())
}

pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MixCommand {
    SetTrackGain {
        revision: u32,
        track_index: usize,
        gain: f64,
    },
    SetTrackMute {
        revision: u32,
        track_index: usize,
        muted: bool,
    },
    SetTrackPan {
        revision: u32,
        track_index: usize,
        pan: f64,
    },
    SetTrackSolo {
        revision: u32,
        track_index: usize,
        soloed: bool,
    },
}

impl MixCommand {
    pub fn target(&self, state: &Snapshot) -> Option<(String, String)> {
        let (revision, index) = match *self {
            Self::SetTrackGain {
                revision,
                track_index,
                gain,
            } => {
                if !gain.is_finite() || !(0.0..=1.0).contains(&gain) {
                    return None;
                }
                (revision, track_index)
            }
            Self::SetTrackPan {
                revision,
                track_index,
                pan,
            } => {
                if !pan.is_finite() || !(-1.0..=1.0).contains(&pan) {
                    return None;
                }
                (revision, track_index)
            }
            Self::SetTrackMute {
                revision,
                track_index,
                ..
            }
            | Self::SetTrackSolo {
                revision,
                track_index,
                ..
            } => (revision, track_index),
        };
        if !state.accepting_commands || revision != state.revision {
            return None;
        }
        Some((
            state.current_song.as_ref()?.id.clone(),
            state.tracks.get(index)?.id.clone(),
        ))
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dispatch {
    pub id: u32,
    pub project_id: String,
    pub track_id: String,
    pub command: MixCommand,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Applied,
    Stale,
    Superseded,
    Unconfirmed,
}

#[derive(Debug, Deserialize)]
pub struct Receipt {
    pub id: u32,
    pub outcome: Outcome,
}
