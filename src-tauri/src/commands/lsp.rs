//! DEVELOPER language-server commands. Servers run as child processes; the UI
//! only sees documents, requests and events for files inside open projects.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use crate::dev::lsp::bridge::{Lsp, Opened, Running};
use crate::dev::lsp::process::LspEvent;
use crate::dev::lsp::registry::{self, Choices, ServerStatus};
use crate::dev::workspace;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Internal(e.to_string()))?
}

fn context(state: &AppState) -> AppResult<(Vec<PathBuf>, Choices)> {
    let conn = state.db.conn()?;
    Ok((workspace::roots(&conn)?, registry::choices(&conn)))
}

#[tauri::command]
pub async fn lsp_subscribe(lsp: State<'_, Arc<Lsp>>, on_event: Channel<LspEvent>) -> AppResult<()> {
    lsp.subscribe(on_event);
    Ok(())
}

/// Every known server with its detection result (for the Languages panel).
#[tauri::command]
pub async fn lsp_servers(state: State<'_, AppState>, project: Option<String>) -> AppResult<Vec<ServerStatus>> {
    let (roots, choices) = context(&state)?;
    let project = match project {
        Some(p) => Some(workspace::resolve(&roots, &p, true)?),
        None => None,
    };
    blocking(move || Ok(registry::detect_all(&choices, project.as_deref()))).await
}

#[tauri::command]
pub async fn lsp_running(lsp: State<'_, Arc<Lsp>>) -> AppResult<Vec<Running>> {
    Ok(lsp.running())
}

#[tauri::command]
pub async fn lsp_open(state: State<'_, AppState>, lsp: State<'_, Arc<Lsp>>, path: String, version: i64, text: String) -> AppResult<Opened> {
    let (roots, choices) = context(&state)?;
    let lsp = Arc::clone(&lsp);
    blocking(move || lsp.open(&roots, &choices, &path, version, text)).await
}

#[tauri::command]
pub async fn lsp_change(state: State<'_, AppState>, lsp: State<'_, Arc<Lsp>>, uri: String, version: i64, text: String) -> AppResult<()> {
    let (_, choices) = context(&state)?;
    let lsp = Arc::clone(&lsp);
    blocking(move || lsp.change(&choices, &uri, version, text)).await
}

#[tauri::command]
pub async fn lsp_save(lsp: State<'_, Arc<Lsp>>, uri: String) -> AppResult<()> {
    let lsp = Arc::clone(&lsp);
    blocking(move || lsp.save(&uri)).await
}

#[tauri::command]
pub async fn lsp_close(lsp: State<'_, Arc<Lsp>>, uri: String) -> AppResult<()> {
    let lsp = Arc::clone(&lsp);
    blocking(move || lsp.close(&uri)).await
}

#[tauri::command]
pub async fn lsp_request(state: State<'_, AppState>, lsp: State<'_, Arc<Lsp>>, server: String, method: String, params: Value) -> AppResult<Value> {
    let (roots, _) = context(&state)?;
    let lsp = Arc::clone(&lsp);
    blocking(move || lsp.request(&roots, &server, &method, params)).await
}

#[tauri::command]
pub async fn lsp_restart(state: State<'_, AppState>, lsp: State<'_, Arc<Lsp>>, server: String) -> AppResult<()> {
    let (_, choices) = context(&state)?;
    let lsp = Arc::clone(&lsp);
    blocking(move || lsp.restart(&server, &choices)).await
}

/// Saves a server's path or disabled flag and stops its running instances so
/// the next opened file uses the new choice.
#[tauri::command]
pub async fn lsp_configure(state: State<'_, AppState>, lsp: State<'_, Arc<Lsp>>, spec: String, path: Option<String>, disabled: bool) -> AppResult<()> {
    if registry::spec(&spec).is_none() {
        return Err(AppError::Invalid(format!("unknown language server '{spec}'")));
    }
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &path {
        if !std::path::Path::new(p).is_file() {
            return Err(AppError::NotFound(format!("file not found: {p}")));
        }
    }
    {
        let conn = state.db.conn()?;
        let mut choices = registry::choices(&conn);
        choices.insert(spec.clone(), registry::UserChoice { path, disabled });
        crate::services::settings::set(&conn, registry::SETTINGS_KEY, &serde_json::to_value(&choices)?)?;
    }
    let lsp = Arc::clone(&lsp);
    blocking(move || {
        lsp.stop_spec(&spec);
        Ok(())
    })
    .await
}
