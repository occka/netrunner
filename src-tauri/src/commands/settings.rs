use std::collections::HashMap;

use serde_json::Value;
use tauri::State;

use crate::error::AppResult;
use crate::services::settings;
use crate::state::AppState;

#[tauri::command]
pub async fn settings_get_all(state: State<'_, AppState>) -> AppResult<HashMap<String, Value>> {
    settings::get_all(&*state.db.conn()?)
}

#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, key: String, value: Value) -> AppResult<()> {
    settings::set(&*state.db.conn()?, &key, &value)
}
