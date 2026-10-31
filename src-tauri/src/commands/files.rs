//! FILES commands. Blocking disk work runs on the blocking pool.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::files::{self, Drive, Entry, Preview};
use crate::services::activity::{self, Level};
use crate::services::launcher;
use crate::state::AppState;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Internal(e.to_string()))?
}

fn log(state: &AppState, msg: &str) {
    if let Ok(c) = state.db.conn() {
        activity::record(&c, Level::Info, "files", msg);
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Places {
    pub drives: Vec<Drive>,
    pub places: Vec<(String, String)>,
}

#[tauri::command]
pub async fn files_places() -> AppResult<Places> {
    blocking(|| Ok(Places { drives: files::drives(), places: files::places() })).await
}

#[tauri::command]
pub async fn files_list(path: String) -> AppResult<Vec<Entry>> {
    blocking(move || files::list(&path)).await
}

#[tauri::command]
pub async fn files_preview(path: String) -> AppResult<Preview> {
    blocking(move || files::preview(&path)).await
}

#[tauri::command]
pub async fn files_create_dir(parent: String, name: String) -> AppResult<String> {
    blocking(move || files::create_dir(&parent, &name)).await
}

#[tauri::command]
pub async fn files_rename(state: State<'_, AppState>, path: String, new_name: String) -> AppResult<String> {
    let p = path.clone();
    let out = blocking(move || files::rename(&path, &new_name)).await?;
    log(&state, &format!("Renamed {p} → {out}"));
    Ok(out)
}

#[tauri::command]
pub async fn files_transfer(state: State<'_, AppState>, paths: Vec<String>, dest: String, move_items: bool) -> AppResult<usize> {
    let d = dest.clone();
    let n = blocking(move || files::transfer(&paths, &dest, move_items)).await?;
    log(&state, &format!("{} {n} item(s) to {d}", if move_items { "Moved" } else { "Copied" }));
    Ok(n)
}

/// Moves items to the Recycle Bin. The UI confirms first.
#[tauri::command]
pub async fn files_delete(state: State<'_, AppState>, paths: Vec<String>) -> AppResult<usize> {
    let n = blocking(move || files::recycle(&paths)).await?;
    log(&state, &format!("Moved {n} item(s) to the Recycle Bin"));
    Ok(n)
}

#[tauri::command]
pub async fn files_open(path: String) -> AppResult<()> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(AppError::NotFound("not found".into()));
    }
    launcher::shell_open(&path, "", p.parent())
}

#[tauri::command]
pub async fn files_reveal(path: String) -> AppResult<()> {
    let mut cmd = std::process::Command::new("explorer.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg(format!("/select,\"{path}\""));
    }
    cmd.spawn().map(|_| ()).map_err(|e| AppError::Launch(e.to_string()))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub entries: Vec<Entry>,
    pub complete: bool,
}

#[tauri::command]
pub async fn files_search(root: String, query: String) -> AppResult<SearchResult> {
    let (entries, complete) = blocking(move || files::search(&root, &query)).await?;
    Ok(SearchResult { entries, complete })
}
