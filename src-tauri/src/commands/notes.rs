use serde::Serialize;
use tauri::{AppHandle, Emitter, State, Webview};

use crate::error::AppResult;
use crate::services::notes::{self, Board, NoteItem};
use crate::state::AppState;

/// `notes://changed`: other windows showing the board reload it. `source` is
/// the webview that made the change, which already has it (and may be typing).
#[derive(Clone, Serialize)]
struct Changed<'a> {
    board: &'a str,
    source: &'a str,
}

fn changed(app: &AppHandle, webview: &Webview, board: &str) {
    let _ = app.emit("notes://changed", Changed { board, source: webview.label() });
}

#[tauri::command]
pub async fn notes_board(state: State<'_, AppState>, board: String) -> AppResult<Board> {
    notes::board(&*state.db.conn()?, &board)
}

#[tauri::command]
pub async fn notes_set_text(app: AppHandle, webview: Webview, state: State<'_, AppState>, board: String, text: String) -> AppResult<()> {
    notes::set_text(&*state.db.conn()?, &board, &text)?;
    changed(&app, &webview, &notes::board_name(&board)?);
    Ok(())
}

#[tauri::command]
pub async fn notes_add(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
    board: String,
    text: String,
    first: bool,
) -> AppResult<NoteItem> {
    let item = notes::add(&*state.db.conn()?, &board, &text, first)?;
    changed(&app, &webview, &notes::board_name(&board)?);
    Ok(item)
}

#[tauri::command]
pub async fn notes_update(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
    id: i64,
    text: Option<String>,
    done: Option<bool>,
) -> AppResult<()> {
    let board = notes::update(&*state.db.conn()?, id, text.as_deref(), done)?;
    changed(&app, &webview, &board);
    Ok(())
}

#[tauri::command]
pub async fn notes_delete(app: AppHandle, webview: Webview, state: State<'_, AppState>, id: i64) -> AppResult<()> {
    if let Some(board) = notes::delete(&*state.db.conn()?, id)? {
        changed(&app, &webview, &board);
    }
    Ok(())
}

#[tauri::command]
pub async fn notes_reorder(app: AppHandle, webview: Webview, state: State<'_, AppState>, board: String, ids: Vec<i64>) -> AppResult<()> {
    notes::reorder(&*state.db.conn()?, &board, &ids)?;
    changed(&app, &webview, &notes::board_name(&board)?);
    Ok(())
}

#[tauri::command]
pub async fn notes_clear_done(app: AppHandle, webview: Webview, state: State<'_, AppState>, board: String) -> AppResult<usize> {
    let n = notes::clear_done(&*state.db.conn()?, &board)?;
    changed(&app, &webview, &notes::board_name(&board)?);
    Ok(n)
}
