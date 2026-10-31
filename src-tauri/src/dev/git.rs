//! Git integration through the user's installed `git` CLI. Network operations
//! use Git's own credential helpers (Git Credential Manager on Windows), so
//! NETRUNNER never handles repository passwords itself.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use super::process::{self, Output};
use crate::error::{AppError, AppResult};

const LOCAL: Duration = Duration::from_secs(20);
const NETWORK: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    /// Index (staged) state: one of M A D R C U or '.' for unchanged.
    pub index: String,
    /// Worktree state: one of M D U ? or '.'.
    pub worktree: String,
    pub orig_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffContents {
    pub original: String,
    pub modified: String,
}

fn git(root: &Path, args: &[&str], timeout: Duration) -> AppResult<Output> {
    process::run("git", args, Some(root), timeout)
}

fn checked(root: &Path, args: &[&str], timeout: Duration) -> AppResult<String> {
    let out = git(root, args, timeout)?;
    if out.ok() {
        Ok(out.stdout_str())
    } else {
        let msg = out.stderr.trim();
        Err(AppError::Launch(if msg.is_empty() { format!("git {} failed", args[0]) } else { msg.to_string() }))
    }
}

/// Validates a repository-relative path given by the UI.
fn rel(path: &str) -> AppResult<&str> {
    let bad = path.is_empty() || path.starts_with('/') || path.contains(':') || path.split(['/', '\\']).any(|p| p == "..");
    if bad {
        Err(AppError::Invalid(format!("invalid repository path '{path}'")))
    } else {
        Ok(path)
    }
}

pub fn parse_status(raw: &str) -> RepoStatus {
    let mut s = RepoStatus { is_repo: true, branch: None, upstream: None, ahead: 0, behind: 0, files: Vec::new() };
    let mut records = raw.split('\0').peekable();
    while let Some(rec) = records.next() {
        if let Some(h) = rec.strip_prefix("# branch.head ") {
            s.branch = (h != "(detached)").then(|| h.to_string());
        } else if let Some(u) = rec.strip_prefix("# branch.upstream ") {
            s.upstream = Some(u.to_string());
        } else if let Some(ab) = rec.strip_prefix("# branch.ab ") {
            for part in ab.split(' ') {
                if let Some(n) = part.strip_prefix('+') {
                    s.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    s.behind = n.parse().unwrap_or(0);
                }
            }
        } else if let Some(p) = rec.strip_prefix("? ") {
            s.files.push(FileStatus { path: p.to_string(), index: ".".into(), worktree: "?".into(), orig_path: None });
        } else if rec.starts_with("1 ") || rec.starts_with("2 ") || rec.starts_with("u ") {
            let renamed = rec.starts_with("2 ");
            // Field counts before the path: ordinary 8, rename/copy 9, unmerged 10.
            let fields = match &rec[..1] {
                "1" => 8,
                "2" => 9,
                _ => 10,
            };
            let parts: Vec<&str> = rec.splitn(fields + 1, ' ').collect();
            let Some(path) = parts.get(fields) else { continue };
            let xy = parts.get(1).copied().unwrap_or("..");
            let mut chars = xy.chars();
            let orig = if renamed { records.next().map(str::to_string) } else { None };
            s.files.push(FileStatus {
                path: path.to_string(),
                index: chars.next().unwrap_or('.').to_string(),
                worktree: chars.next().unwrap_or('.').to_string(),
                orig_path: orig,
            });
        }
    }
    s
}

pub fn status(root: &Path) -> AppResult<RepoStatus> {
    let out = git(root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], LOCAL)?;
    if !out.ok() {
        if out.stderr.contains("not a git repository") {
            return Ok(RepoStatus { is_repo: false, branch: None, upstream: None, ahead: 0, behind: 0, files: Vec::new() });
        }
        return Err(AppError::Launch(out.stderr.trim().to_string()));
    }
    Ok(parse_status(&out.stdout_str()))
}

