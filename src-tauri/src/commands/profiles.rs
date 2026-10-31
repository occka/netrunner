use serde_json::Value;
use tauri::State;

use crate::error::AppResult;
use crate::services::activity::{self, Level};
use crate::services::profiles::{self, Profile};
use crate::state::AppState;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesState {
    pub profiles: Vec<Profile>,
    pub active_id: Option<i64>,
}

#[tauri::command]
pub async fn profiles_state(state: State<'_, AppState>) -> AppResult<ProfilesState> {
    let conn = state.db.conn()?;
    Ok(ProfilesState { profiles: profiles::list(&conn)?, active_id: profiles::active_id(&conn)? })
}

#[tauri::command]
pub async fn profile_create(state: State<'_, AppState>, name: String, copy_from: Option<i64>) -> AppResult<Profile> {
    let conn = state.db.conn()?;
    let profile = profiles::create(&conn, &name, copy_from)?;
    activity::record(&conn, Level::Info, "profiles", &format!("Created profile '{}'", profile.name));
    Ok(profile)
}

#[tauri::command]
pub async fn profile_rename(state: State<'_, AppState>, id: i64, name: String) -> AppResult<Profile> {
    profiles::rename(&*state.db.conn()?, id, &name)
}

#[tauri::command]
pub async fn profile_delete(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    let conn = state.db.conn()?;
    let name = profiles::get(&conn, id)?.name;
    profiles::delete(&conn, id)?;
    activity::record(&conn, Level::Info, "profiles", &format!("Deleted profile '{name}'"));
    Ok(())
}

#[tauri::command]
pub async fn profile_save_layout(state: State<'_, AppState>, id: i64, layout: Value) -> AppResult<Profile> {
    let conn = state.db.conn()?;
    let profile = profiles::save_layout(&conn, id, &layout)?;
    activity::record(&conn, Level::Info, "command", &format!("Saved dashboard layout for '{}'", profile.name));
    Ok(profile)
}

#[tauri::command]
pub async fn profile_activate(app: tauri::AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<Profile> {
    let profile = {
        let conn = state.db.conn()?;
        let profile = profiles::activate(&conn, id)?;
        activity::record(&conn, Level::Info, "profiles", &format!("Switched to profile '{}'", profile.name));
        profile
    };
    // Rules run on a worker thread so the UI gets its answer immediately.
    std::thread::spawn(move || crate::automation::fire(&app, "profile_changed", &id.to_string()));
    Ok(profile)
}
