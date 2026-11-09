use crate::protocol::{state_message, Dispatch, MixCommand, Receipt, Role, Snapshot};
use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, DefaultBodyLimit, Path, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::{net::TcpListener, sync::watch, task::JoinHandle, time};
use tokio_util::sync::CancellationToken;

const QUEUE_LIMIT: usize = 64;
const BATCH_LIMIT: usize = 8;
const SESSION_LIMIT: usize = 16;
const RATE_LIMIT: usize = 10;
const SEND_TIMEOUT: Duration = Duration::from_secs(2);
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(2);
const HEARTBEAT: Duration = Duration::from_secs(15);
const SESSION_STALE: Duration = Duration::from_secs(40);
const AUTH_REVOKED: u16 = 4403;

pub fn random_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

struct Session {
    id: u32,
    role: Role,
    connection: Option<Connection>,
    recent_commands: VecDeque<Instant>,
}

struct Connection {
    id: u32,
    cancel: CancellationToken,
    address: String,
}

#[derive(Serialize)]
pub struct Device {
    pub id: u32,
    role: Role,
    address: String,
}

struct Pending {
    device_id: u32,
    received: Instant,
    dispatch: Dispatch,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
    queue: VecDeque<Pending>,
    inflight: Vec<Pending>,
    next_id: u32,
    last_exchange: Option<Instant>,
}

impl Inner {
    fn id(&mut self) -> u32 {
        self.next_id = self.next_id.wrapping_add(1);
        self.next_id
    }
}

pub struct Hub {
    host: String,
    origin: String,
    pub epoch: String,
    monitor_token: String,
    mixer_token: String,
    cancel: CancellationToken,
    inner: Mutex<Inner>,
    latest: watch::Sender<Arc<Snapshot>>,
}

impl Hub {
    fn new(addr: SocketAddr) -> io::Result<Self> {
        Ok(Self {
            host: addr.to_string(),
            origin: format!("http://{addr}"),
            epoch: random_token()?,
            monitor_token: random_token()?,
            mixer_token: random_token()?,
            cancel: CancellationToken::new(),
            inner: Mutex::new(Inner::default()),
            latest: watch::channel(Arc::new(Snapshot::default())).0,
        })
    }

    fn token(&self, role: Role) -> &str {
        match role {
            Role::Monitor => &self.monitor_token,
            Role::Mixer => &self.mixer_token,
        }
    }

    pub fn pairing_url(&self, role: Role) -> String {
        format!("{}/{}#{}", self.origin, role.path(), self.token(role))
    }

    pub fn devices(&self) -> Vec<Device> {
        let inner = self.inner.lock().expect("LAN state");
        let mut devices: Vec<_> = inner
            .sessions
            .values()
            .filter_map(|session| {
                Some(Device {
                    id: session.id,
                    role: session.role,
                    address: session.connection.as_ref()?.address.clone(),
                })
            })
            .collect();
        devices.sort_by_key(|device| device.id);
        devices
    }

    pub fn kick(&self, device_id: u32) -> bool {
        let mut inner = self.inner.lock().expect("LAN state");
        let Some(key) = inner
            .sessions
            .iter()
            .find_map(|(key, session)| (session.id == device_id).then(|| key.clone()))
        else {
            return false;
        };
        if let Some(connection) = inner
            .sessions
            .remove(&key)
            .and_then(|session| session.connection)
        {
            connection.cancel.cancel();
        }
        inner.queue.retain(|pending| pending.device_id != device_id);
        tracing::info!(device_id, "device revoked");
        true
    }

