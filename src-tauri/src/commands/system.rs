use tauri::State;

use crate::error::{AppError, AppResult};
use crate::services::activity::{self, Level};
use crate::state::AppState;
use crate::system::monitor::{ProcessInfo, Snapshot, SystemInfo};
use crate::system::{network, power, services, startup};

#[tauri::command]
pub async fn system_info(state: State<'_, AppState>) -> AppResult<SystemInfo> {
    state.with_monitor(|m| m.info())
}

#[tauri::command]
pub async fn system_snapshot(state: State<'_, AppState>) -> AppResult<Snapshot> {
    state.with_monitor(|m| m.snapshot())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessList {
    /// False on the first sample, when per-process CPU is not yet measurable.
    pub cpu_valid: bool,
    pub processes: Vec<ProcessInfo>,
}

#[tauri::command]
pub async fn system_top_processes(state: State<'_, AppState>, limit: Option<usize>) -> AppResult<ProcessList> {
    let (cpu_valid, processes) = state.with_monitor(|m| m.top_processes(limit.unwrap_or(8).min(2000)))?;
    Ok(ProcessList { cpu_valid, processes })
}

/// Terminates a process. The UI asks for confirmation first; the backend
/// additionally refuses protected system processes and NETRUNNER itself.
#[tauri::command]
pub async fn system_terminate_process(state: State<'_, AppState>, pid: u32, confirmed: bool) -> AppResult<()> {
    if !confirmed {
        return Err(AppError::ConfirmationRequired("terminating a process can lose unsaved work".into()));
    }
    let name = state.with_monitor(|m| m.terminate(pid))??;
    activity::record(&*state.db.conn()?, Level::Warn, "system", &format!("Terminated process {name} (PID {pid})"));
    Ok(())
}

#[tauri::command]
pub async fn system_startup_list() -> AppResult<Vec<startup::StartupEntry>> {
    Ok(startup::list())
}

#[tauri::command]
pub async fn system_startup_set(state: State<'_, AppState>, id: String, enabled: bool) -> AppResult<()> {
    startup::set_enabled(&id, enabled)?;
    let name = id.split_once(':').map(|(_, n)| n).unwrap_or(&id);
    activity::record(
        &*state.db.conn()?,
        Level::Info,
        "system",
        &format!("{} startup entry '{name}'", if enabled { "Enabled" } else { "Disabled" }),
    );
    Ok(())
}

#[tauri::command]
pub async fn system_services() -> AppResult<Vec<services::ServiceInfo>> {
    services::list()
}

#[tauri::command]
pub async fn system_power() -> AppResult<power::PowerInfo> {
    Ok(power::info())
}

#[tauri::command]
pub async fn system_power_set_plan(state: State<'_, AppState>, guid: String) -> AppResult<()> {
    let name = power::set_active(&guid)?;
    activity::record(&*state.db.conn()?, Level::Info, "system", &format!("Switched power plan to '{name}'"));
    Ok(())
}

#[tauri::command]
pub async fn network_status() -> AppResult<network::NetworkStatus> {
    Ok(network::status())
}

/// Blocking WinRT calls: run on a worker thread.
#[tauri::command]
pub async fn media_status() -> AppResult<crate::system::media::MediaStatus> {
    tauri::async_runtime::spawn_blocking(crate::system::media::status)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

#[tauri::command]
pub async fn media_control(app_id: String, action: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::system::media::control(&app_id, &action))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}
