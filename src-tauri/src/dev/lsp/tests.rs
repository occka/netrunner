//! The bridge against an in-process fake language server, plus a smoke test
//! with a real rust-analyzer when it is installed.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::jsonrpc::{encode, Frame, Framer};
use super::process::{path_for, uri_for, Doc, LspEvent, Rpc, Server, Sink};
use super::registry;

struct PipeReader {
    rx: Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}

impl Read for PipeReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos == self.buf.len() {
            match self.rx.recv() {
                Ok(b) => (self.buf, self.pos) = (b, 0),
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

struct PipeWriter(Sender<Vec<u8>>);

impl Write for PipeWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        // Deliver in two pieces so the client sees split frames.
        let mid = data.len() / 2;
        for part in [&data[..mid], &data[mid..]] {
            self.0.send(part.to_vec()).map_err(|_| std::io::Error::from(std::io::ErrorKind::BrokenPipe))?;
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn pipe() -> (PipeWriter, PipeReader) {
    let (tx, rx) = mpsc::channel();
    (PipeWriter(tx), PipeReader { rx, buf: Vec::new(), pos: 0 })
}

/// A tiny language server: answers initialize, asks for configuration,
/// publishes one diagnostic per opened file, answers hover, never answers
/// `textDocument/slow`, and exits on `exit`.
fn fake_server(mut input: PipeReader, mut output: PipeWriter, seen: Arc<Mutex<Vec<Value>>>) {
    std::thread::spawn(move || {
        let mut framer = Framer::default();
        let mut buf = [0u8; 1024];
        loop {
            let n = match input.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            framer.push(&buf[..n]);
            while let Ok(Some(Frame::Message(msg))) = framer.next() {
                seen.lock().unwrap().push(msg.clone());
                let id = msg.get("id").cloned();
                let reply = |result: Value| encode(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
                match msg.get("method").and_then(Value::as_str) {
                    Some("initialize") => {
                        output
                            .write_all(&encode(&json!({"jsonrpc": "2.0", "id": "cfg-1", "method": "workspace/configuration", "params": {"items": [{"section": "a"}, {"section": "b"}]}})))
                            .unwrap();
                        output.write_all(&reply(json!({"capabilities": {"textDocumentSync": 1, "hoverProvider": true}}))).unwrap();
                    }
                    Some("textDocument/didOpen") => {
                        let uri = msg["params"]["textDocument"]["uri"].clone();
                        let diag = json!({"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 3}}, "severity": 1, "message": "fake error"});
                        output
                            .write_all(&encode(&json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {"uri": uri, "diagnostics": [diag]}})))
                            .unwrap();
                    }
                    Some("textDocument/hover") => output.write_all(&reply(json!({"contents": "hi"}))).unwrap(),
                    Some("shutdown") => output.write_all(&reply(Value::Null)).unwrap(),
                    Some("exit") => return,
                    _ => {}
                }
            }
        }
    });
}

fn events() -> (Sink, Arc<Mutex<Vec<LspEvent>>>) {
    let store = Arc::new(Mutex::new(Vec::new()));
    let s = Arc::clone(&store);
    (Arc::new(move |e| s.lock().unwrap().push(e)), store)
}

fn wait_for(store: &Arc<Mutex<Vec<LspEvent>>>, pred: impl Fn(&LspEvent) -> bool) -> LspEvent {
    for _ in 0..200 {
        if let Some(e) = store.lock().unwrap().iter().find(|e| pred(e)) {
            return e.clone();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("event did not arrive: {:?}", store.lock().unwrap());
}

#[test]
fn handshake_documents_requests_and_shutdown() {
    let (to_server, server_in) = pipe();
    let (server_out, from_server) = pipe();
    let seen = Arc::new(Mutex::new(Vec::new()));
    fake_server(server_in, server_out, Arc::clone(&seen));
    let (sink, store) = events();
    let root = std::env::temp_dir();
    let spec = registry::spec("rust").unwrap();
    let server = Server::connect(spec, &root, "rust|test".into(), Box::new(from_server), Box::new(to_server), None, sink, Arc::new(Mutex::new(VecDeque::new()))).unwrap();
    assert_eq!(server.capabilities["hoverProvider"], json!(true));
    wait_for(&store, |e| matches!(e, LspEvent::Status { state: "ready", .. }));

    // The server's configuration request got one null per item.
    let answered = || seen.lock().unwrap().iter().find(|m| m["id"] == json!("cfg-1")).cloned();
    for _ in 0..100 {
        if answered().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(answered().unwrap()["result"], json!([null, null]));

    let file = root.join("main.rs");
    let uri = uri_for(&file);
    server.open(&uri, Doc { language_id: "rust".into(), version: 1, text: "fn main() {}".into() }).unwrap();
    let LspEvent::Diagnostics { diagnostics, path, .. } = wait_for(&store, |e| matches!(e, LspEvent::Diagnostics { .. })) else { unreachable!() };
    assert_eq!(diagnostics[0]["message"], "fake error");
    assert_eq!(path.unwrap().to_lowercase(), crate::dev::workspace::display(&file).to_lowercase());

    // Stale versions are dropped; newer ones are sent as full text.
    server.change(&uri, 1, "old".into()).unwrap();
    server.change(&uri, 2, "fn main() { }".into()).unwrap();
    let hover = server.request("textDocument/hover", json!({"textDocument": {"uri": uri}, "position": {"line": 0, "character": 1}})).unwrap();
    assert_eq!(hover["contents"], "hi");
    let changes: Vec<Value> = seen.lock().unwrap().iter().filter(|m| m["method"] == "textDocument/didChange").cloned().collect();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0]["params"]["contentChanges"][0]["text"], "fn main() { }");
    server.close(&uri).unwrap();
    assert!(server.idle_for().is_some());

    server.stop();
    wait_for(&store, |e| matches!(e, LspEvent::Status { state: "stopped", .. }));
    assert!(!server.alive());
    assert!(server.request("textDocument/hover", json!({})).is_err());
}

#[test]
fn request_timeout_sends_cancel() {
    let (to_server, server_in) = pipe();
    let (server_out, from_server) = pipe();
    let seen = Arc::new(Mutex::new(Vec::new()));
    fake_server(server_in, server_out, Arc::clone(&seen));
    let rpc = Rpc::start("t", Box::new(from_server), Box::new(to_server), |_, _| {}, |_, _| Ok(Value::Null), || {}).unwrap();
    let started = std::time::Instant::now();
    assert!(rpc.request("textDocument/slow", json!({}), Duration::from_millis(150)).is_err());
    assert!(started.elapsed() < Duration::from_secs(2));
    std::thread::sleep(Duration::from_millis(100));
    let cancel = seen.lock().unwrap().iter().find(|m| m["method"] == "$/cancelRequest").cloned().unwrap();
    assert_eq!(cancel["params"]["id"], json!(1));
    // Matching still works after a timed-out request.
    assert_eq!(rpc.request("textDocument/hover", json!({}), Duration::from_secs(2)).unwrap()["contents"], "hi");
}

#[test]
fn crash_wakes_waiting_requests() {
    let (to_server, _server_in) = pipe();
    let (server_out, from_server) = pipe();
    let (exit_tx, exit_rx) = mpsc::channel();
    let rpc = Rpc::start("t", Box::new(from_server), Box::new(to_server), |_, _| {}, |_, _| Ok(Value::Null), move || exit_tx.send(()).unwrap()).unwrap();
    let waiting = {
        let rpc = Arc::clone(&rpc);
        std::thread::spawn(move || rpc.request("textDocument/hover", json!({}), Duration::from_secs(30)))
    };
    std::thread::sleep(Duration::from_millis(50));
    drop(server_out); // the server's stdout closes
    exit_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(waiting.join().unwrap().is_err());
    assert!(!rpc.alive());
}

#[test]
fn uris_round_trip_windows_paths() {
    let p = std::path::Path::new(r"D:\Проект\src\main.rs");
    let uri = uri_for(p);
    assert!(uri.starts_with("file:///D:/"), "{uri}");
    assert_eq!(path_for(&uri).unwrap(), p);
    // VS Code style (lower-case, escaped colon) from servers.
    assert_eq!(path_for("file:///d%3A/x/y.ts").unwrap().to_string_lossy().to_lowercase(), r"d:\x\y.ts");
    assert!(path_for("untitled:1").is_none());
}

/// Real server, when installed (rustup component add rust-analyzer).
#[test]
fn rust_analyzer_smoke() {
    let spec = registry::spec("rust").unwrap();
    let Some(exe) = registry::locate(spec, None, None) else {
        eprintln!("rust-analyzer is not installed; skipping");
        return;
    };
    let dir = std::env::temp_dir().join(format!("nr-ra-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"ra_smoke\"\nversion = \"0.1.0\"\nedition = \"2021\"\n").unwrap();
    let text = "fn main() { let x: u32 = \"no\"; }\n";
    std::fs::write(dir.join("src").join("main.rs"), text).unwrap();
    let (sink, store) = events();
    let server = Server::spawn(spec, &exe, &dir, "rust|smoke".into(), sink).unwrap();
    let uri = uri_for(&dir.join("src").join("main.rs"));
    server.open(&uri, Doc { language_id: "rust".into(), version: 1, text: text.into() }).unwrap();
    let symbols = server.request("textDocument/documentSymbol", json!({"textDocument": {"uri": uri}})).unwrap();
    assert!(symbols.to_string().contains("main"), "{symbols}");
    server.stop();
    let _ = store;
    let _ = std::fs::remove_dir_all(&dir);
}

/// The whole bridge with a real typescript-language-server. Runs when
/// `NETRUNNER_LSP_SMOKE_DIR` names a folder whose `node_modules/.bin` has it
/// (`npm i typescript typescript-language-server` there).
#[test]
fn typescript_bridge_smoke() {
    let Some(dir) = std::env::var_os("NETRUNNER_LSP_SMOKE_DIR").map(std::path::PathBuf::from) else {
        eprintln!("NETRUNNER_LSP_SMOKE_DIR is not set; skipping");
        return;
    };
    let root = std::fs::canonicalize(&dir).unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("tsconfig.json"), r#"{"compilerOptions":{"strict":true,"target":"es2022","module":"esnext"}}"#).unwrap();
    let lib = "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n";
    std::fs::write(root.join("src").join("lib.ts"), lib).unwrap();
    let main = "import { greet } from \"./lib\";\nconst n: number = greet(\"a\");\n";
    std::fs::write(root.join("src").join("main.ts"), main).unwrap();

    let lsp = Arc::new(super::bridge::Lsp::default());
    let roots = vec![root.clone()];
    let path = crate::dev::workspace::display(&root.join("src").join("main.ts"));
    let opened = lsp.open(&roots, &Default::default(), &path, 1, main.into()).unwrap();
    let super::bridge::Opened::Ready { server, uri, capabilities, .. } = opened else { panic!("{opened:?}") };
    assert!(capabilities["completionProvider"].is_object());

    let def = lsp
        .request(&roots, &server, "textDocument/definition", json!({"textDocument": {"uri": uri}, "position": {"line": 1, "character": 20}}))
        .unwrap();
    // The call resolves to the import binding in main.ts.
    assert!(def.to_string().contains("main.ts") && def.to_string().contains("targetRange"), "{def}");
    let hover = lsp
        .request(&roots, &server, "textDocument/hover", json!({"textDocument": {"uri": uri}, "position": {"line": 1, "character": 20}}))
        .unwrap();
    assert!(hover["contents"]["value"].as_str().unwrap_or_default().contains("greet"), "{hover}");
    // Renaming at the declaration reaches every importer.
    let lib_path = crate::dev::workspace::display(&root.join("src").join("lib.ts"));
    let super::bridge::Opened::Ready { uri: lib_uri, .. } = lsp.open(&roots, &Default::default(), &lib_path, 1, lib.into()).unwrap() else { panic!() };
    let rename = lsp
        .request(&roots, &server, "textDocument/rename", json!({"textDocument": {"uri": lib_uri}, "position": {"line": 0, "character": 17}, "newName": "hello"}))
        .unwrap();
    lsp.close(&lib_uri).unwrap();
    assert!(rename.to_string().contains("lib.ts") && rename.to_string().contains("main.ts"), "{rename}");
    // Requests outside the allowlist or the open projects are refused.
    assert!(lsp.request(&roots, &server, "shutdown", Value::Null).is_err());
    assert!(lsp.request(&roots, &server, "textDocument/hover", json!({"textDocument": {"uri": "file:///C:/Windows/win.ini"}, "position": {"line": 0, "character": 0}})).is_err());
    lsp.close(&uri).unwrap();
    assert_eq!(lsp.running().len(), 1);
    lsp.stop_all();
    assert!(lsp.running().is_empty());
}
