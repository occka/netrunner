//! NEURAL commands. Every chat request carries its own explicit attachment list.
//! Beyond that, the agent reaches only the folder of its own chat (`neural/folder.rs`).

use tauri::ipc::Channel;
use tauri::State;

use crate::dev::workspace;
use crate::error::{AppError, AppResult};
use crate::neural::context::{self, Attachment, ContextItem};
use crate::neural::folder::{ChatFolder, FileInfo};
use crate::neural::gemini::{self, Agent, ChatMessage, ModelInfo, StreamEvent};
use crate::neural::prompts::{self, History};
use crate::neural::{history, tools};
use crate::services::activity::{self, Level};
use crate::services::settings;
use crate::state::AppState;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeuralStatus {
    pub configured: bool,
    pub model: String,
    pub play_model: String,
}

/// About 60 000 tokens. The free tier allows 250 000 tokens a minute and a message
/// can take several requests, so a longer history would hit that limit in play.
const HISTORY_BUDGET: usize = 180_000;

fn model(state: &AppState) -> AppResult<String> {
    Ok(settings::get(&*state.db.conn()?, gemini::MODEL_KEY)?
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| gemini::DEFAULT_MODEL.to_string()))
}

fn play_model(state: &AppState) -> AppResult<String> {
    Ok(settings::get(&*state.db.conn()?, gemini::PLAY_MODEL_KEY)?
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| gemini::DEFAULT_PLAY_MODEL.to_string()))
}

fn folder(state: &AppState, chat_id: i64) -> ChatFolder {
    ChatFolder::new(&state.data_dir, chat_id)
}

