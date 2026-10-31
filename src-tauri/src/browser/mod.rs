//! BROWSER: WebView2 tabs embedded in NETRUNNER windows.
//!
//! Every page runs in a child webview labelled `web-*` with its own WebView2
//! profile (`<local data>/browser`), so sites never share storage with the
//! NETRUNNER UI. Remote pages get no IPC: Tauri's ACL refuses remote origins
//! and `lib.rs` additionally rejects any command from a `web-*` webview. The
//! React UI draws the tab strip and address bar and positions the native
//! webview over an empty element (`browser_set_bounds`).
//!
//! Protection layers (see docs/SECURITY.md): network and cosmetic content
//! blocking ([`blocker`]), Strict tracking prevention, SmartScreen, HTTPS-only
//! navigation, Global Privacy Control, deny-by-default site permissions, no
//! password or form autofill by default, blocked external-app launches, no
//! `file:` or custom-scheme navigation, popups opened as tabs.

pub mod blocker;
pub mod data;
pub mod media;
#[cfg(windows)]
mod native;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder, WebviewUrl};

use crate::error::{AppError, AppResult};
use crate::services::settings;
use crate::state::AppState;
use blocker::Blocker;

/// Webview label prefix for every page NETRUNNER does not control.
pub const LABEL_PREFIX: &str = "web-";

/// User preferences, stored as `browser.*` settings (see `stores/settings.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub adblock: bool,
    pub cosmetic: bool,
    pub https_only: bool,
    pub gpc: bool,
    pub tracking: String,
    pub history: bool,
    pub autofill: bool,
    pub search: String,
    pub lists: Vec<String>,
    pub exceptions: Vec<String>,
    pub webrtc_protect: bool,
    pub extensions: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            adblock: true,
            cosmetic: true,
            https_only: true,
            gpc: true,
            tracking: "strict".into(),
            history: true,
            autofill: false,
            search: "duckduckgo".into(),
            lists: blocker::default_lists(),
            exceptions: Vec::new(),
            webrtc_protect: true,
            extensions: false,
        }
    }
}

impl Prefs {
    pub fn load(conn: &rusqlite::Connection) -> Self {
        let mut p = Prefs::default();
        let get = |k: &str| settings::get(conn, &format!("browser.{k}")).ok().flatten();
        let flag = |k: &str, d: bool| get(k).and_then(|v| v.as_bool()).unwrap_or(d);
        let text = |k: &str, d: &str| get(k).and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| d.to_string());
        let list = |k: &str| {
            get(k).and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect::<Vec<_>>()))
        };
        p.adblock = flag("adblock", p.adblock);
        p.cosmetic = flag("cosmetic", p.cosmetic);
        p.https_only = flag("https_only", p.https_only);
        p.gpc = flag("gpc", p.gpc);
        p.tracking = text("tracking", &p.tracking);
        p.history = flag("history", p.history);
        p.autofill = flag("autofill", p.autofill);
        p.search = text("search", &p.search);
        p.lists = list("adblock_lists").unwrap_or(p.lists);
        p.exceptions = list("adblock_exceptions").unwrap_or_default();
        p.webrtc_protect = flag("webrtc_protect", p.webrtc_protect);
        p.extensions = flag("extensions", p.extensions);
        p
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: String,
    /// Window that hosts the webview: `main`, `overlay-<id>` or a popup.
    pub host: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_back: bool,
    pub can_forward: bool,
    pub blocked: u64,
    pub private: bool,
    pub muted: bool,
    pub audible: bool,
    pub fullscreen: bool,
    pub favicon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub tab: String,
    /// `https-upgrade`, `permission`, `external-app`, `blocked-scheme`, `download`.
    pub kind: String,
    pub host: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: u64,
    pub url: String,
    pub path: Option<String>,
    /// `running`, `done`, `failed`.
    pub state: String,
}

pub struct Browser {
    pub blocker: Blocker,
    prefs: RwLock<Prefs>,
    tabs: Mutex<HashMap<String, Tab>>,
    next_id: AtomicU64,
    blocked_total: AtomicU64,
    profile_dir: PathBuf,
    extensions_dir: PathBuf,
    /// Hosts the user chose to load over plain HTTP this session.
    http_allowed: Mutex<HashSet<String>>,
    downloads: Mutex<Vec<Download>>,
}

