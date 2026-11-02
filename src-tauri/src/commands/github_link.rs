//! DEVELOPER ↔ GITHUB commands. Creating repositories, pull requests and
//! comments publishes data, so those commands require `confirmed`.

use tauri::State;

use crate::dev::github_link::{self as link, Checks, Comment, CreatedPr, CreatedRepo, Origin, PrDetail, PrFile};
use crate::dev::{git, workspace};
use crate::error::{AppError, AppResult};
use crate::services::activity::{self, Level};
use crate::state::AppState;

fn project(state: &AppState, root: &str) -> AppResult<std::path::PathBuf> {
    let roots = workspace::roots(&*state.db.conn()?)?;
    let p = workspace::resolve(&roots, root, true)?;
    if !roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|r| r == p) {
        return Err(AppError::Invalid("not an open project".into()));
    }
    Ok(std::path::PathBuf::from(workspace::display(&p)))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Internal(e.to_string()))?
}

fn log(state: &AppState, msg: &str) {
    if let Ok(c) = state.db.conn() {
        activity::record(&c, Level::Info, "github", msg);
    }
}

fn need(confirmed: bool, what: &str) -> AppResult<()> {
    if confirmed {
        Ok(())
    } else {
        Err(AppError::ConfirmationRequired(format!("{what} publishes to GitHub")))
    }
}

#[tauri::command]
pub async fn gh_origin(state: State<'_, AppState>, root: String) -> AppResult<Option<Origin>> {
    let p = project(&state, &root)?;
    blocking(move || link::origin(&p)).await
}

#[tauri::command]
pub async fn gh_publish(state: State<'_, AppState>, root: String, name: String, description: String, private: bool, confirmed: bool) -> AppResult<CreatedRepo> {
    need(confirmed, "creating a repository")?;
    let p = project(&state, &root)?;
    let created = link::publish(&p, &name, &description, private).await?;
    log(&state, &format!("Published {} to {}", workspace::display(&p), created.full_name));
    Ok(created)
}

#[tauri::command]
pub async fn gh_commits_since(state: State<'_, AppState>, root: String, base: String) -> AppResult<Vec<String>> {
    let p = project(&state, &root)?;
    blocking(move || link::commits_since(&p, &base)).await
}

/// Pushes the current branch, then opens a pull request from it into `base`.
#[tauri::command]
pub async fn gh_create_pr(state: State<'_, AppState>, root: String, title: String, body: String, base: String, draft: bool, confirmed: bool) -> AppResult<CreatedPr> {
    need(confirmed, "a pull request")?;
    let p = project(&state, &root)?;
    let origin = {
        let p = p.clone();
        blocking(move || link::origin(&p)).await?
    }
    .ok_or_else(|| AppError::Invalid("this project has no GitHub 'origin' remote".into()))?;
    let head = origin.branch.clone().ok_or_else(|| AppError::Invalid("switch to a branch first (HEAD is detached)".into()))?;
    {
        let p = p.clone();
        blocking(move || git::push(&p)).await?;
    }
    let pr = link::create_pr(&origin.owner, &origin.repo, &title, &body, &head, &base, draft).await?;
    log(&state, &format!("Opened pull request #{} ({head} → {base}) in {}/{}", pr.number, origin.owner, origin.repo));
    Ok(pr)
}

#[tauri::command]
pub async fn gh_pr(owner: String, repo: String, number: u64) -> AppResult<PrDetail> {
    link::pr(&owner, &repo, number).await
}

#[tauri::command]
pub async fn gh_pr_files(owner: String, repo: String, number: u64) -> AppResult<Vec<PrFile>> {
    link::pr_files(&owner, &repo, number).await
}

#[tauri::command]
pub async fn gh_comments(owner: String, repo: String, number: u64) -> AppResult<Vec<Comment>> {
    link::comments(&owner, &repo, number).await
}

#[tauri::command]
pub async fn gh_add_comment(state: State<'_, AppState>, owner: String, repo: String, number: u64, body: String, confirmed: bool) -> AppResult<Comment> {
    need(confirmed, "a comment")?;
    let c = link::add_comment(&owner, &repo, number, &body).await?;
    log(&state, &format!("Commented on {owner}/{repo}#{number}"));
    Ok(c)
}

#[tauri::command]
pub async fn gh_checkout_pr(state: State<'_, AppState>, root: String, number: u64) -> AppResult<String> {
    let p = project(&state, &root)?;
    blocking(move || link::checkout_pr(&p, number)).await
}

#[tauri::command]
pub async fn gh_checks(owner: String, repo: String, git_ref: String) -> AppResult<Checks> {
    link::checks(&owner, &repo, &git_ref).await
}

/// Creates and switches to `issue-<n>-<slug>` for an issue.
#[tauri::command]
pub async fn gh_issue_branch(state: State<'_, AppState>, root: String, number: u64, title: String) -> AppResult<String> {
    let p = project(&state, &root)?;
    let name = link::issue_branch(number, &title);
    let n = name.clone();
    blocking(move || git::create_branch(&p, &n)).await?;
    Ok(name)
}

/// GitHub URL of a project file: at the current commit (permalink) or branch.
#[tauri::command]
pub async fn gh_file_url(state: State<'_, AppState>, root: String, path: String, from: Option<u32>, to: Option<u32>, permalink: bool) -> AppResult<String> {
    let p = project(&state, &root)?;
    let origin = blocking(move || link::origin(&p)).await?.ok_or_else(|| AppError::Invalid("this project has no GitHub 'origin' remote".into()))?;
    let git_ref = if permalink { origin.head.clone() } else { origin.branch.clone() }.ok_or_else(|| AppError::Invalid("no commit yet".into()))?;
    if path.contains("..") || path.starts_with('/') {
        return Err(AppError::Invalid("invalid path".into()));
    }
    Ok(link::blob_url(&origin.owner, &origin.repo, &git_ref, &path, from.map(|f| (f, to.unwrap_or(f)))))
}
