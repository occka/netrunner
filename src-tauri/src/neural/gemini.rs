//! Google Gemini API (AI Studio) client. The API key is stored only in
//! Windows Credential Manager and sent only in the `x-goog-api-key` header
//! (never in URLs, which can end up in logs).

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::error::{AppError, AppResult};

const SERVICE: &str = "NETRUNNER";
const ACCOUNT: &str = "gemini-api-key";
const API: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const MODEL_KEY: &str = "neural.model";
pub const DEFAULT_MODEL: &str = "gemini-3-flash-preview";

const SYSTEM_PROMPT: &str = "You are NEURAL, the assistant inside NETRUNNER, a Windows desktop control environment. \
You help with code, projects, files and Windows tasks. You cannot access the user's computer: you only see the context \
the user explicitly attached below their message. If you need another file, ask the user to attach it. \
When asked to change a file, reply with the COMPLETE updated file in a single fenced code block so it can be reviewed \
as a diff; never claim you changed, saved, ran or pushed anything yourself. Be concise and precise.";

fn entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| AppError::Internal(format!("credential store unavailable: {e}")))
}

pub fn key() -> AppResult<Option<String>> {
    match entry()?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Internal(format!("cannot read credential: {e}"))),
    }
}

pub fn store_key(key: &str) -> AppResult<()> {
    entry()?.set_password(key).map_err(|e| AppError::Internal(format!("cannot store credential: {e}")))
}

pub fn delete_key() -> AppResult<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Internal(format!("cannot delete credential: {e}"))),
    }
}

fn require_key() -> AppResult<String> {
    key()?.ok_or_else(|| AppError::Invalid("no Gemini API key configured (NEURAL → Connect)".into()))
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("NETRUNNER/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))
}

fn api_error(status: reqwest::StatusCode, body: &str) -> AppError {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| status.to_string());
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN || msg.contains("API key") {
        AppError::Invalid(format!("Gemini rejected the API key: {msg}"))
    } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        AppError::Launch(format!("Gemini rate limit / quota reached: {msg}"))
    } else {
        AppError::Launch(format!("Gemini: {msg}"))
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    pub input_token_limit: Option<u64>,
}

/// Text-chat models only (TTS, image, audio, robotics models are excluded).
pub async fn list_models_with(key: &str) -> AppResult<Vec<ModelInfo>> {
    let resp = client()?
        .get(format!("{API}/models?pageSize=200"))
        .header("x-goog-api-key", key)
        .send()
        .await
        .map_err(|e| AppError::Launch(format!("cannot reach Gemini: {e}")))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(api_error(status, &body));
    }
    let v: Value = serde_json::from_str(&body)?;
    let skip = ["tts", "image", "lyria", "robotics", "computer-use", "transcribe", "embedding", "banana", "aqa", "omni"];
    let mut models: Vec<ModelInfo> = v["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m["supportedGenerationMethods"].as_array().is_some_and(|a| a.iter().any(|x| x == "generateContent")))
        .filter_map(|m| {
            let id = m["name"].as_str()?.strip_prefix("models/")?.to_string();
            (!skip.iter().any(|s| id.contains(s))).then(|| ModelInfo {
                display_name: m["displayName"].as_str().unwrap_or(&id).to_string(),
                input_token_limit: m["inputTokenLimit"].as_u64(),
                id,
            })
        })
        .collect();
    models.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(models)
}

pub async fn list_models() -> AppResult<Vec<ModelInfo>> {
    list_models_with(&require_key()?).await
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// "user" or "model"
    pub role: String,
    pub text: String,
}

/// Tried in order when the selected model is overloaded (503) or retired (404).
const FALLBACK_MODELS: &[&str] = &["gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-flash-latest"];

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    /// Progress shown while waiting for a model to respond.
    Status { text: String },
    /// Which model is answering (differs from the selected one after a fallback).
    Model { model: String, fallback: bool },
    Delta { text: String },
    Done { prompt_tokens: Option<u64>, output_tokens: Option<u64>, finish_reason: Option<String> },
}

fn cancelled() -> &'static Mutex<HashSet<u64>> {
    static C: std::sync::OnceLock<Mutex<HashSet<u64>>> = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}