impl Browser {
    pub fn new(data_dir: &std::path::Path, local_dir: &std::path::Path, prefs: Prefs) -> Self {
        Self {
            blocker: Blocker::new(data_dir),
            prefs: RwLock::new(prefs),
            tabs: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            blocked_total: AtomicU64::new(0),
            profile_dir: local_dir.join("browser"),
            extensions_dir: data_dir.join("browser-extensions"),
            http_allowed: Mutex::new(HashSet::new()),
            downloads: Mutex::new(Vec::new()),
        }
    }

    pub fn prefs(&self) -> Prefs {
        self.prefs.read().map(|p| p.clone()).unwrap_or_default()
    }

    pub fn tabs(&self) -> Vec<Tab> {
        let mut list: Vec<Tab> = self.tabs.lock().map(|t| t.values().cloned().collect()).unwrap_or_default();
        list.sort_by_key(|t| t.id.trim_start_matches(LABEL_PREFIX).trim_start_matches(|c: char| !c.is_ascii_digit()).parse::<u64>().unwrap_or(0));
        list
    }

    pub fn tab(&self, id: &str) -> Option<Tab> {
        self.tabs.lock().ok()?.get(id).cloned()
    }

    pub fn downloads(&self) -> Vec<Download> {
        self.downloads.lock().map(|d| d.clone()).unwrap_or_default()
    }

    pub fn blocked_total(&self) -> u64 {
        self.blocked_total.load(Ordering::Relaxed)
    }

    pub fn extensions_dir(&self) -> &PathBuf {
        &self.extensions_dir
    }

    /// Applies `f` to a tab and returns the updated copy (for emitting).
    fn update(&self, id: &str, f: impl FnOnce(&mut Tab)) -> Option<Tab> {
        let mut tabs = self.tabs.lock().ok()?;
        let tab = tabs.get_mut(id)?;
        f(tab);
        Some(tab.clone())
    }

    pub(crate) fn count_blocked(&self, id: &str) {
        self.blocked_total.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut tabs) = self.tabs.lock() {
            if let Some(t) = tabs.get_mut(id) {
                t.blocked += 1;
            }
        }
    }

    pub(crate) fn is_exception(&self, page_url: &str) -> bool {
        let host = Url::parse(page_url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
        self.prefs.read().map(|p| p.exceptions.iter().any(|e| host == *e || host.ends_with(&format!(".{e}")))).unwrap_or(false)
    }
}

/// Re-reads `browser.*` settings after the UI changed one, and rebuilds the
/// content blocker when the list selection changed.
pub fn reload_prefs(app: &AppHandle) {
    let (Some(state), Some(browser)) = (app.try_state::<AppState>(), app.try_state::<Browser>()) else { return };
    let Ok(conn) = state.db.conn() else { return };
    let next = Prefs::load(&conn);
    let lists_changed = browser.prefs().lists != next.lists;
    if let Ok(mut p) = browser.prefs.write() {
        *p = next.clone();
    }
    if lists_changed {
        start_blocker(app.clone(), false);
    }
}

/// Loads the content blocker on a worker thread, downloading enabled lists
/// that are missing or stale first (unless `offline`).
pub fn start_blocker(app: AppHandle, offline: bool) {
    tauri::async_runtime::spawn(async move {
        let Some(browser) = app.try_state::<Browser>() else { return };
        let lists = browser.prefs().lists;
        if !offline {
            let stale = browser.blocker.stale(&lists);
            if !stale.is_empty() {
                // Build from what is cached first so blocking starts immediately.
                let app2 = app.clone();
                let lists2 = lists.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    if let Some(b) = app2.try_state::<Browser>() {
                        b.blocker.rebuild(&lists2)
                    }
                })
                .await;
                let errors = browser.blocker.download(&stale).await;
                browser.blocker.set_error(if errors.is_empty() {
                    None
                } else {
                    Some(errors.iter().map(|(id, e)| format!("{id}: {e}")).collect::<Vec<_>>().join("; "))
                });
            }
        }
        let app2 = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Some(b) = app2.try_state::<Browser>() {
                b.blocker.rebuild(&lists)
            }
        })
        .await;
        let _ = app.emit("browser://blocker", ());
    });
}

// ---------- Address bar ----------

