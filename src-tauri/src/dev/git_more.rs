//! Git in the editor and the history tools: the index version of a file,
//! staging edited text (hunks), blame, stash, amend, the history graph,
//! branch comparison and cherry-pick. All through the `git` CLI.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use super::process;
use crate::error::{AppError, AppResult};

const LOCAL: Duration = Duration::from_secs(20);

fn run(root: &Path, args: &[&str]) -> AppResult<process::Output> {
    process::run("git", args, Some(root), LOCAL)
}

fn checked(root: &Path, args: &[&str]) -> AppResult<String> {
    let out = run(root, args)?;
    if out.ok() {
        Ok(out.stdout_str())
    } else {
        let msg = out.stderr.trim();
        Err(AppError::Launch(if msg.is_empty() { format!("git {} failed", args[0]) } else { msg.to_string() }))
    }
}

fn rel(path: &str) -> AppResult<&str> {
    let bad = path.is_empty() || path.starts_with(['/', '-']) || path.contains(':') || path.split(['/', '\\']).any(|p| p == "..");
    if bad {
        Err(AppError::Invalid(format!("invalid repository path '{path}'")))
    } else {
        Ok(path)
    }
}

/// Commit-ish given by the UI: hashes, branch names, `stash@{n}`; never an option.
fn rev(r: &str) -> AppResult<&str> {
    let ok = !r.is_empty() && r.len() <= 200 && !r.starts_with('-') && r.chars().all(|c| c.is_ascii_alphanumeric() || "/._-@{}~^".contains(c));
    if ok {
        Ok(r)
    } else {
        Err(AppError::Invalid(format!("invalid revision '{r}'")))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    /// Index (staged) text, or HEAD when nothing is staged; None for untracked files.
    pub text: Option<String>,
    pub tracked: bool,
}

/// The version the editor gutter compares against: the index, like VS Code.
pub fn baseline(root: &Path, path: &str) -> AppResult<Baseline> {
    let path = rel(path)?;
    // `:./` makes the path relative to the project folder, which may sit inside a larger repository.
    let index = run(root, &["show", &format!(":./{path}")])?;
    if index.ok() {
        return Ok(Baseline { text: Some(index.stdout_str()), tracked: true });
    }
    Ok(Baseline { text: None, tracked: false })
}

/// Stages `content` as the index version of `path` (used to stage one hunk):
/// the text is written as a blob and the index entry points at it.
pub fn stage_text(root: &Path, path: &str, content: &str) -> AppResult<()> {
    let path = rel(path)?;
    let tmp = std::env::temp_dir().join(format!("nr-stage-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default()));
    std::fs::write(&tmp, content.as_bytes())?;
    let hash = checked(root, &["hash-object", "-w", &format!("--path={path}"), &tmp.to_string_lossy()]);
    let _ = std::fs::remove_file(&tmp);
    let hash = hash?.trim().to_string();
    let mode = checked(root, &["ls-files", "-s", "--", path])?.split_whitespace().next().unwrap_or("100644").to_string();
    checked(root, &["update-index", "--add", "--cacheinfo", &format!("{mode},{hash},{path}")]).map(|_| ())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: usize,
    pub hash: String,
    pub author: String,
    /// Unix seconds.
    pub time: i64,
    pub summary: String,
    pub committed: bool,
}

/// Parses `git blame --line-porcelain` (every line repeats its commit's headers).
pub fn parse_blame(raw: &str) -> Vec<BlameLine> {
    let mut out = Vec::new();
    let mut cur: Option<BlameLine> = None;
    for line in raw.lines() {
        // The line's code (tab-prefixed) ends its record.
        if line.starts_with('\t') {
            if let Some(b) = cur.take() {
                out.push(b);
            }
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let key = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default();
        if key.len() == 40 && key.chars().all(|c| c.is_ascii_hexdigit()) {
            let final_line = value.split(' ').nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            cur = Some(BlameLine { line: final_line, hash: key[..8].to_string(), author: String::new(), time: 0, summary: String::new(), committed: key.chars().any(|c| c != '0') });
        } else if let Some(b) = cur.as_mut() {
            match key {
                "author" => b.author = value.to_string(),
                "author-time" => b.time = value.parse().unwrap_or(0),
                "summary" => b.summary = value.to_string(),
                _ => {}
            }
        }
    }
    out
}

/// Blame of the saved file, optionally for a line range (1-based, inclusive).
pub fn blame(root: &Path, path: &str, range: Option<(usize, usize)>) -> AppResult<Vec<BlameLine>> {
    let path = rel(path)?;
    let lines = range.map(|(a, b)| format!("{},{}", a.max(1), b.max(a.max(1))));
    let mut args = vec!["blame", "--line-porcelain"];
    if let Some(l) = &lines {
        args.extend(["-L", l.as_str()]);
    }
    args.extend(["--", path]);
    Ok(parse_blame(&checked(root, &args)?))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: usize,
    pub name: String,
    pub message: String,
}

pub fn stash_list(root: &Path) -> AppResult<Vec<Stash>> {
    let out = checked(root, &["stash", "list", "--format=%gd%x1f%s"])?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once('\x1f'))
        .enumerate()
        .map(|(index, (name, message))| Stash { index, name: name.to_string(), message: message.to_string() })
        .collect())
}

pub fn stash_save(root: &Path, message: &str, untracked: bool) -> AppResult<()> {
    let mut args = vec!["stash", "push"];
    if untracked {
        args.push("--include-untracked");
    }
    let msg = message.trim();
    if !msg.is_empty() {
        args.extend(["-m", msg]);
    }
    let out = checked(root, &args)?;
    if out.contains("No local changes to save") {
        return Err(AppError::Invalid("there are no local changes to stash".into()));
    }
    Ok(())
}

/// apply, pop or drop `stash@{index}`.
pub fn stash_action(root: &Path, action: &str, index: usize) -> AppResult<String> {
    if !matches!(action, "apply" | "pop" | "drop") {
        return Err(AppError::Invalid(format!("unknown stash action '{action}'")));
    }
    let name = format!("stash@{{{index}}}");
    if action == "drop" {
        return checked(root, &["stash", "drop", &name]).map(|s| s.trim().to_string());
    }
    // `--index` also restores what was staged; without it, changes that existed
    // only in the index are lost. Fall back when the index cannot be restored.
    match checked(root, &["stash", action, "--index", &name]) {
        Ok(s) => Ok(s.trim().to_string()),
        Err(AppError::Launch(msg)) if msg.contains("--index") || msg.contains("Conflicts in index") => {
            checked(root, &["stash", action, &name]).map(|s| s.trim().to_string())
        }
        Err(e) => Err(e),
    }
}

/// Replaces the last commit's message and adds the staged changes to it.
pub fn amend(root: &Path, message: &str) -> AppResult<String> {
    if message.trim().is_empty() {
        return Err(AppError::Invalid("commit message is required".into()));
    }
    checked(root, &["commit", "--amend", "-m", message])?;
    Ok(checked(root, &["rev-parse", "--short", "HEAD"])?.trim().to_string())
}

/// Whether HEAD is already on its upstream (amending it would need a force push).
pub fn head_pushed(root: &Path) -> bool {
    run(root, &["branch", "-r", "--contains", "HEAD"]).map(|o| o.ok() && !o.stdout_str().trim().is_empty()).unwrap_or(false)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    /// The graph drawing (`* | \` …) for this row.
    pub graph: String,
    pub hash: Option<String>,
    pub refs: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

pub fn parse_graph(raw: &str) -> Vec<GraphRow> {
    raw.lines()
        .map(|line| match line.split_once('\x1f') {
            Some((graph, rest)) => {
                let f: Vec<&str> = rest.split('\x1f').collect();
                GraphRow {
                    graph: graph.trim_end().to_string(),
                    hash: f.first().map(|s| s.to_string()),
                    refs: f.get(1).map(|s| s.trim().trim_start_matches('(').trim_end_matches(')').to_string()).unwrap_or_default(),
                    subject: f.get(2).map(|s| s.to_string()).unwrap_or_default(),
                    author: f.get(3).map(|s| s.to_string()).unwrap_or_default(),
                    date: f.get(4).map(|s| s.to_string()).unwrap_or_default(),
                }
            }
            None => GraphRow { graph: line.trim_end().to_string(), hash: None, refs: String::new(), subject: String::new(), author: String::new(), date: String::new() },
        })
        .collect()
}

pub fn graph(root: &Path, limit: u32) -> AppResult<Vec<GraphRow>> {
    let n = format!("-n{}", limit.clamp(1, 1000));
    let out = run(root, &["log", "--graph", "--all", &n, "--date=short", "--pretty=format:\x1f%h\x1f%d\x1f%s\x1f%an\x1f%ad"])?;
    if !out.ok() {
        return Ok(Vec::new()); // no commits yet
    }
    Ok(parse_graph(&out.stdout_str()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub status: String,
    pub path: String,
}

/// Files that differ between two revisions (`base...head`: changes on head since they diverged).
pub fn compare(root: &Path, base: &str, head: &str) -> AppResult<Vec<ChangedFile>> {
    let range = format!("{}...{}", rev(base)?, rev(head)?);
    let out = checked(root, &["diff", "--name-status", "-z", &range])?;
    let mut parts = out.split('\0').filter(|s| !s.is_empty());
    let mut files = Vec::new();
    while let Some(status) = parts.next() {
        let mut path = parts.next().unwrap_or_default().to_string();
        if status.starts_with('R') || status.starts_with('C') {
            path = parts.next().unwrap_or_default().to_string();
        }
        files.push(ChangedFile { status: status.chars().next().unwrap_or('M').to_string(), path });
    }
    Ok(files)
}

/// Text of a file at a revision ("" when it does not exist there).
pub fn file_at(root: &Path, revision: &str, path: &str) -> AppResult<String> {
    let spec = format!("{}:./{}", rev(revision)?, rel(path)?);
    let out = run(root, &["show", &spec])?;
    Ok(if out.ok() { out.stdout_str() } else { String::new() })
}

pub fn cherry_pick(root: &Path, hash: &str) -> AppResult<String> {
    checked(root, &["cherry-pick", rev(hash)?]).map(|s| s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_line_porcelain_blame() {
        let raw = "\
1111111111111111111111111111111111111111 1 1 2
author Ann
author-time 1700000000
summary first
filename a.txt
\tline one
1111111111111111111111111111111111111111 2 2
author Ann
author-time 1700000000
summary first
filename a.txt
\tline two
0000000000000000000000000000000000000000 3 3 1
author Not Committed Yet
author-time 1800000000
summary Version of a.txt from a.txt
filename a.txt
\tnew line
";
        let b = parse_blame(raw);
        assert_eq!(b.len(), 3);
        assert_eq!((b[1].line, b[1].hash.as_str(), b[1].author.as_str(), b[1].summary.as_str()), (2, "11111111", "Ann", "first"));
        assert!(b[0].committed && !b[2].committed);
    }

    #[test]
    fn parses_graph_rows() {
        let raw = "* \x1fabc123\x1f (HEAD -> main, origin/main)\x1fFix it\x1fAnn\x1f2026-10-01\n|\\  \n| * \x1fdef456\x1f\x1fFeature\x1fBob\x1f2026-09-30";
        let rows = parse_graph(raw);
        assert_eq!(rows.len(), 3);
        assert_eq!((rows[0].hash.as_deref(), rows[0].refs.as_str()), (Some("abc123"), "HEAD -> main, origin/main"));
        assert_eq!(rows[1].hash, None);
        assert_eq!(rows[2].graph, "| *");
    }

    #[test]
    fn rejects_option_like_revisions() {
        assert!(rev("--upload-pack=x").is_err());
        assert!(rev("main~2").is_ok());
        assert!(rev("stash@{0}").is_ok());
        assert!(rel("-x").is_err());
    }

    /// Hunk staging, blame, stash and amend in a scratch repository.
    #[test]
    fn editor_git_round_trip() {
        let dir = std::env::temp_dir().join(format!("nr-git2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let g = |args: &[&str]| checked(&dir, args).unwrap();
        g(&["init", "-b", "main"]);
        g(&["config", "user.name", "NETRUNNER test"]);
        g(&["config", "user.email", "test@netrunner.invalid"]);
        g(&["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        assert!(!baseline(&dir, "a.txt").unwrap().tracked);
        g(&["add", "a.txt"]);
        g(&["commit", "-m", "first"]);
        std::fs::write(dir.join("a.txt"), "ONE\ntwo\nTHREE\n").unwrap();
        // Stage only the first change.
        stage_text(&dir, "a.txt", "ONE\ntwo\nthree\n").unwrap();
        assert_eq!(baseline(&dir, "a.txt").unwrap().text.as_deref(), Some("ONE\ntwo\nthree\n"));
        let staged = g(&["diff", "--cached", "--name-only"]);
        assert_eq!(staged.trim(), "a.txt");
        let b = blame(&dir, "a.txt", Some((2, 2))).unwrap();
        assert_eq!((b.len(), b[0].summary.as_str()), (1, "first"));
        amend(&dir, "first, amended").unwrap();
        assert_eq!(g(&["log", "-1", "--format=%s"]).trim(), "first, amended");
        assert!(!head_pushed(&dir));
        stash_save(&dir, "wip", false).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "ONE\ntwo\nthree\n");
        let list = stash_list(&dir).unwrap();
        assert_eq!((list.len(), list[0].name.as_str()), (1, "stash@{0}"));
        assert!(list[0].message.contains("wip"));
        stash_action(&dir, "pop", 0).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "ONE\ntwo\nTHREE\n");
        // The staged part came back staged.
        assert_eq!(baseline(&dir, "a.txt").unwrap().text.as_deref(), Some("ONE\ntwo\nthree\n"));
        // A change that exists only in the index survives a stash round trip.
        std::fs::write(dir.join("a.txt"), "ONE\ntwo\nthree\n").unwrap();
        g(&["add", "a.txt"]);
        stage_text(&dir, "a.txt", "ONE\nTWO\nthree\n").unwrap();
        stash_save(&dir, "", false).unwrap();
        stash_action(&dir, "pop", 0).unwrap();
        assert_eq!(baseline(&dir, "a.txt").unwrap().text.as_deref(), Some("ONE\nTWO\nthree\n"));
        std::fs::write(dir.join("a.txt"), "ONE\ntwo\nTHREE\n").unwrap();
        g(&["add", "a.txt"]);
        assert!(stash_action(&dir, "clear", 0).is_err());
        g(&["switch", "-c", "feature"]);
        g(&["commit", "-am", "three"]);
        let files = compare(&dir, "main", "feature").unwrap();
        assert_eq!((files.len(), files[0].path.as_str(), files[0].status.as_str()), (1, "a.txt", "M"));
        assert_eq!(file_at(&dir, "main", "a.txt").unwrap(), "ONE\ntwo\nthree\n");
        let hash = g(&["rev-parse", "--short", "HEAD"]).trim().to_string();
        g(&["switch", "main"]);
        cherry_pick(&dir, &hash).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "ONE\ntwo\nTHREE\n");
        assert!(graph(&dir, 20).unwrap().iter().any(|r| r.subject == "three"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
