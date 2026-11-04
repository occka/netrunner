//! The folder a NEURAL chat owns: the only place on the machine its agent can
//! reach. Paths come from the model, so they are treated as hostile: relative
//! only, no links, text types only, with limits on size and count. Copies for
//! undo live outside the folder, where the model cannot see or change them.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

use super::context::is_secret;
use crate::error::{AppError, AppResult};

const MAX_FILE: usize = 256 * 1024;
const MAX_FILES: usize = 300;
const MAX_TOTAL: u64 = 16 * 1024 * 1024;
const MAX_DEPTH: usize = 5;
/// Files in the folder's root are sent with every message, up to this size.
const MAX_ROOT_CONTEXT: usize = 64 * 1024;
const MAX_IMAGE: usize = 8 * 1024 * 1024;
const KEEP_UNDO: usize = 200;
const IMAGES: &str = "images";
const TEXT_TYPES: &[&str] = &["md", "txt", "json", "csv", "yaml", "yml", "toml", "log", "py"];
const RESERVED: &[&str] = &["con", "prn", "aux", "nul"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: u64,
    pub added: usize,
    pub removed: usize,
    pub diff: String,
}

#[derive(Serialize, Deserialize)]
struct UndoRecord {
    path: String,
    before: Option<String>,
}

pub struct ChatFolder {
    root: PathBuf,
    undo: PathBuf,
}

/// Lines changed between two texts: the common start and end are skipped.
pub fn line_diff(before: &str, after: &str) -> (usize, usize, String) {
    let (a, b): (Vec<&str>, Vec<&str>) = (before.lines().collect(), after.lines().collect());
    let start = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let end = a[start..].iter().rev().zip(b[start..].iter().rev()).take_while(|(x, y)| x == y).count();
    let (removed, added) = (&a[start..a.len() - end], &b[start..b.len() - end]);
    let mut diff = String::new();
    for (sign, lines) in [('-', removed), ('+', added)] {
        for line in lines.iter().take(40) {
            if diff.len() < 4096 {
                diff.push(sign);
                diff.push(' ');
                diff.push_str(line);
                diff.push('\n');
            }
        }
    }
    (added.len(), removed.len(), diff)
}

fn clean_component(part: &str) -> AppResult<()> {
    let invalid = |why: &str| Err(AppError::Invalid(format!("invalid path: {why}")));
    if part.is_empty() || part == "." || part == ".." {
        return invalid("use a relative path inside the folder, without . or ..");
    }
    if part.starts_with('.') || part.ends_with('.') || part.ends_with(' ') || part.chars().count() > 120 {
        return invalid("name starts or ends with a dot or space, or is too long");
    }
    if part.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return invalid("name has characters Windows does not allow");
    }
    let stem = part.split('.').next().unwrap_or("").to_lowercase();
    let numbered = (stem.starts_with("com") || stem.starts_with("lpt")) && stem.len() == 4 && stem.ends_with(|c: char| c.is_ascii_digit());
    if RESERVED.contains(&stem.as_str()) || numbered {
        return invalid("reserved Windows name");
    }
    Ok(())
}

