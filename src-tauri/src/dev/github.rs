//! GitHub REST API client. The personal access token lives only in Windows
//! Credential Manager (DPAPI-protected) and is never returned to the UI.

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const SERVICE: &str = "NETRUNNER";
const ACCOUNT: &str = "github-token";
const API: &str = "https://api.github.com";

fn entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| AppError::Internal(format!("credential store unavailable: {e}")))
}

pub fn token() -> AppResult<Option<String>> {
    match entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Internal(format!("cannot read credential: {e}"))),
    }
}

pub fn store_token(token: &str) -> AppResult<()> {
    entry()?.set_password(token).map_err(|e| AppError::Internal(format!("cannot store credential: {e}")))
}

pub fn delete_token() -> AppResult<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Internal(format!("cannot delete credential: {e}"))),
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    #[serde(alias = "login")]
    pub login: String,
    pub name: Option<String>,
    #[serde(alias = "html_url")]
    pub html_url: String,
    #[serde(alias = "public_repos", default)]
    pub public_repos: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    #[serde(alias = "full_name")]
    pub full_name: String,
    pub name: String,
    pub description: Option<String>,
    pub private: bool,
    pub fork: bool,
    pub language: Option<String>,
    #[serde(alias = "stargazers_count", default)]
    pub stargazers_count: u32,
    #[serde(alias = "open_issues_count", default)]
    pub open_issues_count: u32,
    #[serde(alias = "clone_url")]
    pub clone_url: String,
    #[serde(alias = "html_url")]
    pub html_url: String,
    #[serde(alias = "default_branch")]
    pub default_branch: Option<String>,
    #[serde(alias = "pushed_at")]
    pub pushed_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueUser {
    pub login: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub user: IssueUser,
    #[serde(alias = "html_url")]
    pub html_url: String,
    #[serde(alias = "created_at")]
    pub created_at: String,
    #[serde(alias = "updated_at")]
    pub updated_at: String,
    #[serde(default)]
    pub draft: Option<bool>,
    /// Present on issues that are actually pull requests.
    #[serde(alias = "pull_request", default, skip_serializing)]
    pub pull_request: Option<serde_json::Value>,
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("NETRUNNER/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))
}

async fn get<T: for<'de> Deserialize<'de>>(token: &str, path: &str) -> AppResult<T> {
    let resp = client()?
        .get(format!("{API}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| AppError::Launch(format!("GitHub request failed: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppError::Invalid("GitHub rejected the token (expired or revoked)".into()));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
            .unwrap_or_else(|| status.to_string());
        return Err(AppError::Launch(format!("GitHub: {msg}")));
    }
    resp.json::<T>().await.map_err(|e| AppError::Internal(format!("unexpected GitHub response: {e}")))
}

fn require_token() -> AppResult<String> {
    token()?.ok_or_else(|| AppError::Invalid("GitHub is not connected".into()))
}

fn valid_slug(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) && s != ".."
}

pub async fn user_with(token: &str) -> AppResult<User> {
    get(token, "/user").await
}

pub async fn user() -> AppResult<User> {
    user_with(&require_token()?).await
}

pub async fn repos() -> AppResult<Vec<Repo>> {
    get(&require_token()?, "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member").await
}

pub async fn issues(owner: &str, repo: &str, pulls: bool, state: &str) -> AppResult<Vec<Issue>> {
    if !valid_slug(owner) || !valid_slug(repo) || !matches!(state, "open" | "closed" | "all") {
        return Err(AppError::Invalid("invalid repository".into()));
    }
    let kind = if pulls { "pulls" } else { "issues" };
    let list: Vec<Issue> = get(&require_token()?, &format!("/repos/{owner}/{repo}/{kind}?state={state}&per_page=50")).await?;
    // The issues endpoint also returns pull requests; keep them apart.
    Ok(if pulls { list } else { list.into_iter().filter(|i| i.pull_request.is_none()).collect() })
}

