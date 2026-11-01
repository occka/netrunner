//! Automation engine: evaluates rules when events occur and runs their actions.
//!
//! Event sources:
//! - NETRUNNER start (fired once from setup)
//! - profile change (fired by `profile_activate`)
//! - manual run (from the UI)
//! - process start/stop: a watcher thread diffs process names every few
//!   seconds, and only scans while at least one process rule is enabled.
//!
//! Safety: actions never bypass confirmation. A Quick Access command that
//! requires confirmation is not run unattended; the UI is asked to confirm.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppError;
use crate::services::activity::{self, Level};
use crate::services::automation::{self, Rule};
use crate::services::{launcher, profiles, quick_access};
use crate::state::AppState;

const MAX_DEPTH: u8 = 2;
const MIN_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyEvent {
    pub rule: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmEvent {
    pub rule: String,
    pub entry_id: i64,
}

fn last_runs() -> &'static std::sync::Mutex<HashMap<i64, Instant>> {
    static LAST: std::sync::OnceLock<std::sync::Mutex<HashMap<i64, Instant>>> = std::sync::OnceLock::new();
    LAST.get_or_init(Default::default)
}

/// Fires all enabled rules matching `kind`/`value`.
/// Development builds never run automations (they would launch the
/// developer's real programs on every rebuild). `NETRUNNER_DEV_AUTOMATION=1`
/// turns them back on for testing the engine.
pub fn disabled_in_dev() -> bool {
    cfg!(debug_assertions) && std::env::var_os("NETRUNNER_DEV_AUTOMATION").is_none()
}

pub fn fire(app: &AppHandle, kind: &str, value: &str) {
    fire_depth(app, kind, value, 0);
}

fn fire_depth(app: &AppHandle, kind: &str, value: &str, depth: u8) {
    if depth > MAX_DEPTH || disabled_in_dev() {
        return;
    }
    let state = app.state::<AppState>();
    let rules = match state.db.conn().and_then(|c| automation::matching(&c, kind, value)) {
        Ok(r) => r,
        Err(err) => return log::error!("automation lookup failed: {err}"),
    };
    for rule in rules {
        // Failures are already in the activity log; event-driven runs have no caller to report to.
        let _ = run_rule(app, &rule, depth, false);
    }
}

/// Runs one rule and returns what happened (also written to the activity log).
/// `manual` bypasses the rate limit and profile condition. `Ok(None)` means
/// the rule was skipped by its condition or rate limit.
pub fn run_rule(app: &AppHandle, rule: &Rule, depth: u8, manual: bool) -> Result<Option<String>, AppError> {
    if disabled_in_dev() {
        return Err(AppError::Invalid("automations are disabled in development builds (set NETRUNNER_DEV_AUTOMATION=1 to allow)".into()));
    }
    let state = app.state::<AppState>();
    if !manual {
        if let Some(required) = rule.condition_profile_id {
            let active = state.db.conn().ok().and_then(|c| profiles::active_id(&c).ok().flatten());
            if active != Some(required) {
                return Ok(None);
            }
        }
        let mut last = last_runs().lock().unwrap_or_else(|e| e.into_inner());
        if last.get(&rule.id).is_some_and(|t| t.elapsed() < MIN_INTERVAL) {
            return Ok(None);
        }
        last.insert(rule.id, Instant::now());
    }

    let result = execute(app, rule, depth);
    if let Ok(conn) = state.db.conn() {
        match &result {
            Ok(summary) => {
                let _ = automation::mark_run(&conn, rule.id);
                activity::record(&conn, Level::Info, "automation", &format!("'{}': {summary}", rule.name));
            }
            Err(err) => activity::record(&conn, Level::Error, "automation", &format!("'{}' failed: {err}", rule.name)),
        }
    }
    let _ = app.emit("automation://ran", rule.id);
    result.map(Some)
}

