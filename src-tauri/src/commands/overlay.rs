use tauri::{AppHandle, Emitter, State};

use crate::error::AppResult;
use crate::overlay;
use crate::services::activity::{self, Level};
use crate::services::overlays::{self, Overlay, OverlayPatch};
use crate::state::AppState;

#[tauri::command]
pub async fn overlay_list(state: State<'_, AppState>) -> AppResult<Vec<Overlay>> {
    overlays::list(&*state.db.conn()?)
}

#[tauri::command]
pub async fn overlay_get(state: State<'_, AppState>, id: i64) -> AppResult<Overlay> {
    overlays::get(&*state.db.conn()?, id)
}

#[tauri::command]
pub async fn overlay_create(app: AppHandle, state: State<'_, AppState>, widget_type: String) -> AppResult<Overlay> {
    let o = overlays::create(&*state.db.conn()?, &widget_type)?;
    overlay::open(&app, &o)?;
    activity::record(&*state.db.conn()?, Level::Info, "overlay", &format!("Created {} overlay", o.widget_type));
    Ok(o)
}

#[tauri::command]
pub async fn overlay_patch(app: AppHandle, state: State<'_, AppState>, id: i64, patch: OverlayPatch) -> AppResult<Overlay> {
    let o = overlays::patch(&*state.db.conn()?, id, &patch)?;
    overlay::apply(&app, &o);
    Ok(o)
}

#[tauri::command]
pub async fn overlay_set_geometry(state: State<'_, AppState>, id: i64, x: i32, y: i32, width: u32, height: u32) -> AppResult<()> {
    overlays::set_geometry(&*state.db.conn()?, id, x, y, width, height)
}

#[tauri::command]
pub async fn overlay_set_visible(app: AppHandle, id: i64, visible: bool) -> AppResult<()> {
    overlay::set_shown(&app, id, visible)?;
    let _ = app.emit("overlays://changed", ());
    Ok(())
}

#[tauri::command]
pub async fn overlay_delete(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<()> {
    overlay::close(&app, id);
    overlays::delete(&*state.db.conn()?, id)?;
    activity::record(&*state.db.conn()?, Level::Info, "overlay", "Removed an overlay");
    Ok(())
}

#[tauri::command]
pub async fn overlay_toggle_all(app: AppHandle) {
    overlay::toggle_all(&app);
}
