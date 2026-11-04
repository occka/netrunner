//! Debug Adapter Protocol client. An adapter is the user's own program spoken
//! to over stdio or a local TCP port with the same `Content-Length` framing as
//! LSP. This module owns the transport and the startup sequence; the UI drives
//! the session (threads, stack, variables, stepping) through allow-listed requests.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::lsp::jsonrpc::{encode, Frame, Framer};
use super::process;
use crate::error::{AppError, AppResult};
use crate::services::launcher::expand_env;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const INITIALIZED_TIMEOUT: Duration = Duration::from_secs(30);
// What js-debug is called in the protocol.
const JS_DEBUG_ID: &str = "pwa-node";
const JS_DEBUG_SERVER: &str = r"%LOCALAPPDATA%\js-debug\js-debug\src\dapDebugServer.js";
const JS_DEBUG_INSTALL: &str = r#"$d="$env:LOCALAPPDATA\js-debug"; New-Item -ItemType Directory -Force $d | Out-Null; $t=(Invoke-RestMethod https://api.github.com/repos/microsoft/vscode-js-debug/releases/latest).tag_name; Invoke-WebRequest "https://github.com/microsoft/vscode-js-debug/releases/download/$t/js-debug-dap-$t.tar.gz" -OutFile "$d\js-debug.tar.gz"; tar -xzf "$d\js-debug.tar.gz" -C $d; Remove-Item "$d\js-debug.tar.gz""#;

/// Requests the UI may send. Lifecycle (initialize, launch, configurationDone) stays here.
const COMMANDS: &[&str] = &[
    "threads", "stackTrace", "scopes", "variables", "evaluate", "continue", "next", "stepIn", "stepOut", "pause", "setBreakpoints", "setVariable", "source", "terminate", "exceptionInfo",
];

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DapEvent {
    #[serde(rename_all = "camelCase")]
    Event { event: String, body: Value },
    /// The session could not start, or the launch failed.
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
    /// The adapter is gone.
    Closed,
}