pub const SEARCH_ENGINES: &[(&str, &str, &str)] = &[
    ("duckduckgo", "DuckDuckGo", "https://duckduckgo.com/?q="),
    ("startpage", "Startpage", "https://www.startpage.com/do/search?q="),
    ("brave", "Brave Search", "https://search.brave.com/search?q="),
    ("google", "Google", "https://www.google.com/search?q="),
    ("bing", "Bing", "https://www.bing.com/search?q="),
    ("yandex", "Yandex", "https://yandex.ru/search/?text="),
];

fn is_local_host(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
            std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
            std::net::IpAddr::V6(v6) => v6.is_loopback(),
        })
}

/// Turns address-bar input into a URL: a URL, a bare domain, or a search.
pub fn resolve_input(input: &str, search: &str) -> AppResult<Url> {
    let text = input.trim();
    if text.is_empty() {
        return Err(AppError::Invalid("enter an address or a search".into()));
    }
    if let Ok(url) = Url::parse(text) {
        match url.scheme() {
            "http" | "https" => return Ok(url),
            "about" if text == "about:blank" => return Ok(url),
            // "localhost:3000" parses with scheme "localhost"; fall through.
            s if s != "localhost" && !text.contains(' ') && text.contains("://") => {
                return Err(AppError::Invalid(format!("{s}: addresses are not opened by the browser")));
            }
            _ => {}
        }
    }
    let looks_like_host = !text.contains(char::is_whitespace)
        && (text.starts_with("localhost") || text.split('/').next().is_some_and(|h| h.contains('.') && !h.starts_with('.') && !h.ends_with('.')));
    if looks_like_host {
        let host = text.split(['/', ':']).next().unwrap_or("");
        let scheme = if is_local_host(host) { "http" } else { "https" };
        if let Ok(url) = Url::parse(&format!("{scheme}://{text}")) {
            return Ok(url);
        }
    }
    let base = SEARCH_ENGINES.iter().find(|(id, ..)| *id == search).unwrap_or(&SEARCH_ENGINES[0]).2;
    let query: String = url::form_urlencoded::byte_serialize(text.as_bytes()).collect();
    Url::parse(&format!("{base}{query}")).map_err(|e| AppError::Internal(e.to_string()))
}

// ---------- Webviews ----------

/// Navigation policy for top-level navigations: http(s) and about:blank only;
/// plain HTTP is upgraded unless the host is local or allowed this session.
fn navigation_allowed(app: &AppHandle, label: &str, url: &Url) -> bool {
    let Some(browser) = app.try_state::<Browser>() else { return false };
    match url.scheme() {
        "https" | "about" | "blob" | "data" => true,
        "http" => {
            let host = url.host_str().unwrap_or_default().to_string();
            let allowed = !browser.prefs().https_only
                || is_local_host(&host)
                || browser.http_allowed.lock().map(|h| h.contains(&host)).unwrap_or(false);
            if allowed {
                return true;
            }
            let mut https = url.clone();
            if https.set_scheme("https").is_ok() {
                notice(app, label, "https-upgrade", &host, url.as_str());
                let app = app.clone();
                let label = label.to_string();
                tauri::async_runtime::spawn(async move {
                    if let Some(w) = app.get_webview(&label) {
                        let _ = w.navigate(https);
                    }
                });
            }
            false
        }
        other => {
            notice(app, label, "blocked-scheme", url.host_str().unwrap_or(other), url.as_str());
            false
        }
    }
}

fn notice(app: &AppHandle, tab: &str, kind: &str, host: &str, detail: &str) {
    let _ = app.emit(
        "browser://notice",
        Notice { tab: tab.into(), kind: kind.into(), host: host.into(), detail: detail.chars().take(500).collect() },
    );
}

fn emit_tab(app: &AppHandle, tab: Option<Tab>) {
    if let Some(tab) = tab {
        let _ = app.emit("browser://tab", tab);
    }
}

fn permission_name(kind: PermissionKind) -> Option<&'static str> {
    Some(match kind {
        PermissionKind::Camera => "camera",
        PermissionKind::Microphone => "microphone",
        PermissionKind::Geolocation => "geolocation",
        PermissionKind::Notifications => "notifications",
        PermissionKind::ClipboardRead => "clipboard-read",
        PermissionKind::DisplayCapture => "display-capture",
        PermissionKind::Midi => "midi",
        PermissionKind::Sensors => "sensors",
        PermissionKind::LocalFonts => "local-fonts",
        PermissionKind::WindowManagement => "window-management",
        PermissionKind::AutomaticDownloads => "automatic-downloads",
        PermissionKind::FileSystemAccess => "file-system",
        // Left to WebView2's defaults: video DRM, autoplay after a click, games.
        _ => return None,
    })
}

