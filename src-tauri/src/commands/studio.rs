use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::error::AppResult;
use crate::services::activity::{self, Level};
use crate::services::profiles;
use crate::services::studio::{self, CustomWidget, FeedResult};
use crate::state::AppState;

fn changed(app: &AppHandle) {
    let _ = app.emit("studio://changed", ());
}

#[tauri::command]
pub async fn studio_list(state: State<'_, AppState>) -> AppResult<Vec<CustomWidget>> {
    studio::list(&*state.db.conn()?)
}

/// New widgets belong to the active profile.
#[tauri::command]
pub async fn studio_create(app: AppHandle, state: State<'_, AppState>, kind: String, name: String) -> AppResult<CustomWidget> {
    let w = {
        let conn = state.db.conn()?;
        let w = studio::create(&conn, &kind, &name, profiles::active_id(&conn)?)?;
        activity::record(&conn, Level::Info, "studio", &format!("Created custom widget '{}'", w.name));
        w
    };
    changed(&app);
    Ok(w)
}

#[tauri::command]
pub async fn studio_update(app: AppHandle, state: State<'_, AppState>, id: i64, name: String, config: Value) -> AppResult<CustomWidget> {
    let w = studio::update(&*state.db.conn()?, id, &name, &config)?;
    changed(&app);
    Ok(w)
}

#[tauri::command]
pub async fn studio_set_profile(app: AppHandle, state: State<'_, AppState>, id: i64, profile_id: Option<i64>) -> AppResult<CustomWidget> {
    let w = studio::set_profile(&*state.db.conn()?, id, profile_id)?;
    changed(&app);
    Ok(w)
}

#[tauri::command]
pub async fn studio_counter(app: AppHandle, state: State<'_, AppState>, id: i64, value: i64) -> AppResult<CustomWidget> {
    let w = studio::set_counter(&*state.db.conn()?, id, value)?;
    changed(&app);
    Ok(w)
}

#[tauri::command]
pub async fn studio_delete(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<()> {
    {
        let conn = state.db.conn()?;
        let name = studio::get(&conn, id)?.name;
        studio::delete(&conn, id)?;
        activity::record(&conn, Level::Info, "studio", &format!("Deleted custom widget '{name}'"));
    }
    changed(&app);
    Ok(())
}

/// Feed items for a feed widget, by id (address and allowlist come from the database).
#[tauri::command]
pub async fn studio_feed(state: State<'_, AppState>, id: i64, force: bool) -> AppResult<FeedResult> {
    let w = studio::get(&*state.db.conn()?, id)?;
    studio::feed(&w, force).await
}

/// Opens a link from a widget (dashboard or overlay) as a BROWSER tab in the main window.
#[tauri::command]
pub async fn browser_open_request(app: AppHandle, url: String) -> AppResult<()> {
    let url = crate::security::targets::validate_web_url(&url)?;
    crate::desktop::show_main(&app);
    let _ = app.emit_to("main", "browser://open-request", url);
    Ok(())
}
