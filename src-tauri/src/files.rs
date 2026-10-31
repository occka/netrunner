//! FILES module backend: a general file manager driven by the user.
//!
//! Unlike DEVELOPER (scoped to project roots), FILES may browse any folder
//! the user navigates to. Modifications are refused inside Windows system
//! folders and on drive roots, and deletion always goes to the Recycle Bin.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::services::launcher::expand_env;

const PREVIEW_TEXT: u64 = 512 * 1024;
const PREVIEW_IMAGE: u64 = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub path: String,
    pub label: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    /// Unix milliseconds.
    pub modified: Option<u64>,
    pub hidden: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Preview {
    Text { text: String, truncated: bool },
    Image { data_url: String },
    None { reason: String },
}

fn display(p: &Path) -> String {
    let s = p.display().to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

#[cfg(windows)]
fn is_hidden(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    meta.file_attributes() & (HIDDEN | SYSTEM) != 0
}
#[cfg(not(windows))]
fn is_hidden(_meta: &fs::Metadata) -> bool {
    false
}

/// Folders NETRUNNER will not modify (reading is fine).
fn protected_roots() -> Vec<PathBuf> {
    [r"%WINDIR%", r"%ProgramFiles%", r"%ProgramFiles(x86)%", r"%ProgramData%\Microsoft"]
        .iter()
        .map(|p| PathBuf::from(expand_env(p)))
        .filter_map(|p| fs::canonicalize(p).ok())
        .collect()
}

/// Checks a path may be modified: absolute, not a drive root, not in a system folder.
pub fn ensure_modifiable(path: &Path) -> AppResult<PathBuf> {
    if !path.is_absolute() {
        return Err(AppError::Invalid("an absolute path is required".into()));
    }
    let canonical = fs::canonicalize(path).map_err(|_| AppError::NotFound(format!("not found: {}", path.display())))?;
    // A drive root (`\\?\C:\`) has no parent.
    if canonical.parent().is_none() {
        return Err(AppError::Invalid("drive roots cannot be modified".into()));
    }
    if protected_roots().iter().any(|r| canonical.starts_with(r)) {
        return Err(AppError::Invalid("Windows system and program folders are protected".into()));
    }
    Ok(canonical)
}

fn valid_name(name: &str) -> AppResult<()> {
    let bad = name.is_empty()
        || name.len() > 255
        || name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control())
        || name.ends_with(['.', ' ']);
    if bad {
        Err(AppError::Invalid(format!("'{name}' is not a valid name")))
    } else {
        Ok(())
    }
}

pub fn drives() -> Vec<Drive> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut out: Vec<Drive> = disks
        .list()
        .iter()
        .map(|d| Drive {
            path: d.mount_point().display().to_string(),
            label: d.name().to_string_lossy().into_owned(),
            total_bytes: d.total_space(),
            free_bytes: d.available_space(),
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Common user folders shown in the FILES sidebar.
pub fn places() -> Vec<(String, String)> {
    [("Home", "%USERPROFILE%"), ("Desktop", r"%USERPROFILE%\Desktop"), ("Documents", r"%USERPROFILE%\Documents"), ("Downloads", r"%USERPROFILE%\Downloads"), ("Pictures", r"%USERPROFILE%\Pictures")]
        .iter()
        .map(|(n, p)| (n.to_string(), expand_env(p)))
        .filter(|(_, p)| Path::new(p).is_dir())
        .collect()
}

pub fn list(path: &str) -> AppResult<Vec<Entry>> {
    let dir = Path::new(path);
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("folder not found: {path}")));
    }
    let mut out: Vec<Entry> = fs::read_dir(dir)
        .map_err(|e| AppError::Invalid(format!("cannot open folder: {e}")))?
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some(Entry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: display(&e.path()),
                is_dir: meta.is_dir(),
                size: meta.is_file().then_some(meta.len()),
                modified: modified_ms(&meta),
                hidden: is_hidden(&meta),
            })
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

pub fn preview(path: &str) -> AppResult<Preview> {
    let p = Path::new(path);
    let meta = fs::metadata(p).map_err(|_| AppError::NotFound("not found".into()))?;
    if meta.is_dir() {
        return Ok(Preview::None { reason: "folder".into() });
    }
    if crate::neural::context::is_secret(p) {
        return Ok(Preview::None { reason: "credentials file (preview disabled)".into() });
    }
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    };
    if let Some(mime) = mime {
        if meta.len() > PREVIEW_IMAGE {
            return Ok(Preview::None { reason: "image is too large to preview".into() });
        }
        let data = base64::engine::general_purpose::STANDARD.encode(fs::read(p)?);
        return Ok(Preview::Image { data_url: format!("data:{mime};base64,{data}") });
    }
    let mut bytes = Vec::new();
    use std::io::Read;
    fs::File::open(p)?.take(PREVIEW_TEXT).read_to_end(&mut bytes)?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Ok(Preview::None { reason: "binary file".into() });
    }
    Ok(Preview::Text { text: String::from_utf8_lossy(&bytes).into_owned(), truncated: meta.len() > PREVIEW_TEXT })
}

pub fn create_dir(parent: &str, name: &str) -> AppResult<String> {
    valid_name(name)?;
    let parent = ensure_modifiable(Path::new(parent)).or_else(|e| {
        // Creating inside a drive root (e.g. D:\New folder) is allowed.
        let p = Path::new(parent);
        if p.parent().is_none() && p.is_dir() { Ok(p.to_path_buf()) } else { Err(e) }
    })?;
    let target = parent.join(name);
    if target.exists() {
        return Err(AppError::Invalid(format!("'{name}' already exists")));
    }
    fs::create_dir(&target)?;
    Ok(display(&target))
}

