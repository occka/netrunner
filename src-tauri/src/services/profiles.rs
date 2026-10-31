//! Workspace profiles. A profile owns a COMMAND dashboard layout; later phases
//! extend it with Quick Access sets, overlays, hotkeys and automation.
//!
//! The layout is stored as an opaque JSON document whose widget types are
//! defined by the frontend widget registry. The backend only checks its shape.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};

use super::settings;
use crate::error::{AppError, AppResult};

pub const ACTIVE_PROFILE_KEY: &str = "profile.active";

const KINDS: &[&str] = &["default", "development", "gaming", "media", "custom"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub is_builtin: bool,
    pub layout: Value,
    pub created_at: String,
    pub updated_at: String,
}

fn from_row(row: &Row) -> rusqlite::Result<Profile> {
    let raw: String = row.get(4)?;
    Ok(Profile {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        is_builtin: row.get(3)?,
        layout: serde_json::from_str(&raw).unwrap_or_else(|_| empty_layout()),
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const SELECT: &str = "SELECT id, name, kind, is_builtin, layout_json, created_at, updated_at FROM profiles";

pub fn list(conn: &Connection) -> AppResult<Vec<Profile>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY is_builtin DESC, id ASC"))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Profile> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("profile {id} does not exist")))
}

/// Creates a custom profile, optionally copying another profile's layout.
pub fn create(conn: &Connection, name: &str, copy_from: Option<i64>) -> AppResult<Profile> {
    let name = validate_name(name)?;
    let layout = match copy_from {
        Some(source) => get(conn, source)?.layout,
        None => empty_layout(),
    };
    conn.execute(
        "INSERT INTO profiles (name, kind, is_builtin, layout_json) VALUES (?1, 'custom', 0, ?2)",
        params![name, serde_json::to_string(&layout)?],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn rename(conn: &Connection, id: i64, name: &str) -> AppResult<Profile> {
    let name = validate_name(name)?;
    let changed = conn.execute(
        "UPDATE profiles SET name = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![name, id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("profile {id} does not exist")));
    }
    get(conn, id)
}

pub fn save_layout(conn: &Connection, id: i64, layout: &Value) -> AppResult<Profile> {
    validate_layout(layout)?;
    let changed = conn.execute(
        "UPDATE profiles SET layout_json = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![serde_json::to_string(layout)?, id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("profile {id} does not exist")));
    }
    get(conn, id)
}

/// Deletes a custom profile. Built-in profiles and the active profile are kept.
pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    let profile = get(conn, id)?;
    if profile.is_builtin {
        return Err(AppError::Invalid("built-in profiles cannot be deleted".into()));
    }
    if active_id(conn)? == Some(id) {
        return Err(AppError::Invalid("switch to another profile before deleting the active one".into()));
    }
    conn.execute("DELETE FROM profiles WHERE id = ?1", [id])?;
    Ok(())
}

pub fn active_id(conn: &Connection) -> AppResult<Option<i64>> {
    Ok(settings::get(conn, ACTIVE_PROFILE_KEY)?.and_then(|v| v.as_i64()))
}

/// Marks a profile as active. Switching never touches running applications.
pub fn activate(conn: &Connection, id: i64) -> AppResult<Profile> {
    let profile = get(conn, id)?;
    settings::set(conn, ACTIVE_PROFILE_KEY, &json!(id))?;
    Ok(profile)
}

/// Inserts the built-in profiles on first run and makes sure an active profile
/// is set and still exists.
pub fn ensure_seeded(conn: &Connection) -> AppResult<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?;
    if count == 0 {
        for (name, kind, layout) in builtin_profiles() {
            debug_assert!(KINDS.contains(&kind));
            conn.execute(
                "INSERT INTO profiles (name, kind, is_builtin, layout_json) VALUES (?1, ?2, 1, ?3)",
                params![name, kind, serde_json::to_string(&layout)?],
            )?;
        }
    }
    let active_exists = match active_id(conn)? {
        Some(id) => get(conn, id).is_ok(),
        None => false,
    };
    if !active_exists {
        let first: i64 = conn.query_row("SELECT id FROM profiles ORDER BY id LIMIT 1", [], |r| r.get(0))?;
        settings::set(conn, ACTIVE_PROFILE_KEY, &json!(first))?;
    }
    Ok(())
}

fn validate_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 40 {
        return Err(AppError::Invalid("profile name must be 1–40 characters".into()));
    }
    Ok(trimmed.to_string())
}

fn validate_layout(layout: &Value) -> AppResult<()> {
    let widgets = layout
        .get("widgets")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Invalid("layout must contain a 'widgets' array".into()))?;
    if widgets.len() > 64 {
        return Err(AppError::Invalid("layout has too many widgets".into()));
    }
    for widget in widgets {
        let ok = widget.get("id").and_then(Value::as_str).is_some()
            && widget.get("type").and_then(Value::as_str).is_some()
            && ["x", "y", "w", "h"].iter().all(|k| widget.get(*k).and_then(Value::as_i64).is_some());
        if !ok {
            return Err(AppError::Invalid("each widget needs id, type, x, y, w and h".into()));
        }
    }
    Ok(())
}

