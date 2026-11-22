use omnitracks_desktop::{
    close_gate::{CloseDecision, CloseGate, CLOSE_EVENT, CLOSE_GRACE_MS},
    lan::{Device, Server},
    protocol::{Dispatch, Receipt, Role, Snapshot},
};
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;
mod updates;
use updates::{desktop_update_check, desktop_update_download, desktop_update_install};

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
        .map(|role| Ok(Pairing {
            role,
            url: server.hub.pairing_url(role),
        }))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(ConnectionInfo {
        epoch: server.hub.epoch.clone(),
        pairings,
        devices: server.hub.devices(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    interfaces: Vec<Interface>,
    connection: Option<ConnectionInfo>,
    updates_enabled: bool,
}

#[tauri::command]
async fn remote_status(
    state: State<'_, RemoteState>,
    updater: State<'_, updates::PendingUpdate>,
) -> Result<Status, String> {
    let running = state.0.lock().await;
    Ok(Status {
        interfaces: interfaces()?,
        updates_enabled: updater.enabled,
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
) -> Result<ConnectionInfo, String> {
    let running = state.0.lock().await;
    let server = active_server(&running, &epoch)?;
    server.hub.kick(device_id);
    // Expulsar renueva el enlace del rol: se devuelve la información al día para que la interfaz muestre el nuevo.
    connection_info(server)
}

fn active_server<'a>(running: &'a Option<Server>, epoch: &str) -> Result<&'a Server, String> {
    running
        .as_ref()
        .filter(|server| server.is_running() && server.hub.epoch == epoch)
        // El código `LAN_APAGADO` es el único error que la interfaz trata como terminal (`bridgeLoop.ts`): el
        // servidor ya no existe y reintentar no sirve. Cualquier otro error de un intercambio se reintenta.
        .ok_or_else(|| "LAN_APAGADO: El servidor LAN está apagado o la sesión terminó.".into())
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
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new("info,symphonia=warn,symphonia_bundle_mp3=warn,symphonia_codec_aac=warn,symphonia_core=warn,symphonia_default=warn")
    });
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RemoteState::default())
        .manage(CloseGate::default())
        .on_window_event(|window, event| {
            // Cerrar la ventana espera (con tope) a que la interfaz guarde lo pendiente: ver `close_gate`.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let gate = window.state::<CloseGate>();
                match gate.on_close_requested() {
                    CloseDecision::Allow => {}
                    CloseDecision::Wait => api.prevent_close(),
                    CloseDecision::Ask => {
                        api.prevent_close();
                        if let Err(error) = window.emit(CLOSE_EVENT, ()) {
                            tracing::warn!("[Cierre] No se pudo avisar a la interfaz: {error}");
                        }
                        let window = window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(CLOSE_GRACE_MS));
                            // Si la interfaz ya confirmó, la ventana ya no existe y `close` no hace nada.
                            window.state::<CloseGate>().confirm();
                            let _ = window.close();
                        });
                    }
                }
            }
        })
        .setup(|app| {
            app.manage(updates::init(app.handle()));
            let local_data = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let audio_settings_path = local_data.join("audio_settings.json");
            app.manage(omnitracks_desktop::audio::output::AudioEngineState::new(
                audio_settings_path,
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            remote_status,
            remote_start,
            remote_stop,
            remote_kick,
            remote_exchange,
            desktop_update_check,
            desktop_update_download,
            desktop_update_install,
            omnitracks_desktop::close_gate::app_confirm_close,
            omnitracks_desktop::audio::audio_list_hosts,
            omnitracks_desktop::audio::audio_list_devices,
            omnitracks_desktop::audio::audio_get_config,
            omnitracks_desktop::audio::audio_set_config,
            omnitracks_desktop::audio::audio_get_stats,
            omnitracks_desktop::audio::audio_reset_stats,
            omnitracks_desktop::audio::audio_test_tone,
            omnitracks_desktop::audio::audio_import_tracks,
            omnitracks_desktop::audio::audio_cancel_import,
            omnitracks_desktop::audio::audio_get_project_cache_status,
            omnitracks_desktop::audio::audio_load_project,
            omnitracks_desktop::audio::audio_play,
            omnitracks_desktop::audio::audio_pause,
            omnitracks_desktop::audio::audio_stop,
            omnitracks_desktop::audio::audio_seek,
            omnitracks_desktop::audio::audio_get_playback_state,
            omnitracks_desktop::audio::audio_set_track_controls,
            omnitracks_desktop::audio::audio_queue_jump,
            omnitracks_desktop::audio::audio_cancel_jump,
            omnitracks_desktop::audio::audio_toggle_vamp,
            omnitracks_desktop::audio::audio_set_pitch,
            omnitracks_desktop::audio::audio_set_metronome,
            omnitracks_desktop::audio::audio_get_routing,
            omnitracks_desktop::audio::audio_set_routing,
            omnitracks_desktop::audio::audio_reset_routing,
            omnitracks_desktop::audio::audio_configure_song,
            omnitracks_desktop::audio::audio_preload_project,
            omnitracks_desktop::audio::audio_set_master_gains,
            omnitracks_desktop::audio::audio_switch_to_preloaded,
            omnitracks_desktop::audio::audio_reopen_stream,
            omnitracks_desktop::audio::audio_scan_folder,
            omnitracks_desktop::audio::audio_scan_files,
            omnitracks_desktop::audio::audio_import_track_bytes_raw,
            omnitracks_desktop::audio::audio_delete_project_cache,
            omnitracks_desktop::audio::audio_analyze_loudness,
            omnitracks_desktop::audio::audio_get_cache_stats,
            omnitracks_desktop::audio::audio_clean_orphan_caches,
            omnitracks_desktop::audio::audio_check_files_exist,
            omnitracks_desktop::library::library_load,
            omnitracks_desktop::library::library_get_song_peaks,
            omnitracks_desktop::library::library_save,
            omnitracks_desktop::library::library_save_song,
            omnitracks_desktop::library::library_delete_song,
            omnitracks_desktop::library::library_update_song_folder,
            omnitracks_desktop::library::library_write_sidecar,
            omnitracks_desktop::library::library_read_sidecar
        ])
        .run(tauri::generate_context!())
        .expect("OmniTracks");
}