pub fn cancel(request_id: u64) {
    if let Ok(mut c) = cancelled().lock() {
        c.insert(request_id);
    }
}

fn is_cancelled(request_id: u64) -> bool {
    cancelled().lock().map(|c| c.contains(&request_id)).unwrap_or(false)
}

/// Builds the request body. Context is appended to the LAST user message only,
/// so earlier turns are not re-sent with stale attachments.
pub fn request_body(history: &[ChatMessage], context: &str) -> Value {
    let last_user = history.iter().rposition(|m| m.role == "user");
    let contents: Vec<Value> = history
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let role = if m.role == "model" { "model" } else { "user" };
            let text = if Some(i) == last_user && !context.is_empty() {
                format!("{}\n\n---\nAttached context (selected by the user):\n\n{context}", m.text)
            } else {
                m.text.clone()
            };
            json!({ "role": role, "parts": [{ "text": text }] })
        })
        .collect();
    json!({
        "systemInstruction": { "parts": [{ "text": SYSTEM_PROMPT }] },
        "contents": contents,
        "generationConfig": { "temperature": 0.4 }
    })
}

/// No response headers within this time: the model is treated as unavailable.
const FIRST_RESPONSE_TIMEOUT: Duration = Duration::from_secs(20);
/// No new data within this time while streaming: the stream is considered dead.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

enum Wait<T> {
    Done(T),
    TimedOut,
    Cancelled,
}

/// Awaits `fut` while honouring cancellation (checked every 200 ms) and a timeout.
async fn wait_for<F: std::future::Future>(fut: F, request_id: u64, timeout: Duration) -> Wait<F::Output> {
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(fut, deadline);
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    loop {
        tokio::select! {
            out = &mut fut => return Wait::Done(out),
            _ = &mut deadline => return Wait::TimedOut,
            _ = tick.tick() => if is_cancelled(request_id) { return Wait::Cancelled },
        }
    }
}

struct StreamState {
    full: String,
    prompt_tokens: Option<u64>,
    output_tokens: Option<u64>,
    finish_reason: Option<String>,
}

/// Handles one SSE event (`data:` lines carrying JSON chunks).
fn handle_event(event: &str, st: &mut StreamState, channel: &Channel<StreamEvent>) -> AppResult<()> {
    for line in event.lines() {
        let Some(data) = line.strip_prefix("data:") else { continue };
        let Ok(v) = serde_json::from_str::<Value>(data.trim()) else { continue };
        if let Some(parts) = v.pointer("/candidates/0/content/parts").and_then(|p| p.as_array()) {
            // Skip "thought" parts some models emit; only answer text is shown.
            let text: String = parts
                .iter()
                .filter(|p| !p["thought"].as_bool().unwrap_or(false))
                .filter_map(|p| p["text"].as_str())
                .collect();
            if !text.is_empty() {
                st.full.push_str(&text);
                let _ = channel.send(StreamEvent::Delta { text });
            }
        }
        if let Some(r) = v.pointer("/candidates/0/finishReason").and_then(|r| r.as_str()) {
            st.finish_reason = Some(r.to_string());
        }
        if let Some(u) = v.get("usageMetadata") {
            st.prompt_tokens = u["promptTokenCount"].as_u64().or(st.prompt_tokens);
            st.output_tokens = u["candidatesTokenCount"].as_u64().or(st.output_tokens);
        }
        if let Some(block) = v.pointer("/promptFeedback/blockReason").and_then(|b| b.as_str()) {
            return Err(AppError::Invalid(format!("Gemini blocked the request ({block})")));
        }
    }
    Ok(())
}

fn finish(request_id: u64, mut st: StreamState, channel: &Channel<StreamEvent>) -> String {
    if let Ok(mut c) = cancelled().lock() {
        if c.remove(&request_id) {
            st.finish_reason = Some("CANCELLED".into());
        }
    }
    let _ = channel.send(StreamEvent::Done { prompt_tokens: st.prompt_tokens, output_tokens: st.output_tokens, finish_reason: st.finish_reason });
    st.full
}