fn on_permission(app: &AppHandle, label: &str, page: Option<Url>, kind: PermissionKind) -> PermissionResponse {
    let Some(name) = permission_name(kind) else { return PermissionResponse::Default };
    let host = page.and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let granted = app
        .try_state::<AppState>()
        .is_some_and(|s| s.db.conn().is_ok_and(|c| data::is_granted(&c, &host, name)));
    if granted {
        return PermissionResponse::Allow;
    }
    notice(app, label, "permission", &host, name);
    PermissionResponse::Deny
}

fn on_download(app: &AppHandle, label: &str, event: DownloadEvent<'_>) -> bool {
    let Some(browser) = app.try_state::<Browser>() else { return false };
    match event {
        DownloadEvent::Requested { url, destination } => {
            let id = browser.next_id.fetch_add(1, Ordering::Relaxed);
            let path = (!destination.as_os_str().is_empty()).then(|| destination.display().to_string());
            if let Ok(mut d) = browser.downloads.lock() {
                d.push(Download { id, url: url.to_string(), path, state: "running".into() });
                let excess = d.len().saturating_sub(50);
                d.drain(..excess);
            }
            notice(app, label, "download", url.host_str().unwrap_or(""), url.as_str());
        }
        DownloadEvent::Finished { url, path, success } => {
            if let Ok(mut d) = browser.downloads.lock() {
                if let Some(entry) = d.iter_mut().rev().find(|x| x.url == url.as_str() && x.state == "running") {
                    entry.state = if success { "done" } else { "failed" }.into();
                    entry.path = path.map(|p| p.display().to_string()).or(entry.path.take());
                }
            }
            let _ = app.emit("browser://downloads", ());
        }
        _ => {}
    }
    true
}

fn on_page_load(app: &AppHandle, label: &str, url: &Url, finished: bool) {
    let Some(browser) = app.try_state::<Browser>() else { return };
    let tab = browser.update(label, |t| {
        t.url = url.to_string();
        t.loading = !finished;
        if !finished {
            t.blocked = 0;
        }
    });
    if finished {
        if let Some(t) = &tab {
            let prefs = browser.prefs();
            if prefs.history && !t.private {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(conn) = state.db.conn() {
                        let _ = data::record_visit(&conn, &t.url, &t.title);
                    }
                }
            }
            if prefs.adblock && prefs.cosmetic && !browser.is_exception(&t.url) {
                inject_cosmetics(app.clone(), label.to_string(), t.url.clone());
            }
        }
    }
    emit_tab(app, tab);
}

/// Collects the page's classes and ids (bounded), asks the blocker which
/// generic hide rules apply, and injects them as a style element. Runs once at
/// load and once more for content added shortly after.
fn inject_cosmetics(app: AppHandle, label: String, url: String) {
    const COLLECT: &str = "(()=>{const c=new Set(),i=new Set();for(const e of document.querySelectorAll('[class],[id]')){if(c.size+i.size>4000)break;if(e.classList)for(const x of e.classList)c.add(x);if(e.id)i.add(e.id)}return JSON.stringify({c:[...c],i:[...i]})})()";
    for delay in [0u64, 2500] {
        let (app, label, url) = (app.clone(), label.clone(), url.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            let Some(webview) = app.get_webview(&label) else { return };
            let app2 = app.clone();
            let label2 = label.clone();
            let _ = webview.eval_with_callback(COLLECT, move |raw| {
                // ExecuteScript returns the JSON encoding of the returned string.
                let parsed: Option<Value> =
                    serde_json::from_str::<String>(&raw).ok().and_then(|s| serde_json::from_str(&s).ok());
                let strings = |v: Option<&Value>| -> Vec<String> {
                    v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
                };
                let classes = strings(parsed.as_ref().and_then(|p| p.get("c")));
                let ids = strings(parsed.as_ref().and_then(|p| p.get("i")));
                let Some(browser) = app2.try_state::<Browser>() else { return };
                let Some(css) = browser.blocker.cosmetic_css(&url, &classes, &ids) else { return };
                let Ok(css_json) = serde_json::to_string(&css) else { return };
                if let Some(w) = app2.get_webview(&label2) {
                    let _ = w.eval(format!(
                        "(()=>{{let s=document.getElementById('__nr_cosmetic');if(!s){{s=document.createElement('style');s.id='__nr_cosmetic';(document.head||document.documentElement).appendChild(s)}}s.textContent={css_json}}})()"
                    ));
                }
            });
        });
    }
}