/// One entry of a repository folder (contents API).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    pub name: String,
    pub path: String,
    /// file, dir, symlink or submodule.
    #[serde(rename(deserialize = "type"))]
    pub kind: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Deserialize)]
struct RawFile {
    path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    encoding: Option<String>,
    #[serde(alias = "html_url")]
    html_url: Option<String>,
}

/// A file for viewing. Text only: binary or very large files carry no content.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFile {
    pub path: String,
    pub size: u64,
    pub content: Option<String>,
    pub binary: bool,
    pub too_large: bool,
    pub html_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Branch {
    name: String,
}

/// Percent-encodes one path segment for the URL.
fn encode_segment(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Repository path ("" = root): no `..`, no backslashes, no empty segments.
fn repo_path(path: &str) -> AppResult<String> {
    let path = path.trim_matches('/');
    if path.is_empty() {
        return Ok(String::new());
    }
    if path.len() > 1000 || path.contains('\\') || path.split('/').any(|s| s.is_empty() || s == "..") {
        return Err(AppError::Invalid("invalid path in repository".into()));
    }
    Ok(path.split('/').map(encode_segment).collect::<Vec<_>>().join("/"))
}

fn ref_query(git_ref: Option<&str>) -> AppResult<String> {
    match git_ref.map(str::trim).filter(|r| !r.is_empty()) {
        None => Ok(String::new()),
        Some(r) if r.len() <= 200 && !r.contains("..") && r.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/')) => {
            Ok(format!("?ref={}", r.split('/').map(encode_segment).collect::<Vec<_>>().join("%2F")))
        }
        _ => Err(AppError::Invalid("invalid branch name".into())),
    }
}

fn check_repo(owner: &str, repo: &str) -> AppResult<()> {
    if valid_slug(owner) && valid_slug(repo) {
        Ok(())
    } else {
        Err(AppError::Invalid("invalid repository".into()))
    }
}

/// Lists a folder of a repository, folders first.
pub async fn contents(owner: &str, repo: &str, path: &str, git_ref: Option<&str>) -> AppResult<Vec<RepoEntry>> {
    check_repo(owner, repo)?;
    let url = format!("/repos/{owner}/{repo}/contents/{}{}", repo_path(path)?, ref_query(git_ref)?);
    let mut list: Vec<RepoEntry> = get(&require_token()?, &url).await.map_err(|e| match e {
        AppError::Internal(_) => AppError::Invalid("this path is a file, not a folder".into()),
        e => e,
    })?;
    list.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(list)
}

/// Decodes the contents API's base64 file body into text, if it is text.
fn decode_file(raw: RawFile) -> RepoFile {
    const MAX_TEXT: u64 = 1024 * 1024;
    let bytes = match (raw.encoding.as_deref(), raw.content.as_deref()) {
        (Some("base64"), Some(c)) if !c.is_empty() => {
            let clean: String = c.chars().filter(|ch| !ch.is_whitespace()).collect();
            base64::engine::general_purpose::STANDARD.decode(clean).ok()
        }
        _ => None,
    };
    let too_large = raw.size > MAX_TEXT || (bytes.is_none() && raw.size > 0);
    let binary = bytes.as_ref().is_some_and(|b| b.iter().take(8000).any(|&c| c == 0));
    let content = match (&bytes, binary || too_large) {
        (Some(b), false) => Some(String::from_utf8_lossy(b).into_owned()),
        _ => None,
    };
    RepoFile { path: raw.path, size: raw.size, content, binary, too_large: too_large && !binary, html_url: raw.html_url }
}

