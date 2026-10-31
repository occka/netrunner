//! Builds the context sent to the AI from attachments the user selected.
//!
//! The model never gets file-system access or tools: the backend reads only
//! the files listed in the request, enforces size limits and refuses files
//! that look like secrets. The UI previews exactly what will be sent.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::dev::workspace;
use crate::error::{AppError, AppResult};

const MAX_FILE: u64 = 256 * 1024;
const MAX_TOTAL: usize = 1024 * 1024;
const MAX_TREE_ENTRIES: usize = 600;

/// File names / extensions that typically hold credentials.
const SECRET_NAMES: &[&str] = &[".env", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "id_rsa", "id_ed25519", "id_ecdsa", "credentials", "secrets.json"];
const SECRET_EXTS: &[&str] = &["pem", "key", "pfx", "p12", "keystore", "jks", "kdbx", "ppk"];

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Attachment {
    /// A whole text file the user attached.
    File { path: String },
    /// Text the user selected (e.g. in the editor).
    Selection { label: String, text: String },
    /// File names (no contents) under a project root.
    Tree { root: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub label: String,
    pub bytes: usize,
    pub error: Option<String>,
}

pub fn is_secret(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    SECRET_NAMES.iter().any(|s| name == *s || name.starts_with(".env."))
        || SECRET_EXTS.contains(&ext.as_str())
        || path.components().any(|c| c.as_os_str().eq_ignore_ascii_case(".ssh"))
}

fn read_text(path: &str) -> AppResult<(String, String)> {
    let p = PathBuf::from(path);
    if is_secret(&p) {
        return Err(AppError::Invalid("looks like a credentials file; it is never sent to the AI".into()));
    }
    let meta = std::fs::metadata(&p).map_err(|_| AppError::NotFound("file not found".into()))?;
    if !meta.is_file() {
        return Err(AppError::Invalid("not a file".into()));
    }
    if meta.len() > MAX_FILE {
        return Err(AppError::Invalid(format!("larger than {} KB; attach a selection instead", MAX_FILE / 1024)));
    }
    let bytes = std::fs::read(&p)?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(AppError::Invalid("binary file".into()));
    }
    let text = String::from_utf8(bytes).map_err(|_| AppError::Invalid("not UTF-8 text".into()))?;
    Ok((workspace::display(&p), text))
}

fn tree(roots: &[PathBuf], root: &str) -> AppResult<(String, String)> {
    let base = workspace::resolve(roots, root, true)?;
    let mut lines = Vec::new();
    let mut stack = vec![(base.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries.into_iter().rev() {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
            if is_dir && matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist" | "build" | ".venv" | "venv" | "__pycache__" | "bin" | "obj" | ".idea" | ".next") {
                continue;
            }
            let rel = e.path().strip_prefix(&base).map(|r| r.display().to_string()).unwrap_or(name.clone());
            lines.push(if is_dir { format!("{rel}/") } else { rel });
            if is_dir && depth < 6 {
                stack.push((e.path(), depth + 1));
            }
            if lines.len() >= MAX_TREE_ENTRIES {
                lines.push("… (truncated)".into());
                lines.sort();
                return Ok((workspace::display(&base), lines.join("\n")));
            }
        }
    }
    lines.sort();
    Ok((workspace::display(&base), lines.join("\n")))
}

fn fence_lang(path: &str) -> &str {
    Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("")
}

/// Resolves attachments into one context block plus a per-item summary.
/// Items that fail (too big, secret, missing) are reported and skipped.
pub fn build(roots: &[PathBuf], attachments: &[Attachment]) -> (String, Vec<ContextItem>) {
    let mut out = String::new();
    let mut items = Vec::new();
    for a in attachments {
        let rendered: AppResult<(String, String)> = match a {
            Attachment::File { path } => read_text(path).map(|(p, text)| {
                (format!("File {p}"), format!("### File: {p}\n```{}\n{text}\n```\n", fence_lang(&p)))
            }),
            Attachment::Selection { label, text } => {
                if text.len() > MAX_FILE as usize {
                    Err(AppError::Invalid("selection is too large".into()))
                } else {
                    Ok((format!("Selection: {label}"), format!("### Selection from {label}\n```\n{text}\n```\n")))
                }
            }
            Attachment::Tree { root } => tree(roots, root).map(|(r, t)| (format!("File list of {r}"), format!("### Project file list: {r}\n```\n{t}\n```\n"))),
        };
        match rendered {
            Ok((label, block)) if out.len() + block.len() <= MAX_TOTAL => {
                items.push(ContextItem { label, bytes: block.len(), error: None });
                out.push_str(&block);
                out.push('\n');
            }
            Ok((label, _)) => items.push(ContextItem { label, bytes: 0, error: Some("total context limit (1 MB) reached".into()) }),
            Err(e) => items.push(ContextItem {
                label: match a {
                    Attachment::File { path } => format!("File {path}"),
                    Attachment::Selection { label, .. } => format!("Selection: {label}"),
                    Attachment::Tree { root } => format!("File list of {root}"),
                },
                bytes: 0,
                error: Some(e.to_string()),
            }),
        }
    }
    (out, items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_secret_files() {
        assert!(is_secret(Path::new(r"D:\p\.env")));
        assert!(is_secret(Path::new(r"D:\p\.env.local")));
        assert!(is_secret(Path::new(r"C:\Users\x\.ssh\config")));
        assert!(is_secret(Path::new(r"D:\certs\server.pem")));
        assert!(!is_secret(Path::new(r"D:\p\src\env.ts")));
        assert!(!is_secret(Path::new(r"D:\p\main.py")));
    }

    #[test]
    fn builds_context_with_limits() {
        let dir = std::env::temp_dir().join(format!("nr-ctx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = dir.join("a.py");
        std::fs::write(&ok, "print(1)\n").unwrap();
        let secret = dir.join(".env");
        std::fs::write(&secret, "TOKEN=x").unwrap();
        let (ctx, items) = build(
            &[],
            &[
                Attachment::File { path: ok.display().to_string() },
                Attachment::File { path: secret.display().to_string() },
                Attachment::Selection { label: "main.rs:1-2".into(), text: "fn main() {}".into() },
            ],
        );
        assert!(ctx.contains("print(1)") && ctx.contains("```py"));
        assert!(!ctx.contains("TOKEN=x"));
        assert!(items[1].error.is_some());
        assert!(ctx.contains("fn main() {}"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
