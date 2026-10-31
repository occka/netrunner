//! Desktop shell integration: system tray, close-to-tray and Windows autostart.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

use crate::services::settings;
use crate::state::AppState;

pub const CLOSE_TO_TRAY_KEY: &str = "app.close_to_tray";
pub const START_MINIMIZED_KEY: &str = "app.start_minimized";
pub const AUTOSTART_ARG: &str = "--autostart";

pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn bool_setting(app: &AppHandle, key: &str, default: bool) -> bool {
    app.try_state::<AppState>()
        .and_then(|s| s.db.conn().ok().and_then(|c| settings::get(&c, key).ok().flatten()))
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open NETRUNNER", true, None::<&str>)?;
    let overlays = MenuItem::with_id(app, "overlays", "Toggle overlays   Ctrl+Alt+O", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit NETRUNNER", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &overlays, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("NETRUNNER")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "overlays" => crate::overlay::toggle_all(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Closing the main window hides it to the tray when enabled (default on), so
/// Alt+F4 and the title-bar button behave the same way.
pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        if bool_setting(window.app_handle(), CLOSE_TO_TRAY_KEY, true) {
            api.prevent_close();
            let _ = window.hide();
        } else {
            window.app_handle().exit(0);
        }
    }
}

/// When Windows starts NETRUNNER at sign-in, stay in the tray if configured.
pub fn apply_launch_mode(app: &AppHandle) {
    let autostarted = std::env::args().any(|a| a == AUTOSTART_ARG);
    if autostarted && bool_setting(app, START_MINIMIZED_KEY, true) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.hide();
        }
    }
}
