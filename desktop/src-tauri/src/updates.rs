use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct PendingUpdate {
    pub enabled: bool,
    pending: Mutex<Option<(Update, Option<Vec<u8>>)>>,
}

pub fn init(app: &AppHandle) -> PendingUpdate {
    let mut state = PendingUpdate::default();
    if app.config().plugins.0.contains_key("updater") {
        match app.plugin(tauri_plugin_updater::Builder::new().build()) {
            Ok(()) => state.enabled = true,
            Err(error) => tracing::warn!(%error, "Desktop updater disabled"),
        }
    }
    state
}

#[tauri::command]
pub async fn desktop_update_check(
    app: AppHandle,
    state: State<'_, PendingUpdate>,
) -> Result<Option<String>, String> {
    if !state.enabled {
        return Err("Esta compilación no tiene un canal de actualizaciones.".into());
    }
    let mut pending = state.pending.lock().await;
    *pending = None;
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let version = update.as_ref().map(|update| update.version.clone());
    *pending = update.map(|update| (update, None));
    Ok(version)
}

#[tauri::command]
pub async fn desktop_update_download(
    state: State<'_, PendingUpdate>,
    version: String,
) -> Result<(), String> {
    let mut pending = state.pending.lock().await;
    let (update, bytes) = pending
        .as_mut()
        .filter(|(update, _)| update.version == version)
        .ok_or("Vuelve a buscar actualizaciones.")?;
    if bytes.is_none() {
        *bytes = Some(
            update
                .download(|_, _| {}, || {})
                .await
                .map_err(|error| error.to_string())?,
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_update_install(
    state: State<'_, PendingUpdate>,
    version: String,
) -> Result<(), String> {
    let mut pending = state.pending.lock().await;
    let (update, bytes) = pending
        .as_ref()
        .filter(|(update, _)| update.version == version)
        .and_then(|(update, bytes)| Some((update, bytes.as_ref()?)))
        .ok_or("Primero descarga la actualización.")?;
    update.install(bytes).map_err(|error| error.to_string())?;
    *pending = None;
    Ok(())
}