fn empty_layout() -> Value {
    json!({ "version": 1, "widgets": [] })
}

fn widget(id: &str, kind: &str, x: i64, y: i64, w: i64, h: i64) -> Value {
    json!({ "id": id, "type": kind, "x": x, "y": y, "w": w, "h": h })
}

fn builtin_profiles() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "Default",
            "default",
            json!({ "version": 1, "widgets": [
                widget("sys", "system-overview", 0, 0, 5, 9),
                widget("qa", "quick-access", 5, 0, 4, 9),
                widget("clock", "clock", 9, 0, 3, 5),
                widget("log", "activity", 9, 5, 3, 11),
                widget("cpu", "cpu", 0, 9, 5, 7),
                widget("ram", "ram", 5, 9, 4, 7),
                widget("disk", "storage", 0, 16, 5, 7),
                widget("net", "network", 5, 16, 4, 7),
            ]}),
        ),
        (
            "Development",
            "development",
            json!({ "version": 1, "widgets": [
                widget("qa", "quick-access", 0, 0, 5, 9),
                widget("cpu", "cpu", 5, 0, 4, 7),
                widget("clock", "clock", 9, 0, 3, 5),
                widget("ram", "ram", 5, 7, 4, 6),
                widget("tasks", "tasks", 0, 9, 5, 9),
                widget("log", "activity", 9, 5, 3, 13),
            ]}),
        ),
        (
            "Gaming",
            "gaming",
            json!({ "version": 1, "widgets": [
                widget("sys", "system-overview", 0, 0, 5, 9),
                widget("qa", "quick-access", 5, 0, 7, 6),
                widget("cpu", "cpu", 5, 6, 4, 7),
                widget("gpu", "gpu", 9, 6, 3, 7),
                widget("net", "network", 0, 9, 5, 7),
                widget("thermal", "thermal", 5, 13, 4, 5),
            ]}),
        ),
        (
            "Media",
            "media",
            json!({ "version": 1, "widgets": [
                widget("clock", "clock", 0, 0, 4, 6),
                widget("qa", "quick-access", 4, 0, 8, 6),
                widget("net", "network", 0, 6, 6, 7),
                widget("disk", "storage", 6, 6, 6, 7),
            ]}),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;

    #[test]
    fn seeds_builtins_and_active_profile_once() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        ensure_seeded(&conn).unwrap();
        ensure_seeded(&conn).unwrap();
        let profiles = list(&conn).unwrap();
        assert_eq!(profiles.len(), 4);
        assert!(profiles.iter().all(|p| p.is_builtin));
        assert_eq!(active_id(&conn).unwrap(), Some(profiles[0].id));
    }

    #[test]
    fn custom_profile_lifecycle() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        ensure_seeded(&conn).unwrap();
        let base = list(&conn).unwrap()[0].id;
        let custom = create(&conn, "  Night shift ", Some(base)).unwrap();
        assert_eq!(custom.name, "Night shift");
        assert_eq!(custom.kind, "custom");
        assert_eq!(custom.layout, get(&conn, base).unwrap().layout);

        activate(&conn, custom.id).unwrap();
        assert!(delete(&conn, custom.id).is_err(), "active profile must not be deleted");
        activate(&conn, base).unwrap();
        delete(&conn, custom.id).unwrap();
        assert!(delete(&conn, base).is_err(), "built-ins must not be deleted");
    }

    #[test]
    fn rejects_malformed_layouts() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        ensure_seeded(&conn).unwrap();
        let id = list(&conn).unwrap()[0].id;
        assert!(save_layout(&conn, id, &json!({})).is_err());
        assert!(save_layout(&conn, id, &json!({"widgets": [{"id": "a"}]})).is_err());
        let ok = json!({"version": 1, "widgets": [widget("a", "clock", 0, 0, 3, 4)]});
        assert_eq!(save_layout(&conn, id, &ok).unwrap().layout, ok);
    }
}
