//! Quick Access entries: storage and validation. Launching lives in `launcher`.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::security::{command_policy, targets};
use crate::services::hotkeys;

pub const KINDS: &[&str] = &["app", "game", "file", "folder", "website", "command", "project"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub target: String,
    pub args: String,
    pub working_dir: String,
    pub shell: String,
    pub icon: String,
    pub category: String,
    pub favorite: bool,
    pub require_confirm: bool,
    pub sort_order: i64,
    /// None: shown in every profile.
    pub profile_id: Option<i64>,
    /// Global key (normalised); empty means none.
    pub hotkey: String,
    pub launch_count: i64,
    pub last_launched_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Fields the user can edit. Shared by create and update.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub kind: String,
    pub name: String,
    pub target: String,
    #[serde(default)]
    pub args: String,
    #[serde(default)]
    pub working_dir: String,
    #[serde(default)]
    pub shell: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub require_confirm: bool,
    #[serde(default)]
    pub profile_id: Option<i64>,
    #[serde(default)]
    pub hotkey: String,
}

const SELECT: &str = "SELECT id, kind, name, target, args, working_dir, shell, icon, category, favorite,
    require_confirm, sort_order, launch_count, last_launched_at, created_at, updated_at, profile_id, hotkey FROM quick_access";

fn from_row(row: &Row) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: row.get(0)?,
        kind: row.get(1)?,
        name: row.get(2)?,
        target: row.get(3)?,
        args: row.get(4)?,
        working_dir: row.get(5)?,
        shell: row.get(6)?,
        icon: row.get(7)?,
        category: row.get(8)?,
        favorite: row.get(9)?,
        require_confirm: row.get(10)?,
        sort_order: row.get(11)?,
        launch_count: row.get(12)?,
        last_launched_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        profile_id: row.get(16)?,
        hotkey: row.get(17)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<Entry>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY favorite DESC, sort_order ASC, name COLLATE NOCASE ASC"))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Entry> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("quick access entry {id} does not exist")))
}

fn check_profile(conn: &Connection, profile: Option<i64>) -> AppResult<()> {
    if let Some(p) = profile {
        crate::services::profiles::get(conn, p)?;
    }
    Ok(())
}

pub fn create(conn: &Connection, input: EntryInput) -> AppResult<Entry> {
    let mut input = normalize(input)?;
    check_profile(conn, input.profile_id)?;
    input.hotkey = hotkeys::checked(conn, "entry:new", &input.hotkey)?;
    let next_order: i64 =
        conn.query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM quick_access", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO quick_access (kind, name, target, args, working_dir, shell, icon, category, favorite, require_confirm, sort_order, profile_id, hotkey)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            input.kind, input.name, input.target, input.args, input.working_dir, input.shell,
            input.icon, input.category, input.favorite, input.require_confirm, next_order, input.profile_id, input.hotkey
        ],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, input: EntryInput) -> AppResult<Entry> {
    let mut input = normalize(input)?;
    check_profile(conn, input.profile_id)?;
    input.hotkey = hotkeys::checked(conn, &format!("entry:{id}"), &input.hotkey)?;
    let changed = conn.execute(
        "UPDATE quick_access SET kind = ?1, name = ?2, target = ?3, args = ?4, working_dir = ?5, shell = ?6,
         icon = ?7, category = ?8, favorite = ?9, require_confirm = ?10, profile_id = ?11, hotkey = ?12, updated_at = datetime('now') WHERE id = ?13",
        params![
            input.kind, input.name, input.target, input.args, input.working_dir, input.shell,
            input.icon, input.category, input.favorite, input.require_confirm, input.profile_id, input.hotkey, id
        ],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("quick access entry {id} does not exist")));
    }
    get(conn, id)
}

pub fn set_favorite(conn: &Connection, id: i64, favorite: bool) -> AppResult<Entry> {
    conn.execute(
        "UPDATE quick_access SET favorite = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![favorite, id],
    )?;
    get(conn, id)
}

/// Shows an entry in every profile (None) or in one.
pub fn set_profile(conn: &Connection, id: i64, profile: Option<i64>) -> AppResult<Entry> {
    check_profile(conn, profile)?;
    conn.execute("UPDATE quick_access SET profile_id = ?1, updated_at = datetime('now') WHERE id = ?2", params![profile, id])?;
    get(conn, id)
}

pub fn set_hotkey(conn: &Connection, id: i64, keys: &str) -> AppResult<Entry> {
    get(conn, id)?;
    let keys = hotkeys::checked(conn, &format!("entry:{id}"), keys)?;
    conn.execute("UPDATE quick_access SET hotkey = ?1, updated_at = datetime('now') WHERE id = ?2", params![keys, id])?;
    get(conn, id)
}