pub type Sink = Arc<dyn Fn(DapEvent) + Send + Sync>;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBreakpoints {
    pub path: String,
    pub breakpoints: Vec<Breakpoint>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakpoint {
    pub line: u32,
    #[serde(default)]
    pub condition: Option<String>,
}

pub fn set_breakpoints_args(file: &SourceBreakpoints) -> Value {
    let name = Path::new(&file.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let bps: Vec<Value> = file
        .breakpoints
        .iter()
        .map(|b| match b.condition.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            Some(c) => json!({"line": b.line, "condition": c}),
            None => json!({"line": b.line}),
        })
        .collect();
    json!({"source": {"path": file.path, "name": name}, "breakpoints": bps, "sourceModified": false})
}

type Reply = Result<Value, String>;

pub struct Session {
    seq: AtomicI64,
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<i64, Sender<Reply>>>,
    alive: AtomicBool,
    child: Mutex<Option<Child>>,
    pub capabilities: Mutex<Value>,
    initialized: Mutex<Option<Sender<()>>>,
    /// Set for js-debug: each program it debugs is a further session on its port.
    children: Mutex<Option<Arc<Children>>>,
}

/// js-debug asks for a new session per program (`startDebugging`). Stops and
/// variables then come from that session, so it becomes the current one.
struct Children {
    port: u16,
    breakpoints: Vec<SourceBreakpoints>,
    current: Arc<Mutex<Option<Arc<Session>>>>,
    sink: Sink,
}

fn start_child(children: Arc<Children>, arguments: &Value) -> AppResult<()> {
    let stream = TcpStream::connect(("127.0.0.1", children.port))?;
    let read = stream.try_clone()?;
    // The first session stays connected until the end and reports when it is gone.
    let outer = Arc::clone(&children.sink);
    let sink: Sink = Arc::new(move |e| {
        if !matches!(e, DapEvent::Closed) {
            outer(e);
        }
    });
    let (session, init) = Session::connect(Box::new(read), Box::new(stream), None, Arc::clone(&sink))?;
    if let Ok(mut c) = session.children.lock() {
        *c = Some(Arc::clone(&children));
    }
    if let Ok(mut current) = children.current.lock() {
        *current = Some(Arc::clone(&session));
    }
    let request = arguments["request"].as_str().unwrap_or("launch");
    start_session(&session, init, JS_DEBUG_ID, request, arguments["configuration"].clone(), &children.breakpoints, sink)
}

impl Session {
    /// Starts the reader over any byte streams (an adapter's stdio or socket, a fake in tests).
    pub fn connect(reader: Box<dyn Read + Send>, writer: Box<dyn Write + Send>, child: Option<Child>, sink: Sink) -> AppResult<(Arc<Session>, Receiver<()>)> {
        let (init_tx, init_rx) = mpsc::channel();
        let session = Arc::new(Session {
            seq: AtomicI64::new(1),
            writer: Mutex::new(writer),
            pending: Mutex::default(),
            alive: AtomicBool::new(true),
            child: Mutex::new(child),
            capabilities: Mutex::new(json!({})),
            initialized: Mutex::new(Some(init_tx)),
            children: Mutex::new(None),
        });
        let me = Arc::clone(&session);
        let mut reader = reader;
        std::thread::Builder::new()
            .name("nr-dap".into())
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
                            Ok(Some(Frame::Invalid(e))) => log::warn!("debug adapter sent invalid JSON: {e}"),
                            Ok(Some(Frame::Message(msg))) => me.dispatch(msg, &sink),
                            Err(e) => {
                                log::error!("debug adapter stream is broken: {e}");
                                break 'read;
                            }
                        }
                    }
                }
                me.alive.store(false, Ordering::SeqCst);
                for (_, tx) in me.pending.lock().map(|mut p| p.drain().collect::<Vec<_>>()).unwrap_or_default() {
                    let _ = tx.send(Err("the debug adapter stopped".into()));
                }
                sink(DapEvent::Closed);
            })
            .map_err(|e| AppError::Internal(e.to_string()))?;
        Ok((session, init_rx))
    }

    fn dispatch(&self, msg: Value, sink: &Sink) {
        match msg["type"].as_str() {
            Some("response") => {
                let Some(id) = msg["request_seq"].as_i64() else { return };
                if let Some(tx) = self.pending.lock().ok().and_then(|mut p| p.remove(&id)) {
                    let reply = if msg["success"].as_bool().unwrap_or(false) {
                        Ok(msg.get("body").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(error_text(&msg))
                    };
                    let _ = tx.send(reply);
                }
            }
            Some("event") => {
                let event = msg["event"].as_str().unwrap_or_default().to_string();
                if event == "initialized" {
                    if let Some(tx) = self.initialized.lock().ok().and_then(|mut i| i.take()) {
                        let _ = tx.send(());
                    }
                }
                sink(DapEvent::Event { event, body: msg.get("body").cloned().unwrap_or(Value::Null) });
            }
            // Reverse requests. Programs run in the internal console, so runInTerminal is refused.
            Some("request") => {
                let children = if msg["command"] == "startDebugging" { self.children.lock().ok().and_then(|c| c.clone()) } else { None };
                let reply = json!({
                    "seq": self.seq.fetch_add(1, Ordering::Relaxed),
                    "type": "response",
                    "request_seq": msg["seq"],
                    "command": msg["command"],
                    "success": children.is_some(),
                    "message": if children.is_some() { Value::Null } else { json!("not supported by NETRUNNER") },
                });
                let _ = self.write(&reply);
                if let Some(children) = children {
                    let arguments = msg["arguments"].clone();
                    // On its own thread: this one has to keep reading.
                    std::thread::spawn(move || {
                        let sink = Arc::clone(&children.sink);
                        if let Err(e) = start_child(children, &arguments) {
                            sink(DapEvent::Failed { message: e.to_string() });
                        }
                    });
                }
            }
            _ => {}
        }
    }

    fn write(&self, msg: &Value) -> AppResult<()> {
        let mut w = self.writer.lock().map_err(|_| AppError::Internal("debug writer poisoned".into()))?;
        w.write_all(&encode(msg))?;
        w.flush()?;
        Ok(())
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Sends a request; the reply arrives on the returned channel.
    pub fn send(&self, command: &str, arguments: Value) -> AppResult<Receiver<Reply>> {
        if !self.alive() {
            return Err(AppError::Launch("the debug adapter stopped".into()));
        }
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().map_err(|_| AppError::Internal("debug lock poisoned".into()))?.insert(seq, tx);
        self.write(&json!({"seq": seq, "type": "request", "command": command, "arguments": arguments}))?;
        Ok(rx)
    }

    pub fn request(&self, command: &str, arguments: Value, timeout: Duration) -> AppResult<Value> {
        let rx = self.send(command, arguments)?;
        match rx.recv_timeout(timeout) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(AppError::Launch(e)),
            Err(_) => Err(AppError::Launch(format!("{command} timed out"))),
        }
    }

    /// Ends the debuggee and the adapter.
    pub fn stop(&self) {
        if self.alive() {
            let _ = self.request("disconnect", json!({"terminateDebuggee": true}), Duration::from_secs(3));
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

fn error_text(msg: &Value) -> String {
    let format = msg["body"]["error"]["format"].as_str();
    format.or_else(|| msg["message"].as_str()).unwrap_or("the debug adapter refused the request").to_string()
}

/// The startup order the protocol requires: initialize, launch (its reply comes
/// later), wait for `initialized`, breakpoints, configurationDone.
pub fn start_session(session: &Arc<Session>, initialized: Receiver<()>, adapter_id: &str, request: &str, config: Value, breakpoints: &[SourceBreakpoints], sink: Sink) -> AppResult<()> {
    let caps = session.request(
        "initialize",
        json!({
            "clientID": "netrunner",
            "clientName": "NETRUNNER",
            "adapterID": adapter_id,
            "locale": "en",
            "linesStartAt1": true,
            "columnsStartAt1": true,
            "pathFormat": "path",
            "supportsVariableType": true,
            "supportsRunInTerminalRequest": false,
            "supportsStartDebuggingRequest": adapter_id == JS_DEBUG_ID,
        }),
        INITIALIZED_TIMEOUT,
    )?;
    if let Ok(mut c) = session.capabilities.lock() {
        *c = caps;
    }
    let launch = session.send(request, config)?;
    let sink2 = Arc::clone(&sink);
    std::thread::spawn(move || {
        // Adapters may answer only after configurationDone, and only once the program started.
        if let Ok(Err(e)) = launch.recv_timeout(Duration::from_secs(120)) {
            sink2(DapEvent::Failed { message: e });
        }
    });
    if initialized.recv_timeout(INITIALIZED_TIMEOUT).is_err() {
        return Err(AppError::Launch("the debug adapter did not get ready in time".into()));
    }
    for file in breakpoints {
        // Each answer says whether the line could be bound; the UI asks again when the program runs.
        let reply = session.request("setBreakpoints", set_breakpoints_args(file), REQUEST_TIMEOUT)?;
        sink(DapEvent::Event { event: "breakpointsSet".into(), body: json!({"path": file.path, "breakpoints": reply["breakpoints"]}) });
    }
    if session.capabilities.lock().map(|c| c["exceptionBreakpointFilters"].is_array()).unwrap_or(false) {
        let _ = session.request("setExceptionBreakpoints", json!({"filters": []}), REQUEST_TIMEOUT);
    }
    session.request("configurationDone", json!({}), REQUEST_TIMEOUT)?;
    Ok(())
}

// ---------- Adapters ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub languages: &'static str,
    pub found: bool,
    pub path: Option<String>,
    pub note: Option<String>,
    pub install: Option<String>,
    pub docs: &'static str,
}

/// The project's virtual environment first, then the toolchain setting, then PATH.
pub fn python_for(project: &Path, configured: Option<&str>) -> String {
    for dir in [".venv", "venv", "env"] {
        let exe = project.join(dir).join("Scripts").join("python.exe");
        if exe.is_file() {
            return exe.display().to_string();
        }
    }
    configured.map(str::trim).filter(|p| !p.is_empty()).unwrap_or("python").to_string()
}

fn on_path(exe: &str) -> Option<String> {
    let out = process::run("where.exe", &[exe], None, Duration::from_secs(3)).ok()?;
    if !out.ok() {
        return None;
    }
    out.stdout_str().lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
}

fn delve() -> Option<String> {
    on_path("dlv").or_else(|| {
        let p = PathBuf::from(expand_env(r"%USERPROFILE%\go\bin\dlv.exe"));
        p.is_file().then(|| p.display().to_string())
    })
}

/// codelldb from PATH or from the VS Code / Cursor extension folder.
fn codelldb(custom: Option<&str>) -> Option<String> {
    if let Some(p) = custom.map(str::trim).filter(|p| !p.is_empty()) {
        return Path::new(p).is_file().then(|| p.to_string());
    }
    on_path("codelldb").or_else(|| {
        [r"%USERPROFILE%\.vscode\extensions", r"%USERPROFILE%\.cursor\extensions"].iter().find_map(|root| {
            std::fs::read_dir(expand_env(root)).ok()?.flatten().find_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let exe = e.path().join("adapter").join("codelldb.exe");
                (name.starts_with("vadimcn.vscode-lldb") && exe.is_file()).then(|| exe.display().to_string())
            })
        })
    })
}