#[tauri::command]
pub async fn neural_status(state: State<'_, AppState>) -> AppResult<NeuralStatus> {
    Ok(NeuralStatus { configured: gemini::key()?.is_some(), model: model(&state)?, play_model: play_model(&state)? })
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

/// Answers one message. `agent` is false outside the NEURAL tab (DEVELOPER's
/// panel): then the chat's mode is ignored and no tools are offered.
#[tauri::command]
pub async fn neural_chat(
    state: State<'_, AppState>,
    chat_id: i64,
    agent: bool,
    history: Vec<ChatMessage>,
    attachments: Vec<Attachment>,
    request_id: u64,
    on_event: Channel<StreamEvent>,
) -> AppResult<String> {
    if history.last().map(|m| m.role.as_str()) != Some("user") {
        return Err(AppError::Invalid("the last message must be from the user".into()));
    }
    let play = agent && history::mode(&*state.db.conn()?, chat_id)? == "play";
    let chat_folder = folder(&state, chat_id);

    let kept_images: Vec<String> = attachments
        .iter()
        .filter_map(|a| match a {
            Attachment::Image { name, .. } => chat_folder.read_image(name).ok(),
            _ => None,
        })
        .collect();
    let roots = workspace::roots(&*state.db.conn()?)?;
    let (ctx, items) = tauri::async_runtime::spawn_blocking(move || context::build(&roots, &attachments))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let (recent, dropped, near_limit) = gemini::trim_history(&history, HISTORY_BUDGET);
    if dropped > 0 {
        let _ = on_event.send(StreamEvent::Context { dropped });
    }
    let photos = recent.iter().map(|m| m.images.len()).sum::<usize>();
    let mut sent: Vec<String> = items.iter().filter(|i| i.error.is_none() && i.label != "Photo").map(|i| i.label.clone()).collect();
    if photos + kept_images.len() > 0 {
        sent.push(format!("{} photo(s)", photos + kept_images.len()));
    }
    if agent && !chat_folder.list().is_empty() {
        sent.push("files of the chat folder".into());
    }
    if !sent.is_empty() {
        // Audit trail of exactly which local data left the machine.
        activity::record(&*state.db.conn()?, Level::Info, "neural", &format!("Sent to Gemini: {}", sent.join(", ")));
    }

    let contents = gemini::contents(recent, &ctx, &kept_images, &|name| chat_folder.read_image(name).ok());
    let selected = if play { play_model(&state)? } else { model(&state)? };
    let history_state = match (dropped > 0, near_limit) {
        (true, _) => History::Trimmed,
        (_, true) => History::NearLimit,
        _ => History::Full,
    };
    let system = || if agent { prompts::agent(play, &chat_folder, history_state) } else { prompts::PLAIN.to_string() };
    let config = Agent { model: &selected, temperature: prompts::temperature(play), system: &system, tools: agent.then_some(play) };
    let db = &state.db;
    gemini::run(config, contents, request_id, on_event, |name, args| {
        let (result, action) = tools::execute(&chat_folder, name, args, play);
        if let Some(a) = action.as_ref().filter(|a| a.change.is_some()) {
            if let Ok(conn) = db.conn() {
                activity::record(&conn, Level::Info, "neural", &format!("Chat {chat_id}: the agent changed {} in its folder", a.label));
            }
        }
        (result, action)
    })
    .await
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
    pub mode: String,
    pub kept: Vec<Attachment>,
}

/// A change can be undone only while its copy still exists.
fn with_undo_state(state: &AppState, chat_id: i64, mut messages: Vec<history::StoredMessage>) -> Vec<history::StoredMessage> {
    let chat_folder = folder(state, chat_id);
    for action in messages.iter_mut().flat_map(|m| m.actions.iter_mut()) {
        action.change = action.change.filter(|id| chat_folder.can_undo(*id));
    }
    messages
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
    let messages = with_undo_state(&state, active, history::messages(&conn, active)?);
    Ok(ChatState { active_id: active, chats: history::list(&conn)?, messages, mode: history::mode(&conn, active)?, kept: history::kept(&conn, active)? })
}

#[tauri::command]
pub async fn neural_chat_new(state: State<'_, AppState>) -> AppResult<ChatState> {
    let conn = state.db.conn()?;
    // Reuse an existing empty chat instead of piling up blank ones.
    let id = match history::list(&conn)?.into_iter().find(|c| c.message_count == 0) {
        Some(c) => c.id,
        None => history::create(&conn)?,
    };
    history::set_mode(&conn, id, "work")?;
    history::set_kept(&conn, id, &[])?;
    settings::set(&conn, ACTIVE_CHAT_KEY, &serde_json::json!(id))?;
    Ok(ChatState { active_id: id, chats: history::list(&conn)?, messages: Vec::new(), mode: "work".into(), kept: Vec::new() })
}

#[tauri::command]
pub async fn neural_chat_delete(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    folder(&state, id).remove()?;
    history::delete(&*state.db.conn()?, id)
}

#[tauri::command]
pub async fn neural_chat_set_mode(state: State<'_, AppState>, id: i64, mode: String) -> AppResult<()> {
    history::set_mode(&*state.db.conn()?, id, &mode)
}

#[tauri::command]
pub async fn neural_chat_set_kept(state: State<'_, AppState>, id: i64, kept: Vec<Attachment>) -> AppResult<()> {
    history::set_kept(&*state.db.conn()?, id, &kept)
}

// ---------- The chat's folder ----------

#[tauri::command]
pub async fn neural_files(state: State<'_, AppState>, chat_id: i64) -> AppResult<Vec<FileInfo>> {
    Ok(folder(&state, chat_id).list())
}

#[tauri::command]
pub async fn neural_file_read(state: State<'_, AppState>, chat_id: i64, path: String) -> AppResult<String> {
    folder(&state, chat_id).read(&path)
}

/// Undoes one of the agent's changes. Returns the file's path.
#[tauri::command]
pub async fn neural_undo(state: State<'_, AppState>, chat_id: i64, change: u64) -> AppResult<String> {
    let path = folder(&state, chat_id).undo(change)?;
    activity::record(&*state.db.conn()?, Level::Info, "neural", &format!("Chat {chat_id}: undid the agent's change to {path}"));
    Ok(path)
}

#[tauri::command]
pub async fn neural_open_folder(state: State<'_, AppState>, chat_id: i64) -> AppResult<()> {
    let chat_folder = folder(&state, chat_id);
    std::fs::create_dir_all(chat_folder.root())?;
    std::process::Command::new("explorer.exe").arg(chat_folder.root()).spawn().map_err(|e| AppError::Launch(e.to_string()))?;
    Ok(())
}

/// Stores a photo the UI has already re-encoded as JPEG. Returns its name.
#[tauri::command]
pub async fn neural_image_save(state: State<'_, AppState>, chat_id: i64, data: String) -> AppResult<String> {
    folder(&state, chat_id).save_image(&data)
}

/// A stored photo as a data URL, for showing it in the chat.
#[tauri::command]
pub async fn neural_image_read(state: State<'_, AppState>, chat_id: i64, name: String) -> AppResult<String> {
    Ok(format!("data:image/jpeg;base64,{}", folder(&state, chat_id).read_image(&name)?))
}

/// A file dropped on the chat, as a data URL for the UI to re-encode. Reads only
/// image files the user just dropped; nothing is sent to the model here.
#[tauri::command]
pub async fn neural_image_from_path(path: String) -> AppResult<String> {
    let lower = path.to_lowercase();
    let mime = [("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("webp", "image/webp"), ("gif", "image/gif"), ("bmp", "image/bmp")]
        .iter()
        .find(|(ext, _)| lower.ends_with(&format!(".{ext}")))
        .map(|(_, mime)| *mime)
        .ok_or_else(|| AppError::Invalid("not a supported image type".into()))?;
    if std::fs::metadata(&path)?.len() > 40 * 1024 * 1024 {
        return Err(AppError::Invalid("image is too large".into()));
    }
    use base64::Engine;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(std::fs::read(&path)?)))
}

#[tauri::command]
pub async fn neural_chat_rename(state: State<'_, AppState>, id: i64, title: String) -> AppResult<()> {
    history::rename(&*state.db.conn()?, id, &title)
}

#[tauri::command]
pub async fn neural_chat_append(state: State<'_, AppState>, chat_id: i64, message: history::NewMessage) -> AppResult<i64> {
    history::append(&*state.db.conn()?, chat_id, &message)
}