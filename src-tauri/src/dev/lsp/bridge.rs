//! Owns the running language servers: one per (server, project root), started
//! lazily for the first open file, restarted after a crash (at most 3 times in
//! 5 minutes) and stopped after 10 minutes without open files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;

use super::process::{path_for, uri_for, Doc, LspEvent, Server, Sink};
use super::registry::{self, Choices, Spec};
use crate::dev::workspace;
use crate::error::{AppError, AppResult};

const IDLE_STOP: Duration = Duration::from_secs(10 * 60);
const CRASH_WINDOW: Duration = Duration::from_secs(5 * 60);
const MAX_CRASHES: usize = 3;

/// Requests the UI may send. Everything else (shutdown, exit, raw
/// notifications) stays with the bridge.
const METHODS: &[&str] = &[
    "textDocument/completion",
    "completionItem/resolve",
    "textDocument/hover",
    "textDocument/signatureHelp",
    "textDocument/definition",
    "textDocument/typeDefinition",
    "textDocument/implementation",
    "textDocument/references",
    "textDocument/documentHighlight",
    "textDocument/documentSymbol",
    "textDocument/prepareRename",
    "textDocument/rename",
    "textDocument/formatting",
    "textDocument/rangeFormatting",
    "textDocument/codeAction",
    "codeAction/resolve",
    "textDocument/inlayHint",
    "textDocument/semanticTokens/full",
    "textDocument/foldingRange",
    "workspace/symbol",
    "workspace/executeCommand",
];

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Opened {
    #[serde(rename_all = "camelCase")]
    Ready { server: String, spec: &'static str, name: &'static str, uri: String, language_id: &'static str, capabilities: Value },
    #[serde(rename_all = "camelCase")]
    Missing { spec: &'static str, name: &'static str, server: &'static str, install: Option<&'static str> },
    #[serde(rename_all = "camelCase")]
    Disabled { spec: &'static str, name: &'static str },
    #[serde(rename_all = "camelCase")]
    Failed { spec: &'static str, name: &'static str, message: String },
    Unsupported,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub key: String,
    pub spec: &'static str,
    pub root: String,
    pub alive: bool,
    pub documents: usize,
}

#[derive(Default)]
pub struct Lsp {
    servers: Mutex<HashMap<String, Arc<Server>>>,
    /// Document URI → key of the server it is open in.
    owners: Mutex<HashMap<String, String>>,
    starting: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    crashes: Mutex<HashMap<String, Vec<Instant>>>,
    channel: Arc<Mutex<Option<Channel<LspEvent>>>>,
    reaper: OnceLock<()>,
}

fn poisoned<T>(_: T) -> AppError {
    AppError::Internal("lsp lock poisoned".into())
}

fn server_key(spec: &Spec, root: &Path) -> String {
    format!("{}|{}", spec.id, workspace::display(root).to_lowercase())
}

/// Every `textDocument.uri` in request params must be a file inside an open project.
fn check_uris(roots: &[PathBuf], params: &Value) -> AppResult<()> {
    let uri = params.pointer("/textDocument/uri").and_then(Value::as_str);
    if let Some(uri) = uri {
        let path = path_for(uri).ok_or_else(|| AppError::Invalid(format!("not a file URI: {uri}")))?;
        workspace::resolve(roots, &path.to_string_lossy(), true)?;
    }
    Ok(())
}

impl Lsp {
    /// The UI's event channel; a new DEVELOPER view replaces the old one.
    pub fn subscribe(&self, channel: Channel<LspEvent>) {
        if let Ok(mut c) = self.channel.lock() {
            *c = Some(channel);
        }
    }

    fn sink(&self) -> Sink {
        let channel = Arc::clone(&self.channel);
        Arc::new(move |event: LspEvent| {
            if let LspEvent::Status { server, state: "crashed", message, .. } = &event {
                log::warn!("language server {server} crashed: {}", message.as_deref().unwrap_or_default());
            }
            if let Some(c) = channel.lock().ok().and_then(|c| c.clone()) {
                let _ = c.send(event);
            }
        })
    }

    fn start_reaper(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        self.reaper.get_or_init(|| {
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(60));
                let Some(me) = me.upgrade() else { return };
                let idle: Vec<Arc<Server>> = me
                    .servers
                    .lock()
                    .map(|mut s| {
                        let keys: Vec<String> = s.iter().filter(|(_, v)| v.idle_for().is_some_and(|d| d > IDLE_STOP)).map(|(k, _)| k.clone()).collect();
                        keys.iter().filter_map(|k| s.remove(k)).collect()
                    })
                    .unwrap_or_default();
                for server in idle {
                    log::info!("stopping idle language server {}", server.key);
                    server.stop();
                }
            });
        });
    }

    /// The live server for `key`, starting (or restarting) it when needed.
    /// `Ok(None)`: the executable is not installed.
    fn server_for(self: &Arc<Self>, key: &str, spec: &'static Spec, root: &Path, choices: &Choices) -> AppResult<Option<Arc<Server>>> {
        let live = |me: &Self| me.servers.lock().ok().and_then(|s| s.get(key).cloned()).filter(|s| s.alive());
        if let Some(s) = live(self) {
            return Ok(Some(s));
        }
        let gate = Arc::clone(self.starting.lock().map_err(poisoned)?.entry(key.to_string()).or_default());
        let _starting = gate.lock().map_err(poisoned)?;
        if let Some(s) = live(self) {
            return Ok(Some(s));
        }
        let crashed = self.servers.lock().map_err(poisoned)?.remove(key);
        if let Some(dead) = &crashed {
            let mut crashes = self.crashes.lock().map_err(poisoned)?;
            let list = crashes.entry(key.to_string()).or_default();
            list.retain(|t| t.elapsed() < CRASH_WINDOW);
            if list.len() >= MAX_CRASHES {
                // Keep it in the map so a manual Restart still knows its documents.
                self.servers.lock().map_err(poisoned)?.insert(key.to_string(), Arc::clone(dead));
                return Err(AppError::Launch(format!("{} crashed {MAX_CRASHES} times in 5 minutes; use Restart to try again", spec.server)));
            }
            list.push(Instant::now());
        }
        let Some(exe) = registry::locate(spec, choices.get(spec.id), Some(root)) else {
            return Ok(None);
        };
        log::info!("starting language server {} ({}) for {}", spec.server, exe.display(), workspace::display(root));
        let server = Server::spawn(spec, &exe, root, key.to_string(), self.sink())?;
        if let Some(previous) = crashed {
            for (uri, doc) in previous.docs() {
                server.open(&uri, doc)?;
            }
        }
        self.servers.lock().map_err(poisoned)?.insert(key.to_string(), Arc::clone(&server));
        self.start_reaper();
        Ok(Some(server))
    }

    pub fn open(self: &Arc<Self>, roots: &[PathBuf], choices: &Choices, path: &str, version: i64, text: String) -> AppResult<Opened> {
        let file = workspace::resolve(roots, path, true)?;
        let Some((spec, language_id)) = registry::for_file(&file) else { return Ok(Opened::Unsupported) };
        if choices.get(spec.id).is_some_and(|c| c.disabled) {
            return Ok(Opened::Disabled { spec: spec.id, name: spec.name });
        }
        let root = roots
            .iter()
            .filter_map(|r| std::fs::canonicalize(r).ok())
            .filter(|r| file.starts_with(r))
            .max_by_key(|r| r.as_os_str().len())
            .ok_or_else(|| AppError::Invalid("path is outside the open projects".into()))?;
        let key = server_key(spec, &root);
        let server = match self.server_for(&key, spec, &root, choices) {
            Ok(Some(s)) => s,
            Ok(None) => return Ok(Opened::Missing { spec: spec.id, name: spec.name, server: spec.server, install: spec.install }),
            Err(e) => return Ok(Opened::Failed { spec: spec.id, name: spec.name, message: e.to_string() }),
        };
        let uri = uri_for(&file);
        server.open(&uri, Doc { language_id: language_id.to_string(), version, text })?;
        self.owners.lock().map_err(poisoned)?.insert(uri.clone(), key.clone());
        Ok(Opened::Ready { server: key, spec: spec.id, name: spec.name, uri, language_id, capabilities: server.capabilities.clone() })
    }

    fn owner(&self, uri: &str) -> Option<Arc<Server>> {
        let key = self.owners.lock().ok()?.get(uri).cloned()?;
        self.servers.lock().ok()?.get(&key).cloned()
    }

    /// Full-text change. A crashed server is restarted here, on the next edit.
    pub fn change(self: &Arc<Self>, choices: &Choices, uri: &str, version: i64, text: String) -> AppResult<()> {
        let Some(server) = self.owner(uri) else { return Ok(()) };
        let server = if server.alive() {
            server
        } else {
            match self.server_for(&server.key, server.spec, &server.root.clone(), choices)? {
                Some(s) => s,
                None => return Ok(()),
            }
        };
        server.change(uri, version, text)
    }

    pub fn save(&self, uri: &str) -> AppResult<()> {
        match self.owner(uri) {
            Some(s) if s.alive() => s.save(uri),
            _ => Ok(()),
        }
    }

    pub fn close(&self, uri: &str) -> AppResult<()> {
        let server = self.owner(uri);
        self.owners.lock().map_err(poisoned)?.remove(uri);
        match server {
            Some(s) if s.alive() => s.close(uri),
            _ => Ok(()),
        }
    }

    pub fn request(&self, roots: &[PathBuf], key: &str, method: &str, params: Value) -> AppResult<Value> {
        if !METHODS.contains(&method) {
            return Err(AppError::Invalid(format!("{method} is not allowed")));
        }
        check_uris(roots, &params)?;
        let server = self.servers.lock().map_err(poisoned)?.get(key).cloned().ok_or_else(|| AppError::NotFound("language server is not running".into()))?;
        server.request(method, params)
    }

    /// Stops a server and starts it again with the same open documents.
    pub fn restart(self: &Arc<Self>, key: &str, choices: &Choices) -> AppResult<()> {
        let old = self.servers.lock().map_err(poisoned)?.remove(key).ok_or_else(|| AppError::NotFound("language server is not running".into()))?;
        self.crashes.lock().map_err(poisoned)?.remove(key);
        let docs = old.docs();
        let (spec, root) = (old.spec, old.root.clone());
        old.stop();
        let server = self.server_for(key, spec, &root, choices)?.ok_or_else(|| AppError::NotFound(format!("{} is not installed", spec.server)))?;
        for (uri, doc) in docs {
            server.open(&uri, doc)?;
        }
        Ok(())
    }

    /// Stops every server of one kind (after the user disables it or picks another path).
    pub fn stop_spec(&self, spec: &str) {
        let stopped: Vec<Arc<Server>> = self
            .servers
            .lock()
            .map(|mut s| {
                let keys: Vec<String> = s.keys().filter(|k| k.split('|').next() == Some(spec)).cloned().collect();
                keys.iter().filter_map(|k| s.remove(k)).collect()
            })
            .unwrap_or_default();
        for s in stopped {
            s.stop();
        }
    }

    pub fn stop_all(&self) {
        let all: Vec<Arc<Server>> = self.servers.lock().map(|mut s| s.drain().map(|(_, v)| v).collect()).unwrap_or_default();
        for s in all {
            s.stop();
        }
    }

    pub fn running(&self) -> Vec<Running> {
        self.servers
            .lock()
            .map(|s| {
                s.values()
                    .map(|v| Running {
                        key: v.key.clone(),
                        spec: v.spec.id,
                        root: workspace::display(&v.root),
                        alive: v.alive(),
                        documents: v.docs().len(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}
