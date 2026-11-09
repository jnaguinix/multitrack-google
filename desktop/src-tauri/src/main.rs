use base64::{engine::general_purpose::STANDARD, Engine};
use libretracks_desktop::{
    lan::{Device, Server},
    protocol::{Dispatch, Receipt, Role, Snapshot},
};
use qrcode::{render::svg, QrCode};
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tauri::State;
use tokio::sync::Mutex;

const PORT: u16 = 8765;

#[derive(Default)]
struct RemoteState(Mutex<Option<Server>>);

#[derive(Serialize)]
struct Interface {
    name: String,
    address: Ipv4Addr,
}

fn interfaces() -> Result<Vec<Interface>, String> {
    let mut interfaces: Vec<_> = if_addrs::get_if_addrs()
        .map_err(|error| format!("No se pudieron leer las interfaces: {error}"))?
        .into_iter()
        .filter_map(|interface| {
            let IpAddr::V4(address) = interface.ip() else {
                return None;
            };
            address.is_private().then_some(Interface {
                name: interface.name,
                address,
            })
        })
        .collect();
    interfaces.sort_by_key(|interface| interface.address);
    interfaces.dedup_by_key(|interface| interface.address);
    Ok(interfaces)
}

#[derive(Serialize)]
struct Pairing {
    role: Role,
    url: String,
    qr: String,
}

#[derive(Serialize)]
struct ConnectionInfo {
    epoch: String,
    pairings: Vec<Pairing>,
    devices: Vec<Device>,
}

fn connection_info(server: &Server) -> Result<ConnectionInfo, String> {
    let pairings = [Role::Monitor, Role::Mixer]
        .into_iter()
        .map(|role| {
            let url = server.hub.pairing_url(role);
            let image = QrCode::new(url.as_bytes())
                .map_err(|error| format!("No se pudo generar el QR: {error}"))?
                .render::<svg::Color>()
                .min_dimensions(192, 192)
                .build();
            Ok(Pairing {
                role,
                url,
                qr: format!("data:image/svg+xml;base64,{}", STANDARD.encode(image)),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(ConnectionInfo {
        epoch: server.hub.epoch.clone(),
        pairings,
        devices: server.hub.devices(),
    })
}

#[derive(Serialize)]
struct Status {
    interfaces: Vec<Interface>,
    connection: Option<ConnectionInfo>,
}

#[tauri::command]
async fn remote_status(state: State<'_, RemoteState>) -> Result<Status, String> {
    let running = state.0.lock().await;
    Ok(Status {
        interfaces: interfaces()?,
        connection: running
            .as_ref()
            .filter(|server| server.is_running())
            .map(connection_info)
            .transpose()?,
    })
}

#[tauri::command]
async fn remote_start(
    state: State<'_, RemoteState>,
    address: Ipv4Addr,
) -> Result<ConnectionInfo, String> {
    let mut running = state.0.lock().await;
    if let Some(server) = running.as_ref().filter(|server| server.is_running()) {
        return connection_info(server);
    }
    if !interfaces()?
        .iter()
        .any(|interface| interface.address == address)
    {
        return Err("Selecciona una interfaz IPv4 privada de este equipo.".into());
    }
    let addr = SocketAddr::from((address, PORT));
    let server = Server::bind(addr).await.map_err(|error| {
        tracing::warn!(%addr, %error, "LAN bind failed");
        format!("No se pudo abrir {addr}: {error}")
    })?;
    match connection_info(&server) {
        Ok(info) => {
            *running = Some(server);
            Ok(info)
        }
        Err(error) => {
            server.stop().await;
            Err(error)
        }
    }
}

#[tauri::command]
async fn remote_stop(state: State<'_, RemoteState>, epoch: String) -> Result<(), String> {
    let mut running = state.0.lock().await;
    if running
        .as_ref()
        .is_some_and(|server| server.hub.epoch == epoch)
    {
        if let Some(server) = running.take() {
            server.stop().await;
        }
    }
    Ok(())
}

#[tauri::command]
async fn remote_kick(
    state: State<'_, RemoteState>,
    epoch: String,
    device_id: u32,
) -> Result<(), String> {
    let running = state.0.lock().await;
    let server = active_server(&running, &epoch)?;
    server.hub.kick(device_id);
    Ok(())
}

fn active_server<'a>(running: &'a Option<Server>, epoch: &str) -> Result<&'a Server, String> {
    running
        .as_ref()
        .filter(|server| server.is_running() && server.hub.epoch == epoch)
        .ok_or_else(|| "El servidor LAN está apagado o la sesión terminó.".into())
}

#[derive(Serialize)]
struct Exchange {
    commands: Vec<Dispatch>,
    devices: Vec<Device>,
}

#[tauri::command]
async fn remote_exchange(
    state: State<'_, RemoteState>,
    epoch: String,
    snapshot: Snapshot,
    receipts: Vec<Receipt>,
) -> Result<Exchange, String> {
    let running = state.0.lock().await;
    let server = active_server(&running, &epoch)?;
    Ok(Exchange {
        commands: server.hub.exchange(snapshot, receipts),
        devices: server.hub.devices(),
    })
}

fn main() {
    tracing_subscriber::fmt().with_target(false).init();
    tauri::Builder::default()
        .manage(RemoteState::default())
        .invoke_handler(tauri::generate_handler![
            remote_status,
            remote_start,
            remote_stop,
            remote_kick,
            remote_exchange
        ])
        .run(tauri::generate_context!())
        .expect("LibreTracks Desktop");
}
