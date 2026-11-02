//! One running language server: a child process spoken to over stdio, with
//! request/response matching, timeouts and the documents opened in it.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use super::jsonrpc::{self, Frame, Framer, Kind};
use super::registry::Spec;
use crate::error::{AppError, AppResult};

pub const COMPLETION_TIMEOUT: Duration = Duration::from_secs(2);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// jdtls and rust-analyzer on a large workspace answer `initialize` slowly.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);

/// What the UI hears from servers.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LspEvent {
    #[serde(rename_all = "camelCase")]
    Status { server: String, spec: String, state: &'static str, message: Option<String> },
    #[serde(rename_all = "camelCase")]
    Diagnostics { server: String, uri: String, path: Option<String>, version: Option<i64>, diagnostics: Value },
    #[serde(rename_all = "camelCase")]
    Log { server: String, level: i64, message: String },
    #[serde(rename_all = "camelCase")]
    Progress { server: String, token: Value, value: Value },
    #[serde(rename_all = "camelCase")]
    ApplyEdit { server: String, label: Option<String>, edit: Value },
}

pub type Sink = Arc<dyn Fn(LspEvent) + Send + Sync>;

pub fn uri_for(path: &Path) -> String {
    let shown = crate::dev::workspace::display(path);
    url::Url::from_file_path(&shown).map(|u| u.to_string()).unwrap_or_else(|_| format!("file:///{}", shown.replace('\\', "/")))
}

pub fn path_for(uri: &str) -> Option<PathBuf> {
    url::Url::parse(uri).ok().filter(|u| u.scheme() == "file").and_then(|u| u.to_file_path().ok())
}

type Reply = Result<Value, AppError>;

/// The JSON-RPC connection: writes framed messages and routes replies to the
/// thread waiting for them.
pub struct Rpc {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<i64, Sender<Reply>>>,
    next_id: AtomicI64,
    alive: AtomicBool,
}

impl Rpc {
    /// Starts the reader thread. `on_request` answers the server's own
    /// requests; `on_exit` runs once when the stream ends.
    pub fn start(
        name: &str,
        mut reader: Box<dyn Read + Send>,
        writer: Box<dyn Write + Send>,
        on_notification: impl Fn(&str, Value) + Send + 'static,
        on_request: impl Fn(&str, Value) -> Result<Value, (i64, String)> + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> AppResult<Arc<Rpc>> {
        let rpc = Arc::new(Rpc { writer: Mutex::new(writer), pending: Mutex::default(), next_id: AtomicI64::new(1), alive: AtomicBool::new(true) });
        let me = Arc::clone(&rpc);
        std::thread::Builder::new()
            .name(format!("nr-lsp-{name}"))
            .spawn(move || {
                let mut framer = Framer::default();
                let mut buf = vec![0u8; 64 * 1024];
                'read: loop {
                    let n = match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    framer.push(&buf[..n]);
                    loop {
                        match framer.next() {
                            Ok(None) => break,
                            Ok(Some(Frame::Invalid(e))) => log::warn!("language server sent invalid JSON: {e}"),
                            Ok(Some(Frame::Message(msg))) => me.dispatch(msg, &on_notification, &on_request),
                            Err(e) => {
                                log::error!("language server stream is broken: {e}");
                                break 'read;
                            }
                        }
                    }
                }
                me.alive.store(false, Ordering::SeqCst);
                // Wake every waiting request instead of letting it time out.
                for (_, tx) in me.pending.lock().map(|mut p| p.drain().collect::<Vec<_>>()).unwrap_or_default() {
                    let _ = tx.send(Err(AppError::Launch("the language server stopped".into())));
                }
                on_exit();
            })
            .map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(rpc)
    }

