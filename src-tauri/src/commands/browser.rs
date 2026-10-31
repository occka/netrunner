use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::browser::{self, blocker, data, Browser, Download, Prefs, Tab};
use crate::error::{AppError, AppResult};
use crate::overlay;
use crate::services::activity::{self, Level};
use crate::services::overlays::{self, Overlay};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub prefs: Prefs,
    pub blocker: blocker::BlockerStatus,
    pub lists: Vec<blocker::ListStatus>,
    pub blocked_total: u64,
    pub extensions_dir: String,
    pub search_engines: Vec<(String, String)>,
}

#[tauri::command]
pub async fn browser_status(browser: State<'_, Browser>) -> AppResult<BrowserStatus> {
    let prefs = browser.prefs();
    Ok(BrowserStatus {
        lists: browser.blocker.lists(&prefs.lists),
        blocker: browser.blocker.status(),
        blocked_total: browser.blocked_total(),
        extensions_dir: browser.extensions_dir().display().to_string(),
        search_engines: browser::SEARCH_ENGINES.iter().map(|(id, name, _)| (id.to_string(), name.to_string())).collect(),
        prefs,
    })
}

/// Called by the UI after it changed a `browser.*` setting.
#[tauri::command]
pub async fn browser_prefs_changed(app: AppHandle) {
    browser::reload_prefs(&app);
}

/// Downloads every enabled filter list now and rebuilds the blocker.
#[tauri::command]
pub async fn browser_update_lists(app: AppHandle, browser: State<'_, Browser>) -> AppResult<Vec<(String, String)>> {
    let prefs = browser.prefs();
    let lists: Vec<_> = prefs.lists.iter().filter_map(|id| blocker::list_by_id(id).ok()).collect();
    let errors = browser.blocker.download(&lists).await;
    browser.blocker.set_error((!errors.is_empty()).then(|| errors.iter().map(|(i, e)| format!("{i}: {e}")).collect::<Vec<_>>().join("; ")));
    browser::start_blocker(app, true);
    Ok(errors)
}

