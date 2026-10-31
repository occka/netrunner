//! Project workspace file access for the DEVELOPER module.
//!
//! Every path is canonicalised and must lie inside a project root the user
//! opened explicitly. The `.git` directory is read-only through this API.
//! Deletion moves items to the Recycle Bin instead of erasing them.

use std::fs;
use std::path::{Component, Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::services::settings;

pub const ROOTS_KEY: &str = "developer.roots";
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ROOTS: usize = 20;
/// Large generated folders: listed, but flagged so the UI does not auto-expand them.
const HEAVY: &[&str] = &["node_modules", "target", ".git", "dist", "build", "bin", "obj", ".venv", "venv", "__pycache__", ".gradle", ".idea", ".next"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub heavy: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    /// True when the file is not valid UTF-8 / binary; such files are opened read-only.
    pub read_only: bool,
    pub binary: bool,
    pub size: u64,
}

/// Windows canonical paths carry a `\\?\` prefix; strip it for display.
pub fn display(p: &Path) -> String {
    let s = p.display().to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

pub fn roots(conn: &Connection) -> AppResult<Vec<PathBuf>> {
    Ok(settings::get(conn, ROOTS_KEY)?
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect())
}

/// Registers a folder as a project root (most recent first).
pub fn add_root(conn: &Connection, path: &str) -> AppResult<String> {
    let canonical = fs::canonicalize(path).map_err(|_| AppError::NotFound(format!("folder not found: {path}")))?;
    if !canonical.is_dir() {
        return Err(AppError::Invalid("a project must be a folder".into()));
    }
    let shown = display(&canonical);
    let mut list: Vec<String> = roots(conn)?.iter().map(|p| display(p)).filter(|p| !p.eq_ignore_ascii_case(&shown)).collect();
    list.insert(0, shown.clone());
    list.truncate(MAX_ROOTS);
    settings::set(conn, ROOTS_KEY, &json!(list))?;
    Ok(shown)
}

pub fn remove_root(conn: &Connection, path: &str) -> AppResult<()> {
    let list: Vec<String> = roots(conn)?.iter().map(|p| display(p)).filter(|p| !p.eq_ignore_ascii_case(path)).collect();
    settings::set(conn, ROOTS_KEY, &json!(list))?;
    Ok(())
}

/// Resolves `path` and checks it lies inside one of `roots`. For paths that do
/// not exist yet (create/rename targets) the parent must exist and be inside.
pub fn resolve(roots: &[PathBuf], path: &str, must_exist: bool) -> AppResult<PathBuf> {
    let raw = Path::new(path);
    if raw.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::Invalid("relative '..' segments are not allowed".into()));
    }
    let resolved = if raw.exists() {
        fs::canonicalize(raw)?
    } else if must_exist {
        return Err(AppError::NotFound(format!("not found: {path}")));
    } else {
        let parent = raw.parent().ok_or_else(|| AppError::Invalid("invalid path".into()))?;
        let name = raw.file_name().ok_or_else(|| AppError::Invalid("invalid file name".into()))?;
        fs::canonicalize(parent).map_err(|_| AppError::NotFound("parent folder not found".into()))?.join(name)
    };
    let inside = roots
        .iter()
        .filter_map(|r| fs::canonicalize(r).ok())
        .any(|r| resolved.starts_with(&r));
    if !inside {
        return Err(AppError::Invalid("path is outside the open projects".into()));
    }
    Ok(resolved)
}

fn ensure_writable(p: &Path) -> AppResult<()> {
    if p.components().any(|c| c.as_os_str().eq_ignore_ascii_case(".git")) {
        return Err(AppError::Invalid("the .git folder is managed by Git and cannot be edited here".into()));
    }
    Ok(())
}

fn validate_name(name: &str) -> AppResult<()> {
    let bad = name.is_empty()
        || name.len() > 255
        || name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control())
        || name.ends_with(' ')
        || name.ends_with('.');
    if bad {
        Err(AppError::Invalid(format!("'{name}' is not a valid file name")))
    } else {
        Ok(())
    }
}