    fn dispatch(
        &self,
        mut msg: Value,
        on_notification: &impl Fn(&str, Value),
        on_request: &impl Fn(&str, Value) -> Result<Value, (i64, String)>,
    ) {
        match jsonrpc::classify(&msg) {
            Kind::Response { id } => {
                let tx = self.pending.lock().ok().and_then(|mut p| p.remove(&id));
                if let Some(tx) = tx {
                    let reply = match msg.get_mut("error").map(Value::take) {
                        Some(err) => Err(AppError::Invalid(err.get("message").and_then(Value::as_str).unwrap_or("language server error").to_string())),
                        None => Ok(msg.get_mut("result").map(Value::take).unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(reply);
                }
            }
            Kind::Request { id, method } => {
                let params = msg.get_mut("params").map(Value::take).unwrap_or(Value::Null);
                let reply = match on_request(&method, params) {
                    Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                    Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
                };
                let _ = self.send(&reply);
            }
            Kind::Notification { method } => {
                let params = msg.get_mut("params").map(Value::take).unwrap_or(Value::Null);
                on_notification(&method, params);
            }
            Kind::Unknown => {}
        }
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn send(&self, msg: &Value) -> AppResult<()> {
        let mut w = self.writer.lock().map_err(|_| AppError::Internal("language server writer poisoned".into()))?;
        w.write_all(&jsonrpc::encode(msg))?;
        w.flush()?;
        Ok(())
    }

    pub fn notify(&self, method: &str, params: Value) -> AppResult<()> {
        if !self.alive() {
            return Err(AppError::Launch("the language server stopped".into()));
        }
        self.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }

    /// Sends a request and waits for its reply. On timeout the server is told
    /// to cancel (`$/cancelRequest`).
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> AppResult<Value> {
        if !self.alive() {
            return Err(AppError::Launch("the language server stopped".into()));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().map_err(|_| AppError::Internal("lsp lock poisoned".into()))?.insert(id, tx);
        if let Err(e) = self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})) {
            self.forget(id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(_) => {
                self.forget(id);
                let _ = self.notify("$/cancelRequest", json!({"id": id}));
                Err(AppError::Launch(format!("{method} timed out after {} ms", timeout.as_millis())))
            }
        }
    }

    fn forget(&self, id: i64) {
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&id);
        }
    }
}

#[derive(Debug, Clone)]
pub struct Doc {
    pub language_id: String,
    pub version: i64,
    pub text: String,
}

pub struct Server {
    pub key: String,
    pub spec: &'static Spec,
    pub root: PathBuf,
    pub capabilities: Value,
    rpc: Arc<Rpc>,
    child: Mutex<Option<Child>>,
    docs: Mutex<HashMap<String, Doc>>,
    last_used: Mutex<Instant>,
    stopping: Arc<AtomicBool>,
}

