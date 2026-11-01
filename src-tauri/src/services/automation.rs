//! Automation rules: storage, validation and the rules for matching triggers
//! and checking conditions. Running actions is in `crate::automation`.
//!
//! A rule is one trigger, any number of conditions (all must hold) and a chain
//! of actions run in order.

use std::collections::HashSet;

use chrono::{Datelike, NaiveDateTime, NaiveTime};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const TRIGGERS: &[&str] = &[
    "netrunner_start", "manual", "app_started", "app_stopped", "profile_changed", "time", "interval", "file_created",
    "download_finished", "network_up", "network_down", "game_started", "game_stopped", "power_source", "power_plan",
];
pub const CONDITIONS: &[&str] = &["profile", "time_between", "weekday", "process_running", "process_not_running", "power_source", "vpn"];
pub const ACTIONS: &[&str] = &[
    "launch_program", "launch_entry", "switch_profile", "notify", "show_overlay", "hide_overlay", "show_overlay_set",
    "hide_overlay_set", "set_volume", "power_plan", "open_url", "wait",
];
const MAX_CONDITIONS: usize = 8;
const MAX_ACTIONS: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub kind: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub kind: String,
    #[serde(default)]
    pub value: String,
    /// Command-line arguments for `launch_program`.
    #[serde(default)]
    pub args: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    pub trigger_kind: String,
    pub trigger_value: String,
    pub conditions: Vec<Condition>,
    pub actions: Vec<Action>,
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
    #[serde(default)]
    pub conditions: Vec<Condition>,
    pub actions: Vec<Action>,
}

const SELECT: &str =
    "SELECT id, name, enabled, trigger_kind, trigger_value, conditions_json, actions_json, run_count, last_run_at FROM automations";