impl ChatFolder {
    pub fn new(data_dir: &Path, chat_id: i64) -> Self {
        let base = data_dir.join("neural");
        Self { root: base.join("chats").join(chat_id.to_string()), undo: base.join("undo").join(chat_id.to_string()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolves a path from the model to a location inside the folder.
    fn resolve(&self, rel: &str) -> AppResult<PathBuf> {
        let rel = rel.replace('\\', "/");
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.len() > MAX_DEPTH {
            return Err(AppError::Invalid("invalid path: too many nested folders".into()));
        }
        parts.iter().try_for_each(|p| clean_component(p))?;
        if parts[0].eq_ignore_ascii_case(IMAGES) {
            return Err(AppError::Invalid("invalid path: the images folder is managed by NETRUNNER".into()));
        }
        std::fs::create_dir_all(&self.root)?;
        let mut path = self.root.clone();
        for part in &parts {
            path.push(part);
            // A link or junction could lead out of the folder, so none is followed.
            if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(AppError::Invalid("invalid path: links are not followed".into()));
            }
        }
        let root = std::fs::canonicalize(&self.root)?;
        let existing = path.ancestors().find(|p| p.exists()).ok_or_else(|| AppError::Invalid("invalid path".into()))?;
        if !std::fs::canonicalize(existing)?.starts_with(&root) {
            return Err(AppError::Invalid("invalid path: outside the folder".into()));
        }
        if is_secret(&path) {
            return Err(AppError::Invalid("looks like a credentials file; not allowed here".into()));
        }
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !TEXT_TYPES.contains(&ext.as_str()) {
            return Err(AppError::Invalid(format!("only these file types are allowed: {}", TEXT_TYPES.join(", "))));
        }
        Ok(path)
    }

    /// Text files, images excluded; paths use `/`.
    pub fn list(&self) -> Vec<FileInfo> {
        let mut out = Vec::new();
        let mut stack = vec![(self.root.clone(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for entry in rd.flatten() {
                let Ok(kind) = entry.file_type() else { continue };
                let path = entry.path();
                if kind.is_symlink() || (depth == 0 && entry.file_name().eq_ignore_ascii_case(IMAGES)) {
                    continue;
                }
                if kind.is_dir() {
                    if depth < MAX_DEPTH {
                        stack.push((path, depth + 1));
                    }
                } else if let Ok(rel) = path.strip_prefix(&self.root) {
                    let rel = rel.display().to_string().replace('\\', "/");
                    out.push(FileInfo { path: rel, size: entry.metadata().map(|m| m.len()).unwrap_or(0) });
                }
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    pub fn read(&self, rel: &str) -> AppResult<String> {
        let path = self.resolve(rel)?;
        let meta = std::fs::metadata(&path).map_err(|_| AppError::NotFound(format!("no such file: {rel}")))?;
        if !meta.is_file() {
            return Err(AppError::Invalid("not a file".into()));
        }
        if meta.len() as usize > MAX_FILE {
            return Err(AppError::Invalid(format!("larger than {} KB", MAX_FILE / 1024)));
        }
        String::from_utf8(std::fs::read(&path)?).map_err(|_| AppError::Invalid("not UTF-8 text".into()))
    }

    /// Creates or replaces a file and keeps what was there for undo.
    pub fn write(&self, rel: &str, content: &str) -> AppResult<Change> {
        if content.len() > MAX_FILE {
            return Err(AppError::Invalid(format!("content is larger than {} KB", MAX_FILE / 1024)));
        }
        let path = self.resolve(rel)?;
        if path.is_dir() {
            return Err(AppError::Invalid("that path is a folder".into()));
        }
        let before = if path.exists() { Some(self.read(rel)?) } else { None };
        let files = self.list();
        if before.is_none() && files.len() >= MAX_FILES {
            return Err(AppError::Invalid(format!("the folder already has {MAX_FILES} files")));
        }
        let old = before.as_ref().map_or(0, |b| b.len() as u64);
        if files.iter().map(|f| f.size).sum::<u64>() - old + content.len() as u64 > MAX_TOTAL {
            return Err(AppError::Invalid("the folder is full (16 MB)".into()));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let id = self.save_undo(rel, before.as_deref())?;
        let tmp = path.with_extension("netrunner-tmp");
        std::fs::write(&tmp, content)?;
        std::fs::rename(&tmp, &path)?;
        let (added, removed, diff) = line_diff(before.as_deref().unwrap_or(""), content);
        Ok(Change { id, added, removed, diff })
    }

    pub fn append(&self, rel: &str, text: &str) -> AppResult<Change> {
        let path = self.resolve(rel)?;
        let mut content = if path.exists() { self.read(rel)? } else { String::new() };
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(text);
        self.write(rel, &content)
    }

    /// Replaces one exact, unique piece of text.
    pub fn edit(&self, rel: &str, old_text: &str, new_text: &str) -> AppResult<Change> {
        let content = self.read(rel)?;
        if old_text.is_empty() {
            return Err(AppError::Invalid("old_text is empty".into()));
        }
        match content.matches(old_text).count() {
            0 => Err(AppError::NotFound("old_text was not found in the file; read it again".into())),
            1 => self.write(rel, &content.replacen(old_text, new_text, 1)),
            n => Err(AppError::Invalid(format!("old_text matches {n} places; include more of the surrounding text"))),
        }
    }

    fn save_undo(&self, rel: &str, before: Option<&str>) -> AppResult<u64> {
        std::fs::create_dir_all(&self.undo)?;
        let mut ids: Vec<u64> = std::fs::read_dir(&self.undo)?
            .flatten()
            .filter_map(|e| e.path().file_stem()?.to_str()?.parse().ok())
            .collect();
        ids.sort_unstable();
        let id = ids.last().copied().unwrap_or(0) + 1;
        for old in ids.iter().take((ids.len() + 1).saturating_sub(KEEP_UNDO)) {
            let _ = std::fs::remove_file(self.undo.join(format!("{old}.json")));
        }
        let record = UndoRecord { path: rel.to_string(), before: before.map(str::to_string) };
        std::fs::write(self.undo.join(format!("{id}.json")), serde_json::to_vec(&record)?)?;
        Ok(id)
    }

    pub fn can_undo(&self, id: u64) -> bool {
        self.undo.join(format!("{id}.json")).exists()
    }

    /// Returns the file to how it was before that change.
    pub fn undo(&self, id: u64) -> AppResult<String> {
        let record_path = self.undo.join(format!("{id}.json"));
        let bytes = std::fs::read(&record_path).map_err(|_| AppError::NotFound("this change can no longer be undone".into()))?;
        let record: UndoRecord = serde_json::from_slice(&bytes)?;
        let path = self.resolve(&record.path)?;
        match &record.before {
            Some(text) => std::fs::write(&path, text)?,
            None => {
                if path.exists() {
                    std::fs::remove_file(&path)?;
                }
            }
        }
        let _ = std::fs::remove_file(record_path);
        Ok(record.path)
    }

    /// What the model always sees: every file's name, and the root files' text.
    pub fn context(&self) -> String {
        let files = self.list();
        if files.is_empty() {
            return "Your folder is empty.".into();
        }
        let mut out = String::from("Files in your folder:\n");
        for f in &files {
            out.push_str(&format!("- {} ({} bytes)\n", f.path, f.size));
        }
        let mut used = 0;
        for f in files.iter().filter(|f| !f.path.contains('/')) {
            match self.read(&f.path) {
                Ok(text) if used + text.len() <= MAX_ROOT_CONTEXT => {
                    used += text.len();
                    out.push_str(&format!("\n### {} (current contents)\n{text}\n", f.path));
                }
                _ => out.push_str(&format!("\n### {} is not included: too large for the context; use read_file\n", f.path)),
            }
        }
        out
    }

    // ---------- Photos (added by the user, never by the model) ----------

    pub fn save_image(&self, data_base64: &str) -> AppResult<String> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64).map_err(|_| AppError::Invalid("invalid image data".into()))?;
        if bytes.len() > MAX_IMAGE {
            return Err(AppError::Invalid("image is too large".into()));
        }
        if !bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            return Err(AppError::Invalid("not a JPEG image".into()));
        }
        let dir = self.root.join(IMAGES);
        std::fs::create_dir_all(&dir)?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
        let name = format!("img-{stamp}.jpg");
        std::fs::write(dir.join(&name), bytes)?;
        Ok(name)
    }

    /// Base64 JPEG. Names are checked: they come back from the UI and history.
    pub fn read_image(&self, name: &str) -> AppResult<String> {
        let plain = name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
        if !plain || !name.starts_with("img-") || !name.ends_with(".jpg") || name.contains("..") {
            return Err(AppError::Invalid("invalid image name".into()));
        }
        let bytes = std::fs::read(self.root.join(IMAGES).join(name)).map_err(|_| AppError::NotFound("image not found".into()))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    /// Deleting a chat: its files go to the Recycle Bin, undo copies are dropped.
    pub fn remove(&self) -> AppResult<()> {
        if self.root.exists() {
            trash::delete(&self.root).map_err(|e| AppError::Internal(format!("cannot move the chat folder to the Recycle Bin: {e}")))?;
        }
        if self.undo.exists() {
            let _ = std::fs::remove_dir_all(&self.undo);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(tag: &str) -> (PathBuf, ChatFolder) {
        let base = std::env::temp_dir().join(format!("nr-folder-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let f = ChatFolder::new(&base, 7);
        (base, f)
    }

    #[test]
    fn refuses_every_way_out_of_the_folder() {
        let (base, f) = folder("paths");
        std::fs::create_dir_all(base.join("neural/chats/7")).unwrap();
        std::fs::write(base.join("secret.md"), "top secret").unwrap();
        for bad in [
            "../secret.md",
            "../../secret.md",
            "a/../../../secret.md",
            "..\\secret.md",
            "/etc/passwd",
            "C:/Windows/win.ini",
            "C:\\Windows\\win.ini",
            "\\\\server\\share\\a.md",
            "\\\\?\\C:\\a.md",
            "notes.md:hidden",
            "con.md",
            "COM1.txt",
            "lpt9.md",
            ".env",
            ".hidden/a.md",
            "a./b.md",
            "b.md ",
            "",
            "a//b.md",
            "a/b/c/d/e/f.md",
            "tool.exe",
            "run.bat",
            "script.ps1",
            "noextension",
            "images/a.md",
            "server.key.md/../x.pem",
        ] {
            assert!(f.write(bad, "x").is_err(), "write must refuse {bad:?}");
            assert!(f.read(bad).is_err(), "read must refuse {bad:?}");
        }
        assert_eq!(std::fs::read_to_string(base.join("secret.md")).unwrap(), "top secret");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn does_not_follow_a_junction() {
        let (base, f) = folder("junction");
        let root = f.root().to_path_buf();
        std::fs::create_dir_all(&root).unwrap();
        let outside = base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("a.md"), "outside").unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &root.join("link").display().to_string(), &outside.display().to_string()])
            .output()
            .unwrap();
        assert!(made.status.success());
        assert!(f.read("link/a.md").is_err());
        assert!(f.write("link/b.md", "x").is_err());
        assert!(!outside.join("b.md").exists());
        assert!(f.list().is_empty(), "links are not listed");
        let _ = std::process::Command::new("cmd").args(["/C", "rmdir", &root.join("link").display().to_string()]).output();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn writes_edits_appends_and_undoes() {
        let (base, f) = folder("edit");
        let first = f.write("npcs/mira.md", "Mira\nHP 10\n").unwrap();
        assert_eq!((first.added, first.removed), (2, 0));
        let edit = f.edit("npcs/mira.md", "HP 10", "HP 3").unwrap();
        assert_eq!((edit.added, edit.removed), (1, 1));
        assert!(edit.diff.contains("- HP 10") && edit.diff.contains("+ HP 3"));
        assert!(f.edit("npcs/mira.md", "missing", "x").is_err());
        f.append("log.md", "turn 1").unwrap();
        f.append("log.md", "turn 2").unwrap();
        assert_eq!(f.read("log.md").unwrap(), "turn 1\nturn 2");
        assert_eq!(f.list().iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), ["log.md", "npcs/mira.md"]);

        assert!(f.can_undo(edit.id));
        assert_eq!(f.undo(edit.id).unwrap(), "npcs/mira.md");
        assert!(f.read("npcs/mira.md").unwrap().contains("HP 10"));
        assert!(!f.can_undo(edit.id), "a change is undone once");
        f.undo(first.id).unwrap();
        assert!(f.read("npcs/mira.md").is_err(), "undoing a creation removes the file");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn limits_size_and_context() {
        let (base, f) = folder("limits");
        assert!(f.write("big.md", &"x".repeat(MAX_FILE + 1)).is_err());
        f.write("player.md", "HP 12").unwrap();
        f.write("npcs/far.md", "only on request").unwrap();
        f.write("huge.md", &"y".repeat(MAX_ROOT_CONTEXT + 1)).unwrap();
        let ctx = f.context();
        assert!(ctx.contains("- npcs/far.md") && ctx.contains("HP 12"));
        assert!(!ctx.contains("only on request"), "subfolders are read on request");
        assert!(ctx.contains("huge.md is not included"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn keeps_only_real_jpegs_and_checks_names() {
        let (base, f) = folder("images");
        let good = base64::engine::general_purpose::STANDARD.encode([0xFF, 0xD8, 0xFF, 0xE0, 1, 2]);
        let name = f.save_image(&good).unwrap();
        assert_eq!(f.read_image(&name).unwrap(), good);
        assert!(f.save_image(&base64::engine::general_purpose::STANDARD.encode(b"<html>")).is_err());
        for bad in ["../x.jpg", "img-..\\a.jpg", "a.jpg", "img-a.png", "img-../../a.jpg"] {
            assert!(f.read_image(bad).is_err(), "{bad}");
        }
        assert!(f.list().is_empty(), "photos are not listed as text files");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn diff_skips_the_common_start_and_end() {
        let (a, r, d) = line_diff("a\nb\nc\n", "a\nX\nY\nc\n");
        assert_eq!((a, r), (2, 1));
        assert_eq!(d, "- b\n+ X\n+ Y\n");
        assert_eq!(line_diff("same", "same").2, "");
    }
}