/// Streams a reply over `channel`; returns the full text.
///
/// Models are tried in order (selected, then fallbacks). A model that answers
/// 503/404 or sends nothing within `FIRST_RESPONSE_TIMEOUT` is skipped; Google
/// sometimes holds requests to overloaded models open without responding.
pub async fn stream_chat(model: &str, body: Value, request_id: u64, channel: Channel<StreamEvent>) -> AppResult<String> {
    if !model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_')) {
        return Err(AppError::Invalid("invalid model id".into()));
    }
    let key = require_key()?;
    let candidates: Vec<&str> = std::iter::once(model).chain(FALLBACK_MODELS.iter().copied().filter(|m| *m != model)).collect();
    let empty = || StreamState { full: String::new(), prompt_tokens: None, output_tokens: None, finish_reason: None };
    let mut last_error = None;
    let mut response = None;
    for (i, candidate) in candidates.iter().enumerate() {
        let _ = channel.send(StreamEvent::Status {
            text: if i == 0 { format!("Waiting for {candidate}…") } else { format!("Trying {candidate}…") },
        });
        let request = client()?
            .post(format!("{API}/models/{candidate}:streamGenerateContent?alt=sse"))
            .header("x-goog-api-key", &key)
            .json(&body)
            .send();
        let resp = match wait_for(request, request_id, FIRST_RESPONSE_TIMEOUT).await {
            Wait::Done(r) => r.map_err(|e| AppError::Launch(format!("cannot reach Gemini: {e}")))?,
            Wait::Cancelled => return Ok(finish(request_id, empty(), &channel)),
            Wait::TimedOut => {
                log::warn!("Gemini model {candidate} sent no response within {}s; trying fallback", FIRST_RESPONSE_TIMEOUT.as_secs());
                last_error = Some(AppError::Launch(format!("{candidate} did not respond (overloaded)")));
                continue;
            }
        };
        let status = resp.status();
        if status.is_success() {
            let _ = channel.send(StreamEvent::Model { model: candidate.to_string(), fallback: i > 0 });
            response = Some(resp);
            break;
        }
        let text = resp.text().await.unwrap_or_default();
        // Overloaded or retired model: try the next one. Anything else is final.
        if status == reqwest::StatusCode::SERVICE_UNAVAILABLE || status == reqwest::StatusCode::NOT_FOUND {
            log::warn!("Gemini model {candidate} unavailable ({status}); trying fallback");
            last_error = Some(api_error(status, &text));
            continue;
        }
        return Err(api_error(status, &text));
    }
    let Some(resp) = response else {
        return Err(last_error.unwrap_or_else(|| AppError::Launch("no Gemini model is available right now".into())));
    };

    let mut st = empty();
    let mut buffer = String::new();
    let mut stream = resp.bytes_stream();
    loop {
        let chunk = match wait_for(stream.next(), request_id, IDLE_TIMEOUT).await {
            Wait::Done(Some(chunk)) => chunk.map_err(|e| AppError::Launch(format!("stream interrupted: {e}")))?,
            Wait::Done(None) | Wait::Cancelled => break,
            Wait::TimedOut => return Err(AppError::Launch(format!("Gemini stopped sending data for {}s", IDLE_TIMEOUT.as_secs()))),
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        // SSE events are separated by a blank line (LF or CRLF).
        while let Some(pos) = buffer.find("\n\n").or_else(|| buffer.find("\r\n\r\n")) {
            let event: String = buffer.drain(..pos).collect();
            buffer = buffer.trim_start_matches(['\r', '\n']).to_string();
            handle_event(&event, &mut st, &channel)?;
        }
    }
    // The last event may not be followed by a blank line.
    if !buffer.trim().is_empty() {
        handle_event(&buffer, &mut st, &channel)?;
    }
    Ok(finish(request_id, st, &channel))
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_goes_on_last_user_turn_only() {
        let history = vec![
            ChatMessage { role: "user".into(), text: "hi".into() },
            ChatMessage { role: "model".into(), text: "hello".into() },
            ChatMessage { role: "user".into(), text: "explain".into() },
        ];
        let body = request_body(&history, "### File: a.py");
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[0]["parts"][0]["text"], "hi");
        assert_eq!(contents[1]["role"], "model");
        assert!(contents[2]["parts"][0]["text"].as_str().unwrap().contains("### File: a.py"));
        assert!(body["systemInstruction"]["parts"][0]["text"].as_str().unwrap().contains("cannot access"));
    }
}