/// js-debug's server script, from where the Install command puts it.
fn js_debug() -> Option<String> {
    if cfg!(debug_assertions) {
        if let Some(p) = std::env::var("NETRUNNER_DEV_JS_DEBUG").ok().filter(|p| Path::new(p).is_file()) {
            return Some(p);
        }
    }
    let p = PathBuf::from(expand_env(JS_DEBUG_SERVER));
    p.is_file().then(|| p.display().to_string())
}

pub fn adapters(project: &Path, python: Option<&str>, codelldb_path: Option<&str>) -> Vec<AdapterStatus> {
    let py = python_for(project, python);
    let check = process::run(&py, &["-c", "import debugpy; print(debugpy.__version__)"], Some(project), Duration::from_secs(8));
    let (found, note) = match check {
        Ok(o) if o.ok() => (true, Some(format!("debugpy {} in {py}", o.stdout_str().trim()))),
        Ok(_) => (false, Some(format!("debugpy is not installed for {py}"))),
        Err(_) => (false, Some("Python was not found".to_string())),
    };
    let dlv = delve();
    let lldb = codelldb(codelldb_path);
    let js = js_debug();
    let node = on_path("node");
    vec![
        AdapterStatus { id: "debugpy", name: "debugpy", languages: "Python", found, path: found.then_some(py.clone()), note, install: Some(if py == "python" { "python -m pip install debugpy".to_string() } else { format!("& '{py}' -m pip install debugpy") }), docs: "https://github.com/microsoft/debugpy" },
        AdapterStatus { id: "delve", name: "Delve", languages: "Go", found: dlv.is_some(), path: dlv, note: None, install: Some("go install github.com/go-delve/delve/cmd/dlv@latest".to_string()), docs: "https://github.com/go-delve/delve" },
        AdapterStatus {
            id: "codelldb",
            name: "CodeLLDB",
            languages: "Rust, C, C++",
            found: lldb.is_some(),
            path: lldb,
            note: Some("Comes with the VS Code extension vadimcn.vscode-lldb, or download a release and pick codelldb.exe".into()),
            install: None,
            docs: "https://github.com/vadimcn/codelldb/releases",
        },
        AdapterStatus {
            id: "js-debug",
            name: "js-debug",
            languages: "JavaScript (Node.js)",
            found: js.is_some() && node.is_some(),
            note: if node.is_none() { Some("Node.js is not installed".into()) } else { None },
            path: js,
            install: Some(JS_DEBUG_INSTALL.to_string()),
            docs: "https://github.com/microsoft/vscode-js-debug",
        },
    ]
}