/// Sends `navigator.globalPrivacyControl = true` to scripts as GPC requires.
const GPC_SCRIPT: &str = "try{Object.defineProperty(Navigator.prototype,'globalPrivacyControl',{get:()=>true,configurable:true})}catch(e){}";

fn browser_args(prefs: &Prefs) -> String {
    // Unlike NETRUNNER's own webview, SmartScreen stays on here.
    // HardwareMediaKeyHandling publishes playing pages to Windows media
    // sessions (volume flyout, media keys, the Music Player widget).
    let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI --enable-features=HardwareMediaKeyHandling");
    if prefs.webrtc_protect {
        // WebRTC may only use the default route, so local addresses do not leak.
        args.push_str(" --force-webrtc-ip-handling-policy=default_public_interface_only");
    }
    args
}

/// Applies the shared configuration to a `WebviewBuilder` or `WebviewWindowBuilder`.
macro_rules! configure {
    ($builder:expr, $app:expr, $browser:expr, $label:expr, $private:expr) => {{
        let prefs = $browser.prefs();
        let mut b = $builder
            .data_directory($browser.profile_dir.clone())
            .additional_browser_args(&browser_args(&prefs))
            .incognito($private)
            .devtools(cfg!(debug_assertions))
            .zoom_hotkeys_enabled(true)
            .general_autofill_enabled(prefs.autofill)
            .background_color(tauri::webview::Color(11, 13, 16, 255))
            .browser_extensions_enabled(prefs.extensions);
        if prefs.extensions {
            let _ = std::fs::create_dir_all($browser.extensions_dir());
            b = b.extensions_path($browser.extensions_dir());
        }
        if prefs.gpc {
            b = b.initialization_script_for_all_frames(GPC_SCRIPT);
        }
        b = b.initialization_script(media::HOOK);
        let (a1, l1) = ($app.clone(), $label.clone());
        let (a2, l2) = ($app.clone(), $label.clone());
        let (a3, l3) = ($app.clone(), $label.clone());
        let (a4, l4) = ($app.clone(), $label.clone());
        let (a5, l5) = ($app.clone(), $label.clone());
        let (a6, l6, private) = ($app.clone(), $label.clone(), $private);
        b.on_navigation(move |url| navigation_allowed(&a1, &l1, url))
            .on_page_load(move |_, payload| on_page_load(&a2, &l2, payload.url(), payload.event() == PageLoadEvent::Finished))
            .on_document_title_changed(move |_, title| {
                if let Some(b) = a3.try_state::<Browser>() {
                    emit_tab(&a3, b.update(&l3, |t| t.title = title.chars().take(300).collect()));
                }
            })
            .on_download(move |_, event| on_download(&a4, &l4, event))
            .on_permission_request(move |webview, kind| on_permission(&a5, &l5, webview.url().ok(), kind))
            .on_new_window(move |url, features| on_new_window(&a6, &l6, url, features, private))
    }};
}