fn execute(app: &AppHandle, rule: &Rule, depth: u8) -> Result<String, AppError> {
    let state = app.state::<AppState>();
    let id = || rule.action_value.parse::<i64>().map_err(|_| AppError::Invalid("invalid action target".into()));
    match rule.action_kind.as_str() {
        "notify" => {
            let _ = app.emit("automation://notify", NotifyEvent { rule: rule.name.clone(), message: rule.action_value.clone() });
            Ok("notification shown".into())
        }
        "launch_program" => {
            let exe = launcher::expand_env(&rule.action_value);
            let path = std::path::Path::new(&exe);
            if path.is_absolute() && !path.exists() {
                return Err(AppError::Launch(format!("program not found: {exe}")));
            }
            // ShellExecute: programs that need administrator rights show the normal UAC prompt.
            launcher::shell_open(&exe, &rule.action_args, path.parent())?;
            Ok(format!("launched {}", path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()))
        }
        "launch_entry" => {
            let entry = quick_access::get(&*state.db.conn()?, id()?)?;
            match launcher::launch(&entry, false) {
                Ok(()) => {
                    quick_access::mark_launched(&*state.db.conn()?, entry.id)?;
                    Ok(format!("launched '{}'", entry.name))
                }
                Err(AppError::ConfirmationRequired(_)) => {
                    let _ = app.emit("automation://confirm", ConfirmEvent { rule: rule.name.clone(), entry_id: entry.id });
                    Ok(format!("asked for confirmation to run '{}'", entry.name))
                }
                Err(e) => Err(e),
            }
        }
        "switch_profile" => {
            let profile = profiles::activate(&*state.db.conn()?, id()?)?;
            let _ = app.emit("profiles://changed", profile.id);
            crate::overlay::sync_profile(app);
            let _ = app.emit("overlays://changed", ());
            fire_depth(app, "profile_changed", &profile.id.to_string(), depth + 1);
            Ok(format!("switched to profile '{}'", profile.name))
        }
        "show_overlay" | "hide_overlay" => {
            let show = rule.action_kind == "show_overlay";
            crate::overlay::set_shown(app, id()?, show)?;
            let _ = app.emit("overlays://changed", ());
            Ok(if show { "overlay shown".into() } else { "overlay hidden".into() })
        }
        other => Err(AppError::Invalid(format!("unknown action '{other}'"))),
    }
}

/// Background process watcher for app_started / app_stopped rules.
pub fn start_process_watcher(app: AppHandle) {
    if disabled_in_dev() {
        log::info!("automation: disabled in this development build");
        return;
    }
    std::thread::Builder::new()
        .name("nr-automation".into())
        .spawn(move || {
            let mut sys = System::new_with_specifics(RefreshKind::nothing());
            let mut previous: Option<HashSet<String>> = None;
            let mut previous_wanted: Option<HashSet<String>> = None;
            loop {
                let wanted: HashSet<String> = {
                    let state = app.state::<AppState>();
                    state
                        .db
                        .conn()
                        .and_then(|c| automation::list(&c))
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|r| r.enabled && matches!(r.trigger_kind.as_str(), "app_started" | "app_stopped"))
                        .map(|r| r.trigger_value)
                        .collect()
                };
                if wanted.is_empty() {
                    previous = None;
                    std::thread::sleep(Duration::from_secs(10));
                    continue;
                }
                sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
                let now: HashSet<String> = sys
                    .processes()
                    .values()
                    .map(|p| p.name().to_string_lossy().to_lowercase())
                    .filter(|n| wanted.contains(n))
                    .collect();
                // A rule added/removed changes the watched set; re-baseline instead
                // of reporting already-running processes as newly started.
                if previous_wanted.as_ref() != Some(&wanted) {
                    previous = None;
                    previous_wanted = Some(wanted.clone());
                }
                if let Some(prev) = &previous {
                    for started in now.difference(prev) {
                        fire(&app, "app_started", started);
                    }
                    for stopped in prev.difference(&now) {
                        fire(&app, "app_stopped", stopped);
                    }
                }
                previous = Some(now);
                std::thread::sleep(Duration::from_secs(3));
            }
        })
        .expect("failed to start automation watcher");
}