fn free_port() -> AppResult<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

struct Spawned {
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    child: Child,
}

fn drain_stderr(child: &mut Child) -> Arc<Mutex<VecDeque<String>>> {
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(mut err) = child.stderr.take() {
        let t = Arc::clone(&tail);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = err.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if let Ok(mut q) = t.lock() {
                    q.push_back(String::from_utf8_lossy(&buf[..n]).chars().take(400).collect::<String>());
                    if q.len() > 6 {
                        q.pop_front();
                    }
                }
            }
        });
    }
    tail
}

fn spawn_stdio(exe: &str, args: &[&str], cwd: &Path) -> AppResult<Spawned> {
    let mut cmd = process::command(exe);
    cmd.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| AppError::Launch(format!("cannot start {exe}: {e}")))?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Err(AppError::Internal("adapter pipes are missing".into()));
    };
    drain_stderr(&mut child);
    Ok(Spawned { reader: Box::new(stdout), writer: Box::new(stdin), child })
}

/// Adapters that serve DAP on a port: start, then connect (retrying while it boots).
fn spawn_tcp(exe: &str, args: &[String], cwd: &Path, port: u16) -> AppResult<Spawned> {
    let mut cmd = process::command(exe);
    cmd.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| AppError::Launch(format!("cannot start {exe}: {e}")))?;
    drain_stderr(&mut child);
    let deadline = Instant::now() + Duration::from_secs(15);
    let stream = loop {
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(s) => break s,
            Err(_) if Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                let _ = child.kill();
                return Err(AppError::Launch(format!("{exe} did not open its debug port: {e}")));
            }
        }
    };
    let read = stream.try_clone()?;
    Ok(Spawned { reader: Box::new(read), writer: Box::new(stream), child })
}

#[derive(Default)]
pub struct Dap {
    /// The session the UI talks to. For js-debug, the program's own session.
    current: Arc<Mutex<Option<Arc<Session>>>>,
    /// The one that owns the adapter process.
    root: Mutex<Option<Arc<Session>>>,
}

pub struct StartOptions<'a> {
    pub project: &'a Path,
    pub adapter: &'a str,
    pub request: &'a str,
    pub config: Value,
    pub breakpoints: &'a [SourceBreakpoints],
    pub python: Option<&'a str>,
    pub codelldb: Option<&'a str>,
}