pub fn list_dir(roots: &[PathBuf], path: &str) -> AppResult<Vec<DirEntry>> {
    let dir = resolve(roots, path, true)?;
    let mut out: Vec<DirEntry> = fs::read_dir(&dir)?
        .flatten()
        .map(|e| {
            let meta = e.metadata().ok();
            let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
            let name = e.file_name().to_string_lossy().into_owned();
            DirEntry {
                heavy: is_dir && HEAVY.iter().any(|h| name.eq_ignore_ascii_case(h)),
                path: display(&e.path()),
                size: if is_dir { None } else { meta.map(|m| m.len()) },
                is_dir,
                name,
            }
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

pub fn read_file(roots: &[PathBuf], path: &str) -> AppResult<FileContent> {
    let p = resolve(roots, path, true)?;
    let size = fs::metadata(&p)?.len();
    if size > MAX_FILE_BYTES {
        return Err(AppError::Invalid(format!("file is too large to edit ({} MB limit)", MAX_FILE_BYTES / 1024 / 1024)));
    }
    let bytes = fs::read(&p)?;
    let binary = bytes.iter().take(8192).any(|b| *b == 0);
    let (content, read_only) = if binary {
        (String::new(), true)
    } else {
        match String::from_utf8(bytes) {
            Ok(s) => (s, false),
            Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), true),
        }
    };
    Ok(FileContent { path: display(&p), content, read_only: read_only || ensure_writable(&p).is_err(), binary, size })
}

/// Writes atomically: a temp file next to the target, then a rename.
pub fn write_file(roots: &[PathBuf], path: &str, content: &str) -> AppResult<()> {
    let p = resolve(roots, path, false)?;
    ensure_writable(&p)?;
    let tmp = p.with_file_name(format!(".{}.nr-tmp", p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
    fs::write(&tmp, content.as_bytes())?;
    fs::rename(&tmp, &p).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(())
}

pub fn create(roots: &[PathBuf], parent: &str, name: &str, dir: bool) -> AppResult<String> {
    validate_name(name)?;
    let parent = resolve(roots, parent, true)?;
    let target = parent.join(name);
    ensure_writable(&target)?;
    if target.exists() {
        return Err(AppError::Invalid(format!("'{name}' already exists")));
    }
    if dir {
        fs::create_dir(&target)?;
    } else {
        fs::OpenOptions::new().write(true).create_new(true).open(&target)?;
    }
    Ok(display(&target))
}

pub fn rename(roots: &[PathBuf], path: &str, new_name: &str) -> AppResult<String> {
    validate_name(new_name)?;
    let from = resolve(roots, path, true)?;
    ensure_writable(&from)?;
    if roots.iter().filter_map(|r| fs::canonicalize(r).ok()).any(|r| r == from) {
        return Err(AppError::Invalid("a project root cannot be renamed here".into()));
    }
    let to = from.with_file_name(new_name);
    if to.exists() && !to.to_string_lossy().eq_ignore_ascii_case(&from.to_string_lossy()) {
        return Err(AppError::Invalid(format!("'{new_name}' already exists")));
    }
    fs::rename(&from, &to)?;
    Ok(display(&to))
}

/// Moves a file or folder to the Windows Recycle Bin (recoverable).
pub fn recycle(roots: &[PathBuf], path: &str) -> AppResult<()> {
    let p = resolve(roots, path, true)?;
    ensure_writable(&p)?;
    if roots.iter().filter_map(|r| fs::canonicalize(r).ok()).any(|r| r == p) {
        return Err(AppError::Invalid("close the project instead of deleting its root folder".into()));
    }
    trash::delete(&p).map_err(|e| AppError::Internal(format!("could not move to Recycle Bin: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nr-ws-test-{}-{}", std::process::id(), rand_suffix()));
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::canonicalize(dir).unwrap()
    }
    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn scoped_file_operations() {
        let root = temp_root();
        let roots = vec![root.clone()];
        let r = display(&root);
        let file = create(&roots, &r, "main.py", false).unwrap();
        write_file(&roots, &file, "print('hi')\n").unwrap();
        assert_eq!(read_file(&roots, &file).unwrap().content, "print('hi')\n");
        let renamed = rename(&roots, &file, "app.py").unwrap();
        assert!(renamed.ends_with("app.py"));
        assert!(list_dir(&roots, &r).unwrap().iter().any(|e| e.name == "app.py"));
        // Escapes are rejected.
        assert!(read_file(&roots, &format!(r"{r}\..\outside.txt")).is_err());
        assert!(list_dir(&roots, r"C:\Windows").is_err());
        assert!(create(&roots, &r, "bad:name", false).is_err());
        // .git is read-only.
        fs::create_dir(root.join(".git")).unwrap();
        assert!(write_file(&roots, &format!(r"{r}\.git\config"), "x").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn binary_files_open_read_only() {
        let root = temp_root();
        let roots = vec![root.clone()];
        let p = root.join("blob.bin");
        fs::write(&p, [0u8, 1, 2, 3]).unwrap();
        let c = read_file(&roots, &display(&p)).unwrap();
        assert!(c.binary && c.read_only);
        let _ = fs::remove_dir_all(&root);
    }
}