    pub fn exchange(&self, snapshot: Snapshot, receipts: Vec<Receipt>) -> Vec<Dispatch> {
        let mut inner = self.inner.lock().expect("LAN state");
        if self.cancel.is_cancelled() {
            return Vec::new();
        }
        inner.last_exchange = Some(Instant::now());
        for receipt in receipts.into_iter().take(BATCH_LIMIT) {
            if let Some(index) = inner
                .inflight
                .iter()
                .position(|entry| entry.dispatch.id == receipt.id)
            {
                let entry = inner.inflight.swap_remove(index);
                tracing::info!(
                    device_id = entry.device_id,
                    command_id = entry.dispatch.id,
                    outcome = ?receipt.outcome,
                    elapsed_ms = entry.received.elapsed().as_secs_f64() * 1000.0,
                    "command receipt"
                );
            }
        }
        inner.inflight.retain(|entry| {
            if entry.received.elapsed() < RECEIPT_TIMEOUT {
                return true;
            }
            tracing::warn!(
                command_id = entry.dispatch.id,
                "no command receipt before deadline"
            );
            false
        });

        self.latest.send_if_modified(|latest| {
            if latest.as_ref() == &snapshot {
                return false;
            }
            *latest = Arc::new(snapshot.clone());
            true
        });

        if !inner.inflight.is_empty() {
            return Vec::new();
        }
        let mut dispatches = Vec::with_capacity(BATCH_LIMIT);
        while dispatches.len() < BATCH_LIMIT {
            let Some(pending) = inner.queue.pop_front() else {
                break;
            };
            let dispatch = &pending.dispatch;
            let still_targets =
                dispatch
                    .command
                    .target(&snapshot)
                    .is_some_and(|(project, track)| {
                        project == dispatch.project_id && track == dispatch.track_id
                    });
            if !still_targets || pending.received.elapsed() >= RECEIPT_TIMEOUT {
                tracing::info!(command_id = dispatch.id, "stale queued command dropped");
                continue;
            }
            dispatches.push(dispatch.clone());
            inner.inflight.push(pending);
        }
        dispatches
    }

    fn enqueue(&self, key: &str, connection_id: u32, text: &str) -> Result<(), &'static str> {
        let mut inner = self.inner.lock().expect("LAN state");
        if inner
            .last_exchange
            .is_none_or(|last| last.elapsed() >= RECEIPT_TIMEOUT)
        {
            return Err("player bridge unavailable");
        }
        let Some(session) = inner.sessions.get_mut(key) else {
            return Err("revoked");
        };
        if self.cancel.is_cancelled()
            || !session
                .connection
                .as_ref()
                .is_some_and(|connection| connection.id == connection_id)
        {
            return Err("revoked");
        }
        if session.role != Role::Mixer {
            return Err("read-only role");
        }
        let now = Instant::now();
        session
            .recent_commands
            .retain(|accepted| now.duration_since(*accepted) < Duration::from_secs(1));
        if session.recent_commands.len() >= RATE_LIMIT {
            return Err("rate limited");
        }
        session.recent_commands.push_back(now);
        let device_id = session.id;
        let command = serde_json::from_str::<MixCommand>(text).map_err(|_| "invalid command")?;
        let (project_id, track_id) = command
            .target(&self.latest.borrow())
            .ok_or("invalid target or value")?;
        if inner.queue.len() >= QUEUE_LIMIT {
            return Err("queue full");
        }
        let id = inner.id();
        inner.queue.push_back(Pending {
            device_id,
            received: now,
            dispatch: Dispatch {
                id,
                project_id,
                track_id,
                command,
            },
        });
        tracing::debug!(device_id, command_id = id, "command queued");
        Ok(())
    }

    fn origin_ok(&self, headers: &HeaderMap) -> bool {
        headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            == Some(self.host.as_str())
            && headers
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                == Some(self.origin.as_str())
    }

    fn has_session(&self, key: &str, role: Role) -> bool {
        !self.cancel.is_cancelled()
            && self
                .inner
                .lock()
                .expect("LAN state")
                .sessions
                .get(key)
                .is_some_and(|session| session.role == role)
    }

    fn connect(
        &self,
        key: &str,
        role: Role,
        address: String,
    ) -> Option<(u32, u32, CancellationToken)> {
        let mut inner = self.inner.lock().expect("LAN state");
        if self.cancel.is_cancelled() {
            return None;
        }
        let connection_id = inner.id();
        let session = inner
            .sessions
            .get_mut(key)
            .filter(|session| session.role == role)?;
        if let Some(previous) = session.connection.take() {
            previous.cancel.cancel();
        }
        let cancel = self.cancel.child_token();
        session.connection = Some(Connection {
            id: connection_id,
            cancel: cancel.clone(),
            address,
        });
        Some((session.id, connection_id, cancel))
    }

    fn disconnected(&self, key: &str, connection_id: u32) {
        let mut inner = self.inner.lock().expect("LAN state");
        if let Some(session) = inner.sessions.get_mut(key) {
            if session
                .connection
                .as_ref()
                .is_some_and(|connection| connection.id == connection_id)
            {
                session.connection = None;
                let id = session.id;
                inner.queue.retain(|entry| entry.device_id != id);
            }
        }
    }
}

