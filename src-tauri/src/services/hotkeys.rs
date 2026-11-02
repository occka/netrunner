//! Keyboard shortcuts: combination parsing and normalisation, the table of all
//! NETRUNNER keys (built-ins plus Quick Access entries) and conflict checks.
//! Registration with Windows lives in `crate::hotkeys`.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::services::settings;

pub const SETTINGS_KEY: &str = "hotkeys.custom";

pub struct Builtin {
    pub id: &'static str,
    pub label: &'static str,
    pub default: &'static str,
    /// Works while another program has focus (registered with Windows).
    pub global: bool,
}

/// Development builds run beside the installed app, so they take another overlay key.
pub const OVERLAY_DEFAULT: &str = if cfg!(debug_assertions) { "Ctrl+Alt+Shift+O" } else { "Ctrl+Alt+O" };

pub const BUILTINS: &[Builtin] = &[
    Builtin { id: "palette", label: "Search & command palette", default: "Ctrl+K", global: false },
    Builtin { id: "inspector", label: "Toggle inspector", default: "Ctrl+I", global: false },
    Builtin { id: "overlays", label: "Show / hide overlays", default: OVERLAY_DEFAULT, global: true },
];

const NAMED_KEYS: &[&str] = &[
    "Space", "Tab", "Enter", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right", "Backquote", "Minus", "Equal", "BracketLeft",
    "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash",
];

fn canonical_key(k: &str) -> Option<String> {
    let upper = k.to_ascii_uppercase();
    if upper.len() == 1 && upper.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some(upper);
    }
    if let Some(n) = upper.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()) {
        if (1..=24).contains(&n) {
            return Some(format!("F{n}"));
        }
    }
    NAMED_KEYS.iter().find(|n| n.eq_ignore_ascii_case(k)).map(|n| n.to_string())
}

/// `ctrl + alt+ k` → `Ctrl+Alt+K`. A letter or digit alone, or with Shift only,
/// is refused: it would swallow normal typing.
pub fn normalize(combo: &str) -> AppResult<String> {
    let (mut ctrl, mut alt, mut shift, mut win) = (false, false, false, false);
    let mut key = None;
    for part in combo.split('+').map(str::trim) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => ctrl = true,
            "alt" | "option" => alt = true,
            "shift" => shift = true,
            "win" | "super" | "meta" | "cmd" => win = true,
            "" => return Err(AppError::Invalid(format!("'{combo}' is not a key combination"))),
            _ => {
                if key.is_some() {
                    return Err(AppError::Invalid(format!("'{combo}' has more than one key")));
                }
                key = Some(canonical_key(part).ok_or_else(|| AppError::Invalid(format!("'{part}' cannot be used in a shortcut")))?);
            }
        }
    }
    let key = key.ok_or_else(|| AppError::Invalid("a shortcut needs a key besides the modifiers".into()))?;
    if !ctrl && !alt && !win && !key.starts_with('F') {
        return Err(AppError::Invalid("use Ctrl, Alt or Win with this key: alone it would block typing".into()));
    }
    let mut out = String::new();
    for (on, name) in [(ctrl, "Ctrl+"), (alt, "Alt+"), (shift, "Shift+"), (win, "Win+")] {
        if on {
            out.push_str(name);
        }
    }
    out.push_str(&key);
    Ok(out)
}

