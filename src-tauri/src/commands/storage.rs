//! STORAGE: backups, export, import and restore of the database.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::services::activity::{self, Level};
use crate::services::settings;
use crate::state::AppState;
use crate::storage::backups::{self, Backup};

pub const EVERY_KEY: &str = "storage.backup_every_days";
pub const KEEP_KEY: &str = "storage.backup_keep";

fn dir(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("backups")
}

#[tauri::command]
pub async fn storage_backups(state: State<'_, AppState>) -> AppResult<Vec<Backup>> {
    Ok(backups::list(&dir(&state)))
}

#[tauri::command]
pub async fn storage_backup_now(state: State<'_, AppState>) -> AppResult<()> {
    let conn = state.db.conn()?;
    let path = backups::create(&conn, &dir(&state), "manual")?;
    activity::record(&conn, Level::Info, "storage", &format!("Backed up the database to {}", path.display()));
    Ok(())
}

/// A copy of everything (settings, profiles, layouts, notes, chats, history) in a file the user chose.
#[tauri::command]
pub async fn storage_export(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let target = std::path::PathBuf::from(&path);
    if !target.is_absolute() || target.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() != Some("db") {
        return Err(AppError::Invalid("choose a .db file".into()));
    }
    let conn = state.db.conn()?;
    backups::write_copy(&conn, &target)?;
    activity::record(&conn, Level::Info, "storage", &format!("Exported the database to {}", target.display()));
    Ok(())
}

/// Checks the file now, swaps it in at the restart that follows.
fn restore(app: &tauri::AppHandle, state: &AppState, source: &std::path::Path) -> AppResult<()> {
    {
        let conn = state.db.conn()?;
        backups::schedule_restore(&conn, &state.data_dir, source)?;
        activity::record(&conn, Level::Warn, "storage", &format!("Restoring the database from {}; restarting", source.display()));
    }
    app.restart();
}

#[tauri::command]
pub async fn storage_restore(app: tauri::AppHandle, state: State<'_, AppState>, name: String) -> AppResult<()> {
    let source = backups::in_dir(&dir(&state), &name)?;
    restore(&app, &state, &source)
}

/// Import: a file exported from this or another NETRUNNER replaces this database.
#[tauri::command]
pub async fn storage_import(app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> AppResult<()> {
    let source = std::path::PathBuf::from(&path);
    if !source.is_file() {
        return Err(AppError::NotFound("file not found".into()));
    }
    restore(&app, &state, &source)
}

#[tauri::command]
pub async fn storage_backup_delete(state: State<'_, AppState>, name: String) -> AppResult<()> {
    let path = backups::in_dir(&dir(&state), &name)?;
    std::fs::remove_file(&path)?;
    activity::record(&*state.db.conn()?, Level::Info, "storage", &format!("Deleted backup {name}"));
    Ok(())
}

#[tauri::command]
pub async fn storage_open_backups(state: State<'_, AppState>) -> AppResult<()> {
    let d = dir(&state);
    std::fs::create_dir_all(&d)?;
    std::process::Command::new("explorer.exe").arg(&d).spawn().map_err(|e| AppError::Launch(e.to_string()))?;
    Ok(())
}

/// Runs in the background: an automatic backup when one is due, then pruning.
pub fn scheduled(state: &AppState) {
    let Ok(conn) = state.db.conn() else { return };
    let get = |k: &str, d: u64| settings::get(&conn, k).ok().flatten().and_then(|v| v.as_u64()).unwrap_or(d);
    let (every, keep) = (get(EVERY_KEY, 7), get(KEEP_KEY, 8));
    let d = dir(state);
    if every == 0 || !backups::due(&d, std::time::Duration::from_secs(every * 24 * 3600)) {
        return;
    }
    match backups::create(&conn, &d, "auto") {
        Ok(path) => {
            let pruned = backups::prune(&d, keep as usize);
            log::info!("automatic backup written to {} ({pruned} old ones removed)", path.display());
        }
        Err(e) => activity::record(&conn, Level::Warn, "storage", &format!("Automatic backup failed: {e}")),
    }
}