fn client_capabilities() -> Value {
    let kinds: Vec<i64> = (1..=25).collect();
    let symbols: Vec<i64> = (1..=26).collect();
    json!({
        "general": {"positionEncodings": ["utf-16"]},
        "workspace": {
            "applyEdit": true,
            "workspaceEdit": {"documentChanges": true, "resourceOperations": ["create", "rename", "delete"]},
            "configuration": true,
            "workspaceFolders": true,
            "symbol": {"symbolKind": {"valueSet": symbols}},
            "executeCommand": {},
            "didChangeConfiguration": {"dynamicRegistration": false}
        },
        "textDocument": {
            "synchronization": {"didSave": true, "willSave": false, "willSaveWaitUntil": false, "dynamicRegistration": false},
            "completion": {
                "contextSupport": true,
                "completionItem": {
                    "snippetSupport": true,
                    "documentationFormat": ["markdown", "plaintext"],
                    "resolveSupport": {"properties": ["documentation", "detail", "additionalTextEdits"]},
                    "insertReplaceSupport": true,
                    "labelDetailsSupport": true,
                    "deprecatedSupport": true,
                    "tagSupport": {"valueSet": [1]}
                },
                "completionItemKind": {"valueSet": kinds}
            },
            "hover": {"contentFormat": ["markdown", "plaintext"]},
            "signatureHelp": {
                "contextSupport": true,
                "signatureInformation": {
                    "documentationFormat": ["markdown", "plaintext"],
                    "parameterInformation": {"labelOffsetSupport": true},
                    "activeParameterSupport": true
                }
            },
            "definition": {"linkSupport": true},
            "typeDefinition": {"linkSupport": true},
            "implementation": {"linkSupport": true},
            "references": {},
            "documentHighlight": {},
            "documentSymbol": {"hierarchicalDocumentSymbolSupport": true, "symbolKind": {"valueSet": symbols}},
            "rename": {"prepareSupport": true},
            "formatting": {},
            "rangeFormatting": {},
            "codeAction": {
                "codeActionLiteralSupport": {"codeActionKind": {"valueSet": [
                    "", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite",
                    "source", "source.organizeImports", "source.fixAll"
                ]}},
                "isPreferredSupport": true,
                "dataSupport": true,
                "resolveSupport": {"properties": ["edit"]}
            },
            "publishDiagnostics": {"relatedInformation": true, "versionSupport": true, "tagSupport": {"valueSet": [1, 2]}},
            "semanticTokens": {
                "requests": {"full": true, "range": false},
                "tokenTypes": [
                    "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable",
                    "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment",
                    "string", "number", "regexp", "operator", "decorator"
                ],
                "tokenModifiers": [
                    "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async",
                    "modification", "documentation", "defaultLibrary"
                ],
                "formats": ["relative"],
                "multilineTokenSupport": false,
                "overlappingTokenSupport": false
            },
            "inlayHint": {},
            "foldingRange": {}
        },
        "window": {"workDoneProgress": true, "showMessage": {}}
    })
}