/// Persists a user-defined order. Ids not in the list keep their position.
pub fn reorder(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    for (index, id) in ids.iter().enumerate() {
        conn.execute("UPDATE quick_access SET sort_order = ?1 WHERE id = ?2", params![index as i64, id])?;
    }
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<Entry> {
    let entry = get(conn, id)?;
    conn.execute("DELETE FROM quick_access WHERE id = ?1", [id])?;
    Ok(entry)
}

pub fn mark_launched(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE quick_access SET launch_count = launch_count + 1, last_launched_at = datetime('now') WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// Trims fields, validates them per kind and applies safety defaults.
fn normalize(mut input: EntryInput) -> AppResult<EntryInput> {
    input.kind = input.kind.trim().to_lowercase();
    input.name = input.name.trim().to_string();
    input.target = input.target.trim().trim_matches('"').to_string();
    input.args = input.args.trim().to_string();
    input.working_dir = input.working_dir.trim().trim_matches('"').to_string();
    input.category = input.category.trim().to_string();
    input.icon = input.icon.trim().to_string();

    if !KINDS.contains(&input.kind.as_str()) {
        return Err(AppError::Invalid(format!("unknown entry type '{}'", input.kind)));
    }
    if input.name.is_empty() || input.name.chars().count() > 80 {
        return Err(AppError::Invalid("name must be 1–80 characters".into()));
    }
    if input.target.is_empty() {
        return Err(AppError::Invalid("target is required".into()));
    }

    match input.kind.as_str() {
        "website" => {
            input.target = targets::validate_web_url(&input.target)?;
            input.args.clear();
            input.working_dir.clear();
        }
        "command" => {
            input.shell = input.shell.trim().to_lowercase();
            if !matches!(input.shell.as_str(), "cmd" | "powershell") {
                return Err(AppError::Invalid("command entries need a shell: cmd or powershell".into()));
            }
            // Dangerous commands always require confirmation, whatever the user set.
            if command_policy::assess(&input.target).dangerous {
                input.require_confirm = true;
            }
        }
        // Launcher URIs have no working directory.
        "game" if targets::game_protocol(&input.target)?.is_some() => input.working_dir.clear(),
        _ => {}
    }
    if input.kind != "command" {
        input.shell.clear();
    }
    if matches!(input.kind.as_str(), "folder" | "file" | "project") {
        input.args.clear();
    }
    Ok(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;

    fn input(kind: &str, target: &str) -> EntryInput {
        EntryInput {
            kind: kind.into(),
            name: "Test".into(),
            target: target.into(),
            args: String::new(),
            working_dir: String::new(),
            shell: String::new(),
            icon: String::new(),
            category: String::new(),
            favorite: false,
            require_confirm: false,
            profile_id: None,
            hotkey: String::new(),
        }
    }

    #[test]
    fn profile_and_hotkey_round_trip() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        let profile = crate::services::profiles::ensure_seeded(&conn).map(|_| crate::services::profiles::active_id(&conn).unwrap().unwrap()).unwrap();
        let mut a = input("app", "a.exe");
        a.profile_id = Some(profile);
        a.hotkey = "alt+ctrl+1".into();
        let a = create(&conn, a).unwrap();
        assert_eq!((a.profile_id, a.hotkey.as_str()), (Some(profile), "Ctrl+Alt+1"));
        // The same key cannot go to a second entry, a built-in's neither.
        let mut b = input("app", "b.exe");
        b.hotkey = "Ctrl+Alt+1".into();
        assert!(create(&conn, b.clone()).is_err());
        b.hotkey = "Ctrl+K".into();
        assert!(create(&conn, b.clone()).is_err());
        b.hotkey = String::new();
        let b = create(&conn, b).unwrap();
        assert!(set_hotkey(&conn, b.id, "ctrl+alt+1").is_err());
        assert_eq!(set_hotkey(&conn, b.id, "ctrl+alt+2").unwrap().hotkey, "Ctrl+Alt+2");
        // An entry keeps its own key when edited.
        let mut edit = input("app", "a.exe");
        edit.hotkey = a.hotkey.clone();
        assert_eq!(update(&conn, a.id, edit).unwrap().hotkey, "Ctrl+Alt+1");
        assert_eq!(set_profile(&conn, a.id, None).unwrap().profile_id, None);
        assert!(set_profile(&conn, a.id, Some(9999)).is_err());
    }

    #[test]
    fn crud_round_trip() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        let created = create(&conn, input("folder", "\"C:\\Users\"")).unwrap();
        assert_eq!(created.target, "C:\\Users");
        let mut changed = input("website", "https://github.com");
        changed.name = "GitHub".into();
        let updated = update(&conn, created.id, changed).unwrap();
        assert_eq!(updated.kind, "website");
        assert_eq!(updated.target, "https://github.com/");
        set_favorite(&conn, created.id, true).unwrap();
        assert!(get(&conn, created.id).unwrap().favorite);
        mark_launched(&conn, created.id).unwrap();
        assert_eq!(get(&conn, created.id).unwrap().launch_count, 1);
        delete(&conn, created.id).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn validates_per_kind() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        assert!(create(&conn, input("website", "javascript:alert(1)")).is_err());
        assert!(create(&conn, input("command", "dir")).is_err(), "shell is required");
        assert!(create(&conn, input("unknown", "x")).is_err());
        assert!(create(&conn, input("game", "ms-settings:display")).is_err());
        assert!(create(&conn, input("game", "steam://rungameid/1091500")).is_ok());
    }

    #[test]
    fn dangerous_commands_force_confirmation() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        let mut cmd = input("command", "rd /s /q C:\\temp\\x");
        cmd.shell = "cmd".into();
        assert!(create(&conn, cmd).unwrap().require_confirm);
    }
}
