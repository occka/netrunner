//! GitHub REST API client. The personal access token lives only in Windows
//! Credential Manager (DPAPI-protected) and is never returned to the UI.

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
    fn deserializes_github_repo() {
        let json = r#"{"full_name":"o/r","name":"r","description":null,"private":true,"fork":false,"language":"Rust",
            "stargazers_count":3,"open_issues_count":1,"clone_url":"https://github.com/o/r.git","html_url":"https://github.com/o/r",
            "default_branch":"main","pushed_at":"2026-01-01T00:00:00Z"}"#;
        let r: Repo = serde_json::from_str(json).unwrap();
        assert_eq!(r.full_name, "o/r");
        assert_eq!(r.stargazers_count, 3);
    }
}