fn from_row(r: &Row) -> rusqlite::Result<Rule> {
    Ok(Rule {
        id: r.get(0)?,
        name: r.get(1)?,
        enabled: r.get(2)?,
        trigger_kind: r.get(3)?,
        trigger_value: r.get(4)?,
        conditions: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
        actions: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
        run_count: r.get(7)?,
        last_run_at: r.get(8)?,
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

fn exe_name(v: &str) -> AppResult<String> {
    let mut v = v.trim().trim_matches('"').to_lowercase();
    if v.is_empty() || v.contains(['\\', '/']) {
        return Err(AppError::Invalid("enter a process name, e.g. game.exe".into()));
    }
    if !v.ends_with(".exe") {
        v.push_str(".exe");
    }
    Ok(v)
}

fn hhmm(v: &str) -> AppResult<String> {
    Ok(NaiveTime::parse_from_str(v.trim(), "%H:%M").map_err(|_| AppError::Invalid("time must be HH:MM".into()))?.format("%H:%M").to_string())
}

fn int_in(v: &str, min: i64, max: i64, what: &str) -> AppResult<String> {
    match v.trim().parse::<i64>() {
        Ok(n) if (min..=max).contains(&n) => Ok(n.to_string()),
        _ => Err(AppError::Invalid(format!("{what} must be {min}–{max}"))),
    }
}

fn trigger_value(kind: &str, v: &str) -> AppResult<String> {
    let v = v.trim();
    Ok(match kind {
        "app_started" | "app_stopped" => exe_name(v)?,
        "time" => hhmm(v)?,
        "interval" => int_in(v, 1, 1440, "the interval in minutes")?,
        "file_created" => {
            let p = std::path::Path::new(v.trim_matches('"'));
            if !p.is_absolute() || !p.is_dir() {
                return Err(AppError::Invalid("choose an existing folder to watch".into()));
            }
            p.display().to_string()
        }
        "download_finished" => v
            .split([',', ' ', ';'])
            .map(|e| e.trim().trim_start_matches("*.").trim_start_matches('.').to_lowercase())
            .filter(|e| !e.is_empty())
            .collect::<Vec<_>>()
            .join(","),
        "power_source" => match v {
            "ac" | "battery" => v.to_string(),
            _ => return Err(AppError::Invalid("choose AC power or battery".into())),
        },
        "profile_changed" if !v.is_empty() => int_in(v, 1, i64::MAX, "profile")?,
        _ => v.chars().take(200).collect(),
    })
}

fn condition(c: &Condition) -> AppResult<Condition> {
    if !CONDITIONS.contains(&c.kind.as_str()) {
        return Err(AppError::Invalid("unknown condition".into()));
    }
    let v = c.value.trim();
    let value = match c.kind.as_str() {
        "profile" => int_in(v, 1, i64::MAX, "profile")?,
        "time_between" => {
            let (a, b) = v.split_once('-').ok_or_else(|| AppError::Invalid("time range must be HH:MM-HH:MM".into()))?;
            format!("{}-{}", hhmm(a)?, hhmm(b)?)
        }
        "weekday" => int_in(v, 1, 127, "days")?,
        "process_running" | "process_not_running" => exe_name(v)?,
        "power_source" | "vpn" => match (c.kind.as_str(), v) {
            ("power_source", "ac" | "battery") | ("vpn", "up" | "down") => v.to_string(),
            _ => return Err(AppError::Invalid("invalid condition value".into())),
        },
        _ => v.to_string(),
    };
    Ok(Condition { kind: c.kind.clone(), value })
}

fn action(a: &Action) -> AppResult<Action> {
    if !ACTIONS.contains(&a.kind.as_str()) {
        return Err(AppError::Invalid("unknown action".into()));
    }
    let v = a.value.trim();
    let mut args = String::new();
    let value = match a.kind.as_str() {
        "launch_program" => {
            args = a.args.trim().to_string();
            let p = v.trim_matches('"');
            if p.is_empty() {
                return Err(AppError::Invalid("choose the program to launch".into()));
            }
            p.to_string()
        }
        "launch_entry" | "switch_profile" | "show_overlay" | "hide_overlay" => {
            v.parse::<i64>().map_err(|_| AppError::Invalid("choose a target for the action".into()))?.to_string()
        }
        "show_overlay_set" | "hide_overlay_set" => {
            if v == "all" {
                v.to_string()
            } else {
                int_in(v, 1, i64::MAX, "profile")?
            }
        }
        "notify" if v.is_empty() => return Err(AppError::Invalid("notification text is required".into())),
        "notify" => v.chars().take(300).collect(),
        "set_volume" => int_in(v, 0, 100, "volume")?,
        "power_plan" if v.is_empty() => return Err(AppError::Invalid("choose a power plan".into())),
        "open_url" => crate::security::targets::validate_web_url(v)?,
        "wait" => int_in(v, 1, 600, "the wait in seconds")?,
        _ => v.to_string(),
    };
    Ok(Action { kind: a.kind.clone(), value, args })
}

fn normalize(mut i: RuleInput) -> AppResult<RuleInput> {
    i.name = i.name.trim().to_string();
    if i.name.is_empty() || i.name.chars().count() > 80 {
        return Err(AppError::Invalid("name must be 1–80 characters".into()));
    }
    if !TRIGGERS.contains(&i.trigger_kind.as_str()) {
        return Err(AppError::Invalid("unknown trigger".into()));
    }
    i.trigger_value = trigger_value(&i.trigger_kind, &i.trigger_value)?;
    if i.conditions.len() > MAX_CONDITIONS {
        return Err(AppError::Invalid(format!("at most {MAX_CONDITIONS} conditions")));
    }
    if i.actions.is_empty() || i.actions.len() > MAX_ACTIONS {
        return Err(AppError::Invalid(format!("a rule needs 1–{MAX_ACTIONS} actions")));
    }
    if i.actions.iter().all(|a| a.kind == "wait") {
        return Err(AppError::Invalid("a rule needs an action besides waiting".into()));
    }
    i.conditions = i.conditions.iter().map(condition).collect::<AppResult<_>>()?;
    i.actions = i.actions.iter().map(action).collect::<AppResult<_>>()?;
    Ok(i)
}

pub fn create(conn: &Connection, input: RuleInput) -> AppResult<Rule> {
    let i = normalize(input)?;
    conn.execute(
        "INSERT INTO automations (name, enabled, trigger_kind, trigger_value, conditions_json, actions_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![i.name, i.enabled, i.trigger_kind, i.trigger_value, serde_json::to_string(&i.conditions)?, serde_json::to_string(&i.actions)?],
    )?;
    get(conn, conn.last_insert_rowid())
}

/// Validates without saving (the editor's dry run uses the normalised rule).
pub fn check(input: RuleInput) -> AppResult<RuleInput> {
    normalize(input)
}

pub fn update(conn: &Connection, id: i64, input: RuleInput) -> AppResult<Rule> {
    let i = normalize(input)?;
    let n = conn.execute(
        "UPDATE automations SET name=?1, enabled=?2, trigger_kind=?3, trigger_value=?4, conditions_json=?5, actions_json=?6 WHERE id=?7",
        params![
            i.name,
            i.enabled,
            i.trigger_kind,
            i.trigger_value,
            serde_json::to_string(&i.conditions)?,
            serde_json::to_string(&i.actions)?,
            id
        ],
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
    conn.execute("UPDATE automations SET run_count = run_count + 1, last_run_at = datetime('now') WHERE id = ?1", [id])?;
    Ok(())
}

/// Whether an event (`kind`, `value`) fires a rule's trigger. An empty rule value means "any".
///
/// Event values: process name (app_*), profile id, game id (game_*), file path
/// (download_finished), `vpn|<adapter>` or `<adapter>` (network_*), `ac`/`battery`, plan GUID.
pub fn trigger_matches(rule: &Rule, kind: &str, value: &str) -> bool {
    if !rule.enabled || rule.trigger_kind != kind {
        return false;
    }
    let want = rule.trigger_value.as_str();
    if want.is_empty() {
        return true;
    }
    match kind {
        "download_finished" => {
            let path = value.to_lowercase();
            want.split(',').any(|ext| path.ends_with(&format!(".{ext}")))
        }
        "network_up" | "network_down" => {
            if want.eq_ignore_ascii_case("vpn") {
                value.starts_with("vpn|")
            } else {
                value.rsplit('|').next().unwrap_or("").to_lowercase().contains(&want.to_lowercase())
            }
        }
        _ => want.eq_ignore_ascii_case(value),
    }
}

/// Enabled rules fired by an event.
pub fn matching(conn: &Connection, kind: &str, value: &str) -> AppResult<Vec<Rule>> {
    Ok(list(conn)?.into_iter().filter(|r| trigger_matches(r, kind, value)).collect())
}

/// What conditions are checked against, gathered once per run.
#[derive(Debug, Default)]
pub struct Context {
    pub active_profile: Option<i64>,
    pub now: NaiveDateTime,
    /// Lower-case process names; only gathered when a rule needs them.
    pub processes: HashSet<String>,
    pub on_ac: Option<bool>,
    pub vpn_up: bool,
}

/// Whether one condition holds.
pub fn condition_met(c: &Condition, ctx: &Context) -> bool {
    match c.kind.as_str() {
        "profile" => c.value.parse::<i64>().ok() == ctx.active_profile,
        "time_between" => {
            let Some((a, b)) = c.value.split_once('-') else { return false };
            let (Ok(a), Ok(b)) = (NaiveTime::parse_from_str(a, "%H:%M"), NaiveTime::parse_from_str(b, "%H:%M")) else { return false };
            let t = ctx.now.time();
            // A range like 22:00-06:00 crosses midnight.
            if a <= b {
                t >= a && t < b
            } else {
                t >= a || t < b
            }
        }
        "weekday" => c.value.parse::<u8>().is_ok_and(|days| days & (1 << ctx.now.weekday().num_days_from_monday()) != 0),
        "process_running" => ctx.processes.contains(&c.value),
        "process_not_running" => !ctx.processes.contains(&c.value),
        "power_source" => ctx.on_ac == Some(c.value == "ac"),
        "vpn" => ctx.vpn_up == (c.value == "up"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;
    use chrono::NaiveDate;

    fn act(kind: &str, value: &str) -> Action {
        Action { kind: kind.into(), value: value.into(), args: String::new() }
    }

    fn input(trigger: &str, tv: &str, actions: Vec<Action>) -> RuleInput {
        RuleInput { name: "Rule".into(), enabled: true, trigger_kind: trigger.into(), trigger_value: tv.into(), conditions: vec![], actions }
    }

    #[test]
    fn validates_rules() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        assert!(create(&conn, input("app_started", "", vec![act("notify", "x")])).is_err());
        assert!(create(&conn, input("manual", "", vec![act("launch_entry", "abc")])).is_err());
        assert!(create(&conn, input("bogus", "", vec![act("notify", "x")])).is_err());
        assert!(create(&conn, input("manual", "", vec![])).is_err(), "needs an action");
        assert!(create(&conn, input("manual", "", vec![act("wait", "5")])).is_err(), "waiting alone is not an action");
        assert!(create(&conn, input("time", "25:00", vec![act("notify", "x")])).is_err());
        assert!(create(&conn, input("manual", "", vec![act("open_url", "javascript:alert(1)")])).is_err());
        assert!(create(&conn, input("manual", "", vec![act("set_volume", "150")])).is_err());

        let r = create(&conn, input("app_started", "Cyberpunk2077", vec![act("set_volume", "40"), act("wait", "3"), act("notify", "Gaming")])).unwrap();
        assert_eq!(r.trigger_value, "cyberpunk2077.exe");
        assert_eq!(r.actions.len(), 3);
        let t = create(&conn, input("time", "7:05", vec![act("open_url", "https://example.com")])).unwrap();
        assert_eq!(t.trigger_value, "07:05");
        let d = create(&conn, input("download_finished", "*.PDF, .zip", vec![act("notify", "x")])).unwrap();
        assert_eq!(d.trigger_value, "pdf,zip");

        let mut c = input("manual", "", vec![act("notify", "x")]);
        c.conditions = vec![Condition { kind: "time_between".into(), value: "22:00 - 6:00".into() }];
        assert_eq!(create(&conn, c).unwrap().conditions[0].value, "22:00-06:00");
        let mut bad = input("manual", "", vec![act("notify", "x")]);
        bad.conditions = vec![Condition { kind: "weekday".into(), value: "0".into() }];
        assert!(create(&conn, bad).is_err());

        mark_run(&conn, r.id).unwrap();
        assert_eq!(get(&conn, r.id).unwrap().run_count, 1);
    }

    #[test]
    fn migration_keeps_old_rules() {
        // A v11 database with a single-action rule and a profile condition, migrated to v12.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE profiles (id INTEGER PRIMARY KEY);
             INSERT INTO profiles (id) VALUES (3);
             CREATE TABLE automations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
               trigger_kind TEXT NOT NULL, trigger_value TEXT NOT NULL DEFAULT '', condition_profile_id INTEGER, action_kind TEXT NOT NULL,
               action_value TEXT NOT NULL DEFAULT '', action_args TEXT NOT NULL DEFAULT '', run_count INTEGER NOT NULL DEFAULT 0,
               last_run_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
             INSERT INTO automations (name, trigger_kind, condition_profile_id, action_kind, action_value, action_args)
               VALUES ('PowerUP', 'netrunner_start', 3, 'launch_program', 'E:\\Tools\\ThrottleStop.exe', '-min');",
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute_batch(include_str!("../../migrations/0012_automation_chains.sql")).unwrap();
        tx.commit().unwrap();
        let r = get(&conn, 1).unwrap();
        assert_eq!(r.conditions, vec![Condition { kind: "profile".into(), value: "3".into() }]);
        assert_eq!(r.actions, vec![Action { kind: "launch_program".into(), value: "E:\\Tools\\ThrottleStop.exe".into(), args: "-min".into() }]);
    }

    fn rule(kind: &str, value: &str) -> Rule {
        Rule {
            id: 1,
            name: "r".into(),
            enabled: true,
            trigger_kind: kind.into(),
            trigger_value: value.into(),
            conditions: vec![],
            actions: vec![],
            run_count: 0,
            last_run_at: None,
        }
    }

    #[test]
    fn triggers_match_events() {
        assert!(trigger_matches(&rule("app_started", "game.exe"), "app_started", "GAME.EXE"));
        assert!(!trigger_matches(&rule("app_started", "game.exe"), "app_stopped", "game.exe"));
        assert!(trigger_matches(&rule("download_finished", "pdf,zip"), "download_finished", r"C:\Downloads\Report.PDF"));
        assert!(!trigger_matches(&rule("download_finished", "pdf"), "download_finished", r"C:\Downloads\x.pdf.crdownload"));
        assert!(trigger_matches(&rule("download_finished", ""), "download_finished", r"C:\x.bin"));
        assert!(trigger_matches(&rule("network_up", "vpn"), "network_up", "vpn|WireGuard Tunnel"));
        assert!(!trigger_matches(&rule("network_up", "vpn"), "network_up", "Ethernet"));
        assert!(trigger_matches(&rule("network_down", "wi-fi"), "network_down", "Wi-Fi"));
        assert!(trigger_matches(&rule("game_started", ""), "game_started", "steam:1"));
        let mut off = rule("manual", "");
        off.enabled = false;
        assert!(!trigger_matches(&off, "manual", ""));
    }

    #[test]
    fn conditions_hold() {
        // Monday 2026-11-02, 23:30.
        let ctx = Context {
            active_profile: Some(3),
            now: NaiveDate::from_ymd_opt(2026, 11, 2).unwrap().and_hms_opt(23, 30, 0).unwrap(),
            processes: ["discord.exe".to_string()].into_iter().collect(),
            on_ac: Some(false),
            vpn_up: true,
        };
        let c = |kind: &str, value: &str| condition_met(&Condition { kind: kind.into(), value: value.into() }, &ctx);
        assert!(c("profile", "3") && !c("profile", "4"));
        assert!(c("time_between", "22:00-06:00"), "crosses midnight");
        assert!(!c("time_between", "08:00-18:00"));
        assert!(c("weekday", "1") && !c("weekday", "2"));
        assert!(c("process_running", "discord.exe") && c("process_not_running", "steam.exe"));
        assert!(c("power_source", "battery") && !c("power_source", "ac"));
        assert!(c("vpn", "up") && !c("vpn", "down"));
    }
}
