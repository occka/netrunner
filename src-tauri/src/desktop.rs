//! Desktop shell integration: system tray, close-to-tray and Windows autostart.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use crate::services::settings;
use crate::state::AppState;

pub const CLOSE_TO_TRAY_KEY: &str = "app.close_to_tray";
pub const START_MINIMIZED_KEY: &str = "app.start_minimized";
pub const AUTOSTART_ARG: &str = "--autostart";

// `get_window`, not `get_webview_window`: with BROWSER tabs open the main
// window hosts several webviews and is no longer a single-webview window.
pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Opens a web page as a BROWSER tab in the main window (shown if hidden).
pub fn open_in_browser(app: &AppHandle, url: &str) -> crate::error::AppResult<()> {
    let url = crate::security::targets::validate_web_url(url)?;
    show_main(app);
    let _ = app.emit_to("main", "browser://open-request", url);
    Ok(())
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
    let unlock = MenuItem::with_id(app, "overlays-unlock", "Unlock click-through overlays", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit NETRUNNER", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &overlays, &unlock, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("NETRUNNER")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "overlays" => crate::overlay::toggle_all(app),
            "overlays-unlock" => crate::overlay::unlock_click_through(app),
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
    // Closing the ringing window (Alt+F4) stops what rings, so no sound is left without a window.
    if window.label() == crate::alarm::RING_WINDOW {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            crate::alarm::stop_all(window.app_handle());
        }
        return;
    }
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
    let minimized = autostarted && bool_setting(app, START_MINIMIZED_KEY, true);
    log::info!("launch: {}", if autostarted { "started by Windows sign-in" } else { "started by the user" });
    if minimized {
        log::info!("launch: staying in the tray (Start minimised to tray is on)");
        if let Some(win) = app.get_window("main") {
            let _ = win.hide();
        }
    }
}

/// The Windows startup entry stores an absolute path. After a reinstall to
/// another folder it points at a missing file and sign-in silently starts
/// nothing, so an enabled entry is rewritten for the running executable.
/// Debug builds never touch it (it would point autostart at `target\debug`).
#[cfg(windows)]
pub fn repair_autostart(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    if cfg!(debug_assertions) {
        return;
    }
    let manager = app.autolaunch();
    // Disabled entries (by the user or in Task Manager) are left alone.
    if !manager.is_enabled().unwrap_or(false) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let current = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .and_then(|k| k.get_value::<String, _>(app.package_info().name.as_str()))
        .unwrap_or_default();
    let expected = exe.display().to_string();
    if !current.to_lowercase().contains(&expected.to_lowercase()) {
        match manager.enable() {
            Ok(()) => log::warn!("autostart entry pointed at '{current}'; rewritten for '{expected}'"),
            Err(err) => log::error!("cannot repair the autostart entry: {err}"),
        }
    }
}
