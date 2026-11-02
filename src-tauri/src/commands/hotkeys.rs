//! The keyboard shortcut editor.

use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::hotkeys;
use crate::services::hotkeys::{self as table, Binding};
use crate::services::quick_access;
use crate::state::AppState;

#[tauri::command]
pub async fn hotkeys_list(app: AppHandle) -> AppResult<Vec<Binding>> {
    hotkeys::table(&app)
}

/// Sets one key. Empty: back to the default (built-ins) or no key (entries).
#[tauri::command]
pub async fn hotkey_set(app: AppHandle, state: State<'_, AppState>, id: String, keys: String) -> AppResult<Vec<Binding>> {
    {
        let conn = state.db.conn()?;
        match id.strip_prefix("entry:") {
            Some(entry) => {
                let entry: i64 = entry.parse().map_err(|_| AppError::Invalid("invalid shortcut".into()))?;
                quick_access::set_hotkey(&conn, entry, &keys)?;
            }
            None => table::set_builtin(&conn, &id, &keys)?,
        }
    }
    hotkeys::sync(&app)?;
    hotkeys::table(&app)
}

/// Built-in keys back to their defaults; entry keys stay.
#[tauri::command]
pub async fn hotkeys_reset(app: AppHandle, state: State<'_, AppState>) -> AppResult<Vec<Binding>> {
    table::reset_builtins(&*state.db.conn()?)?;
    hotkeys::sync(&app)?;
    hotkeys::table(&app)
}
