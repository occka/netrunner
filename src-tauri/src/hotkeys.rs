//! Global shortcuts registered with Windows: the overlay key and Quick Access
//! entry keys. Keys of the app window (palette, inspector) are handled in the UI.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::error::{AppError, AppResult};
use crate::services::activity::{self, Level};
use crate::services::hotkeys::{self, Binding};
use crate::services::{launcher, profiles, quick_access};
use crate::state::AppState;

#[derive(Clone, Copy)]
enum Target {
    Overlays,
    Entry(i64),
}

#[derive(Default)]
pub struct Hotkeys {
    registered: Mutex<HashMap<u32, (Shortcut, Target)>>,
    /// Binding id → why Windows refused it.
    errors: Mutex<HashMap<String, String>>,
}

/// Registers the current keys again (startup, and after any key changes).
pub fn sync(app: &AppHandle) -> AppResult<()> {
    let (Some(state), Some(hk)) = (app.try_state::<AppState>(), app.try_state::<Hotkeys>()) else { return Ok(()) };
    let wanted = hotkeys::bindings(&*state.db.conn()?)?;
    let mut registered = hk.registered.lock().map_err(|_| AppError::Internal("hotkey lock poisoned".into()))?;
    let mut errors = HashMap::new();
    for (shortcut, _) in registered.values() {
        let _ = app.global_shortcut().unregister(*shortcut);
    }
    registered.clear();
    for b in wanted.iter().filter(|b| b.global && !b.keys.is_empty()) {
        let target = b.entry_id.map_or(Target::Overlays, Target::Entry);
        let parsed = hotkeys::plugin_syntax(&b.keys).parse::<Shortcut>().map_err(|e| e.to_string());
        let result = parsed.and_then(|s| app.global_shortcut().register(s).map(|()| s).map_err(|e| e.to_string()));
        match result {
            Ok(s) => {
                registered.insert(s.id(), (s, target));
            }
            Err(err) => {
                // Usually another program owns the combination; everything else still works.
                log::warn!("hotkey {} for '{}' unavailable: {err}", b.keys, b.label);
                errors.insert(b.id.clone(), "Taken by another program".to_string());
            }
        }
    }
    if let Ok(mut e) = hk.errors.lock() {
        *e = errors;
    }
    Ok(())
}

/// The shortcut table for the editor, with registration errors.
pub fn table(app: &AppHandle) -> AppResult<Vec<Binding>> {
    let state = app.state::<AppState>();
    let mut list = hotkeys::bindings(&*state.db.conn()?)?;
    if let Ok(errors) = app.state::<Hotkeys>().errors.lock() {
        for b in &mut list {
            b.error = errors.get(&b.id).cloned();
        }
    }
    Ok(list)
}

/// Called by the plugin when a registered combination is pressed.
pub fn pressed(app: &AppHandle, shortcut_id: u32) {
    let target = app.try_state::<Hotkeys>().and_then(|h| h.registered.lock().ok().and_then(|r| r.get(&shortcut_id).map(|(_, t)| *t)));
    match target {
        Some(Target::Overlays) => crate::overlay::toggle_all(app),
        Some(Target::Entry(id)) => {
            let app = app.clone();
            // Windows may take a moment to start the target: not on the hotkey thread.
            std::thread::spawn(move || launch_entry(&app, id));
        }
        None => {}
    }
}

/// Same rules as a launch from the UI: a command that needs confirmation asks
/// in the main window instead of running.
fn launch_entry(app: &AppHandle, id: i64) {
    let state = app.state::<AppState>();
    let entry = {
        let Ok(conn) = state.db.conn() else { return };
        let Ok(entry) = quick_access::get(&conn, id) else { return };
        // An entry of another profile sleeps until that profile is active.
        if entry.profile_id.is_some() && entry.profile_id != profiles::active_id(&conn).ok().flatten() {
            log::info!("hotkey for '{}' ignored: it belongs to another profile", entry.name);
            return;
        }
        entry
    };
    let result = launcher::launch(&entry, false);
    let Ok(conn) = state.db.conn() else { return };
    match result {
        Ok(()) => {
            let _ = quick_access::mark_launched(&conn, id);
            activity::record(&conn, Level::Info, "launcher", &format!("Launched {} '{}' with {}", entry.kind, entry.name, entry.hotkey));
        }
        Err(AppError::ConfirmationRequired(_)) => {
            crate::desktop::show_main(app);
            let _ = app.emit("automation://confirm", crate::automation::ConfirmEvent { rule: format!("Hotkey {}", entry.hotkey), entry_id: id });
        }
        Err(err) => activity::record(&conn, Level::Error, "launcher", &format!("Failed to launch '{}' with {}: {err}", entry.name, entry.hotkey)),
    }
}
