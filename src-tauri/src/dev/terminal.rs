//! Integrated terminal: real Windows pseudo-consoles (ConPTY) via portable-pty.
//! Output streams to the UI over a Tauri channel; input is written verbatim.
//! Only an allowlisted set of shells can be started.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::error::{AppError, AppResult};

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOption {
    pub id: &'static str,
    pub label: &'static str,
}

fn shell_command(id: &str) -> Option<CommandBuilder> {
    let git_bash = PathBuf::from(r"C:\Program Files\Git\bin\bash.exe");
    let mut cmd = match id {
        "powershell" => {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoLogo");
            c
        }
        "pwsh" => {
            let mut c = CommandBuilder::new("pwsh.exe");
            c.arg("-NoLogo");
            c
        }
        "cmd" => CommandBuilder::new("cmd.exe"),
        "gitbash" if git_bash.is_file() => {
            let mut c = CommandBuilder::new(git_bash);
            c.args(["--login", "-i"]);
            c
        }
        _ => return None,
    };
    cmd.env("TERM", "xterm-256color");
    cmd.env("NETRUNNER", "1");
    Some(cmd)
}

pub fn available_shells() -> Vec<ShellOption> {
    let mut out = vec![ShellOption { id: "powershell", label: "Windows PowerShell" }, ShellOption { id: "cmd", label: "Command Prompt" }];
    if crate::dev::process::run("where.exe", &["pwsh.exe"], None, std::time::Duration::from_secs(3)).is_ok_and(|o| o.ok()) {
        out.insert(0, ShellOption { id: "pwsh", label: "PowerShell 7" });
    }
    if std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe").is_file() {
        out.push(ShellOption { id: "gitbash", label: "Git Bash" });
    }
    out
}

/// Decodes a UTF-8 byte stream that may split characters across reads.
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self { pending: Vec::new() }
    }

    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    return out;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
                    match e.error_len() {
                        // Invalid bytes: replace and continue after them.
                        Some(len) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + len);
                        }
                        // Incomplete sequence at the end: keep it for the next read.
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                    }
                }
            }
        }
    }
}

impl Terminals {
    pub fn spawn(&self, shell: &str, cwd: Option<PathBuf>, cols: u16, rows: u16, channel: Channel<TermEvent>) -> AppResult<u32> {
        let mut cmd = shell_command(shell).ok_or_else(|| AppError::Invalid(format!("unsupported shell '{shell}'")))?;
        let dir = cwd.or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from));
        if let Some(d) = dir {
            cmd.cwd(d);
        }
        let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
        let pair = native_pty_system().openpty(size).map_err(|e| AppError::Launch(format!("cannot open terminal: {e}")))?;
        let child = pair.slave.spawn_command(cmd).map_err(|e| AppError::Launch(format!("cannot start shell: {e}")))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| AppError::Internal(e.to_string()))?;
        let writer = pair.master.take_writer().map_err(|e| AppError::Internal(e.to_string()))?;

        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().map_err(|_| AppError::Internal("terminal lock poisoned".into()))?.insert(id, Session {
            master: pair.master,
            writer,
            child,
        });

        let sessions = Arc::clone(&self.sessions);
        std::thread::Builder::new()
            .name(format!("nr-term-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                let mut decoder = Utf8Stream::new();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let data = decoder.push(&buf[..n]);
                            if !data.is_empty() && channel.send(TermEvent::Data { data }).is_err() {
                                break;
                            }
                        }
                    }
                }
                let code = sessions
                    .lock()
                    .ok()
                    .and_then(|mut s| s.remove(&id))
                    .and_then(|mut s| s.child.wait().ok())
                    .map(|status| status.exit_code());
                let _ = channel.send(TermEvent::Exit { code });
            })
            .map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(id)
    }

    fn with<T>(&self, id: u32, f: impl FnOnce(&mut Session) -> AppResult<T>) -> AppResult<T> {
        let mut map = self.sessions.lock().map_err(|_| AppError::Internal("terminal lock poisoned".into()))?;
        let session = map.get_mut(&id).ok_or_else(|| AppError::NotFound("terminal session has ended".into()))?;
        f(session)
    }

    pub fn write(&self, id: u32, data: &str) -> AppResult<()> {
        self.with(id, |s| {
            s.writer.write_all(data.as_bytes())?;
            s.writer.flush()?;
            Ok(())
        })
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> AppResult<()> {
        self.with(id, |s| {
            s.master
                .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
                .map_err(|e| AppError::Internal(e.to_string()))
        })
    }

    pub fn kill(&self, id: u32) -> AppResult<()> {
        self.with(id, |s| s.child.kill().map_err(|e| AppError::Internal(e.to_string())))
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8Stream;

    #[test]
    fn utf8_stream_handles_split_characters() {
        let text = "привет ▸ ok";
        let bytes = text.as_bytes();
        let mut d = Utf8Stream::new();
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            out.push_str(&d.push(chunk));
        }
        assert_eq!(out, text);
        assert_eq!(d.push(&[0xff, b'a']), "\u{FFFD}a");
    }
}
