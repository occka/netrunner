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

use super::tools::{self, Action};
use crate::error::{AppError, AppResult};

const SERVICE: &str = "NETRUNNER";
const ACCOUNT: &str = "gemini-api-key";
const API: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const MODEL_KEY: &str = "neural.model";
pub const DEFAULT_MODEL: &str = "gemini-3-flash-preview";
pub const PLAY_MODEL_KEY: &str = "neural.model_play";
/// Play is many short requests: Flash Lite has by far the larger free quota.
pub const DEFAULT_PLAY_MODEL: &str = "gemini-3.5-flash-lite";

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
    /// Names of photos in the chat's folder.
    #[serde(default)]
    pub images: Vec<String>,
}

/// Tried in order when the selected model is overloaded, retired or out of its
/// daily quota. Flash Lite comes first: its free quota is far larger than Flash's.
const FALLBACK_MODELS: &[&str] = &["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-flash-latest"];

/// Tool rounds for one user message; each one is a request against the quota.
const MAX_STEPS: usize = 8;
const REPLY_NOW: &str = "(NETRUNNER: your tools have finished and the user has seen no reply yet. Answer them now, in their language.)";
/// A photo stays visible to the model for this many messages.
const IMAGE_WINDOW: usize = 6;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    /// Progress shown while waiting for a model to respond.
    Status { text: String },
    /// Which model is answering (differs from the selected one after a fallback).
    Model { model: String, fallback: bool },
    Delta { text: String },
    /// Something the agent did.
    Action { action: Action },
    /// Older messages of a long chat were left out of this request.
    Context { dropped: usize },
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

fn image_part(data: &str) -> Value {
    json!({ "inlineData": { "mimeType": "image/jpeg", "data": data } })
}

/// Builds the conversation. Context and kept photos go on the LAST user message
/// only, so earlier turns are not re-sent with stale attachments. A photo sent
/// with a message stays for the next few messages. `image` returns its base64.
pub fn contents(history: &[ChatMessage], context: &str, kept_images: &[String], image: &dyn Fn(&str) -> Option<String>) -> Vec<Value> {
    let last_user = history.iter().rposition(|m| m.role == "user");
    let window_start = history.len().saturating_sub(IMAGE_WINDOW);
    history
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let role = if m.role == "model" { "model" } else { "user" };
            let text = if Some(i) == last_user && !context.is_empty() {
                format!("{}\n\n---\nAttached context (selected by the user):\n\n{context}", m.text)
            } else {
                m.text.clone()
            };
            let mut parts = vec![json!({ "text": text })];
            if i >= window_start {
                parts.extend(m.images.iter().filter_map(|name| image(name)).map(|data| image_part(&data)));
            }
            if Some(i) == last_user {
                parts.extend(kept_images.iter().map(|data| image_part(data)));
            }
            json!({ "role": role, "parts": parts })
        })
        .collect()
}

/// Newest messages that fit `budget` characters, starting on a user message.
/// Returns how many were left out and whether the rest is close to the limit.
pub fn trim_history(history: &[ChatMessage], budget: usize) -> (&[ChatMessage], usize, bool) {
    let mut used = 0;
    let mut start = history.len();
    while start > 0 && (start == history.len() || used + history[start - 1].text.len() <= budget) {
        used += history[start - 1].text.len();
        start -= 1;
    }
    if start > 0 {
        while start < history.len() - 1 && history[start].role != "user" {
            start += 1;
        }
    }
    (&history[start..], start, start == 0 && used * 5 >= budget * 4)
}

/// Flash and newer can call functions and run code in one request; Gemma cannot.
fn supports_tools(model: &str) -> bool {
    !model.starts_with("gemma")
}

fn supports_code_execution(model: &str) -> bool {
    ["gemini-3", "gemini-4", "gemini-flash"].iter().any(|p| model.starts_with(p))
}

/// The instructions and tools of a conversation.
pub struct Agent<'a> {
    pub model: &'a str,
    pub temperature: f32,
    /// Rebuilt for every request, so the model sees its files as they are now.
    pub system: &'a (dyn Fn() -> String + Sync),
    /// `None`: a plain chat, no tools. `Some(play)`: an agent, with dice in Play.
    pub tools: Option<bool>,
}