pub async fn file(owner: &str, repo: &str, path: &str, git_ref: Option<&str>) -> AppResult<RepoFile> {
    check_repo(owner, repo)?;
    let p = repo_path(path)?;
    if p.is_empty() {
        return Err(AppError::Invalid("pick a file".into()));
    }
    let raw: RawFile = get(&require_token()?, &format!("/repos/{owner}/{repo}/contents/{p}{}", ref_query(git_ref)?))
        .await
        .map_err(|e| match e {
            AppError::Internal(_) => AppError::Invalid("this path is a folder, not a file".into()),
            e => e,
        })?;
    Ok(decode_file(raw))
}

pub async fn branches(owner: &str, repo: &str) -> AppResult<Vec<String>> {
    check_repo(owner, repo)?;
    let list: Vec<Branch> = get(&require_token()?, &format!("/repos/{owner}/{repo}/branches?per_page=100")).await?;
    Ok(list.into_iter().map(|b| b.name).collect())
}

// ---------- Local clones ----------

/// "owner/repo" (lower case) of every GitHub remote in a `.git/config`.
pub fn github_remotes(config: &str) -> Vec<String> {
    config
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let url = l.strip_prefix("url")?.trim_start().strip_prefix('=')?.trim();
            let rest = url
                .strip_prefix("https://github.com/")
                .or_else(|| url.strip_prefix("http://github.com/"))
                .or_else(|| url.strip_prefix("git@github.com:"))
                .or_else(|| url.strip_prefix("ssh://git@github.com/"))
                .or_else(|| url.split_once('@').and_then(|(_, r)| r.strip_prefix("github.com/")))?;
            let rest = rest.trim_end_matches('/').trim_end_matches(".git");
            let mut parts = rest.split('/');
            let (owner, repo) = (parts.next()?, parts.next()?);
            (valid_slug(owner) && valid_slug(repo)).then(|| format!("{owner}/{repo}").to_lowercase())
        })
        .collect()
}

/// The `.git` config of a working tree (`.git` folder, or a `.git` file pointing elsewhere).
fn git_config(dir: &std::path::Path) -> Option<String> {
    let dot = dir.join(".git");
    if dot.is_dir() {
        return std::fs::read_to_string(dot.join("config")).ok();
    }
    let pointer = std::fs::read_to_string(&dot).ok()?;
    let gitdir = pointer.trim().strip_prefix("gitdir:")?.trim();
    let gitdir = dir.join(gitdir);
    std::fs::read_to_string(gitdir.join("config"))
        .or_else(|_| std::fs::read_to_string(gitdir.join("..").join("..").join("config")))
        .ok()
}

const SKIP: &[&str] = &[
    "node_modules", "target", "windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "appdata",
    "system volume information", "recovery", "perflogs", "msocache", "dist", "build", "out", "bin", "obj", "venv", ".venv",
];

/// Folders where clones usually live. Drive roots are scanned two levels deep,
/// the user's folders three; NETRUNNER's own project list is checked directly.
pub fn search_roots(projects: &[std::path::PathBuf]) -> Vec<(std::path::PathBuf, usize)> {
    let mut out: Vec<(std::path::PathBuf, usize)> = projects.iter().map(|p| (p.clone(), 0)).collect();
    if let Some(home) = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from) {
        for sub in ["source\\repos", "Documents\\GitHub", "Documents", "Projects", "projects", "dev", "code", "repos", "src", "git", "Desktop"] {
            out.push((home.join(sub), 3));
        }
    }
    for letter in b'C'..=b'Z' {
        let root = std::path::PathBuf::from(format!("{}:\\", letter as char));
        if root.exists() {
            out.push((root, 2));
        }
    }
    out
}

