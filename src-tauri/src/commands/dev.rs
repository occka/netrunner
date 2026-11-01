//! DEVELOPER (workspace, terminal, toolchains, git) and GITHUB commands.

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::State;

use crate::dev::terminal::{ShellOption, TermEvent, Terminals};
use crate::dev::{git, github, toolchains, workspace};
use crate::error::{AppError, AppResult};
use crate::services::activity::{self, Level};
use crate::services::settings;
use crate::state::AppState;

/// Runs blocking work (processes, disk) off the async executor.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Internal(e.to_string()))?
}

fn roots(state: &AppState) -> AppResult<Vec<PathBuf>> {
    workspace::roots(&*state.db.conn()?)
}

/// Resolves a project root given by the UI; it must be a registered project.
fn project(state: &AppState, root: &str) -> AppResult<PathBuf> {
    let roots = roots(state)?;
    let p = workspace::resolve(&roots, root, true)?;
    if !roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|r| r == p) {
        return Err(AppError::Invalid("not an open project".into()));
    }
    Ok(p)
}

fn log(state: &AppState, source: &str, msg: &str) {
    if let Ok(c) = state.db.conn() {
        activity::record(&c, Level::Info, source, msg);
    }
}

// ---------- Workspace ----------

#[tauri::command]
pub async fn dev_projects(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(roots(&state)?.iter().map(|p| workspace::display(p)).collect())
}

#[tauri::command]
pub async fn dev_open_project(state: State<'_, AppState>, path: String) -> AppResult<String> {
    let root = workspace::add_root(&*state.db.conn()?, &path)?;
    log(&state, "developer", &format!("Opened project {root}"));
    Ok(root)
}

#[tauri::command]
pub async fn dev_close_project(state: State<'_, AppState>, path: String) -> AppResult<()> {
    workspace::remove_root(&*state.db.conn()?, &path)
}

#[tauri::command]
pub async fn dev_list_dir(state: State<'_, AppState>, path: String) -> AppResult<Vec<workspace::DirEntry>> {
    let r = roots(&state)?;
    blocking(move || workspace::list_dir(&r, &path)).await
}

#[tauri::command]
pub async fn dev_read_file(state: State<'_, AppState>, path: String) -> AppResult<workspace::FileContent> {
    let r = roots(&state)?;
    blocking(move || workspace::read_file(&r, &path)).await
}

#[tauri::command]
pub async fn dev_write_file(state: State<'_, AppState>, path: String, content: String) -> AppResult<()> {
    let r = roots(&state)?;
    blocking(move || workspace::write_file(&r, &path, &content)).await
}

#[tauri::command]
pub async fn dev_create(state: State<'_, AppState>, parent: String, name: String, dir: bool) -> AppResult<String> {
    let r = roots(&state)?;
    blocking(move || workspace::create(&r, &parent, &name, dir)).await
}

#[tauri::command]
pub async fn dev_rename(state: State<'_, AppState>, path: String, new_name: String) -> AppResult<String> {
    let r = roots(&state)?;
    blocking(move || workspace::rename(&r, &path, &new_name)).await
}

/// Moves to the Recycle Bin. The UI confirms first.
#[tauri::command]
pub async fn dev_delete(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let r = roots(&state)?;
    let shown = path.clone();
    blocking(move || workspace::recycle(&r, &path)).await?;
    log(&state, "developer", &format!("Moved {shown} to the Recycle Bin"));
    Ok(())
}

#[tauri::command]
pub async fn dev_reveal(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let p = workspace::resolve(&roots(&state)?, &path, true)?;
    let mut cmd = std::process::Command::new("explorer.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg(format!("/select,\"{}\"", workspace::display(&p)));
    }
    cmd.spawn().map(|_| ()).map_err(|e| AppError::Launch(e.to_string()))
}

#[tauri::command]
pub async fn dev_toolchains(state: State<'_, AppState>) -> AppResult<Vec<toolchains::Toolchain>> {
    let overrides: HashMap<String, String> = settings::get(&*state.db.conn()?, toolchains::PATHS_KEY)?
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    blocking(move || Ok(toolchains::detect(&overrides))).await
}

// ---------- Terminal ----------

#[tauri::command]
pub async fn term_shells() -> AppResult<Vec<ShellOption>> {
    blocking(|| Ok(crate::dev::terminal::available_shells())).await
}