pub fn rename(path: &str, new_name: &str) -> AppResult<String> {
    valid_name(new_name)?;
    let from = ensure_modifiable(Path::new(path))?;
    let to = from.with_file_name(new_name);
    if to.exists() && !display(&to).eq_ignore_ascii_case(&display(&from)) {
        return Err(AppError::Invalid(format!("'{new_name}' already exists")));
    }
    fs::rename(&from, &to)?;
    Ok(display(&to))
}

fn copy_recursive(from: &Path, to: &Path) -> AppResult<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for e in fs::read_dir(from)?.flatten() {
            copy_recursive(&e.path(), &to.join(e.file_name()))?;
        }
    } else {
        fs::copy(from, to)?;
    }
    Ok(())
}

/// Picks "name - Copy", "name - Copy (2)", … when the target exists.
fn free_target(dest: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let first = dest.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..1000)
        .map(|i| dest.join(if i == 1 { format!("{stem} - Copy{ext}") } else { format!("{stem} - Copy ({i}){ext}") }))
        .find(|c| !c.exists())
        .unwrap_or(first)
}

pub fn transfer(paths: &[String], dest: &str, move_items: bool) -> AppResult<usize> {
    let dest_dir = fs::canonicalize(dest).map_err(|_| AppError::NotFound("destination not found".into()))?;
    if !dest_dir.is_dir() {
        return Err(AppError::Invalid("destination must be a folder".into()));
    }
    if protected_roots().iter().any(|r| dest_dir.starts_with(r)) {
        return Err(AppError::Invalid("Windows system and program folders are protected".into()));
    }
    let mut done = 0;
    for p in paths {
        let src = if move_items { ensure_modifiable(Path::new(p))? } else { fs::canonicalize(p).map_err(|_| AppError::NotFound(format!("not found: {p}")))? };
        if dest_dir.starts_with(&src) {
            return Err(AppError::Invalid("cannot copy or move a folder into itself".into()));
        }
        let name = src.file_name().ok_or_else(|| AppError::Invalid("invalid source".into()))?;
        if move_items {
            let target = dest_dir.join(name);
            if target.exists() {
                return Err(AppError::Invalid(format!("'{}' already exists in the destination", name.to_string_lossy())));
            }
            // rename fails across volumes; fall back to copy + recycle.
            if fs::rename(&src, &target).is_err() {
                copy_recursive(&src, &target)?;
                trash::delete(&src).map_err(|e| AppError::Internal(format!("copied, but could not remove the original: {e}")))?;
            }
        } else {
            copy_recursive(&src, &free_target(&dest_dir, name))?;
        }
        done += 1;
    }
    Ok(done)
}

pub fn recycle(paths: &[String]) -> AppResult<usize> {
    let checked: Vec<PathBuf> = paths.iter().map(|p| ensure_modifiable(Path::new(p))).collect::<AppResult<_>>()?;
    trash::delete_all(&checked).map_err(|e| AppError::Internal(format!("could not move to Recycle Bin: {e}")))?;
    Ok(checked.len())
}

/// Name search below `root`, bounded in results, depth and time (no index).
pub fn search(root: &str, query: &str) -> AppResult<(Vec<Entry>, bool)> {
    let q = query.trim().to_lowercase();
    if q.len() < 2 {
        return Err(AppError::Invalid("enter at least 2 characters".into()));
    }
    let start = Instant::now();
    let mut out = Vec::new();
    let mut stack = vec![(PathBuf::from(root), 0usize)];
    let mut complete = true;
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= 500 || start.elapsed() > Duration::from_secs(6) {
            complete = false;
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            if name.to_lowercase().contains(&q) {
                out.push(Entry {
                    path: display(&e.path()),
                    is_dir: meta.is_dir(),
                    size: meta.is_file().then_some(meta.len()),
                    modified: modified_ms(&meta),
                    hidden: is_hidden(&meta),
                    name,
                });
            }
            if meta.is_dir() && depth < 12 && !meta.file_type().is_symlink() {
                stack.push((e.path(), depth + 1));
            }
        }
    }
    Ok((out, complete))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_system_folders_and_roots() {
        assert!(ensure_modifiable(&PathBuf::from(expand_env(r"%WINDIR%\System32"))).is_err());
        assert!(ensure_modifiable(Path::new(r"C:\")).is_err());
        assert!(ensure_modifiable(Path::new("relative.txt")).is_err());
    }

    #[test]
    fn file_operations_round_trip() {
        let base = std::env::temp_dir().join(format!("nr-files-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let b = display(&fs::canonicalize(&base).unwrap());
        let sub = create_dir(&b, "sub").unwrap();
        fs::write(base.join("a.txt"), "hello").unwrap();
        let a = format!(r"{b}\a.txt");
        assert_eq!(transfer(std::slice::from_ref(&a), &sub, false).unwrap(), 1);
        assert_eq!(transfer(std::slice::from_ref(&a), &b, false).unwrap(), 1); // copy into same folder → "a - Copy.txt"
        assert!(base.join("a - Copy.txt").exists());
        let renamed = rename(&a, "b.txt").unwrap();
        assert!(renamed.ends_with("b.txt"));
        match preview(&renamed).unwrap() {
            Preview::Text { text, .. } => assert_eq!(text, "hello"),
            _ => panic!("expected text preview"),
        }
        let (found, _) = search(&b, "copy").unwrap();
        assert_eq!(found.len(), 1);
        assert!(transfer(std::slice::from_ref(&b), &sub, true).is_err(), "cannot move a folder into itself");
        let _ = fs::remove_dir_all(&base);
    }
}
