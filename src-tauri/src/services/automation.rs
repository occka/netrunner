//! Automation rules: storage and validation. Execution is in `crate::automation`.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const TRIGGERS: &[&str] = &["netrunner_start", "app_started", "app_stopped", "profile_changed", "manual"];
pub const ACTIONS: &[&str] = &["launch_program", "launch_entry", "switch_profile", "notify", "show_overlay", "hide_overlay"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    pub trigger_kind: String,
    pub trigger_value: String,
    pub condition_profile_id: Option<i64>,
    pub action_kind: String,
    pub action_value: String,
    /// Command-line arguments for `launch_program`.
    pub action_args: String,
    pub run_count: i64,
    pub last_run_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleInput {
    pub name: String,
    pub enabled: bool,
    pub trigger_kind: String,
    #[serde(default)]
    pub trigger_value: String,
    pub condition_profile_id: Option<i64>,
    pub action_kind: String,
    #[serde(default)]
    pub action_value: String,
    #[serde(default)]
    pub action_args: String,
}

const SELECT: &str = "SELECT id, name, enabled, trigger_kind, trigger_value, condition_profile_id, action_kind,
    action_value, action_args, run_count, last_run_at FROM automations";

fn from_row(r: &Row) -> rusqlite::Result<Rule> {
    Ok(Rule {
        id: r.get(0)?,
        name: r.get(1)?,
        enabled: r.get(2)?,
        trigger_kind: r.get(3)?,
        trigger_value: r.get(4)?,
        condition_profile_id: r.get(5)?,
        action_kind: r.get(6)?,
        action_value: r.get(7)?,
        action_args: r.get(8)?,
        run_count: r.get(9)?,
        last_run_at: r.get(10)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<Rule>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY id"))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Rule> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("automation {id} does not exist")))
}

fn normalize(mut i: RuleInput) -> AppResult<RuleInput> {
    i.name = i.name.trim().to_string();
    i.trigger_value = i.trigger_value.trim().to_string();
    i.action_value = i.action_value.trim().to_string();
    i.action_args = i.action_args.trim().to_string();
    if i.name.is_empty() || i.name.chars().count() > 80 {
        return Err(AppError::Invalid("name must be 1–80 characters".into()));
    }
    if !TRIGGERS.contains(&i.trigger_kind.as_str()) || !ACTIONS.contains(&i.action_kind.as_str()) {
        return Err(AppError::Invalid("unknown trigger or action".into()));
    }
    if matches!(i.trigger_kind.as_str(), "app_started" | "app_stopped") {
        i.trigger_value = i.trigger_value.to_lowercase();
        if i.trigger_value.is_empty() {
            return Err(AppError::Invalid("enter the process name, e.g. game.exe".into()));
        }
        if !i.trigger_value.ends_with(".exe") {
            i.trigger_value.push_str(".exe");
        }
    }
    let needs_id = matches!(i.action_kind.as_str(), "launch_entry" | "switch_profile" | "show_overlay" | "hide_overlay");
    if needs_id && i.action_value.parse::<i64>().is_err() {
        return Err(AppError::Invalid("choose a target for the action".into()));
    }
    if i.action_kind == "launch_program" {
        i.action_value = i.action_value.trim_matches('"').to_string();
        if i.action_value.is_empty() {
            return Err(AppError::Invalid("choose the program to launch".into()));
        }
    } else {
        i.action_args.clear();
    }
    if i.action_kind == "notify" && i.action_value.is_empty() {
        return Err(AppError::Invalid("notification text is required".into()));
    }
    Ok(i)
}

pub fn create(conn: &Connection, input: RuleInput) -> AppResult<Rule> {
    let i = normalize(input)?;
    conn.execute(
        "INSERT INTO automations (name, enabled, trigger_kind, trigger_value, condition_profile_id, action_kind, action_value, action_args)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![i.name, i.enabled, i.trigger_kind, i.trigger_value, i.condition_profile_id, i.action_kind, i.action_value, i.action_args],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, input: RuleInput) -> AppResult<Rule> {
    let i = normalize(input)?;
    let n = conn.execute(
        "UPDATE automations SET name=?1, enabled=?2, trigger_kind=?3, trigger_value=?4, condition_profile_id=?5,
         action_kind=?6, action_value=?7, action_args=?8 WHERE id=?9",
        params![i.name, i.enabled, i.trigger_kind, i.trigger_value, i.condition_profile_id, i.action_kind, i.action_value, i.action_args, id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("automation {id} does not exist")));
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM automations WHERE id = ?1", [id])?;
    Ok(())
}

pub fn mark_run(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE automations SET run_count = run_count + 1, last_run_at = datetime('now') WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// Enabled rules matching a trigger. Process names compare case-insensitively.
pub fn matching(conn: &Connection, kind: &str, value: &str) -> AppResult<Vec<Rule>> {
    Ok(list(conn)?
        .into_iter()
        .filter(|r| r.enabled && r.trigger_kind == kind)
        .filter(|r| r.trigger_value.is_empty() || r.trigger_value.eq_ignore_ascii_case(value))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;

    fn input(trigger: &str, tv: &str, action: &str, av: &str) -> RuleInput {
        RuleInput {
            name: "Rule".into(),
            enabled: true,
            trigger_kind: trigger.into(),
            trigger_value: tv.into(),
            condition_profile_id: None,
            action_kind: action.into(),
            action_value: av.into(),
            action_args: String::new(),
        }
    }

    #[test]
    fn validates_and_matches() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        assert!(create(&conn, input("app_started", "", "notify", "x")).is_err());
        assert!(create(&conn, input("manual", "", "launch_entry", "abc")).is_err());
        assert!(create(&conn, input("bogus", "", "notify", "x")).is_err());
        let r = create(&conn, input("app_started", "Cyberpunk2077", "notify", "Gaming time")).unwrap();
        assert_eq!(r.trigger_value, "cyberpunk2077.exe");
        assert_eq!(matching(&conn, "app_started", "CYBERPUNK2077.EXE").unwrap().len(), 1);
        assert!(matching(&conn, "app_stopped", "cyberpunk2077.exe").unwrap().is_empty());
        mark_run(&conn, r.id).unwrap();
        assert_eq!(get(&conn, r.id).unwrap().run_count, 1);

        assert!(create(&conn, input("manual", "", "launch_program", "")).is_err(), "program path required");
        let mut p = input("netrunner_start", "", "launch_program", "\"E:\\Tools\\ThrottleStop.exe\"");
        p.action_args = " -minimized ".into();
        let r = create(&conn, p).unwrap();
        assert_eq!(r.action_value, "E:\\Tools\\ThrottleStop.exe");
        assert_eq!(r.action_args, "-minimized");
        let mut n = input("manual", "", "notify", "hi");
        n.action_args = "ignored".into();
        assert_eq!(create(&conn, n).unwrap().action_args, "");
    }
}