#[tauri::command]
pub async fn term_spawn(
    state: State<'_, AppState>,
    terminals: State<'_, Terminals>,
    shell: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> AppResult<u32> {
    let dir = match cwd {
        Some(c) => Some(workspace::resolve(&roots(&state)?, &c, true)?),
        None => None,
    };
    terminals.spawn(&shell, dir, cols, rows, on_event)
}

#[tauri::command]
pub async fn term_write(terminals: State<'_, Terminals>, id: u32, data: String) -> AppResult<()> {
    terminals.write(id, &data)
}

#[tauri::command]
pub async fn term_resize(terminals: State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> AppResult<()> {
    terminals.resize(id, cols, rows)
}

#[tauri::command]
pub async fn term_kill(terminals: State<'_, Terminals>, id: u32) -> AppResult<()> {
    terminals.kill(id)
}

// ---------- Git ----------

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>, root: String) -> AppResult<git::RepoStatus> {
    let p = project(&state, &root)?;
    blocking(move || git::status(&p)).await
}

#[tauri::command]
pub async fn git_diff(state: State<'_, AppState>, root: String, path: String, staged: bool) -> AppResult<git::DiffContents> {
    let p = project(&state, &root)?;
    blocking(move || git::diff_contents(&p, &path, staged)).await
}

#[tauri::command]
pub async fn git_stage(state: State<'_, AppState>, root: String, paths: Vec<String>) -> AppResult<()> {
    let p = project(&state, &root)?;
    blocking(move || git::stage(&p, &paths)).await
}

#[tauri::command]
pub async fn git_unstage(state: State<'_, AppState>, root: String, paths: Vec<String>) -> AppResult<()> {
    let p = project(&state, &root)?;
    blocking(move || git::unstage(&p, &paths)).await
}

#[tauri::command]
pub async fn git_discard(state: State<'_, AppState>, root: String, path: String, untracked: bool, confirmed: bool) -> AppResult<()> {
    if !confirmed {
        return Err(AppError::ConfirmationRequired("discarding changes cannot be undone".into()));
    }
    let p = project(&state, &root)?;
    let shown = path.clone();
    blocking(move || git::discard(&p, &path, untracked)).await?;
    log(&state, "git", &format!("Discarded changes in {shown}"));
    Ok(())
}

#[tauri::command]
pub async fn git_commit(state: State<'_, AppState>, root: String, message: String) -> AppResult<String> {
    let p = project(&state, &root)?;
    let hash = blocking(move || git::commit(&p, &message)).await?;
    log(&state, "git", &format!("Committed {hash} in {root}"));
    Ok(hash)
}

#[tauri::command]
pub async fn git_log(state: State<'_, AppState>, root: String, limit: Option<u32>) -> AppResult<Vec<git::Commit>> {
    let p = project(&state, &root)?;
    blocking(move || git::log(&p, limit.unwrap_or(50))).await
}

#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>, root: String) -> AppResult<Vec<String>> {
    let p = project(&state, &root)?;
    blocking(move || git::branches(&p)).await
}

#[tauri::command]
pub async fn git_checkout(state: State<'_, AppState>, root: String, branch: String) -> AppResult<()> {
    let p = project(&state, &root)?;
    blocking(move || git::checkout(&p, &branch)).await
}

#[tauri::command]
pub async fn git_create_branch(state: State<'_, AppState>, root: String, name: String) -> AppResult<()> {
    let p = project(&state, &root)?;
    blocking(move || git::create_branch(&p, &name)).await
}

#[tauri::command]
pub async fn git_pull(state: State<'_, AppState>, root: String) -> AppResult<String> {
    let p = project(&state, &root)?;
    let out = blocking(move || git::pull(&p)).await?;
    log(&state, "git", &format!("Pulled {root}"));
    Ok(out)
}

/// Pushing publishes commits; the UI asks first, and the backend requires it.
#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, root: String, confirmed: bool) -> AppResult<String> {
    if !confirmed {
        return Err(AppError::ConfirmationRequired("pushing publishes your commits to the remote".into()));
    }
    let p = project(&state, &root)?;
    let out = blocking(move || git::push(&p)).await?;
    log(&state, "git", &format!("Pushed {root}"));
    Ok(out)
}

#[tauri::command]
pub async fn git_init(state: State<'_, AppState>, root: String) -> AppResult<()> {
    let p = project(&state, &root)?;
    blocking(move || git::init(&p)).await
}

/// Clones into a folder the user picked, then opens it as a project.
#[tauri::command]
pub async fn git_clone(state: State<'_, AppState>, url: String, parent: String, name: String) -> AppResult<String> {
    let parent_dir = std::fs::canonicalize(&parent).map_err(|_| AppError::NotFound("destination folder not found".into()))?;
    let u = url.clone();
    let target = blocking(move || git::clone(&u, &parent_dir, &name)).await?;
    let root = workspace::add_root(&*state.db.conn()?, &target.to_string_lossy())?;
    log(&state, "git", &format!("Cloned {url} into {root}"));
    Ok(root)
}

