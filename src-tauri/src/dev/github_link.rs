//! DEVELOPER ↔ GITHUB: publish a local project, pull requests (create, list,
//! files, comments, CI checks, checkout), issue branches and permalinks.
//! Nothing is created on GitHub without the user's confirmation in the UI and
//! the `confirmed` flag on the command.

use std::path::Path;
use std::time::Duration;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::github::{require_token, send, valid_slug};
use super::process;
use crate::error::{AppError, AppResult};

const LOCAL: Duration = Duration::from_secs(20);
const NETWORK: Duration = Duration::from_secs(300);

fn git(root: &Path, args: &[&str], timeout: Duration) -> AppResult<String> {
    let out = process::run("git", args, Some(root), timeout)?;
    if out.ok() {
        Ok(out.stdout_str())
    } else {
        let msg = out.stderr.trim();
        Err(AppError::Launch(if msg.is_empty() { format!("git {} failed", args[0]) } else { msg.to_string() }))
    }
}

fn slugs(owner: &str, repo: &str) -> AppResult<()> {
    if valid_slug(owner) && valid_slug(repo) {
        Ok(())
    } else {
        Err(AppError::Invalid("invalid repository".into()))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub owner: String,
    pub repo: String,
    pub branch: Option<String>,
    pub head: Option<String>,
}

/// The project's GitHub `origin`, current branch and HEAD commit.
pub fn origin(root: &Path) -> AppResult<Option<Origin>> {
    let Ok(url) = git(root, &["remote", "get-url", "origin"], LOCAL) else { return Ok(None) };
    let Some(full) = super::github::github_remotes(&format!("url = {}", url.trim())).into_iter().next() else { return Ok(None) };
    let (owner, repo) = full.split_once('/').map(|(o, r)| (o.to_string(), r.to_string())).unwrap_or_default();
    let branch = git(root, &["rev-parse", "--abbrev-ref", "HEAD"], LOCAL).ok().map(|b| b.trim().to_string()).filter(|b| b != "HEAD");
    let head = git(root, &["rev-parse", "HEAD"], LOCAL).ok().map(|h| h.trim().to_string());
    Ok(Some(Origin { owner, repo, branch, head }))
}

// ---------- Publish ----------

pub fn create_repo_body(name: &str, description: &str, private: bool) -> AppResult<Value> {
    if !valid_slug(name) {
        return Err(AppError::Invalid("a repository name may use letters, digits, '-', '_' and '.'".into()));
    }
    Ok(json!({"name": name, "description": description.trim(), "private": private, "auto_init": false}))
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CreatedRepo {
    pub full_name: String,
    pub clone_url: String,
    pub html_url: String,
}

/// Adds `origin` and pushes the current branch with upstream.
pub fn push_to_new_remote(root: &Path, url: &str) -> AppResult<()> {
    if git(root, &["remote", "get-url", "origin"], LOCAL).is_ok() {
        return Err(AppError::Invalid("this project already has an 'origin' remote".into()));
    }
    git(root, &["rev-parse", "--verify", "HEAD"], LOCAL).map_err(|_| AppError::Invalid("commit something first: there is nothing to publish".into()))?;
    git(root, &["remote", "add", "origin", url], LOCAL)?;
    git(root, &["push", "-u", "origin", "HEAD"], NETWORK).map(|_| ())
}

pub async fn publish(root: &Path, name: &str, description: &str, private: bool) -> AppResult<CreatedRepo> {
    if git(root, &["remote", "get-url", "origin"], LOCAL).is_ok() {
        return Err(AppError::Invalid("this project already has an 'origin' remote".into()));
    }
    git(root, &["rev-parse", "--verify", "HEAD"], LOCAL).map_err(|_| AppError::Invalid("commit something first: there is nothing to publish".into()))?;
    let body = create_repo_body(name, description, private)?;
    let created: CreatedRepo = send(Method::POST, &require_token()?, "/user/repos", Some(&body)).await?;
    let root = root.to_path_buf();
    let url = created.clone_url.clone();
    tauri::async_runtime::spawn_blocking(move || push_to_new_remote(&root, &url)).await.map_err(|e| AppError::Internal(e.to_string()))??;
    Ok(created)
}

// ---------- Pull requests ----------

pub fn pr_body(title: &str, body: &str, head: &str, base: &str, draft: bool) -> AppResult<Value> {
    if title.trim().is_empty() {
        return Err(AppError::Invalid("a pull request needs a title".into()));
    }
    if head == base {
        return Err(AppError::Invalid("the branch to merge must differ from the base branch".into()));
    }
    Ok(json!({"title": title.trim(), "body": body, "head": head, "base": base, "draft": draft}))
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CreatedPr {
    pub number: u64,
    pub html_url: String,
}

/// Creates a pull request from the pushed current branch.
pub async fn create_pr(owner: &str, repo: &str, title: &str, body: &str, head: &str, base: &str, draft: bool) -> AppResult<CreatedPr> {
    slugs(owner, repo)?;
    let payload = pr_body(title, body, head, base, draft)?;
    send(Method::POST, &require_token()?, &format!("/repos/{owner}/{repo}/pulls"), Some(&payload)).await
}

/// Subjects of commits on HEAD that `base` lacks (default PR description).
pub fn commits_since(root: &Path, base: &str) -> AppResult<Vec<String>> {
    if base.is_empty() || base.starts_with('-') || !base.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c)) {
        return Err(AppError::Invalid("invalid base branch".into()));
    }
    let range = [format!("origin/{base}..HEAD"), format!("{base}..HEAD")];
    for r in &range {
        if let Ok(out) = git(root, &["log", "--format=%s", "-n100", r], LOCAL) {
            return Ok(out.lines().map(str::to_string).collect());
        }
    }
    Ok(Vec::new())
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PrRef {
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub sha: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PrDetail {
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub draft: Option<bool>,
    pub html_url: String,
    pub head: PrRef,
    pub base: PrRef,
    pub user: super::github::IssueUser,
}

pub async fn pr(owner: &str, repo: &str, number: u64) -> AppResult<PrDetail> {
    slugs(owner, repo)?;
    send(Method::GET, &require_token()?, &format!("/repos/{owner}/{repo}/pulls/{number}"), None).await
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PrFile {
    pub filename: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub previous_filename: Option<String>,
}

pub async fn pr_files(owner: &str, repo: &str, number: u64) -> AppResult<Vec<PrFile>> {
    slugs(owner, repo)?;
    send(Method::GET, &require_token()?, &format!("/repos/{owner}/{repo}/pulls/{number}/files?per_page=100"), None).await
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Comment {
    pub id: u64,
    pub body: String,
    pub user: super::github::IssueUser,
    pub created_at: String,
    pub html_url: String,
}

pub async fn comments(owner: &str, repo: &str, number: u64) -> AppResult<Vec<Comment>> {
    slugs(owner, repo)?;
    send(Method::GET, &require_token()?, &format!("/repos/{owner}/{repo}/issues/{number}/comments?per_page=100"), None).await
}

pub async fn add_comment(owner: &str, repo: &str, number: u64, body: &str) -> AppResult<Comment> {
    slugs(owner, repo)?;
    if body.trim().is_empty() {
        return Err(AppError::Invalid("the comment is empty".into()));
    }
    send(Method::POST, &require_token()?, &format!("/repos/{owner}/{repo}/issues/{number}/comments"), Some(&json!({"body": body}))).await
}

/// Fetches the PR's head into a local `pr-<n>` branch and switches to it.
pub fn checkout_pr(root: &Path, number: u64) -> AppResult<String> {
    let branch = format!("pr-{number}");
    git(root, &["fetch", "origin", &format!("pull/{number}/head:{branch}")], NETWORK)
        .or_else(|e| if e.to_string().contains("refusing to fetch into") { Ok(String::new()) } else { Err(e) })?;
    git(root, &["switch", &branch], LOCAL)?;
    Ok(branch)
}

// ---------- CI checks ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    /// queued | in_progress | completed
    pub status: String,
    pub conclusion: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checks {
    /// success | failure | pending | none
    pub state: String,
    pub checks: Vec<Check>,
}

pub fn summarize(checks: &[Check]) -> String {
    if checks.is_empty() {
        return "none".into();
    }
    let failed = checks.iter().any(|c| matches!(c.conclusion.as_deref(), Some("failure" | "timed_out" | "cancelled" | "action_required" | "error")));
    if failed {
        return "failure".into();
    }
    if checks.iter().any(|c| c.status != "completed") {
        return "pending".into();
    }
    "success".into()
}

/// Check runs (GitHub Actions and apps) plus classic commit statuses for a ref.
pub async fn checks(owner: &str, repo: &str, git_ref: &str) -> AppResult<Checks> {
    slugs(owner, repo)?;
    if git_ref.is_empty() || git_ref.starts_with('-') || !git_ref.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c)) {
        return Err(AppError::Invalid("invalid ref".into()));
    }
    let token = require_token()?;
    let runs: Value = send(Method::GET, &token, &format!("/repos/{owner}/{repo}/commits/{git_ref}/check-runs?per_page=100"), None).await?;
    let mut list: Vec<Check> = runs["check_runs"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|r| Check {
                    name: r["name"].as_str().unwrap_or_default().to_string(),
                    status: r["status"].as_str().unwrap_or("completed").to_string(),
                    conclusion: r["conclusion"].as_str().map(str::to_string),
                    url: r["html_url"].as_str().map(str::to_string),
                })
                .collect()
        })
        .unwrap_or_default();
    if let Ok(status) = send::<Value>(Method::GET, &token, &format!("/repos/{owner}/{repo}/commits/{git_ref}/status"), None).await {
        for s in status["statuses"].as_array().into_iter().flatten() {
            let state = s["state"].as_str().unwrap_or("pending");
            list.push(Check {
                name: s["context"].as_str().unwrap_or("status").to_string(),
                status: if state == "pending" { "in_progress".into() } else { "completed".into() },
                conclusion: (state != "pending").then(|| state.to_string()),
                url: s["target_url"].as_str().map(str::to_string),
            });
        }
    }
    Ok(Checks { state: summarize(&list), checks: list })
}

// ---------- Issues and links ----------

/// `issue-42-fix-login-on-windows` from an issue number and title.
pub fn issue_branch(number: u64, title: &str) -> String {
    let mut slug = String::new();
    for c in title.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        format!("issue-{number}")
    } else {
        format!("issue-{number}-{slug}")
    }
}