pub struct Server {
    pub hub: Arc<Hub>,
    task: JoinHandle<()>,
}

impl Server {
    pub async fn bind(addr: SocketAddr) -> io::Result<Self> {
        let listener = TcpListener::bind(addr).await?;
        let hub = Arc::new(Hub::new(listener.local_addr()?)?);
        let app = Router::new()
            .route("/monitor", get(page))
            .route("/mezclador", get(page))
            .route("/remote.js", get(script))
            .route("/remote.css", get(styles))
            .route("/session/{role}", get(check_session).post(pair))
            .route("/ws/{role}", get(upgrade))
            .layer(DefaultBodyLimit::max(1024))
            .with_state(hub.clone());
        let shutdown = hub.cancel.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown.clone().cancelled_owned())
            .await
            {
                tracing::error!(%error, "LAN listener failed");
            }
            shutdown.cancel();
        });
        tracing::info!(host = %hub.host, "LAN listener started");
        Ok(Self { hub, task })
    }

    pub fn is_running(&self) -> bool {
        !self.hub.cancel.is_cancelled() && !self.task.is_finished()
    }

    pub async fn stop(self) {
        self.hub.cancel.cancel();
        // Stop accepting before replying to the toggle. Upgraded sockets each observe cancellation.
        let mut task = self.task;
        if time::timeout(SEND_TIMEOUT, &mut task).await.is_err() {
            task.abort();
            let _ = task.await;
        }
        tracing::info!("LAN listener stopped");
    }
}

const PAGE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

async fn page() -> impl IntoResponse {
    (
        [
            (header::CONTENT_SECURITY_POLICY, PAGE_CSP),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Html(include_str!("../../web/remote.html")),
    )
}

async fn script() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../../web/remote.js"),
    )
}

async fn styles() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../../web/remote.css"),
    )
}

fn session_cookie(headers: &HeaderMap, role: Role) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|pair| {
            let (key, value) = pair.trim().split_once('=')?;
            (key == role.cookie() && value.len() == 43).then_some(value)
        })
}

