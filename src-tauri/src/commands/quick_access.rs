use tauri::State;

use crate::error::{AppError, AppResult};
use crate::security::command_policy::{self, CommandAssessment};
use crate::services::activity::{self, Level};
use crate::services::launcher;
use crate::services::quick_access::{self, Entry, EntryInput};
use crate::state::AppState;

#[tauri::command]
pub async fn qa_list(state: State<'_, AppState>) -> AppResult<Vec<Entry>> {
    quick_access::list(&*state.db.conn()?)
}

#[tauri::command]
pub async fn qa_create(state: State<'_, AppState>, input: EntryInput) -> AppResult<Entry> {
    let conn = state.db.conn()?;
    let entry = quick_access::create(&conn, input)?;
    activity::record(&conn, Level::Info, "quick-access", &format!("Added {} '{}'", entry.kind, entry.name));
    Ok(entry)
}

#[tauri::command]
pub async fn qa_update(state: State<'_, AppState>, id: i64, input: EntryInput) -> AppResult<Entry> {
    let conn = state.db.conn()?;
    let entry = quick_access::update(&conn, id, input)?;
    activity::record(&conn, Level::Info, "quick-access", &format!("Updated '{}'", entry.name));
    Ok(entry)
}

#[tauri::command]
pub async fn qa_set_favorite(state: State<'_, AppState>, id: i64, favorite: bool) -> AppResult<Entry> {
    quick_access::set_favorite(&*state.db.conn()?, id, favorite)
}

#[tauri::command]
pub async fn qa_reorder(state: State<'_, AppState>, ids: Vec<i64>) -> AppResult<()> {
    quick_access::reorder(&*state.db.conn()?, &ids)
}

#[tauri::command]
pub async fn qa_delete(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    let conn = state.db.conn()?;
    let entry = quick_access::delete(&conn, id)?;
    activity::record(&conn, Level::Info, "quick-access", &format!("Removed '{}'", entry.name));
    Ok(())
}

/// Launches an entry by id. The target is always read from the database, so
/// the frontend cannot ask the backend to execute an arbitrary path.
#[tauri::command]
pub async fn qa_launch(state: State<'_, AppState>, id: i64, confirmed: Option<bool>) -> AppResult<Entry> {
    let entry = quick_access::get(&*state.db.conn()?, id)?;
    // The DB lock is not held while Windows starts the target.
    let result = launcher::launch(&entry, confirmed.unwrap_or(false));
    let conn = state.db.conn()?;
    match &result {
        Ok(()) => {
            quick_access::mark_launched(&conn, id)?;
            if entry.kind == "command" && command_policy::assess(&entry.target).dangerous {
                activity::record(&conn, Level::Warn, "launcher", &format!("Ran flagged command '{}' after confirmation", entry.name));
            } else {
                activity::record(&conn, Level::Info, "launcher", &format!("Launched {} '{}'", entry.kind, entry.name));
            }
        }
        Err(AppError::ConfirmationRequired(_)) => {}
        Err(err) => activity::record(&conn, Level::Error, "launcher", &format!("Failed to launch '{}': {err}", entry.name)),
    }
    result?;
    quick_access::get(&conn, id)
}

#[tauri::command]
pub async fn qa_reveal(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    let entry = quick_access::get(&*state.db.conn()?, id)?;
    launcher::reveal(&entry)
}

#[tauri::command]
pub async fn qa_assess_command(command: String) -> CommandAssessment {
    command_policy::assess(&command)
}