// ---------- GitHub ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubStatus {
    pub connected: bool,
    pub user: Option<github::User>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn github_status() -> AppResult<GitHubStatus> {
    if github::token()?.is_none() {
        return Ok(GitHubStatus { connected: false, user: None, error: None });
    }
    match github::user().await {
        Ok(user) => Ok(GitHubStatus { connected: true, user: Some(user), error: None }),
        Err(e) => Ok(GitHubStatus { connected: true, user: None, error: Some(e.to_string()) }),
    }
}

/// Validates the token against GitHub before storing it in Credential Manager.
#[tauri::command]
pub async fn github_connect(state: State<'_, AppState>, token: String) -> AppResult<github::User> {
    let token = token.trim().to_string();
    if token.len() < 20 || token.chars().any(char::is_whitespace) {
        return Err(AppError::Invalid("that does not look like a GitHub token".into()));
    }
    let user = github::user_with(&token).await?;
    github::store_token(&token)?;
    log(&state, "github", &format!("Connected GitHub account {}", user.login));
    Ok(user)
}

#[tauri::command]
pub async fn github_disconnect(state: State<'_, AppState>) -> AppResult<()> {
    github::delete_token()?;
    log(&state, "github", "Disconnected GitHub account (token removed from Credential Manager)");
    Ok(())
}

#[tauri::command]
pub async fn github_repos() -> AppResult<Vec<github::Repo>> {
    github::repos().await
}

#[tauri::command]
pub async fn github_issues(owner: String, repo: String, pulls: bool, state: Option<String>) -> AppResult<Vec<github::Issue>> {
    github::issues(&owner, &repo, pulls, state.as_deref().unwrap_or("open")).await
}

#[tauri::command]
pub async fn github_contents(owner: String, repo: String, path: String, git_ref: Option<String>) -> AppResult<Vec<github::RepoEntry>> {
    github::contents(&owner, &repo, &path, git_ref.as_deref()).await
}

#[tauri::command]
pub async fn github_file(owner: String, repo: String, path: String, git_ref: Option<String>) -> AppResult<github::RepoFile> {
    github::file(&owner, &repo, &path, git_ref.as_deref()).await
}

#[tauri::command]
pub async fn github_branches(owner: String, repo: String) -> AppResult<Vec<String>> {
    github::branches(&owner, &repo).await
}

const LINKS_KEY: &str = "github.links";

/// Local clones: folders you linked by hand, then clones found automatically
/// (project list, usual folders, drive roots; bounded scan). "owner/repo" (lower case) → folder.
#[tauri::command]
pub async fn github_local_clones(state: State<'_, AppState>) -> AppResult<std::collections::BTreeMap<String, String>> {
    let (projects, links) = {
        let conn = state.db.conn()?;
        (workspace::roots(&conn)?, crate::services::settings::get(&conn, LINKS_KEY)?.unwrap_or_default())
    };
    let mut found = tauri::async_runtime::spawn_blocking(move || github::find_clones(&github::search_roots(&projects), 6000))
        .await
        .map_err(|e| crate::error::AppError::Internal(e.to_string()))?;
    if let Some(map) = links.as_object() {
        for (repo, path) in map {
            if let Some(path) = path.as_str().filter(|p| std::path::Path::new(p).is_dir()) {
                found.insert(repo.to_lowercase(), path.to_string());
            }
        }
    }
    Ok(found)
}

/// Links a repository to a local folder (a Git working tree), or removes the link with `path` = None.
#[tauri::command]
pub async fn github_link_local(state: State<'_, AppState>, full_name: String, path: Option<String>) -> AppResult<()> {
    let key = full_name.to_lowercase();
    if key.split('/').count() != 2 || key.len() > 201 {
        return Err(crate::error::AppError::Invalid("invalid repository".into()));
    }
    let conn = state.db.conn()?;
    let mut links = crate::services::settings::get(&conn, LINKS_KEY)?.unwrap_or_else(|| serde_json::json!({}));
    if !links.is_object() {
        links = serde_json::json!({});
    }
    match path {
        Some(p) => {
            let dir = std::fs::canonicalize(&p).map_err(|_| crate::error::AppError::NotFound(format!("folder not found: {p}")))?;
            if !dir.join(".git").exists() {
                return Err(crate::error::AppError::Invalid("this folder is not a Git repository (no .git inside)".into()));
            }
            links[&key] = serde_json::json!(workspace::display(&dir));
        }
        None => {
            if let Some(map) = links.as_object_mut() {
                map.remove(&key);
            }
        }
    }
    crate::services::settings::set(&conn, LINKS_KEY, &links)
}