/// GitHub URL of a file at a commit (permalink) or branch, with an optional line range.
pub fn blob_url(owner: &str, repo: &str, git_ref: &str, path: &str, lines: Option<(u32, u32)>) -> String {
    let path: Vec<String> = path.split('/').map(|p| url::form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>().replace('+', "%20")).collect();
    let anchor = match lines {
        Some((a, b)) if b > a => format!("#L{a}-L{b}"),
        Some((a, _)) => format!("#L{a}"),
        None => String::new(),
    };
    format!("https://github.com/{owner}/{repo}/blob/{git_ref}/{}{anchor}", path.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_requests() {
        assert_eq!(create_repo_body("my-app", " demo ", true).unwrap(), json!({"name": "my-app", "description": "demo", "private": true, "auto_init": false}));
        assert!(create_repo_body("bad name", "", false).is_err());
        assert_eq!(pr_body("Fix", "- a", "feature", "main", true).unwrap()["draft"], json!(true));
        assert!(pr_body(" ", "", "a", "b", false).is_err());
        assert!(pr_body("x", "", "main", "main", false).is_err());
    }

    #[test]
    fn names_and_links() {
        assert_eq!(issue_branch(42, "Fix login on Windows!!"), "issue-42-fix-login-on-windows");
        assert_eq!(issue_branch(7, "Ошибка"), "issue-7");
        assert_eq!(issue_branch(1, "a".repeat(80).as_str()).len(), "issue-1-".len() + 40);
        assert_eq!(blob_url("occka", "netrunner", "abc123", "src/a b.ts", Some((3, 3))), "https://github.com/occka/netrunner/blob/abc123/src/a%20b.ts#L3");
        assert_eq!(blob_url("o", "r", "main", "x.rs", Some((2, 5))), "https://github.com/o/r/blob/main/x.rs#L2-L5");
    }

    #[test]
    fn summarizes_checks() {
        let c = |status: &str, conclusion: Option<&str>| Check { name: "x".into(), status: status.into(), conclusion: conclusion.map(str::to_string), url: None };
        assert_eq!(summarize(&[]), "none");
        assert_eq!(summarize(&[c("completed", Some("success")), c("completed", Some("skipped"))]), "success");
        assert_eq!(summarize(&[c("completed", Some("success")), c("in_progress", None)]), "pending");
        assert_eq!(summarize(&[c("in_progress", None), c("completed", Some("failure"))]), "failure");
    }

    /// Publishing pushes to a fresh remote; checked with a local bare repository.
    #[test]
    fn publishes_to_a_bare_remote() {
        let base = std::env::temp_dir().join(format!("nr-publish-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (work, bare) = (base.join("work"), base.join("remote.git"));
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--bare", "-b", "main"], LOCAL).unwrap();
        git(&work, &["init", "-b", "main"], LOCAL).unwrap();
        for (k, v) in [("user.name", "NETRUNNER test"), ("user.email", "test@netrunner.invalid")] {
            git(&work, &["config", k, v], LOCAL).unwrap();
        }
        // Nothing committed yet: refused.
        assert!(push_to_new_remote(&work, &bare.to_string_lossy()).is_err());
        std::fs::write(work.join("a.txt"), "x").unwrap();
        git(&work, &["add", "."], LOCAL).unwrap();
        git(&work, &["commit", "-m", "first"], LOCAL).unwrap();
        push_to_new_remote(&work, &bare.to_string_lossy()).unwrap();
        assert_eq!(git(&bare, &["log", "--format=%s", "main"], LOCAL).unwrap().trim(), "first");
        assert!(git(&work, &["rev-parse", "--abbrev-ref", "@{u}"], LOCAL).unwrap().contains("origin/main"));
        // An existing origin is never replaced.
        assert!(push_to_new_remote(&work, "https://example.invalid/x.git").is_err());
        // Origin parsing (not GitHub: none).
        assert!(origin(&work).unwrap().is_none());
        git(&work, &["remote", "set-url", "origin", "https://github.com/Occka/NetRunner.git"], LOCAL).unwrap();
        let o = origin(&work).unwrap().unwrap();
        assert_eq!((o.owner.as_str(), o.repo.as_str(), o.branch.as_deref()), ("occka", "netrunner", Some("main")));
        git(&work, &["switch", "-c", "feature"], LOCAL).unwrap();
        std::fs::write(work.join("b.txt"), "y").unwrap();
        git(&work, &["add", "."], LOCAL).unwrap();
        git(&work, &["commit", "-m", "second"], LOCAL).unwrap();
        assert_eq!(commits_since(&work, "main").unwrap(), vec!["second".to_string()]);
        let _ = std::fs::remove_dir_all(&base);
    }
}
