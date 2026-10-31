//! Now playing per browser tab, read through the media hook script
//! (`media_hook.js`) that every tab gets. Unlike Windows media sessions, this
//! tells NETRUNNER's tabs apart (SoundCloud vs YouTube) and controls exactly
//! the tab shown in the Music Player.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::{webview, Browser};
use crate::error::{AppError, AppResult};

pub const HOOK: &str = include_str!("media_hook.js");

/// Media Session actions a page can receive from NETRUNNER.
const ACTIONS: &[&str] = &["toggle", "play", "pause", "nexttrack", "previoustrack", "stop"];

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct HookState {
    title: String,
    artist: String,
    album: String,
    artwork: Vec<Artwork>,
    playing: bool,
    present: bool,
    position: Option<f64>,
    duration: Option<f64>,
    actions: Vec<String>,
    #[serde(rename = "docTitle")]
    doc_title: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct Artwork {
    src: String,
    sizes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabMedia {
    pub tab: String,
    /// Window hosting the tab: `main` or `overlay-<id>`.
    pub host: String,
    pub url: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Largest https artwork the page declared (fetch with [`artwork`]).
    pub artwork_url: Option<String>,
    pub playing: bool,
    pub position_secs: Option<f64>,
    pub duration_secs: Option<f64>,
    pub can_previous: bool,
    pub can_next: bool,
    pub muted: bool,
}

fn clip(s: String, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Picks the largest declared artwork ("512x512" beats "96x96").
fn best_artwork(list: &[Artwork]) -> Option<String> {
    list.iter()
        .filter(|a| a.src.starts_with("https://") && a.src.len() < 2048)
        .max_by_key(|a| a.sizes.split(['x', 'X']).next().and_then(|w| w.trim().parse::<u32>().ok()).unwrap_or(0))
        .map(|a| a.src.clone())
}

async fn eval_json(app: &AppHandle, id: &str, js: &str) -> Option<String> {
    let view = webview(app, id).ok()?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    view.eval_with_callback(js, move |raw| {
        let _ = tx.send(raw);
    })
    .ok()?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_millis(800)).ok()).await.ok().flatten()
}

/// Media state of every tab and web overlay that has played or declared media.
pub async fn states(app: &AppHandle) -> Vec<TabMedia> {
    let Some(browser) = app.try_state::<Browser>() else { return vec![] };
    let tabs: Vec<_> = browser.tabs().into_iter().filter(|t| t.host == "main" || t.host.starts_with("overlay-")).collect();
    let queries = tabs.iter().map(|t| {
        let app = app.clone();
        let id = t.id.clone();
        async move { eval_json(&app, &id, "window.__nrMedia ? window.__nrMedia.state() : 'null'").await }
    });
    let results = futures_util::future::join_all(queries).await;
    tabs.into_iter()
        .zip(results)
        .filter_map(|(tab, raw)| {
            // ExecuteScript returns the JSON encoding of the returned string.
            let state: HookState =
                raw.and_then(|r| serde_json::from_str::<String>(&r).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            if !state.present && !tab.audible {
                return None;
            }
            let title = if state.title.is_empty() { if state.doc_title.is_empty() { tab.title.clone() } else { state.doc_title } } else { state.title };
            Some(TabMedia {
                tab: tab.id,
                host: tab.host,
                url: tab.url,
                title: clip(title, 300),
                artist: clip(state.artist, 200),
                album: clip(state.album, 200),
                artwork_url: best_artwork(&state.artwork),
                playing: state.playing || tab.audible,
                position_secs: state.position.filter(|p| *p >= 0.0),
                duration_secs: state.duration.filter(|d| *d > 0.0 && d.is_finite()),
                can_previous: state.actions.iter().any(|a| a == "previoustrack"),
                can_next: state.actions.iter().any(|a| a == "nexttrack"),
                muted: tab.muted,
            })
        })
        .collect()
}

pub fn control(app: &AppHandle, id: &str, action: &str) -> AppResult<()> {
    if !ACTIONS.contains(&action) {
        return Err(AppError::Invalid(format!("unknown media action {action}")));
    }
    // `action` is from a fixed list, so it is safe to put in the script.
    webview(app, id)?
        .eval(format!("window.__nrMedia && window.__nrMedia.act('{action}')"))
        .map_err(|e| AppError::Internal(e.to_string()))
}

fn art_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Downloads a page's declared artwork as a data URL (the UI's CSP only
/// allows inline images). Cached per URL; at most 2 MB, images only.
pub async fn artwork(url: &str) -> Option<String> {
    if !url.starts_with("https://") {
        return None;
    }
    if let Some(hit) = art_cache().lock().ok().and_then(|c| c.get(url).cloned()) {
        return hit;
    }
    let fetched = async {
        let resp = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().ok()?.get(url).send().await.ok()?;
        let mime = resp.headers().get("content-type")?.to_str().ok()?.split(';').next()?.trim().to_string();
        if !mime.starts_with("image/") || resp.content_length().is_some_and(|l| l > 2_000_000) {
            return None;
        }
        let bytes = resp.bytes().await.ok()?;
        (bytes.len() <= 2_000_000).then(|| format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }
    .await;
    if let Ok(mut cache) = art_cache().lock() {
        if cache.len() > 64 {
            cache.clear();
        }
        cache.insert(url.to_string(), fetched.clone());
    }
    fetched
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_largest_https_artwork() {
        let list = vec![
            Artwork { src: "https://i1.sndcdn.com/a-t50x50.jpg".into(), sizes: "50x50".into() },
            Artwork { src: "https://i1.sndcdn.com/a-t500x500.jpg".into(), sizes: "500x500".into() },
            Artwork { src: "http://insecure.example/x.jpg".into(), sizes: "1000x1000".into() },
        ];
        assert_eq!(best_artwork(&list).as_deref(), Some("https://i1.sndcdn.com/a-t500x500.jpg"));
        assert_eq!(best_artwork(&[]), None);
    }

    #[test]
    fn hook_state_tolerates_partial_json() {
        let s: HookState = serde_json::from_str(r#"{"title":"Track","playing":true,"actions":["nexttrack"]}"#).unwrap();
        assert!(s.playing && s.artist.is_empty() && s.actions == ["nexttrack"]);
    }
}