fn request_body(agent: &Agent, model: &str, contents: &[Value]) -> Value {
    let mut body = json!({
        "systemInstruction": { "parts": [{ "text": (agent.system)() }] },
        "contents": contents,
        "generationConfig": { "temperature": agent.temperature }
    });
    if let Some(play) = agent.tools {
        if supports_tools(model) {
            // Not in Play: Flash Lite took to running code just to think, and then
            // often stopped without a reply. Dice and files cover what a game needs.
            let code = !play && supports_code_execution(model);
            body["tools"] = tools::declarations(play, code);
            if code {
                // Gemini refuses hosted code execution next to functions without this.
                body["toolConfig"] = json!({ "includeServerSideToolInvocations": true });
            }
        }
    }
    body
}

/// No response headers within this time: the model is treated as unavailable.
const FIRST_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// No new data within this time while streaming: the stream is considered dead.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// The same for a request in the middle of a tool round: the model cannot change
/// by then, and a slow answer is better than losing the round.
const NEXT_STEP_TIMEOUT: Duration = Duration::from_secs(90);
/// Waits for an overloaded model in the middle of a tool round.
const BUSY_RETRIES: u32 = 3;
/// A rate limit is waited out only if it clears this soon.
const MAX_RATE_WAIT: u64 = 65;

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

#[derive(Default)]
struct StreamState {
    full: String,
    /// Every part as received: signatures must go back exactly as they came.
    parts: Vec<Value>,
    code: Option<String>,
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
            for part in parts {
                // Skip "thought" parts some models emit; only answer text is shown.
                if !part["thought"].as_bool().unwrap_or(false) {
                    if let Some(text) = part["text"].as_str().filter(|t| !t.is_empty()) {
                        st.full.push_str(text);
                        let _ = channel.send(StreamEvent::Delta { text: text.to_string() });
                    }
                }
                if let Some(code) = part.pointer("/executableCode/code").and_then(|c| c.as_str()) {
                    st.code = Some(code.to_string());
                }
                if let Some(result) = part.get("codeExecutionResult") {
                    let output = result["output"].as_str().unwrap_or("");
                    let failed = result["outcome"].as_str().is_some_and(|o| o != "OUTCOME_OK");
                    let action = Action {
                        kind: "python".into(),
                        label: "Python, run by Google".into(),
                        detail: Some(format!("{}\n\n{output}", st.code.take().unwrap_or_default())),
                        error: failed.then(|| "the code failed".to_string()),
                        ..Action::default()
                    };
                    let _ = channel.send(StreamEvent::Action { action });
                }
                let blank = part["text"].as_str().is_some_and(str::is_empty) && part.get("thoughtSignature").is_none();
                if !blank {
                    st.parts.push(part.clone());
                }
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

#[derive(Debug, PartialEq)]
enum RateLimit {
    /// A per-minute limit that clears soon.
    Wait(u64),
    /// A daily quota, or no hint: another model may still have quota.
    NextModel,
}

/// Reads Google's quota details from a 429 response.
fn rate_limit(body: &str) -> RateLimit {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return RateLimit::NextModel };
    let details = v.pointer("/error/details").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let daily = details.iter().any(|d| d["violations"].as_array().is_some_and(|list| list.iter().any(|q| q["quotaId"].as_str().is_some_and(|id| id.contains("PerDay")))));
    let delay = details.iter().find_map(|d| d["retryDelay"].as_str()).and_then(|s| s.trim_end_matches('s').parse::<f64>().ok());
    match delay {
        Some(seconds) if !daily && seconds <= MAX_RATE_WAIT as f64 => RateLimit::Wait(seconds.ceil() as u64 + 1),
        _ => RateLimit::NextModel,
    }
}

/// One request. Models are tried in order; a model that answers 503/404, is out
/// of quota or sends nothing within `FIRST_RESPONSE_TIMEOUT` is skipped: Google
/// sometimes holds requests to overloaded models open without responding.
/// Returns which model answered.
async fn stream_step(
    agent: &Agent<'_>,
    candidates: &[&str],
    contents: &[Value],
    key: &str,
    request_id: u64,
    channel: &Channel<StreamEvent>,
    first_step: bool,
) -> AppResult<(usize, StreamState)> {
    let mut last_error = None;
    let mut response = None;
    'models: for (i, candidate) in candidates.iter().enumerate() {
        let mut rate_waits = 0;
        let mut busy_retries = 0;
        loop {
            if first_step {
                let _ = channel.send(StreamEvent::Status { text: if i == 0 { format!("Waiting for {candidate}…") } else { format!("Trying {candidate}…") } });
            }
            let body = request_body(agent, candidate, contents);
            let request = client()?.post(format!("{API}/models/{candidate}:streamGenerateContent?alt=sse")).header("x-goog-api-key", key).json(&body).send();
            let timeout = if first_step { FIRST_RESPONSE_TIMEOUT } else { NEXT_STEP_TIMEOUT };
            let resp = match wait_for(request, request_id, timeout).await {
                Wait::Done(r) => r.map_err(|e| AppError::Launch(format!("cannot reach Gemini: {e}")))?,
                Wait::Cancelled => return Ok((i, StreamState::default())),
                Wait::TimedOut => {
                    log::warn!("Gemini model {candidate} sent no response within {}s; trying fallback", timeout.as_secs());
                    last_error = Some(AppError::Launch(format!("{candidate} did not respond (overloaded)")));
                    continue 'models;
                }
            };
            let status = resp.status();
            if status.is_success() {
                if first_step {
                    let _ = channel.send(StreamEvent::Model { model: candidate.to_string(), fallback: i > 0 });
                }
                response = Some((i, resp));
                break 'models;
            }
            let text = resp.text().await.unwrap_or_default();
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                if let (RateLimit::Wait(seconds), true) = (rate_limit(&text), rate_waits < 2) {
                    rate_waits += 1;
                    let _ = channel.send(StreamEvent::Status { text: format!("Rate limit of {candidate}: waiting {seconds} s…") });
                    if let Wait::Cancelled = wait_for(tokio::time::sleep(Duration::from_secs(seconds)), request_id, Duration::from_secs(seconds + 1)).await {
                        return Ok((i, StreamState::default()));
                    }
                    continue;
                }
                log::warn!("Gemini model {candidate} is out of quota; trying fallback");
                last_error = Some(api_error(status, &text));
                continue 'models;
            }
            if !first_step && status == reqwest::StatusCode::SERVICE_UNAVAILABLE && busy_retries < BUSY_RETRIES {
                busy_retries += 1;
                let _ = channel.send(StreamEvent::Status { text: format!("{candidate} is busy, retrying…") });
                let pause = Duration::from_secs(u64::from(busy_retries) * 4);
                if let Wait::Cancelled = wait_for(tokio::time::sleep(pause), request_id, pause + Duration::from_secs(1)).await {
                    return Ok((i, StreamState::default()));
                }
                continue;
            }
            // Overloaded or retired model: try the next one. Anything else is final.
            if status == reqwest::StatusCode::SERVICE_UNAVAILABLE || status == reqwest::StatusCode::NOT_FOUND {
                log::warn!("Gemini model {candidate} unavailable ({status}); trying fallback");
                last_error = Some(api_error(status, &text));
                continue 'models;
            }
            return Err(api_error(status, &text));
        }
    }
    let Some((index, resp)) = response else {
        return Err(last_error.unwrap_or_else(|| AppError::Launch("no Gemini model is available right now".into())));
    };

    let mut st = StreamState::default();
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
            handle_event(&event, &mut st, channel)?;
        }
    }
    // The last event may not be followed by a blank line.
    if !buffer.trim().is_empty() {
        handle_event(&buffer, &mut st, channel)?;
    }
    Ok((index, st))
}