impl Server {
    /// Starts the executable and runs the `initialize` handshake.
    pub fn spawn(spec: &'static Spec, exe: &Path, root: &Path, key: String, sink: Sink) -> AppResult<Arc<Server>> {
        let mut cmd = crate::dev::process::command(&exe.to_string_lossy());
        // A plain folder path (no `\\?\` prefix), as terminals get: some tools break on it.
        cmd.args(spec.args).current_dir(crate::dev::workspace::display(root)).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| AppError::Launch(format!("cannot start {}: {e}", spec.server)))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        // Servers log to stderr; keep the tail for the error shown after a crash.
        let tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
        let tail_w = Arc::clone(&tail);
        let name = spec.id;
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut decoder = crate::dev::terminal::Utf8Stream::new();
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                for line in decoder.push(&buf[..n]).lines().filter(|l| !l.trim().is_empty()) {
                    log::debug!("[{name}] {line}");
                    if let Ok(mut t) = tail_w.lock() {
                        t.push_back(line.chars().take(300).collect());
                        if t.len() > 8 {
                            t.pop_front();
                        }
                    }
                }
            }
        });
        Self::connect(spec, root, key, Box::new(stdout), Box::new(stdin), Some(child), sink, tail)
    }

    /// Talks LSP over any byte streams (a child's stdio, or a fake server in tests).
    #[allow(clippy::too_many_arguments)]
    pub fn connect(
        spec: &'static Spec,
        root: &Path,
        key: String,
        reader: Box<dyn Read + Send>,
        writer: Box<dyn Write + Send>,
        child: Option<Child>,
        sink: Sink,
        stderr_tail: Arc<Mutex<VecDeque<String>>>,
    ) -> AppResult<Arc<Server>> {
        let root_uri = uri_for(root);
        let folder_name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let folders = json!([{"uri": root_uri, "name": folder_name}]);
        let stopping = Arc::new(AtomicBool::new(false));

        let (k1, s1) = (key.clone(), Arc::clone(&sink));
        let on_notification = move |method: &str, params: Value| match method {
            "textDocument/publishDiagnostics" => {
                let uri = params.get("uri").and_then(Value::as_str).unwrap_or_default().to_string();
                s1(LspEvent::Diagnostics {
                    server: k1.clone(),
                    path: path_for(&uri).map(|p| crate::dev::workspace::display(&p)),
                    uri,
                    version: params.get("version").and_then(Value::as_i64),
                    diagnostics: params.get("diagnostics").cloned().unwrap_or_else(|| json!([])),
                });
            }
            "window/logMessage" | "window/showMessage" => s1(LspEvent::Log {
                server: k1.clone(),
                level: params.get("type").and_then(Value::as_i64).unwrap_or(4),
                message: params.get("message").and_then(Value::as_str).unwrap_or_default().chars().take(2000).collect(),
            }),
            "$/progress" => s1(LspEvent::Progress {
                server: k1.clone(),
                token: params.get("token").cloned().unwrap_or(Value::Null),
                value: params.get("value").cloned().unwrap_or(Value::Null),
            }),
            _ => {}
        };
        let (k2, s2, f2) = (key.clone(), Arc::clone(&sink), folders.clone());
        let on_request = move |method: &str, params: Value| -> Result<Value, (i64, String)> {
            match method {
                // Defaults for every section the server asks about.
                "workspace/configuration" => {
                    let n = params.get("items").and_then(Value::as_array).map_or(0, Vec::len);
                    Ok(Value::Array(vec![Value::Null; n]))
                }
                "workspace/workspaceFolders" => Ok(f2.clone()),
                "window/workDoneProgress/create"
                | "client/registerCapability"
                | "client/unregisterCapability"
                | "workspace/semanticTokens/refresh"
                | "workspace/inlayHint/refresh"
                | "workspace/codeLens/refresh"
                | "workspace/diagnostic/refresh" => Ok(Value::Null),
                // The UI applies the edit to open tabs and files (inside open projects only).
                "workspace/applyEdit" => {
                    s2(LspEvent::ApplyEdit {
                        server: k2.clone(),
                        label: params.get("label").and_then(Value::as_str).map(str::to_string),
                        edit: params.get("edit").cloned().unwrap_or(Value::Null),
                    });
                    Ok(json!({"applied": true}))
                }
                "window/showMessageRequest" => {
                    s2(LspEvent::Log {
                        server: k2.clone(),
                        level: params.get("type").and_then(Value::as_i64).unwrap_or(3),
                        message: params.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
                    });
                    Ok(Value::Null)
                }
                "window/showDocument" => Ok(json!({"success": false})),
                other => Err((-32601, format!("{other} is not supported by NETRUNNER"))),
            }
        };
        let (k3, s3, stop3, tail3, spec_id) = (key.clone(), Arc::clone(&sink), Arc::clone(&stopping), Arc::clone(&stderr_tail), spec.id);
        let on_exit = move || {
            let intended = stop3.load(Ordering::SeqCst);
            let message = (!intended).then(|| {
                let tail = tail3.lock().map(|t| t.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default();
                if tail.is_empty() { "the language server exited".to_string() } else { tail }
            });
            s3(LspEvent::Status { server: k3, spec: spec_id.into(), state: if intended { "stopped" } else { "crashed" }, message });
        };

        let rpc = Rpc::start(spec.id, reader, writer, on_notification, on_request, on_exit)?;
        sink(LspEvent::Status { server: key.clone(), spec: spec.id.into(), state: "starting", message: None });
        let init = json!({
            "processId": std::process::id(),
            "clientInfo": {"name": "NETRUNNER", "version": env!("CARGO_PKG_VERSION")},
            "locale": "en",
            "rootPath": crate::dev::workspace::display(root),
            "rootUri": root_uri,
            "workspaceFolders": folders,
            "capabilities": client_capabilities(),
            "trace": "off"
        });
        let result = match rpc.request("initialize", init, INITIALIZE_TIMEOUT) {
            Ok(r) => r,
            Err(e) => {
                stopping.store(true, Ordering::SeqCst);
                if let Some(mut c) = child {
                    let _ = c.kill();
                }
                return Err(AppError::Launch(format!("{} did not start: {e}", spec.server)));
            }
        };
        rpc.notify("initialized", json!({}))?;
        let capabilities = result.get("capabilities").cloned().unwrap_or_else(|| json!({}));
        sink(LspEvent::Status { server: key.clone(), spec: spec.id.into(), state: "ready", message: None });
        Ok(Arc::new(Server {
            key,
            spec,
            root: root.to_path_buf(),
            capabilities,
            rpc,
            child: Mutex::new(child),
            docs: Mutex::default(),
            last_used: Mutex::new(Instant::now()),
            stopping,
        }))
    }

    pub fn alive(&self) -> bool {
        self.rpc.alive()
    }

    fn touch(&self) {
        if let Ok(mut t) = self.last_used.lock() {
            *t = Instant::now();
        }
    }

    /// Seconds since the last document closed, or None while documents are open.
    pub fn idle_for(&self) -> Option<Duration> {
        let open = self.docs.lock().map(|d| !d.is_empty()).unwrap_or(true);
        (!open).then(|| self.last_used.lock().map(|t| t.elapsed()).unwrap_or_default())
    }

    pub fn docs(&self) -> HashMap<String, Doc> {
        self.docs.lock().map(|d| d.clone()).unwrap_or_default()
    }

    /// 0 = none, 1 = full, 2 = incremental (we always send the full text).
    fn sync_kind(&self) -> i64 {
        let sync = &self.capabilities["textDocumentSync"];
        sync.as_i64().or_else(|| sync.get("change").and_then(Value::as_i64)).unwrap_or(1)
    }

    pub fn open(&self, uri: &str, doc: Doc) -> AppResult<()> {
        self.touch();
        let params = json!({"textDocument": {"uri": uri, "languageId": doc.language_id, "version": doc.version, "text": doc.text}});
        self.docs.lock().map_err(|_| AppError::Internal("lsp lock poisoned".into()))?.insert(uri.to_string(), doc);
        self.rpc.notify("textDocument/didOpen", params)
    }

    pub fn change(&self, uri: &str, version: i64, text: String) -> AppResult<()> {
        self.touch();
        {
            let mut docs = self.docs.lock().map_err(|_| AppError::Internal("lsp lock poisoned".into()))?;
            let Some(doc) = docs.get_mut(uri) else { return Ok(()) };
            if version <= doc.version {
                return Ok(());
            }
            doc.version = version;
            doc.text.clone_from(&text);
        }
        if self.sync_kind() == 0 {
            return Ok(());
        }
        self.rpc.notify("textDocument/didChange", json!({"textDocument": {"uri": uri, "version": version}, "contentChanges": [{"text": text}]}))
    }

    pub fn save(&self, uri: &str) -> AppResult<()> {
        let include = self.capabilities["textDocumentSync"]["save"]["includeText"].as_bool().unwrap_or(false);
        let mut params = json!({"textDocument": {"uri": uri}});
        if include {
            if let Some(doc) = self.docs.lock().ok().and_then(|d| d.get(uri).cloned()) {
                params["text"] = Value::String(doc.text);
            }
        }
        self.rpc.notify("textDocument/didSave", params)
    }

    pub fn close(&self, uri: &str) -> AppResult<()> {
        self.touch();
        let removed = self.docs.lock().map_err(|_| AppError::Internal("lsp lock poisoned".into()))?.remove(uri);
        if removed.is_some() {
            self.rpc.notify("textDocument/didClose", json!({"textDocument": {"uri": uri}}))?;
        }
        Ok(())
    }

    pub fn request(&self, method: &str, params: Value) -> AppResult<Value> {
        self.touch();
        let timeout = if method == "textDocument/completion" { COMPLETION_TIMEOUT } else { REQUEST_TIMEOUT };
        self.rpc.request(method, params, timeout)
    }

    /// Polite shutdown, then kill if the server does not exit.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if self.alive() {
            let _ = self.rpc.request("shutdown", Value::Null, Duration::from_secs(2));
            let _ = self.rpc.notify("exit", Value::Null);
        }
        if let Some(mut child) = self.child.lock().ok().and_then(|mut c| c.take()) {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