/// Finds local clones of GitHub repositories under `roots`, bounded by depth
/// and by the number of folders visited. Returns "owner/repo" → folder.
pub fn find_clones(roots: &[(std::path::PathBuf, usize)], max_dirs: usize) -> std::collections::BTreeMap<String, String> {
    let mut found = std::collections::BTreeMap::new();
    let mut seen = std::collections::HashSet::new();
    let mut visited = 0usize;
    let mut stack: Vec<(std::path::PathBuf, usize)> = roots.iter().rev().cloned().collect();
    while let Some((dir, depth)) = stack.pop() {
        if visited >= max_dirs || !seen.insert(dir.clone()) {
            continue;
        }
        visited += 1;
        if let Some(cfg) = git_config(&dir) {
            for full in github_remotes(&cfg) {
                found.entry(full).or_insert_with(|| crate::dev::workspace::display(&dir));
            }
            // A working tree's subfolders are its own files, not other clones.
            continue;
        }
        if depth == 0 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut subdirs: Vec<std::path::PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| {
                let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
                !name.starts_with('.') && !name.starts_with('$') && !SKIP.contains(&name.as_str())
            })
            .collect();
        subdirs.sort();
        for sub in subdirs.into_iter().rev() {
            stack.push((sub, depth - 1));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert!(valid_slug("netrunner-app"));
        assert!(valid_slug("user.name"));
        assert!(!valid_slug("../etc"));
        assert!(!valid_slug("a/b"));
        assert!(!valid_slug(""));
    }

    #[test]
    fn remotes_and_paths() {
        let cfg = "[remote \"origin\"]\n\turl = https://github.com/Occka/NetRunner.git\n[remote \"up\"]\n\turl = git@github.com:other/tool\n[remote \"x\"]\n\turl = https://gitlab.com/a/b.git\n";
        assert_eq!(github_remotes(cfg), ["occka/netrunner", "other/tool"]);
        assert_eq!(repo_path("/src/main.rs").unwrap(), "src/main.rs");
        assert_eq!(repo_path("docs/My File.md").unwrap(), "docs/My%20File.md");
        assert!(repo_path("../x").is_err() && repo_path("a//b").is_err() && repo_path("a\\b").is_err());
        assert_eq!(ref_query(Some("feature/x")).unwrap(), "?ref=feature%2Fx");
        assert!(ref_query(Some("a..b")).is_err());
    }

    #[test]
    fn decodes_text_and_refuses_binary() {
        let enc = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let f = decode_file(RawFile { path: "a.txt".into(), size: 5, content: Some(enc(b"hello")), encoding: Some("base64".into()), html_url: None });
        assert_eq!(f.content.as_deref(), Some("hello"));
        let f = decode_file(RawFile { path: "a.png".into(), size: 4, content: Some(enc(&[0x89, 0, 1, 2])), encoding: Some("base64".into()), html_url: None });
        assert!(f.binary && f.content.is_none());
        let f = decode_file(RawFile { path: "big.bin".into(), size: 5_000_000, content: Some(String::new()), encoding: Some("none".into()), html_url: None });
        assert!(f.too_large && f.content.is_none());
    }

    #[test]
    fn finds_local_clones() {
        let root = std::env::temp_dir().join(format!("nr-clones-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("work").join("netrunner");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git").join("config"), "[remote \"origin\"]\n\turl = https://github.com/occka/netrunner.git\n").unwrap();
        // A clone nested inside a working tree is not looked for.
        std::fs::create_dir_all(repo.join("vendor").join("inner").join(".git")).unwrap();
        let found = find_clones(&[(root.clone(), 3)], 1000);
        assert_eq!(found.len(), 1);
        assert!(found["occka/netrunner"].to_lowercase().ends_with("netrunner"));
        assert!(find_clones(&[(root.clone(), 1)], 1000).is_empty(), "depth limit");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn deserializes_github_repo() {
        let json = r#"{"full_name":"o/r","name":"r","description":null,"private":true,"fork":false,"language":"Rust",
            "stargazers_count":3,"open_issues_count":1,"clone_url":"https://github.com/o/r.git","html_url":"https://github.com/o/r",
            "default_branch":"main","pushed_at":"2026-01-01T00:00:00Z"}"#;
        let r: Repo = serde_json::from_str(json).unwrap();
        assert_eq!(r.full_name, "o/r");
        assert_eq!(r.stargazers_count, 3);
    }
}
