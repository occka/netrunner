use tauri::State;

use crate::error::AppResult;
use crate::services::activity::{self, ActivityEntry, Level};
use crate::state::AppState;

#[tauri::command]
pub async fn activity_list(state: State<'_, AppState>, limit: Option<u32>) -> AppResult<Vec<ActivityEntry>> {
    activity::list(&*state.db.conn()?, limit.unwrap_or(100))
}

#[tauri::command]
pub async fn activity_clear(state: State<'_, AppState>) -> AppResult<()> {
    let conn = state.db.conn()?;
    activity::clear(&conn)?;
    activity::record(&conn, Level::Info, "activity", "Activity log cleared");
    Ok(())
}