async fn check_session(
    State(hub): State<Arc<Hub>>,
    Path(path): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let Some(role) = Role::from_path(&path) else {
        return StatusCode::NOT_FOUND;
    };
    if session_cookie(&headers, role).is_some_and(|key| hub.has_session(key, role)) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::UNAUTHORIZED
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairRequest {
    token: String,
}

async fn pair(
    State(hub): State<Arc<Hub>>,
    Path(path): Path<String>,
    headers: HeaderMap,
    Json(request): Json<PairRequest>,
) -> Response {
    let Some(role) = Role::from_path(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !hub.origin_ok(&headers)
        || !bool::from(request.token.as_bytes().ct_eq(hub.token(role).as_bytes()))
    {
        tracing::warn!(?role, "pairing rejected");
        return StatusCode::FORBIDDEN.into_response();
    }
    if session_cookie(&headers, role).is_some_and(|key| hub.has_session(key, role)) {
        return StatusCode::NO_CONTENT.into_response();
    }
    let Ok(key) = random_token() else {
        tracing::error!("session token generation failed");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut inner = hub.inner.lock().expect("LAN state");
    if hub.cancel.is_cancelled() || inner.sessions.len() >= SESSION_LIMIT {
        tracing::warn!(?role, "session limit reached or listener stopped");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let id = inner.id();
    let cookie = format!("{}={key}; Path=/; HttpOnly; SameSite=Strict", role.cookie());
    inner.sessions.insert(
        key,
        Session {
            id,
            role,
            connection: None,
            recent_commands: VecDeque::new(),
        },
    );
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).expect("ASCII session cookie"),
    );
    response
}

async fn upgrade(
    State(hub): State<Arc<Hub>>,
    Path(path): Path<String>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(role) = Role::from_path(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !hub.origin_ok(&headers) {
        tracing::warn!(?role, "WebSocket origin rejected");
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(key) = session_cookie(&headers, role).filter(|key| hub.has_session(key, role)) else {
        tracing::warn!(?role, "WebSocket session rejected");
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let key = key.to_owned();
    ws.max_message_size(1024)
        .max_frame_size(1024)
        .write_buffer_size(0)
        .max_write_buffer_size(256 * 1024)
        .on_failed_upgrade(|error| tracing::warn!(%error, "WebSocket upgrade failed"))
        .on_upgrade(move |socket| serve_socket(socket, hub, role, key, addr.ip().to_string()))
}

async fn send(socket: &mut WebSocket, message: Message) -> bool {
    match time::timeout(SEND_TIMEOUT, socket.send(message)).await {
        Ok(Ok(())) => true,
        Ok(Err(error)) => {
            tracing::info!(%error, "socket write failed");
            false
        }
        Err(_) => {
            tracing::warn!("slow socket write timed out");
            false
        }
    }
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    if send(
        socket,
        Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })),
    )
    .await
    {
        // Drain in-flight frames without executing them so Windows can deliver the close frame.
        let _ = time::timeout(Duration::from_millis(250), async {
            while let Some(Ok(frame)) = socket.recv().await {
                if matches!(frame, Message::Close(_)) {
                    break;
                }
            }
        })
        .await;
    }
}

async fn serve_socket(
    mut socket: WebSocket,
    hub: Arc<Hub>,
    role: Role,
    key: String,
    address: String,
) {
    let Some((device_id, connection_id, cancel)) = hub.connect(&key, role, address) else {
        close(&mut socket, AUTH_REVOKED, "Sesión revocada").await;
        return;
    };
    tracing::info!(device_id, ?role, "device connected");
    let mut state = hub.latest.subscribe();
    let mut last_sent = None;
    let mut heartbeat = time::interval_at(time::Instant::now() + HEARTBEAT, HEARTBEAT);
    heartbeat.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    let mut last_seen = Instant::now();
    let mut invalid = 0u8;

    loop {
        // Clone just the current snapshot. Changes while writing collapse into the next latest state.
        let snapshot = state.borrow_and_update().clone();
        if cancel.is_cancelled() {
            close(&mut socket, AUTH_REVOKED, "Sesión cerrada").await;
            break;
        }
        let current = snapshot.view(role);
        if let Some(message) = state_message(&current, last_sent.as_ref()) {
            if !send(&mut socket, Message::Text(message.into())).await {
                break;
            }
            last_sent = Some(current);
        }

        tokio::select! {
            _ = cancel.cancelled() => continue,
            changed = state.changed() => {
                if changed.is_err() { break; }
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > SESSION_STALE {
                    tracing::warn!(device_id, "socket heartbeat expired");
                    break;
                }
                if !send(&mut socket, Message::Ping(Default::default())).await { break; }
            }
            received = socket.recv() => {
                last_seen = Instant::now();
                let result = match received {
                    Some(Ok(Message::Text(text))) => hub.enqueue(&key, connection_id, &text),
                    Some(Ok(Message::Binary(_))) => Err("binary commands are invalid"),
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => Ok(()),
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(error)) => {
                        tracing::info!(device_id, %error, "socket read failed");
                        break;
                    }
                };
                if let Err(reason) = result {
                    tracing::warn!(device_id, ?role, reason, "command rejected");
                    if reason == "revoked" {
                        close(&mut socket, AUTH_REVOKED, "Sesión revocada").await;
                        break;
                    }
                    if reason == "rate limited" || reason == "queue full" {
                        let notice = serde_json::json!({"type": "rejected", "reason": reason}).to_string();
                        if !send(&mut socket, Message::Text(notice.into())).await { break; }
                        invalid = invalid.saturating_add(1);
                        if invalid < 3 { continue; }
                    } else {
                        invalid = invalid.saturating_add(1);
                        if invalid < 3 { continue; }
                    }
                    close(&mut socket, 1008, "Comando rechazado").await;
                    break;
                }
            }
        }
    }
    hub.disconnected(&key, connection_id);
    tracing::info!(device_id, ?role, "device disconnected");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Outcome, Song, Track};

    fn ready_snapshot() -> Snapshot {
        Snapshot {
            revision: 1,
            accepting_commands: true,
            current_song: Some(Song {
                id: "song".into(),
                title: "Ensayo".into(),
                key: "C".into(),
                bpm: 120.0,
                beats_per_bar: 4,
                beat_unit: 4,
            }),
            tracks: vec![Track {
                id: "track".into(),
                name: "Bajo".into(),
                color: "#ed655c".into(),
                gain: 1.0,
                muted: false,
                pan: 0.0,
                soloed: false,
            }],
            ..Snapshot::default()
        }
    }

    #[test]
    fn bounded_admission_and_batches() {
        let hub = Hub::new("127.0.0.1:8765".parse().unwrap()).unwrap();
        let state = ready_snapshot();
        hub.exchange(state.clone(), vec![]);
        let command = r#"{"type":"setTrackGain","revision":1,"trackIndex":0,"gain":0.6}"#;
        for index in 0..7 {
            let key = format!("session-{index}");
            {
                let mut inner = hub.inner.lock().unwrap();
                let id = inner.id();
                inner.sessions.insert(
                    key.clone(),
                    Session {
                        id,
                        role: Role::Mixer,
                        connection: None,
                        recent_commands: VecDeque::new(),
                    },
                );
            }
            let (_, connection_id, _) = hub.connect(&key, Role::Mixer, "127.0.0.1".into()).unwrap();
            let remaining = QUEUE_LIMIT - index * RATE_LIMIT;
            for _ in 0..RATE_LIMIT.min(remaining) {
                assert_eq!(hub.enqueue(&key, connection_id, command), Ok(()));
            }
            let expected = if remaining >= RATE_LIMIT {
                "rate limited"
            } else {
                "queue full"
            };
            assert_eq!(hub.enqueue(&key, connection_id, command), Err(expected));
        }
        assert_eq!(hub.inner.lock().unwrap().queue.len(), QUEUE_LIMIT);
        let batch = hub.exchange(state.clone(), vec![]);
        assert_eq!(batch.len(), BATCH_LIMIT);
        assert!(hub.exchange(state.clone(), vec![]).is_empty());
        let receipts = batch
            .into_iter()
            .map(|entry| Receipt {
                id: entry.id,
                outcome: Outcome::Applied,
            })
            .collect();
        let newer = Snapshot {
            revision: 2,
            ..state
        };
        assert!(hub.exchange(newer, receipts).is_empty());
        assert!(hub.inner.lock().unwrap().queue.is_empty());
    }

    #[test]
    fn slow_writer_keeps_latest_and_diffs_from_last_sent() {
        let hub = Hub::new("127.0.0.1:8765".parse().unwrap()).unwrap();
        let mut state = ready_snapshot();
        hub.exchange(state.clone(), vec![]);
        let mut reader = hub.latest.subscribe();
        let last_sent = reader.borrow_and_update().view(Role::Mixer);
        for step in 1..100 {
            state.tracks[0].gain = step as f64 / 100.0;
            hub.exchange(state.clone(), vec![]);
        }
        let latest = reader.borrow_and_update().view(Role::Mixer);
        assert!(!reader.has_changed().unwrap());
        let delta: serde_json::Value =
            serde_json::from_str(&state_message(&latest, Some(&last_sent)).unwrap()).unwrap();
        assert_eq!(delta["type"], "delta");
        assert_eq!(delta["state"].as_object().unwrap().len(), 1);
        assert_eq!(delta["state"]["tracks"][0]["gain"], 0.99);
    }
}
