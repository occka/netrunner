//! Floating overlay windows: independent, frameless, always-on-top webviews
//! that render a single widget. They appear above windowed and borderless
//! fullscreen apps; exclusive-fullscreen games draw over them (by design, no
//! graphics injection is attempted).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};
use crate::services::overlays::{self, Overlay};
use crate::services::profiles;
use crate::state::AppState;

/// Set by the global hotkey / tray toggle; hides overlays without changing
/// their saved visibility.
static HIDDEN: AtomicBool = AtomicBool::new(false);

pub fn label(id: i64) -> String {
    format!("overlay-{id}")
}

pub fn open(app: &AppHandle, o: &Overlay) -> AppResult<()> {
    // Web overlays hold a second (browser) webview, so look the window up as a plain window.
    if let Some(win) = app.get_window(&label(o.id)) {
        let _ = win.show();
        return Ok(());
    }
    let url = WebviewUrl::App(format!("index.html?overlay={}", o.id).into());
    let win = WebviewWindowBuilder::new(app, label(o.id), url)
        .title(format!("NETRUNNER overlay · {}", if o.title.is_empty() { &o.widget_type } else { &o.title }))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(!o.locked)
        .visible(false)
        .build()
        .map_err(|e| AppError::Internal(format!("cannot create overlay window: {e}")))?;
    let _ = win.set_position(PhysicalPosition::new(o.x, o.y));
    let _ = win.set_size(PhysicalSize::new(o.width, o.height));
    let _ = win.set_ignore_cursor_events(o.ignores_cursor());
    crate::overlay_snap::attach(app, &win);
    if !HIDDEN.load(Ordering::Relaxed) {
        let _ = win.show();
    }
    Ok(())
}

pub fn close(app: &AppHandle, id: i64) {
    // Web overlays host a browser tab; forget it before its window goes away.
    crate::browser::forget_host(app, &label(id));
    if let Some(win) = app.get_window(&label(id)) {
        let _ = win.destroy();
    }
}

/// Applies lock state to an open window (locked = not resizable; dragging is
/// disabled in the overlay page itself) and click-through.
pub fn apply(app: &AppHandle, o: &Overlay) {
    if let Some(win) = app.get_window(&label(o.id)) {
        let _ = win.set_resizable(!o.locked);
        let _ = win.set_ignore_cursor_events(o.ignores_cursor());
    }
}

/// Tray: makes click-through overlays clickable again by unlocking them.
pub fn unlock_click_through(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    match state.db.conn().and_then(|c| overlays::unlock_click_through(&c)) {
        Ok(list) => {
            for o in &list {
                apply(app, o);
            }
            let _ = app.emit("overlays://changed", ());
        }
        Err(err) => log::error!("cannot unlock overlays: {err}"),
    }
}

fn active_profile(app: &AppHandle) -> Option<i64> {
    let state = app.try_state::<AppState>()?;
    let conn = state.db.conn().ok()?;
    profiles::active_id(&conn).ok().flatten()
}

/// Opens overlays flagged "show on startup" when NETRUNNER starts. Overlays of
/// other profiles are marked visible too and open when their profile is activated.
pub fn restore_on_startup(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    if let Ok(Some(v)) = state.db.conn().and_then(|c| crate::services::settings::get(&c, crate::overlay_snap::SETTING_KEY)) {
        crate::overlay_snap::set_enabled(v.as_bool().unwrap_or(true));
    }
    let list = match state.db.conn().and_then(|c| overlays::list(&c)) {
        Ok(list) => list,
        Err(err) => {
            log::error!("cannot load overlays: {err}");
            return;
        }
    };
    let active = active_profile(app);
    for o in list {
        if o.visible != o.show_on_startup {
            if let Ok(c) = state.db.conn() {
                let _ = overlays::set_visible(&c, o.id, o.show_on_startup);
            }
        }
        if o.show_on_startup && o.in_set(active) {
            if let Err(err) = open(app, &o) {
                log::error!("{err}");
            }
        }
    }
}

/// After a profile switch: closes the previous profile's overlays and opens
/// the visible overlays of the active one. Overlays shown in every profile and
/// the remembered visibility of each overlay are left alone.
pub fn sync_profile(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let list = match state.db.conn().and_then(|c| overlays::list(&c)) {
        Ok(list) => list,
        Err(err) => {
            log::error!("cannot load overlays: {err}");
            return;
        }
    };
    let active = active_profile(app);
    for o in list {
        if !o.in_set(active) {
            close(app, o.id);
        } else if o.visible {
            if let Err(err) = open(app, &o) {
                log::error!("{err}");
            }
        }
    }
}

/// Global hotkey / tray: hide or show all open overlay windows.
pub fn toggle_all(app: &AppHandle) {
    let hide = !HIDDEN.load(Ordering::Relaxed);
    HIDDEN.store(hide, Ordering::Relaxed);
    for (label, win) in app.windows() {
        if label.starts_with("overlay-") {
            let _ = if hide { win.hide() } else { win.show() };
        }
    }
}

pub fn set_shown(app: &AppHandle, id: i64, visible: bool) -> AppResult<()> {
    let state = app.state::<AppState>();
    let o = overlays::get(&*state.db.conn()?, id)?;
    overlays::set_visible(&*state.db.conn()?, id, visible)?;
    // An overlay of another profile only remembers that it is shown; it opens
    // when that profile becomes active.
    if visible && o.in_set(active_profile(app)) {
        open(app, &o)
    } else if visible {
        Ok(())
    } else {
        close(app, id);
        Ok(())
    }
}
