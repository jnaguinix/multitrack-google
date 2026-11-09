use futures_util::{SinkExt, StreamExt};
use libretracks_desktop::{
    lan::Server,
    protocol::{Clock, Outcome, Receipt, Role, Snapshot, Song, Track},
};
use serde_json::{json, Value};
use std::{net::SocketAddr, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http, Error, Message},
    MaybeTlsStream, WebSocketStream,
};

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn snapshot(revision: u32) -> Snapshot {
    Snapshot {
        revision,
        accepting_commands: true,
        current_song: Some(Song {
            id: format!("song-{revision}"),
            title: "Ensayo".into(),
            key: "C".into(),
            bpm: 120.0,
            beats_per_bar: 4,
            beat_unit: 4,
        }),
        tracks: vec![Track {
            id: "bass".into(),
            name: "Bajo".into(),
            gain: 1.0,
            muted: false,
        }],
        ..Snapshot::default()
    }
}

async fn start() -> Server {
    Server::bind("127.0.0.1:0".parse().unwrap()).await.unwrap()
}

fn pairing(server: &Server, role: Role) -> (SocketAddr, String) {
    let url = server.hub.pairing_url(role);
    let (route, token) = url.split_once('#').unwrap();
    let addr = route
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    (addr, token.into())
}

async fn post_pair(addr: SocketAddr, role: Role, token: &str) -> String {
    let mut socket = TcpStream::connect(addr).await.unwrap();
    let data = json!({ "token": token }).to_string();
    let request = format!(
        "POST /session/{} HTTP/1.1\r\nHost: {addr}\r\nOrigin: http://{addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",
        role.path(), data.len()
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    time::timeout(Duration::from_secs(2), socket.read_to_string(&mut response))
        .await
        .unwrap()
        .unwrap();
    response
}

async fn session(server: &Server, role: Role) -> (SocketAddr, String) {
    let (addr, token) = pairing(server, role);
    let response = post_pair(addr, role, &token).await;
    assert!(response.starts_with("HTTP/1.1 204"), "{response}");
    let cookie = response
        .lines()
        .find_map(|line| line.strip_prefix("set-cookie: "))
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    (addr, cookie.into())
}

async fn websocket(
    addr: SocketAddr,
    role: Role,
    cookie: &str,
    origin: &str,
) -> Result<Client, Error> {
    let mut request = format!("ws://{addr}/ws/{}", role.path())
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert(http::header::ORIGIN, origin.parse().unwrap());
    request
        .headers_mut()
        .insert(http::header::COOKIE, cookie.parse().unwrap());
    connect_async(request).await.map(|(socket, _)| socket)
}

async fn message(client: &mut Client) -> Message {
    time::timeout(Duration::from_secs(2), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

async fn state(client: &mut Client) -> Value {
    serde_json::from_str(message(client).await.to_text().unwrap()).unwrap()
}

async fn send(client: &mut Client, data: Value) {
    client
        .send(Message::Text(data.to_string().into()))
        .await
        .unwrap();
}

fn status(error: Error) -> http::StatusCode {
    match error {
        Error::Http(response) => response.status(),
        other => panic!("unexpected handshake error: {other}"),
    }
}

#[tokio::test]
async fn snapshots_deltas_reconnection_and_slow_reader() {
    let server = start().await;
    let initial = snapshot(1);
    server.hub.exchange(initial.clone(), vec![]);
    let (addr, cookie) = session(&server, Role::Monitor).await;
    let origin = format!("http://{addr}");
    let mut slow = websocket(addr, Role::Monitor, &cookie, &origin)
        .await
        .unwrap();
    let full = state(&mut slow).await;
    assert_eq!(full["type"], "snapshot");
    assert_eq!(full["state"]["currentSong"]["title"], "Ensayo");
    assert!(full["state"].get("tracks").is_none());

    let (_, mixer_cookie) = session(&server, Role::Mixer).await;
    let mut mixer = websocket(addr, Role::Mixer, &mixer_cookie, &origin)
        .await
        .unwrap();
    assert_eq!(state(&mut mixer).await["state"]["tracks"][0]["gain"], 1.0);
    for tick in 1..=300 {
        let mut current = initial.clone();
        current.clock = Clock {
            position_sec: tick as f64,
            duration_sec: 300.0,
            playing: true,
            rate: 1.0,
            sampled_at_ms: tick,
        };
        server.hub.exchange(current, vec![]);
    }
    loop {
        let delta = state(&mut mixer).await;
        assert_eq!(delta["type"], "delta");
        assert_eq!(delta["state"].as_object().unwrap().len(), 1);
        if delta["state"]["clock"]["positionSec"] == 300.0 {
            break;
        }
    }

    drop(slow);
    let mut reconnect = websocket(addr, Role::Monitor, &cookie, &origin)
        .await
        .unwrap();
    let full = state(&mut reconnect).await;
    assert_eq!(full["type"], "snapshot");
    assert_eq!(full["state"]["clock"]["positionSec"], 300.0);
    server.stop().await;
    assert!(TcpStream::connect(addr).await.is_err());
}

#[tokio::test]
async fn validates_roles_origin_and_schema() {
    let server = start().await;
    let initial = snapshot(1);
    server.hub.exchange(initial.clone(), vec![]);
    let (addr, monitor_token) = pairing(&server, Role::Monitor);
    assert!(post_pair(addr, Role::Mixer, &monitor_token)
        .await
        .starts_with("HTTP/1.1 403"));

    let (_, monitor_cookie) = session(&server, Role::Monitor).await;
    let (_, mixer_cookie) = session(&server, Role::Mixer).await;
    let origin = format!("http://{addr}");
    assert_eq!(
        status(
            websocket(addr, Role::Mixer, &monitor_cookie, &origin)
                .await
                .unwrap_err()
        ),
        401
    );
    assert_eq!(
        status(
            websocket(addr, Role::Mixer, &mixer_cookie, "http://otra-web")
                .await
                .unwrap_err()
        ),
        403
    );

    let mut monitor = websocket(addr, Role::Monitor, &monitor_cookie, &origin)
        .await
        .unwrap();
    state(&mut monitor).await;
    for command in [
        json!({ "type": "setTrackGain", "revision": 1, "trackIndex": 0, "gain": 0.5 }),
        json!({ "type": "setTrackMute", "revision": 1, "trackIndex": 0, "muted": true }),
        json!({ "type": "stop" }),
    ] {
        send(&mut monitor, command).await;
    }
    assert!(matches!(message(&mut monitor).await, Message::Close(_)));

    let invalid_groups = [
        [
            json!({"type": "stop"}),
            json!({"type": "changeSong"}),
            json!({"type": "setConfig"}),
        ],
        [
            json!({ "type": "setTrackGain", "revision": 1, "trackIndex": 0, "gain": 1.2 }),
            json!({ "type": "setTrackMute", "revision": 1, "trackIndex": 8, "muted": true }),
            json!({ "type": "setTrackMute", "revision": 1, "trackIndex": 0, "muted": 1 }),
        ],
    ];
    for group in invalid_groups {
        let mut mixer = websocket(addr, Role::Mixer, &mixer_cookie, &origin)
            .await
            .unwrap();
        state(&mut mixer).await;
        for command in group {
            send(&mut mixer, command).await;
        }
        assert!(matches!(message(&mut mixer).await, Message::Close(_)));
    }
    assert!(server.hub.exchange(initial, vec![]).is_empty());
    server.stop().await;
}

#[tokio::test]
async fn dispatches_only_current_tracks_and_revokes_a_device() {
    let server = start().await;
    let initial = snapshot(1);
    server.hub.exchange(initial.clone(), vec![]);
    let (addr, cookie) = session(&server, Role::Mixer).await;
    let origin = format!("http://{addr}");
    let mut mixer = websocket(addr, Role::Mixer, &cookie, &origin)
        .await
        .unwrap();
    state(&mut mixer).await;
    send(
        &mut mixer,
        json!({ "type": "setTrackGain", "revision": 1, "trackIndex": 0, "gain": 0.4 }),
    )
    .await;

    let command = time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(command) = server.hub.exchange(initial.clone(), vec![]).pop() {
                break command;
            }
            time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(command.track_id, "bass");
    let mut changed = initial.clone();
    changed.tracks[0].gain = 0.4;
    server.hub.exchange(
        changed,
        vec![Receipt {
            id: command.id,
            outcome: Outcome::Applied,
        }],
    );
    assert_eq!(state(&mut mixer).await["state"]["tracks"][0]["gain"], 0.4);

    send(
        &mut mixer,
        json!({ "type": "setTrackMute", "revision": 1, "trackIndex": 0, "muted": true }),
    )
    .await;
    assert!(server.hub.exchange(snapshot(2), vec![]).is_empty());
    assert_eq!(state(&mut mixer).await["state"]["revision"], 2);
    let device = server.hub.devices().pop().unwrap();
    assert!(server.hub.kick(device.id));
    // On Windows, a simultaneous client write can reset TCP before the close frame arrives.
    // In both cases the device must disconnect and the old cookie must fail authentication.
    match time::timeout(Duration::from_secs(2), mixer.next())
        .await
        .unwrap()
    {
        Some(Ok(Message::Close(Some(frame)))) => assert_eq!(u16::from(frame.code), 4403),
        Some(Err(Error::Io(error))) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
        None => {}
        other => panic!("expected revocation disconnect, got {other:?}"),
    }
    assert_eq!(
        status(
            websocket(addr, Role::Mixer, &cookie, &origin)
                .await
                .unwrap_err()
        ),
        401
    );
    assert!(server.hub.exchange(snapshot(2), vec![]).is_empty());
    server.stop().await;
}