impl Dap {
    pub fn start(&self, o: StartOptions<'_>, sink: Sink) -> AppResult<()> {
        self.stop();
        if !matches!(o.request, "launch" | "attach") {
            return Err(AppError::Invalid("a debug session either launches or attaches".into()));
        }
        let mut js_debug_port = None;
        let spawned = match o.adapter {
            "debugpy" => spawn_stdio(&python_for(o.project, o.python), &["-m", "debugpy.adapter"], o.project)?,
            "delve" => {
                let exe = delve().ok_or_else(|| AppError::NotFound("Delve (dlv) is not installed".into()))?;
                let port = free_port()?;
                spawn_tcp(&exe, &["dap".into(), format!("--listen=127.0.0.1:{port}")], o.project, port)?
            }
            "codelldb" => {
                let exe = codelldb(o.codelldb).ok_or_else(|| AppError::NotFound("CodeLLDB is not installed".into()))?;
                let port = free_port()?;
                spawn_tcp(&exe, &["--port".into(), port.to_string()], o.project, port)?
            }
            "js-debug" => {
                let script = js_debug().ok_or_else(|| AppError::NotFound("js-debug is not installed".into()))?;
                let node = on_path("node").ok_or_else(|| AppError::NotFound("Node.js is not installed".into()))?;
                let port = free_port()?;
                js_debug_port = Some(port);
                spawn_tcp(&node, &[script, port.to_string(), "127.0.0.1".into()], o.project, port)?
            }
            other => return Err(AppError::Invalid(format!("unknown debug adapter '{other}'"))),
        };
        let (session, init) = Session::connect(spawned.reader, spawned.writer, Some(spawned.child), Arc::clone(&sink))?;
        if let Some(port) = js_debug_port {
            let children = Children { port, breakpoints: o.breakpoints.to_vec(), current: Arc::clone(&self.current), sink: Arc::clone(&sink) };
            *session.children.lock().map_err(|_| AppError::Internal("debug lock poisoned".into()))? = Some(Arc::new(children));
        }
        // Current before it starts: a program's own session may replace it during the start.
        *self.current.lock().map_err(|_| AppError::Internal("debug lock poisoned".into()))? = Some(Arc::clone(&session));
        *self.root.lock().map_err(|_| AppError::Internal("debug lock poisoned".into()))? = Some(Arc::clone(&session));
        let adapter_id = if js_debug_port.is_some() { JS_DEBUG_ID } else { o.adapter };
        if let Err(e) = start_session(&session, init, adapter_id, o.request, o.config, o.breakpoints, sink) {
            self.stop();
            return Err(e);
        }
        Ok(())
    }

    pub fn request(&self, command: &str, arguments: Value) -> AppResult<Value> {
        if !COMMANDS.contains(&command) {
            return Err(AppError::Invalid(format!("{command} is not allowed")));
        }
        let session = self.current.lock().ok().and_then(|c| c.clone()).ok_or_else(|| AppError::NotFound("no debug session is running".into()))?;
        session.request(command, arguments, REQUEST_TIMEOUT)
    }