#[tauri::command]
pub async fn browser_tabs(browser: State<'_, Browser>) -> AppResult<Vec<Tab>> {
    Ok(browser.tabs())
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, browser: State<'_, Browser>, input: String, private: bool) -> AppResult<Tab> {
    let url = browser::resolve_input(&input, &browser.prefs().search)?;
    browser::open_tab(&app, "main", url, private)
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, browser: State<'_, Browser>, id: String, input: String) -> AppResult<()> {
    let url = browser::resolve_input(&input, &browser.prefs().search)?;
    browser::webview(&app, &id)?.navigate(url).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn browser_action(app: AppHandle, id: String, action: String) -> AppResult<()> {
    browser::native_action(&app, &id, &action)
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, id: String) -> AppResult<()> {
    browser::close_tab(&app, &id)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn browser_set_bounds(app: AppHandle, id: String, x: f64, y: f64, width: f64, height: f64, visible: bool) -> AppResult<()> {
    browser::set_bounds(&app, &id, x, y, width, height, visible)
}

#[tauri::command]
pub async fn browser_set_zoom(app: AppHandle, id: String, factor: f64) -> AppResult<()> {
    browser::webview(&app, &id)?.set_zoom(factor.clamp(0.25, 5.0)).map_err(|e| AppError::Internal(e.to_string()))
}

/// The user chose to load this site over plain HTTP for the rest of the session.
#[tauri::command]
pub async fn browser_allow_http(app: AppHandle, id: String, url: String) -> AppResult<()> {
    let parsed = tauri::Url::parse(&url).map_err(|_| AppError::Invalid("invalid URL".into()))?;
    if parsed.scheme() != "http" {
        return Err(AppError::Invalid("not an http:// address".into()));
    }
    browser::allow_http(&app, parsed.host_str().unwrap_or_default());
    browser::webview(&app, &id)?.navigate(parsed).map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn browser_clear_data(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    browser::clear_data(&app)?;
    data::clear_history(&*state.db.conn()?)?;
    activity::record(&*state.db.conn()?, Level::Info, "browser", "Cleared browsing data");
    Ok(())
}

#[tauri::command]
pub async fn browser_downloads(browser: State<'_, Browser>) -> AppResult<Vec<Download>> {
    Ok(browser.downloads())
}

#[tauri::command]
pub async fn browser_bookmarks(state: State<'_, AppState>) -> AppResult<Vec<data::Bookmark>> {
    data::bookmarks(&*state.db.conn()?)
}

#[tauri::command]
pub async fn browser_bookmark_add(state: State<'_, AppState>, url: String, title: String) -> AppResult<data::Bookmark> {
    data::add_bookmark(&*state.db.conn()?, &url, &title)
}

#[tauri::command]
pub async fn browser_bookmark_rename(state: State<'_, AppState>, id: i64, title: String) -> AppResult<()> {
    data::rename_bookmark(&*state.db.conn()?, id, &title)
}

#[tauri::command]
pub async fn browser_bookmark_remove(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    data::remove_bookmark(&*state.db.conn()?, id)
}

#[tauri::command]
pub async fn browser_history(state: State<'_, AppState>, query: String, limit: i64) -> AppResult<Vec<data::HistoryEntry>> {
    data::history(&*state.db.conn()?, &query, limit)
}

#[tauri::command]
pub async fn browser_history_clear(state: State<'_, AppState>) -> AppResult<()> {
    data::clear_history(&*state.db.conn()?)
}

#[tauri::command]
pub async fn browser_permissions(state: State<'_, AppState>) -> AppResult<Vec<data::SitePermission>> {
    data::permissions(&*state.db.conn()?)
}

#[tauri::command]
pub async fn browser_permission_set(state: State<'_, AppState>, host: String, kind: String, granted: bool) -> AppResult<()> {
    let conn = state.db.conn()?;
    if granted {
        data::grant(&conn, &host, &kind)?;
        activity::record(&conn, Level::Info, "browser", &format!("Allowed {kind} for {host}"));
        Ok(())
    } else {
        data::revoke(&conn, &host, &kind)
    }
}

/// What each tab and web overlay is playing (Music Player widget).
#[tauri::command]
pub async fn browser_media(app: AppHandle) -> AppResult<Vec<browser::media::TabMedia>> {
    Ok(browser::media::states(&app).await)
}

#[tauri::command]
pub async fn browser_media_control(app: AppHandle, id: String, action: String) -> AppResult<()> {
    browser::media::control(&app, &id, &action)
}

#[tauri::command]
pub async fn browser_media_artwork(url: String) -> AppResult<Option<String>> {
    Ok(browser::media::artwork(&url).await)
}

/// Moves a playing tab into a new web overlay without reloading it.
#[tauri::command]
pub async fn browser_pop_out(app: AppHandle, state: State<'_, AppState>, browser: State<'_, Browser>, id: String) -> AppResult<Overlay> {
    let tab = browser.tab(&id).ok_or_else(|| AppError::NotFound("tab is closed".into()))?;
    let o = overlays::create_web(&*state.db.conn()?, &tab.url, &tab.title)?;
    overlay::open(&app, &o)?;
    browser::move_tab(&app, &id, &overlay::label(o.id))?;
    activity::record(&*state.db.conn()?, Level::Info, "browser", &format!("Moved {} to an overlay", tab.url));
    let _ = app.emit("overlays://changed", ());
    Ok(o)
}

/// Web overlay page: returns the tab shown in this overlay, creating it on
/// first use (or reusing a tab that was popped out of BROWSER).
#[tauri::command]
pub async fn browser_overlay_tab(app: AppHandle, state: State<'_, AppState>, overlay_id: i64) -> AppResult<Tab> {
    let host = overlay::label(overlay_id);
    if let Some(tab) = browser::tab_for_host(&app, &host) {
        return Ok(tab);
    }
    let o = overlays::get(&*state.db.conn()?, overlay_id)?;
    if o.widget_type != overlays::WEB_TYPE {
        return Err(AppError::Invalid("not a web overlay".into()));
    }
    let url = tauri::Url::parse(&o.url).map_err(|_| AppError::Invalid("overlay URL is invalid".into()))?;
    browser::open_tab(&app, &host, url, false)
}
