//! NEURAL commands. Every chat request carries its own explicit attachment
//! list; the backend has no notion of "the AI reading files" otherwise.

use tauri::ipc::Channel;
use tauri::State;

use crate::dev::workspace;
use crate::error::{AppError, AppResult};
use crate::neural::context::{self, Attachment, ContextItem};
use crate::neural::gemini::{self, ChatMessage, ModelInfo, StreamEvent};
use crate::neural::history;
use crate::services::activity::{self, Level};
use crate::services::settings;
use crate::state::AppState;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeuralStatus {
    pub configured: bool,
    pub model: String,
}

fn model(state: &AppState) -> AppResult<String> {
    Ok(settings::get(&*state.db.conn()?, gemini::MODEL_KEY)?
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| gemini::DEFAULT_MODEL.to_string()))
}

#[tauri::command]
pub async fn neural_status(state: State<'_, AppState>) -> AppResult<NeuralStatus> {
    Ok(NeuralStatus { configured: gemini::key()?.is_some(), model: model(&state)? })
}

/// Validates the key with a model listing before storing it.
#[tauri::command]
pub async fn neural_connect(state: State<'_, AppState>, key: String) -> AppResult<Vec<ModelInfo>> {
    let key = key.trim().to_string();
    if key.len() < 20 || key.chars().any(char::is_whitespace) {
        return Err(AppError::Invalid("that does not look like an API key".into()));
    }
    let models = gemini::list_models_with(&key).await?;
    gemini::store_key(&key)?;
    activity::record(&*state.db.conn()?, Level::Info, "neural", "Connected Gemini API key (stored in Credential Manager)");
    Ok(models)
}

#[tauri::command]
pub async fn neural_disconnect(state: State<'_, AppState>) -> AppResult<()> {
    gemini::delete_key()?;
    activity::record(&*state.db.conn()?, Level::Info, "neural", "Removed Gemini API key");
    Ok(())
}

#[tauri::command]
pub async fn neural_models() -> AppResult<Vec<ModelInfo>> {
    gemini::list_models().await
}

/// What would be sent for these attachments (labels and sizes), without sending.
#[tauri::command]
pub async fn neural_preview(state: State<'_, AppState>, attachments: Vec<Attachment>) -> AppResult<Vec<ContextItem>> {
    let roots = workspace::roots(&*state.db.conn()?)?;
    tauri::async_runtime::spawn_blocking(move || context::build(&roots, &attachments).1)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn neural_chat(
    state: State<'_, AppState>,
    history: Vec<ChatMessage>,
    attachments: Vec<Attachment>,
    request_id: u64,
    on_event: Channel<StreamEvent>,
) -> AppResult<String> {
    if history.last().map(|m| m.role.as_str()) != Some("user") {
        return Err(AppError::Invalid("the last message must be from the user".into()));
    }
    let roots = workspace::roots(&*state.db.conn()?)?;
    let (ctx, items) = tauri::async_runtime::spawn_blocking(move || context::build(&roots, &attachments))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let sent: Vec<&str> = items.iter().filter(|i| i.error.is_none()).map(|i| i.label.as_str()).collect();
    if !sent.is_empty() {
        // Audit trail of exactly which local data left the machine.
        activity::record(&*state.db.conn()?, Level::Info, "neural", &format!("Sent to Gemini: {}", sent.join(", ")));
    }
    let model = model(&state)?;
    gemini::stream_chat(&model, gemini::request_body(&history, &ctx), request_id, on_event).await
}

#[tauri::command]
pub async fn neural_cancel(request_id: u64) {
    gemini::cancel(request_id);
}

// ---------- Chat history (local) ----------

pub const ACTIVE_CHAT_KEY: &str = "neural.active_chat";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatState {
    pub active_id: i64,
    pub chats: Vec<history::Chat>,
    pub messages: Vec<history::StoredMessage>,
}

/// Opens a chat (or the last active one, creating a chat if none exists).
#[tauri::command]
pub async fn neural_chat_open(state: State<'_, AppState>, id: Option<i64>) -> AppResult<ChatState> {
    let conn = state.db.conn()?;
    let stored = settings::get(&conn, ACTIVE_CHAT_KEY)?.and_then(|v| v.as_i64());
    let mut active = id.or(stored).unwrap_or(0);
    if active == 0 || !history::exists(&conn, active)? {
        active = match history::list(&conn)?.first() {
            Some(c) if id.is_none() => c.id,
            _ => history::create(&conn)?,
        };
    }
    settings::set(&conn, ACTIVE_CHAT_KEY, &serde_json::json!(active))?;
    Ok(ChatState { active_id: active, chats: history::list(&conn)?, messages: history::messages(&conn, active)? })
}

#[tauri::command]
pub async fn neural_chat_new(state: State<'_, AppState>) -> AppResult<ChatState> {
    let conn = state.db.conn()?;
    // Reuse an existing empty chat instead of piling up blank ones.
    let id = match history::list(&conn)?.into_iter().find(|c| c.message_count == 0) {
        Some(c) => c.id,
        None => history::create(&conn)?,
    };
    settings::set(&conn, ACTIVE_CHAT_KEY, &serde_json::json!(id))?;
    Ok(ChatState { active_id: id, chats: history::list(&conn)?, messages: Vec::new() })
}

#[tauri::command]
pub async fn neural_chat_delete(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    history::delete(&*state.db.conn()?, id)
}

#[tauri::command]
pub async fn neural_chat_rename(state: State<'_, AppState>, id: i64, title: String) -> AppResult<()> {
    history::rename(&*state.db.conn()?, id, &title)
}

#[tauri::command]
pub async fn neural_chat_append(state: State<'_, AppState>, chat_id: i64, message: history::NewMessage) -> AppResult<i64> {
    history::append(&*state.db.conn()?, chat_id, &message)
}