    pub fn stop(&self) {
        let current = self.current.lock().ok().and_then(|mut c| c.take());
        let root = self.root.lock().ok().and_then(|mut c| c.take());
        if let Some(s) = &current {
            s.stop();
        }
        if let Some(r) = root.filter(|r| !current.as_ref().is_some_and(|c| Arc::ptr_eq(c, r))) {
            r.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PipeReader(mpsc::Receiver<Vec<u8>>, Vec<u8>, usize);
    impl Read for PipeReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.2 == self.1.len() {
                match self.0.recv() {
                    Ok(b) => (self.1, self.2) = (b, 0),
                    Err(_) => return Ok(0),
                }
            }
            let n = out.len().min(self.1.len() - self.2);
            out[..n].copy_from_slice(&self.1[self.2..self.2 + n]);
            self.2 += n;
            Ok(n)
        }
    }
    struct PipeWriter(mpsc::Sender<Vec<u8>>);
    impl Write for PipeWriter {
        fn write(&mut self, d: &[u8]) -> std::io::Result<usize> {
            self.0.send(d.to_vec()).map_err(|_| std::io::Error::from(std::io::ErrorKind::BrokenPipe))?;
            Ok(d.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn pipe() -> (PipeWriter, PipeReader) {
        let (tx, rx) = mpsc::channel();
        (PipeWriter(tx), PipeReader(rx, Vec::new(), 0))
    }

    /// Behaves like debugpy: `launch` is answered only after configurationDone;
    /// then the program stops at a breakpoint.
    fn fake_adapter(mut input: PipeReader, mut output: PipeWriter, seen: Arc<Mutex<Vec<String>>>, fail_launch: bool) {
        std::thread::spawn(move || {
            let mut framer = Framer::default();
            let mut buf = [0u8; 2048];
            let mut launch_seq = 0;
            let mut seq = 100;
            loop {
                let n = match input.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                framer.push(&buf[..n]);
                while let Ok(Some(Frame::Message(m))) = framer.next() {
                    let cmd = m["command"].as_str().unwrap_or_default().to_string();
                    if m["type"] == "response" {
                        seen.lock().unwrap().push(format!("reply:{cmd}:{}", m["success"]));
                        continue;
                    }
                    seen.lock().unwrap().push(cmd.clone());
                    seq += 1;
                    let mut reply = |body: Value, command: &str, request_seq: i64| {
                        output.write_all(&encode(&json!({"seq": seq, "type": "response", "request_seq": request_seq, "command": command, "success": true, "body": body}))).unwrap();
                    };
                    let this = m["seq"].as_i64().unwrap();
                    match cmd.as_str() {
                        "initialize" => reply(json!({"supportsConfigurationDoneRequest": true, "exceptionBreakpointFilters": [{"filter": "raised"}]}), "initialize", this),
                        "launch" | "attach" => {
                            launch_seq = this;
                            output.write_all(&encode(&json!({"seq": 1, "type": "request", "command": "runInTerminal", "arguments": {}}))).unwrap();
                            output.write_all(&encode(&json!({"seq": 2, "type": "event", "event": "initialized"}))).unwrap();
                        }
                        "setBreakpoints" => {
                            let bps: Vec<Value> = m["arguments"]["breakpoints"].as_array().unwrap().iter().map(|b| json!({"verified": true, "line": b["line"]})).collect();
                            reply(json!({"breakpoints": bps}), "setBreakpoints", this);
                        }
                        "configurationDone" => {
                            reply(json!({}), "configurationDone", this);
                            if fail_launch {
                                output.write_all(&encode(&json!({"seq": 3, "type": "response", "request_seq": launch_seq, "command": "launch", "success": false, "message": "no such program"}))).unwrap();
                            } else {
                                reply(json!({}), "launch", launch_seq);
                                output.write_all(&encode(&json!({"seq": 4, "type": "event", "event": "stopped", "body": {"reason": "breakpoint", "threadId": 1}}))).unwrap();
                            }
                        }
                        "setExceptionBreakpoints" => reply(json!({}), "setExceptionBreakpoints", this),
                        "threads" => reply(json!({"threads": [{"id": 1, "name": "main"}]}), "threads", this),
                        "disconnect" => {
                            reply(json!({}), "disconnect", this);
                            return;
                        }
                        _ => {}
                    }
                }
            }
        });
    }

    fn sink() -> (Sink, Arc<Mutex<Vec<DapEvent>>>) {
        let store = Arc::new(Mutex::new(Vec::new()));
        let s = Arc::clone(&store);
        (Arc::new(move |e| s.lock().unwrap().push(e)), store)
    }

    fn wait(store: &Arc<Mutex<Vec<DapEvent>>>, f: impl Fn(&DapEvent) -> bool) -> DapEvent {
        for _ in 0..200 {
            if let Some(e) = store.lock().unwrap().iter().find(|e| f(e)) {
                return e.clone();
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("no such event: {:?}", store.lock().unwrap());
    }

    type Started = (Arc<Session>, Arc<Mutex<Vec<String>>>, Arc<Mutex<Vec<DapEvent>>>);

    fn start(fail: bool) -> Started {
        let (to_adapter, adapter_in) = pipe();
        let (adapter_out, from_adapter) = pipe();
        let seen = Arc::new(Mutex::new(Vec::new()));
        fake_adapter(adapter_in, adapter_out, Arc::clone(&seen), fail);
        let (s, store) = sink();
        let (session, init) = Session::connect(Box::new(from_adapter), Box::new(to_adapter), None, Arc::clone(&s)).unwrap();
        let bps = vec![SourceBreakpoints { path: r"C:\p\main.py".into(), breakpoints: vec![Breakpoint { line: 3, condition: None }, Breakpoint { line: 9, condition: Some("x > 1".into()) }] }];
        start_session(&session, init, "debugpy", "launch", json!({"program": "main.py"}), &bps, s).unwrap();
        (session, seen, store)
    }

    #[test]
    fn startup_follows_the_protocol_order() {
        let (session, seen, store) = start(false);
        let log = seen.lock().unwrap().clone();
        let cmds: Vec<&str> = log.iter().map(String::as_str).filter(|c| !c.starts_with("reply:")).collect();
        assert_eq!(cmds, ["initialize", "launch", "setBreakpoints", "setExceptionBreakpoints", "configurationDone"]);
        // The reverse request was refused, the event reached the UI.
        assert!(log.iter().any(|c| c == "reply:runInTerminal:false"));
        let DapEvent::Event { body, .. } = wait(&store, |e| matches!(e, DapEvent::Event { event, .. } if event == "breakpointsSet")) else { unreachable!() };
        assert_eq!(body["breakpoints"][1]["line"], 9);
        let DapEvent::Event { body, .. } = wait(&store, |e| matches!(e, DapEvent::Event { event, .. } if event == "stopped")) else { unreachable!() };
        assert_eq!(body["threadId"], 1);
        assert_eq!(session.request("threads", json!({}), REQUEST_TIMEOUT).unwrap()["threads"][0]["name"], "main");
        session.stop();
        wait(&store, |e| matches!(e, DapEvent::Closed));
        assert!(!session.alive());
        assert!(session.request("threads", json!({}), REQUEST_TIMEOUT).is_err());
    }

    #[test]
    fn a_failed_launch_is_reported() {
        let (session, _seen, store) = start(true);
        let DapEvent::Failed { message } = wait(&store, |e| matches!(e, DapEvent::Failed { .. })) else { unreachable!() };
        assert_eq!(message, "no such program");
        session.stop();
    }

    /// Speaks js-debug's protocol: the first session asks for a second one, which
    /// is where the program runs and stops.
    #[test]
    fn a_program_session_takes_over_from_the_first_one() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            for (conn, stream) in listener.incoming().enumerate() {
                let mut stream = stream.unwrap();
                let log = Arc::clone(&log);
                std::thread::spawn(move || {
                    let mut framer = Framer::default();
                    let mut buf = [0u8; 4096];
                    let mut seq = 100;
                    loop {
                        let n = match stream.read(&mut buf) {
                            Ok(0) | Err(_) => return,
                            Ok(n) => n,
                        };
                        framer.push(&buf[..n]);
                        while let Ok(Some(Frame::Message(m))) = framer.next() {
                            let cmd = m["command"].as_str().unwrap_or_default().to_string();
                            log.lock().unwrap().push(format!("{conn}:{}:{cmd}", m["type"].as_str().unwrap_or_default()));
                            if m["type"] != "request" {
                                continue;
                            }
                            seq += 1;
                            let body = match cmd.as_str() {
                                "initialize" => json!({"supportsConfigurationDoneRequest": true, "got": m["arguments"]["supportsStartDebuggingRequest"]}),
                                "setBreakpoints" => json!({"breakpoints": [{"verified": true, "line": 2}]}),
                                "threads" => json!({"threads": [{"id": conn, "name": "from session"}]}),
                                _ => json!({}),
                            };
                            let reply = json!({"seq": seq, "type": "response", "request_seq": m["seq"], "command": cmd, "success": true, "body": body});
                            stream.write_all(&encode(&reply)).unwrap();
                            if cmd == "disconnect" {
                                return;
                            }
                            let mut event = |name: &str, body: Value| stream.write_all(&encode(&json!({"seq": 0, "type": "event", "event": name, "body": body}))).unwrap();
                            if cmd == "launch" {
                                event("initialized", json!({}));
                            }
                            if cmd == "configurationDone" && conn == 1 {
                                event("stopped", json!({"reason": "breakpoint", "threadId": 1}));
                            }
                            if cmd == "launch" && conn == 0 {
                                let ask = json!({"seq": 50, "type": "request", "command": "startDebugging", "arguments": {"request": "launch", "configuration": {"__pendingTargetId": "abc"}}});
                                stream.write_all(&encode(&ask)).unwrap();
                            }
                        }
                    }
                });
            }
        });

        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let (s, store) = sink();
        let dap = Dap::default();
        let bps = vec![SourceBreakpoints { path: "app.js".into(), breakpoints: vec![Breakpoint { line: 2, condition: None }] }];
        let (root, init) = Session::connect(Box::new(stream.try_clone().unwrap()), Box::new(stream), None, Arc::clone(&s)).unwrap();
        *root.children.lock().unwrap() = Some(Arc::new(Children { port, breakpoints: bps.clone(), current: Arc::clone(&dap.current), sink: Arc::clone(&s) }));
        *dap.current.lock().unwrap() = Some(Arc::clone(&root));
        *dap.root.lock().unwrap() = Some(Arc::clone(&root));
        start_session(&root, init, JS_DEBUG_ID, "launch", json!({"program": "app.js"}), &bps, s).unwrap();

        wait(&store, |e| matches!(e, DapEvent::Event { event, .. } if event == "stopped"));
        // Requests now go to the program's session, which has the breakpoints.
        assert_eq!(dap.request("threads", json!({})).unwrap()["threads"][0]["id"], 1);
        let log = seen.lock().unwrap().clone();
        assert!(log.contains(&"0:response:startDebugging".to_string()), "{log:?}");
        for step in ["1:request:initialize", "1:request:launch", "1:request:setBreakpoints", "1:request:configurationDone"] {
            assert!(log.iter().any(|l| l == step), "{step} in {log:?}");
        }
        dap.stop();
        wait(&store, |e| matches!(e, DapEvent::Closed));
        assert!(matches!(dap.request("threads", json!({})), Err(AppError::NotFound(_))));
    }

    /// The real thing: js-debug and node. `NETRUNNER_DEV_JS_DEBUG` points to dapDebugServer.js.
    #[test]
    #[ignore]
    fn js_debug_stops_at_a_breakpoint() {
        let dir = std::env::temp_dir().join(format!("nr-jsdbg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("app.js");
        std::fs::write(&file, "const answer = 40 + 2;
console.log('hello from node', answer);
console.log('done');
").unwrap();
        let path = file.display().to_string();
        let (s, store) = sink();
        let dap = Dap::default();
        let bps = vec![SourceBreakpoints { path: path.clone(), breakpoints: vec![Breakpoint { line: 2, condition: None }] }];
        let config = json!({"name": "app", "type": "pwa-node", "request": "launch", "console": "internalConsole", "program": path, "cwd": dir.display().to_string()});
        dap.start(StartOptions { project: &dir, adapter: "js-debug", request: "launch", config, breakpoints: &bps, python: None, codelldb: None }, s).unwrap();

        let until = |what: &str, f: &dyn Fn(&DapEvent) -> bool| {
            for _ in 0..300 {
                if let Some(e) = store.lock().unwrap().iter().find(|e| f(e)) {
                    return e.clone();
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            panic!("no {what}: {:?}", store.lock().unwrap());
        };
        let DapEvent::Event { body, .. } = until("stop", &|e| matches!(e, DapEvent::Event { event, .. } if event == "stopped")) else { unreachable!() };
        let thread = body["threadId"].as_i64().unwrap();
        let stack = dap.request("stackTrace", json!({"threadId": thread})).unwrap();
        let frame = &stack["stackFrames"][0];
        assert_eq!(frame["line"], 2, "{stack}");
        let scopes = dap.request("scopes", json!({"frameId": frame["id"]})).unwrap();
        let local = scopes["scopes"][0]["variablesReference"].clone();
        let vars = dap.request("variables", json!({"variablesReference": local})).unwrap();
        assert!(vars["variables"].as_array().unwrap().iter().any(|v| v["name"] == "answer" && v["value"] == "42"), "{vars}");

        dap.request("continue", json!({"threadId": thread})).unwrap();
        until("output", &|e| matches!(e, DapEvent::Event { event, body } if event == "output" && body["output"].as_str().is_some_and(|o| o.contains("hello from node"))));
        until("end", &|e| matches!(e, DapEvent::Event { event, .. } if event == "terminated"));
        dap.stop();
        until("close", &|e| matches!(e, DapEvent::Closed));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn builds_breakpoint_requests() {
        let a = set_breakpoints_args(&SourceBreakpoints { path: r"D:\p\a.py".into(), breakpoints: vec![Breakpoint { line: 2, condition: Some("  ".into()) }, Breakpoint { line: 5, condition: Some("n == 2".into()) }] });
        assert_eq!(a["source"]["name"], "a.py");
        assert_eq!(a["breakpoints"], json!([{"line": 2}, {"line": 5, "condition": "n == 2"}]));
    }

    #[test]
    fn only_allowed_requests_pass_and_venv_wins() {
        let d = Dap::default();
        assert!(matches!(d.request("launch", json!({})), Err(AppError::Invalid(_))));
        assert!(matches!(d.request("threads", json!({})), Err(AppError::NotFound(_))));
        let root = std::env::temp_dir().join(format!("nr-dap-{}", std::process::id()));
        let scripts = root.join(".venv").join("Scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        assert_eq!(python_for(&root, Some(r"C:\Py\python.exe")), r"C:\Py\python.exe");
        std::fs::write(scripts.join("python.exe"), b"").unwrap();
        assert!(python_for(&root, None).ends_with(r".venv\Scripts\python.exe"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