/// `window.open` with an explicit size (sign-in popups) gets a real popup
/// window so `window.opener` keeps working; anything else opens as a tab.
fn on_new_window(
    app: &AppHandle,
    opener: &str,
    url: Url,
    features: tauri::webview::NewWindowFeatures,
    private: bool,
) -> NewWindowResponse<tauri::Wry> {
    if !matches!(url.scheme(), "http" | "https" | "about") {
        return NewWindowResponse::Deny;
    }
    let Some(browser) = app.try_state::<Browser>() else { return NewWindowResponse::Deny };
    let host = browser.tab(opener).map(|t| t.host).unwrap_or_else(|| "main".into());
    if features.size().is_some() {
        let label = format!("{LABEL_PREFIX}popup-{}", browser.next_id.fetch_add(1, Ordering::Relaxed));
        let size = features.size();
        let builder = tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::External("about:blank".parse().expect("valid")))
            .title(format!("NETRUNNER · {}", url.host_str().unwrap_or("popup")))
            .window_features(features);
        let builder = configure!(builder, app, browser, label, private);
        let builder = match size {
            Some(s) => builder.inner_size(s.width.clamp(200.0, 1600.0), s.height.clamp(200.0, 1200.0)),
            None => builder.inner_size(520.0, 640.0),
        };
        match builder.build() {
            Ok(window) => {
                register(app, &browser, &label, "popup", &url, private);
                #[cfg(windows)]
                native::harden(window.as_ref(), app.clone(), label);
                NewWindowResponse::Create { window }
            }
            Err(err) => {
                log::warn!("popup window failed: {err}");
                NewWindowResponse::Deny
            }
        }
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            match open_tab(&app, &host, url, private) {
                Ok(tab) => {
                    let _ = app.emit("browser://opened", tab);
                }
                Err(err) => log::warn!("cannot open tab: {err}"),
            }
        });
        NewWindowResponse::Deny
    }
}

fn register(app: &AppHandle, browser: &Browser, label: &str, host: &str, url: &Url, private: bool) -> Tab {
    let tab = Tab { id: label.into(), host: host.into(), url: url.to_string(), loading: true, private, ..Default::default() };
    if let Ok(mut tabs) = browser.tabs.lock() {
        tabs.insert(label.into(), tab.clone());
    }
    emit_tab(app, Some(tab.clone()));
    tab
}

/// Opens a page in a new hidden child webview of window `host`. The UI then
/// positions and shows it with [`set_bounds`].
pub fn open_tab(app: &AppHandle, host: &str, url: Url, private: bool) -> AppResult<Tab> {
    let browser = app.try_state::<Browser>().ok_or_else(|| AppError::Internal("browser not ready".into()))?;
    let window = app.get_window(host).ok_or_else(|| AppError::NotFound(format!("window {host} is not open")))?;
    if browser.tabs.lock().map(|t| t.len()).unwrap_or(0) >= 40 {
        return Err(AppError::Invalid("too many tabs are open (40)".into()));
    }
    let label = format!("{LABEL_PREFIX}{}", browser.next_id.fetch_add(1, Ordering::Relaxed));
    let tab = register(app, &browser, &label, host, &url, private);
    // Start blank: the page loads only after the request filter is installed
    // (`with_webview` and `navigate` run in order on the UI thread).
    let blank = WebviewUrl::External("about:blank".parse().expect("valid URL"));
    let builder = WebviewBuilder::new(&label, blank).focused(false);
    let builder = configure!(builder, app, browser, label, private);
    let webview = window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
        .map_err(|e| {
            if let Ok(mut t) = browser.tabs.lock() {
                t.remove(&label);
            }
            AppError::Internal(format!("cannot create browser view: {e}"))
        })?;
    let _ = webview.hide();
    #[cfg(windows)]
    native::harden(&webview, app.clone(), label);
    webview.navigate(url).map_err(|e| AppError::Internal(format!("cannot open page: {e}")))?;
    Ok(tab)
}

pub fn webview(app: &AppHandle, id: &str) -> AppResult<tauri::Webview> {
    if !id.starts_with(LABEL_PREFIX) {
        return Err(AppError::Invalid("not a browser tab".into()));
    }
    app.get_webview(id).ok_or_else(|| AppError::NotFound(format!("tab {id} is closed")))
}

/// Hides and forgets the tab at once; destroying the WebView2 controller can
/// take a moment, so it happens after the UI has moved on.
pub fn close_tab(app: &AppHandle, id: &str) -> AppResult<()> {
    let view = webview(app, id).ok();
    if let Some(w) = &view {
        let _ = w.hide();
    }
    if let Some(b) = app.try_state::<Browser>() {
        if let Ok(mut t) = b.tabs.lock() {
            t.remove(id);
        }
    }
    let _ = app.emit("browser://closed", id);
    if let Some(w) = view {
        tauri::async_runtime::spawn(async move {
            let _ = w.close();
        });
    }
    Ok(())
}