/// Original/modified text for a diff view. `staged` compares HEAD↔index,
/// otherwise index↔working tree.
pub fn diff_contents(root: &Path, path: &str, staged: bool) -> AppResult<DiffContents> {
    let path = rel(path)?;
    let show = |spec: String| git(root, &["show", &spec], LOCAL).map(|o| if o.ok() { o.stdout_str() } else { String::new() });
    if staged {
        Ok(DiffContents { original: show(format!("HEAD:{path}"))?, modified: show(format!(":{path}"))? })
    } else {
        let index = git(root, &["show", &format!(":{path}")], LOCAL)?;
        let original = if index.ok() { index.stdout_str() } else { show(format!("HEAD:{path}"))? };
        let modified = std::fs::read(root.join(path)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        Ok(DiffContents { original, modified })
    }
}

pub fn stage(root: &Path, paths: &[String]) -> AppResult<()> {
    let mut args = vec!["add", "--"];
    for p in paths {
        args.push(rel(p)?);
    }
    checked(root, &args, LOCAL).map(|_| ())
}

pub fn unstage(root: &Path, paths: &[String]) -> AppResult<()> {
    let mut args = vec!["restore", "--staged", "--"];
    for p in paths {
        args.push(rel(p)?);
    }
    checked(root, &args, LOCAL).map(|_| ())
}

/// Discards working-tree changes (the UI confirms first; this cannot be undone).
pub fn discard(root: &Path, path: &str, untracked: bool) -> AppResult<()> {
    let path = rel(path)?;
    if untracked {
        let full = root.join(path);
        return trash::delete(&full).map_err(|e| AppError::Internal(format!("could not move to Recycle Bin: {e}")));
    }
    checked(root, &["restore", "--", path], LOCAL).map(|_| ())
}

pub fn commit(root: &Path, message: &str) -> AppResult<String> {
    if message.trim().is_empty() {
        return Err(AppError::Invalid("commit message is required".into()));
    }
    checked(root, &["commit", "-m", message], LOCAL)?;
    Ok(checked(root, &["rev-parse", "--short", "HEAD"], LOCAL)?.trim().to_string())
}

pub fn log(root: &Path, limit: u32) -> AppResult<Vec<Commit>> {
    let n = format!("-n{}", limit.clamp(1, 500));
    let out = git(root, &["log", &n, "--date=iso-strict", "--pretty=format:%h%x1f%an%x1f%ad%x1f%s%x1e"], LOCAL)?;
    if !out.ok() {
        return Ok(Vec::new()); // empty repository
    }
    Ok(out
        .stdout_str()
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_matches(['\n', '\r']).split('\x1f').collect();
            (f.len() == 4).then(|| Commit { hash: f[0].into(), author: f[1].into(), date: f[2].into(), subject: f[3].into() })
        })
        .collect())
}

pub fn branches(root: &Path) -> AppResult<Vec<String>> {
    Ok(checked(root, &["branch", "--format=%(refname:short)"], LOCAL)?.lines().map(str::to_string).filter(|b| !b.is_empty()).collect())
}

fn valid_branch(root: &Path, name: &str) -> AppResult<()> {
    let ok = git(root, &["check-ref-format", "--branch", name], LOCAL)?.ok();
    if ok && !name.starts_with('-') {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("'{name}' is not a valid branch name")))
    }
}

pub fn checkout(root: &Path, branch: &str) -> AppResult<()> {
    valid_branch(root, branch)?;
    checked(root, &["switch", branch], LOCAL).map(|_| ())
}

pub fn create_branch(root: &Path, name: &str) -> AppResult<()> {
    valid_branch(root, name)?;
    checked(root, &["switch", "-c", name], LOCAL).map(|_| ())
}

pub fn pull(root: &Path) -> AppResult<String> {
    checked(root, &["pull", "--ff-only"], NETWORK).map(|s| s.trim().to_string())
}

pub fn push(root: &Path) -> AppResult<String> {
    let out = git(root, &["push"], NETWORK)?;
    if out.ok() {
        return Ok(out.stderr.trim().to_string()); // git reports push progress on stderr
    }
    // First push of a new branch: set the upstream explicitly.
    if out.stderr.contains("has no upstream branch") {
        let branch = checked(root, &["rev-parse", "--abbrev-ref", "HEAD"], LOCAL)?;
        return checked(root, &["push", "-u", "origin", branch.trim()], NETWORK).map(|s| s.trim().to_string());
    }
    Err(AppError::Launch(out.stderr.trim().to_string()))
}

pub fn init(root: &Path) -> AppResult<()> {
    checked(root, &["init"], LOCAL).map(|_| ())
}

/// Clones `url` into `parent/<name>` and returns the new folder.
pub fn clone(url: &str, parent: &Path, name: &str) -> AppResult<std::path::PathBuf> {
    let parsed = url::Url::parse(url).map_err(|_| AppError::Invalid("enter an https:// repository URL".into()))?;
    if parsed.scheme() != "https" {
        return Err(AppError::Invalid("only https:// clone URLs are supported".into()));
    }
    if name.is_empty() || name.contains(['/', '\\', ':']) || name == ".." {
        return Err(AppError::Invalid("invalid folder name".into()));
    }
    let target = parent.join(name);
    if target.exists() {
        return Err(AppError::Invalid(format!("{} already exists", target.display())));
    }
    let out = process::run("git", &["clone", "--", url, &target.to_string_lossy()], Some(parent), NETWORK)?;
    if !out.ok() {
        return Err(AppError::Launch(out.stderr.trim().to_string()));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let raw = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/app.ts\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new name.rs\0old.rs\0\
? notes/todo.md\0";
        let s = parse_status(raw);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert_eq!(s.files.len(), 3);
        assert_eq!(s.files[0].path, "src/app.ts");
        assert_eq!((s.files[0].index.as_str(), s.files[0].worktree.as_str()), (".", "M"));
        assert_eq!(s.files[1].path, "new name.rs");
        assert_eq!(s.files[1].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(s.files[2].worktree, "?");
    }

    #[test]
    fn rejects_escaping_paths() {
        assert!(rel("../x").is_err());
        assert!(rel("C:/x").is_err());
        assert!(rel("src/../../x").is_err());
        assert!(rel("src/main.rs").is_ok());
    }
}