fn function_calls(parts: &[Value]) -> Vec<Value> {
    parts.iter().filter_map(|p| p.get("functionCall").cloned()).collect()
}

/// Answers one user message, calling tools until the model has finished. Returns
/// the full text. `run_tool` is only called for agents, and only with a call the
/// model made; it decides what is allowed.
pub async fn run(
    agent: Agent<'_>,
    mut contents: Vec<Value>,
    request_id: u64,
    channel: Channel<StreamEvent>,
    run_tool: impl FnMut(&str, &Value) -> (Value, Option<Action>) + Send,
) -> AppResult<String> {
    let mut run_tool = run_tool;
    let model = agent.model;
    if !model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_')) {
        return Err(AppError::Invalid("invalid model id".into()));
    }
    let key = require_key()?;
    let all: Vec<&str> = std::iter::once(model).chain(FALLBACK_MODELS.iter().copied().filter(|m| *m != model)).collect();
    let mut candidates = all.as_slice();
    let mut full = String::new();
    let mut output_tokens = 0;
    let mut nudged = false;
    let mut last = StreamState::default();
    for step in 0..MAX_STEPS {
        if step > 0 {
            let _ = channel.send(StreamEvent::Status { text: "Working…".into() });
        }
        let (index, mut st) = stream_step(&agent, candidates, &contents, &key, request_id, &channel, step == 0).await?;
        // Thought signatures belong to the model that made them.
        candidates = std::slice::from_ref(&candidates[index]);
        full.push_str(&st.full);
        output_tokens += st.output_tokens.unwrap_or(0);
        let calls = function_calls(&st.parts);
        let parts = std::mem::take(&mut st.parts);
        last = st;
        if is_cancelled(request_id) || agent.tools.is_none() {
            break;
        }
        if calls.is_empty() {
            // Models sometimes stop after their tools without a word to the user.
            if full.trim().is_empty() && (step > 0 || !parts.is_empty()) && !nudged && step + 1 < MAX_STEPS {
                nudged = true;
                if !parts.is_empty() {
                    contents.push(json!({ "role": "model", "parts": parts }));
                }
                contents.push(json!({ "role": "user", "parts": [{ "text": REPLY_NOW }] }));
                continue;
            }
            break;
        }
        contents.push(json!({ "role": "model", "parts": parts }));
        let results: Vec<Value> = calls
            .iter()
            .map(|call| {
                let name = call["name"].as_str().unwrap_or("");
                let (response, action) = run_tool(name, &call["args"]);
                if let Some(action) = action {
                    let _ = channel.send(StreamEvent::Action { action });
                }
                let mut result = json!({ "name": name, "response": response });
                if let Some(id) = call.get("id") {
                    result["id"] = id.clone();
                }
                json!({ "functionResponse": result })
            })
            .collect();
        contents.push(json!({ "role": "user", "parts": results }));
        if step + 1 == MAX_STEPS {
            let note = format!("\n\n[Stopped after {MAX_STEPS} tool steps for one message. Say \"continue\" to go on.]");
            full.push_str(&note);
            let _ = channel.send(StreamEvent::Delta { text: note });
        }
    }
    if let Ok(mut c) = cancelled().lock() {
        if c.remove(&request_id) {
            last.finish_reason = Some("CANCELLED".into());
        }
    }
    let _ = channel.send(StreamEvent::Done { prompt_tokens: last.prompt_tokens, output_tokens: Some(output_tokens), finish_reason: last.finish_reason });
    Ok(full)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, text: &str) -> ChatMessage {
        ChatMessage { role: role.into(), text: text.into(), images: vec![] }
    }

    fn plain_agent<'a>(system: &'a (dyn Fn() -> String + Sync), tools: Option<bool>, model: &'static str) -> Agent<'a> {
        Agent { model, temperature: 0.4, system, tools }
    }

    #[test]
    fn context_goes_on_last_user_turn_only() {
        let history = vec![msg("user", "hi"), msg("model", "hello"), msg("user", "explain")];
        let c = contents(&history, "### File: a.py", &[], &|_| None);
        assert_eq!(c.len(), 3);
        assert_eq!(c[0]["parts"][0]["text"], "hi");
        assert_eq!(c[1]["role"], "model");
        assert!(c[2]["parts"][0]["text"].as_str().unwrap().contains("### File: a.py"));
    }

    #[test]
    fn photos_stay_for_a_few_messages_and_kept_ones_for_all() {
        let mut history = vec![ChatMessage { role: "user".into(), text: "look".into(), images: vec!["img-a.jpg".into()] }, msg("model", "ok")];
        let image = |name: &str| (name == "img-a.jpg").then(|| "AAAA".to_string());
        let c = contents(&history, "", &[], &image);
        assert_eq!(c[0]["parts"][1]["inlineData"]["data"], "AAAA");
        assert_eq!(c[0]["parts"][1]["inlineData"]["mimeType"], "image/jpeg");
        for _ in 0..3 {
            history.push(msg("user", "next"));
            history.push(msg("model", "ok"));
        }
        history.push(msg("user", "now"));
        let c = contents(&history, "", &["KEPT".to_string()], &image);
        assert_eq!(c[0]["parts"].as_array().unwrap().len(), 1, "the old photo is gone");
        let last = c.last().unwrap()["parts"].as_array().unwrap();
        assert_eq!(last[1]["inlineData"]["data"], "KEPT");
    }

    #[test]
    fn long_history_keeps_the_newest_messages() {
        let history = vec![msg("user", &"a".repeat(50)), msg("model", &"b".repeat(50)), msg("user", &"c".repeat(50)), msg("model", &"d".repeat(50)), msg("user", "new")];
        let (kept, dropped, near) = trim_history(&history, 1000);
        assert_eq!((kept.len(), dropped, near), (5, 0, false));
        let (_, dropped, near) = trim_history(&history, 240);
        assert_eq!((dropped, near), (0, true), "within the budget but close to it");
        let (kept, dropped, _) = trim_history(&history, 110);
        assert_eq!((kept.len(), dropped), (3, 2), "starts on a user message");
        assert_eq!(kept[0].role, "user");
        let (kept, dropped, _) = trim_history(&history, 1);
        assert_eq!((kept.len(), dropped), (1, 4), "the new message always goes");
    }

    #[test]
    fn body_declares_tools_only_for_agents_and_able_models() {
        let system = || "S".to_string();
        let plain = request_body(&plain_agent(&system, None, "gemini-3-flash-preview"), "gemini-3-flash-preview", &[]);
        assert!(plain.get("tools").is_none() && plain.get("toolConfig").is_none());
        assert_eq!(plain["systemInstruction"]["parts"][0]["text"], "S");

        let agent = plain_agent(&system, Some(true), "gemini-3.5-flash-lite");
        let body = request_body(&agent, "gemini-3.5-flash-lite", &[]);
        assert!(body.get("toolConfig").is_none() && !body["tools"].to_string().contains("codeExecution"), "no Python in Play");
        assert!(body["tools"].to_string().contains("roll_dice"));
        let work = plain_agent(&system, Some(false), "gemini-3.5-flash-lite");
        let body = request_body(&work, "gemini-3.5-flash-lite", &[]);
        assert_eq!(body["toolConfig"]["includeServerSideToolInvocations"], true);
        assert!(body["tools"].to_string().contains("codeExecution") && !body["tools"].to_string().contains("roll_dice"));
        let old = request_body(&work, "gemini-2.5-flash", &[]);
        assert!(old["tools"].to_string().contains("write_file") && !old["tools"].to_string().contains("codeExecution"));
        assert!(old.get("toolConfig").is_none());
        assert!(request_body(&work, "gemma-4-26b", &[]).get("tools").is_none());
    }

    #[test]
    fn reads_rate_limit_details() {
        let minute = r#"{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"23s"}]}}"#;
        assert_eq!(rate_limit(minute), RateLimit::Wait(24));
        let day = r#"{"error":{"code":429,"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},{"retryDelay":"23s"}]}}"#;
        assert_eq!(rate_limit(day), RateLimit::NextModel);
        assert_eq!(rate_limit(r#"{"error":{"details":[{"retryDelay":"3600s"}]}}"#), RateLimit::NextModel);
        assert_eq!(rate_limit("not json"), RateLimit::NextModel);
    }

    #[test]
    fn stream_events_use_the_field_names_the_ui_reads() {
        let done = serde_json::to_value(StreamEvent::Done { prompt_tokens: Some(1), output_tokens: Some(2), finish_reason: Some("SAFETY".into()) }).unwrap();
        assert_eq!(done, json!({ "type": "done", "promptTokens": 1, "outputTokens": 2, "finishReason": "SAFETY" }));
    }

    #[test]
    fn keeps_signatures_and_finds_function_calls() {
        // Captured from gemini-3.5-flash-lite: only the first parallel call has a signature.
        let chunk = r#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"roll_dice","args":{"notation":"1d20"},"id":"call_1"},"thoughtSignature":"SIG"},{"functionCall":{"name":"write_file","args":{"path":"a.md","content":"x"},"id":"call_2"}}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":125,"candidatesTokenCount":43}}"#;
        let channel = Channel::new(|_| Ok(()));
        let mut st = StreamState::default();
        handle_event(chunk, &mut st, &channel).unwrap();
        handle_event(r#"data: {"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"finishReason":"STOP"}]}"#, &mut st, &channel).unwrap();
        assert_eq!(st.parts.len(), 2, "the blank closing part is dropped");
        assert_eq!(st.parts[0]["thoughtSignature"], "SIG");
        assert_eq!(st.finish_reason.as_deref(), Some("STOP"));
        let calls = function_calls(&st.parts);
        assert_eq!(calls[1]["name"], "write_file");
        assert_eq!(calls[0]["id"], "call_1");
        assert_eq!(st.prompt_tokens, Some(125));
    }
}
