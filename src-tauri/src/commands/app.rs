use tauri::State;
use tauri_plugin_autostart::ManagerExt;

use crate::error::{AppError, AppResult};
use crate::services::activity::{self, Level};
use crate::state::AppState;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub database_path: Option<String>,
    pub schema_version: i64,
}

#[tauri::command]
pub async fn app_info(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<AppInfo> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.display().to_string(),
        database_path: state.db.path().map(|p| p.display().to_string()),
        schema_version: state.db.schema_version()?,
    })
}

/// Whether NETRUNNER is registered to start with Windows (HKCU Run key).
#[tauri::command]
pub async fn app_autostart_get(app: tauri::AppHandle) -> AppResult<bool> {
    app.autolaunch().is_enabled().map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn app_autostart_set(app: tauri::AppHandle, state: State<'_, AppState>, enabled: bool) -> AppResult<bool> {
    let manager = app.autolaunch();
    let result = if enabled { manager.enable() } else { manager.disable() };
    result.map_err(|e| AppError::Internal(e.to_string()))?;
    activity::record(
        &*state.db.conn()?,
        Level::Info,
        "core",
        if enabled { "Enabled start with Windows" } else { "Disabled start with Windows" },
    );
    manager.is_enabled().map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub available: Option<String>,
    pub notes: Option<String>,
}

/// Checks the GitHub release feed (signed `latest.json`) for a newer version.
#[tauri::command]
pub async fn app_check_update(app: tauri::AppHandle) -> AppResult<UpdateInfo> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| AppError::Internal(e.to_string()))?;
    let update = updater.check().await.map_err(|e| AppError::Launch(format!("update check failed: {e}")))?;
    Ok(UpdateInfo {
        current: app.package_info().version.to_string(),
        available: update.as_ref().map(|u| u.version.clone()),
        notes: update.and_then(|u| u.body),
    })
}

/// Downloads the signed update, verifies it against the bundled public key,
/// runs the installer (passive mode) and restarts. The UI confirms first.
#[tauri::command]
pub async fn app_install_update(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| AppError::Internal(e.to_string()))?;
    let update = updater
        .check()
        .await
        .map_err(|e| AppError::Launch(format!("update check failed: {e}")))?
        .ok_or_else(|| AppError::NotFound("no update available".into()))?;
    activity::record(&*state.db.conn()?, Level::Info, "core", &format!("Installing update {}", update.version));
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| AppError::Launch(format!("update failed: {e}")))?;
    app.restart();
}

/// Opens an http(s) link in the user's default browser.
#[tauri::command]
pub async fn app_open_url(url: String) -> AppResult<()> {
    let url = crate::security::targets::validate_web_url(&url)?;
    crate::services::launcher::shell_open(&url, "", None)
}