/// Forgets tabs whose host window was destroyed (overlay closed).
pub fn forget_host(app: &AppHandle, host: &str) {
    let Some(b) = app.try_state::<Browser>() else { return };
    let gone: Vec<String> = b.tabs.lock().map(|t| t.values().filter(|x| x.host == host).map(|x| x.id.clone()).collect()).unwrap_or_default();
    for id in gone {
        let _ = close_tab(app, &id);
    }
}

pub fn set_bounds(app: &AppHandle, id: &str, x: f64, y: f64, w: f64, h: f64, visible: bool) -> AppResult<()> {
    let webview = webview(app, id)?;
    if visible && w >= 1.0 && h >= 1.0 {
        // One call: wry's separate size/position setters re-read the current
        // position, which is wrong after a tab was moved to another window.
        let _ = webview.set_bounds(tauri::Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w, h).into() });
        let _ = webview.show();
        #[cfg(windows)]
        native::raise(&webview);
    } else {
        let _ = webview.hide();
    }
    Ok(())
}

pub fn allow_http(app: &AppHandle, host: &str) {
    if let Some(b) = app.try_state::<Browser>() {
        if let Ok(mut h) = b.http_allowed.lock() {
            h.insert(host.to_string());
        }
    }
}

/// Moves a tab's live webview into another window (pop-out to an overlay)
/// without reloading, so playback continues.
pub fn move_tab(app: &AppHandle, id: &str, host: &str) -> AppResult<()> {
    let webview = webview(app, id)?;
    let window = app.get_window(host).ok_or_else(|| AppError::NotFound(format!("window {host} is not open")))?;
    webview.reparent(&window).map_err(|e| AppError::Internal(format!("cannot move tab: {e}")))?;
    let _ = webview.hide();
    if let Some(b) = app.try_state::<Browser>() {
        emit_tab(app, b.update(id, |t| t.host = host.into()));
    }
    Ok(())
}

pub fn tab_for_host(app: &AppHandle, host: &str) -> Option<Tab> {
    app.try_state::<Browser>()?.tabs().into_iter().find(|t| t.host == host)
}

/// Native actions that Tauri does not expose (back/forward/stop/mute/clear data).
pub fn native_action(app: &AppHandle, id: &str, action: &str) -> AppResult<()> {
    let webview = webview(app, id)?;
    match action {
        "reload" => webview.reload().map_err(|e| AppError::Internal(e.to_string())),
        #[cfg(windows)]
        "back" | "forward" | "stop" | "mute" | "unmute" => {
            native::action(&webview, action);
            Ok(())
        }
        _ => Err(AppError::Invalid(format!("unknown action {action}"))),
    }
}

#[cfg(windows)]
pub fn clear_data(app: &AppHandle) -> AppResult<()> {
    // Any tab gives access to the shared profile; without tabs there is nothing loaded to clear.
    let tab = app.try_state::<Browser>().and_then(|b| b.tabs().into_iter().next());
    match tab {
        Some(t) => {
            native::clear_profile(&webview(app, &t.id)?);
            Ok(())
        }
        None => Err(AppError::Invalid("open a tab first: browsing data is cleared through the browser profile".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_bar_input() {
        assert_eq!(resolve_input("https://example.com/a", "duckduckgo").unwrap().as_str(), "https://example.com/a");
        assert_eq!(resolve_input("example.com", "duckduckgo").unwrap().as_str(), "https://example.com/");
        assert_eq!(resolve_input("localhost:3000/x", "duckduckgo").unwrap().as_str(), "http://localhost:3000/x");
        assert_eq!(resolve_input("192.168.1.1", "duckduckgo").unwrap().as_str(), "http://192.168.1.1/");
        assert!(resolve_input("rust borrow checker", "duckduckgo").unwrap().as_str().starts_with("https://duckduckgo.com/?q=rust+borrow"));
        assert!(resolve_input("погода", "yandex").unwrap().as_str().starts_with("https://yandex.ru/search/?text="));
        assert!(resolve_input("file:///C:/Windows/win.ini", "duckduckgo").is_err());
        assert!(resolve_input("javascript://alert(1)", "duckduckgo").is_err());
        assert!(resolve_input("   ", "duckduckgo").is_err());
    }

    #[test]
    fn local_hosts_are_not_upgraded() {
        assert!(is_local_host("localhost") && is_local_host("10.0.0.2") && is_local_host("printer.local"));
        assert!(!is_local_host("example.com") && !is_local_host("8.8.8.8"));
    }
}
