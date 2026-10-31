//! Floating overlay windows: independent, frameless, always-on-top webviews
//! that render a single widget. They appear above windowed and borderless
//! fullscreen apps; exclusive-fullscreen games draw over them (by design, no
//! graphics injection is attempted).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};
use crate::services::overlays::{self, Overlay};
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
/// disabled in the overlay page itself).
pub fn apply(app: &AppHandle, o: &Overlay) {
    if let Some(win) = app.get_window(&label(o.id)) {
        let _ = win.set_resizable(!o.locked);
    }
}

/// Opens overlays flagged "show on startup" when NETRUNNER starts.
pub fn restore_on_startup(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let list = match state.db.conn().and_then(|c| overlays::list(&c)) {
        Ok(list) => list,
        Err(err) => {
            log::error!("cannot load overlays: {err}");
            return;
        }
    };
    for o in list {
        let conn = state.db.conn();
        if o.show_on_startup {
            if let Ok(c) = &conn {
                let _ = overlays::set_visible(c, o.id, true);
            }
            if let Err(err) = open(app, &o) {
                log::error!("{err}");
            }
        } else if o.visible {
            if let Ok(c) = &conn {
                let _ = overlays::set_visible(c, o.id, false);
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
    if visible {
        open(app, &o)
    } else {
        close(app, id);
        Ok(())
    }
}