/// A normalised combination in the syntax of the global-shortcut plugin.
pub fn plugin_syntax(normalized: &str) -> String {
    normalized
        .split('+')
        .map(|p| match p {
            "Ctrl" => "ctrl".to_string(),
            "Alt" => "alt".to_string(),
            "Shift" => "shift".to_string(),
            "Win" => "super".to_string(),
            key => key.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    /// `palette`, `inspector`, `overlays` or `entry:<id>`.
    pub id: String,
    pub label: String,
    /// Empty: no key.
    pub keys: String,
    pub default: Option<String>,
    pub global: bool,
    pub entry_id: Option<i64>,
    /// Why Windows refused the key, if it did.
    pub error: Option<String>,
}

fn custom(conn: &Connection) -> HashMap<String, String> {
    settings::get(conn, SETTINGS_KEY).ok().flatten().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

/// Every NETRUNNER shortcut: built-ins, then Quick Access entries that have a key.
pub fn bindings(conn: &Connection) -> AppResult<Vec<Binding>> {
    let c = custom(conn);
    let mut out: Vec<Binding> = BUILTINS
        .iter()
        .map(|b| Binding {
            id: b.id.to_string(),
            label: b.label.to_string(),
            keys: c.get(b.id).cloned().unwrap_or_else(|| b.default.to_string()),
            default: Some(b.default.to_string()),
            global: b.global,
            entry_id: None,
            error: None,
        })
        .collect();
    let mut stmt = conn.prepare("SELECT id, name, hotkey FROM quick_access WHERE hotkey <> '' ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    for row in rows {
        let (id, name, keys) = row?;
        out.push(Binding { id: format!("entry:{id}"), label: format!("Launch {name}"), keys, default: None, global: true, entry_id: Some(id), error: None });
    }
    Ok(out)
}

/// The binding that already uses `keys`, other than `id`.
pub fn conflict<'a>(bindings: &'a [Binding], id: &str, keys: &str) -> Option<&'a Binding> {
    bindings.iter().find(|b| b.id != id && !b.keys.is_empty() && b.keys == keys)
}

/// Normalises `keys` for binding `id` and refuses keys NETRUNNER already uses
/// and those it reserves inside the editor. Empty stays empty (no key).
pub fn checked(conn: &Connection, id: &str, keys: &str) -> AppResult<String> {
    if keys.trim().is_empty() {
        return Ok(String::new());
    }
    let keys = normalize(keys)?;
    if let Some(other) = conflict(&bindings(conn)?, id, &keys) {
        return Err(AppError::Invalid(format!("{keys} is already used by \"{}\"", other.label)));
    }
    Ok(keys)
}

/// Sets a built-in key (empty: back to the default). Entry keys are stored on the entry.
pub fn set_builtin(conn: &Connection, id: &str, keys: &str) -> AppResult<()> {
    if !BUILTINS.iter().any(|b| b.id == id) {
        return Err(AppError::Invalid(format!("unknown shortcut '{id}'")));
    }
    let keys = checked(conn, id, keys)?;
    let mut c = custom(conn);
    if keys.is_empty() {
        c.remove(id);
    } else {
        c.insert(id.to_string(), keys);
    }
    settings::set(conn, SETTINGS_KEY, &serde_json::to_value(c)?)
}

pub fn reset_builtins(conn: &Connection) -> AppResult<()> {
    settings::set(conn, SETTINGS_KEY, &serde_json::json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::Shortcut;

    #[test]
    fn normalizes_combinations() {
        assert_eq!(normalize("ctrl + alt+k").unwrap(), "Ctrl+Alt+K");
        assert_eq!(normalize("Shift+Control+1").unwrap(), "Ctrl+Shift+1");
        assert_eq!(normalize("win+pageup").unwrap(), "Win+PageUp");
        assert_eq!(normalize("F5").unwrap(), "F5");
        assert_eq!(normalize("Shift+f12").unwrap(), "Shift+F12");
        for bad in ["k", "Shift+K", "Ctrl+Alt", "Ctrl+K+L", "Ctrl+", "Ctrl+Ё", "Ctrl+F25", ""] {
            assert!(normalize(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn every_key_parses_for_the_plugin() {
        let mut keys: Vec<String> = NAMED_KEYS.iter().map(|k| format!("Ctrl+{k}")).collect();
        keys.extend(["Ctrl+Alt+O", "Ctrl+Alt+Shift+Win+1", "F24", "Alt+Z"].map(String::from));
        for k in keys {
            let syntax = plugin_syntax(&normalize(&k).unwrap());
            assert!(syntax.parse::<Shortcut>().is_ok(), "{k} -> {syntax}");
        }
    }

    fn db() -> crate::storage::Database {
        crate::storage::Database::open_in_memory().unwrap()
    }

    #[test]
    fn built_ins_can_change_and_conflicts_are_refused() {
        let db = db();
        let conn = db.conn().unwrap();
        assert_eq!(bindings(&conn).unwrap()[0].keys, "Ctrl+K");
        assert!(set_builtin(&conn, "palette", "ctrl+i").is_err()); // inspector has it
        set_builtin(&conn, "palette", "ctrl+shift+space").unwrap();
        assert_eq!(bindings(&conn).unwrap()[0].keys, "Ctrl+Shift+Space");
        // Ctrl+K is free now.
        assert_eq!(checked(&conn, "entry:1", "Ctrl+K").unwrap(), "Ctrl+K");
        set_builtin(&conn, "palette", "").unwrap();
        assert_eq!(bindings(&conn).unwrap()[0].keys, "Ctrl+K");
        assert!(set_builtin(&conn, "nope", "ctrl+j").is_err());
        set_builtin(&conn, "inspector", "ctrl+j").unwrap();
        reset_builtins(&conn).unwrap();
        assert_eq!(bindings(&conn).unwrap()[1].keys, "Ctrl+I");
    }

    #[test]
    fn entry_keys_join_the_table() {
        let db = db();
        let conn = db.conn().unwrap();
        conn.execute("INSERT INTO quick_access (kind, name, target, hotkey) VALUES ('app', 'Paint', 'mspaint.exe', 'Ctrl+Alt+P')", []).unwrap();
        let all = bindings(&conn).unwrap();
        assert_eq!((all[3].id.as_str(), all[3].label.as_str(), all[3].global), ("entry:1", "Launch Paint", true));
        assert!(checked(&conn, "palette", "alt+ctrl+p").is_err());
        assert_eq!(checked(&conn, "entry:1", "Ctrl+Alt+P").unwrap(), "Ctrl+Alt+P");
        assert_eq!(checked(&conn, "entry:1", " ").unwrap(), "");
    }
}
