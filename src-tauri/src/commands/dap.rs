//! DEVELOPER debugger commands. The adapter and the program run with the
//! user's rights, like Run and tasks; the UI starts a session only on request.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use crate::dev::dap::{self, AdapterStatus, Dap, DapEvent, SourceBreakpoints, StartOptions};
use crate::dev::{toolchains, workspace};
use crate::error::{AppError, AppResult};
use crate::services::activity::{self, Level};
use crate::services::settings;
use crate::state::AppState;

const CODELLDB_KEY: &str = "developer.codelldb_path";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Internal(e.to_string()))?
}

/// (project folder, python override, codelldb override)
fn context(state: &AppState, root: &str) -> AppResult<(PathBuf, Option<String>, Option<String>)> {
    let conn = state.db.conn()?;
    let roots = workspace::roots(&conn)?;
    let p = workspace::resolve(&roots, root, true)?;
    if !roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|r| r == p) {
        return Err(AppError::Invalid("not an open project".into()));
    }
    let python = settings::get(&conn, toolchains::PATHS_KEY)?.and_then(|v| v.get("python").and_then(Value::as_str).map(str::to_string));
    let lldb = settings::get(&conn, CODELLDB_KEY)?.and_then(|v| v.as_str().map(str::to_string));
    Ok((PathBuf::from(workspace::display(&p)), python, lldb))
}

#[tauri::command]
pub async fn dap_adapters(state: State<'_, AppState>, root: String) -> AppResult<Vec<AdapterStatus>> {
    let (project, python, lldb) = context(&state, &root)?;
    blocking(move || Ok(dap::adapters(&project, python.as_deref(), lldb.as_deref()))).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn dap_start(
    state: State<'_, AppState>,
    session: State<'_, Arc<Dap>>,
    root: String,
    adapter: String,
    request: String,
    config: Value,
    breakpoints: Vec<SourceBreakpoints>,
    on_event: Channel<DapEvent>,
) -> AppResult<()> {
    let (project, python, lldb) = context(&state, &root)?;
    activity::record(&*state.db.conn()?, Level::Info, "developer", &format!("Debug session with {adapter} in {}", project.display()));
    let dap = Arc::clone(&session);
    blocking(move || {
        let sink: dap::Sink = Arc::new(move |e| {
            let _ = on_event.send(e);
        });
        dap.start(StartOptions { project: &project, adapter: &adapter, request: &request, config, breakpoints: &breakpoints, python: python.as_deref(), codelldb: lldb.as_deref() }, sink)
    })
    .await
}

#[tauri::command]
pub async fn dap_request(session: State<'_, Arc<Dap>>, command: String, arguments: Value) -> AppResult<Value> {
    let dap = Arc::clone(&session);
    blocking(move || dap.request(&command, arguments)).await
}

#[tauri::command]
pub async fn dap_stop(session: State<'_, Arc<Dap>>) -> AppResult<()> {
    let dap = Arc::clone(&session);
    blocking(move || {
        dap.stop();
        Ok(())
    })
    .await
}
