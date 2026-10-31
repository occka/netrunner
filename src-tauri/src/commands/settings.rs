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
pub async fn settings_set(app: tauri::AppHandle, state: State<'_, AppState>, key: String, value: Value) -> AppResult<()> {
    settings::set(&*state.db.conn()?, &key, &value)?;
    if key.starts_with("browser.") {
        crate::browser::reload_prefs(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn appearance_wallpapers(state: State<'_, AppState>) -> AppResult<Vec<crate::services::appearance::Wallpaper>> {
    crate::services::appearance::list(&state.data_dir)
}

/// `path` comes from the native file picker; the image is copied, never referenced.
#[tauri::command]
pub async fn appearance_import_wallpaper(state: State<'_, AppState>, path: String) -> AppResult<crate::services::appearance::Wallpaper> {
    crate::services::appearance::import(&state.data_dir, std::path::Path::new(&path))
}

#[tauri::command]
pub async fn appearance_delete_wallpaper(state: State<'_, AppState>, name: String) -> AppResult<()> {
    crate::services::appearance::delete(&state.data_dir, &name)
}

#[tauri::command]
pub async fn appearance_wallpaper_data(state: State<'_, AppState>, name: String) -> AppResult<String> {
    crate::services::appearance::data_url(&state.data_dir, &name)
}
