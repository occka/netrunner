//! Automation engine: evaluates rules when events occur and runs their action chains.
//!
//! Event sources:
//! - NETRUNNER start (fired once from setup), profile change, manual run
//! - process start/stop: a watcher thread diffs process names every 3 s while process rules exist
//! - time of day, intervals, new files in a folder, network adapters up/down,
//!   AC/battery and power plan changes: an event thread checks every 5 s while such rules exist
//! - games started/stopped (playtime tracker) and finished downloads (BROWSER)
//!
//! Safety: actions never bypass confirmation. A Quick Access command that
//! requires confirmation is not run unattended; the UI is asked to confirm.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use chrono::{Local, NaiveTime};
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::services::activity::{self, Level};
use crate::services::automation::{self, Action, Context, Rule, RuleInput};
use crate::services::{launcher, overlays, profiles, quick_access};
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

/// Development builds never run automations (they would launch the
/// developer's real programs on every rebuild). `NETRUNNER_DEV_AUTOMATION=1`
/// turns them back on for testing the engine. Dry runs work regardless.
pub fn disabled_in_dev() -> bool {
    cfg!(debug_assertions) && std::env::var_os("NETRUNNER_DEV_AUTOMATION").is_none()
}

/// Fires all enabled rules matching an event. Each rule runs on its own
/// thread, so a rule that waits never holds up the event source.
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
        let app = app.clone();
        // Failures are already in the activity log; event-driven runs have no caller to report to.
        std::thread::spawn(move || {
            let _ = run_rule(&app, &rule, depth, false);
        });
    }
}

fn needs_processes(rule_conditions: &[automation::Condition]) -> bool {
    rule_conditions.iter().any(|c| c.kind.starts_with("process_"))
}

/// The state conditions are checked against, gathered now.
fn context(app: &AppHandle, with_processes: bool) -> Context {
    let state = app.state::<AppState>();
    let processes = if with_processes {
        let mut sys = System::new_with_specifics(RefreshKind::nothing());
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        sys.processes().values().map(|p| p.name().to_string_lossy().to_lowercase()).collect()
    } else {
        HashSet::new()
    };
    Context {
        active_profile: state.db.conn().ok().and_then(|c| profiles::active_id(&c).ok().flatten()),
        now: Local::now().naive_local(),
        processes,
        on_ac: crate::system::power::info().on_ac_power,
        vpn_up: crate::system::network::status().adapters.iter().any(|a| a.vpn_like && a.up),
    }
}

/// Runs one rule and returns what happened (also written to the activity log).
/// `manual` (the Run button) skips the conditions and the rate limit.
/// `Ok(None)` means the rule was skipped by a condition or the rate limit.
pub fn run_rule(app: &AppHandle, rule: &Rule, depth: u8, manual: bool) -> Result<Option<String>, AppError> {
    if disabled_in_dev() {
        return Err(AppError::Invalid("automations are disabled in development builds (set NETRUNNER_DEV_AUTOMATION=1 to allow)".into()));
    }
    let state = app.state::<AppState>();
    if !manual {
        if !rule.conditions.is_empty() {
            let ctx = context(app, needs_processes(&rule.conditions));
            if !rule.conditions.iter().all(|c| automation::condition_met(c, &ctx)) {
                return Ok(None);
            }
        }
        let mut last = last_runs().lock().unwrap_or_else(|e| e.into_inner());
        if last.get(&rule.id).is_some_and(|t| t.elapsed() < MIN_INTERVAL) {
            return Ok(None);
        }
        last.insert(rule.id, Instant::now());
    }

    // Actions run in order; the chain stops at the first failure.
    let mut done = Vec::new();
    let mut result = Ok(());
    for action in &rule.actions {
        match execute(app, rule, action, depth) {
            Ok(summary) => done.push(summary),
            Err(err) => {
                result = Err(err);
                break;
            }
        }
    }
    let summary = done.join(", ");
    if let Ok(conn) = state.db.conn() {
        match &result {
            Ok(()) => {
                let _ = automation::mark_run(&conn, rule.id);
                activity::record(&conn, Level::Info, "automation", &format!("'{}': {summary}", rule.name));
            }
            Err(err) => {
                let before = if summary.is_empty() { String::new() } else { format!(" (after: {summary})") };
                activity::record(&conn, Level::Error, "automation", &format!("'{}' failed: {err}{before}", rule.name));
            }
        }
    }
    let _ = app.emit("automation://ran", rule.id);
    result.map(|_| Some(summary))
}

fn overlay_set(app: &AppHandle, target: &str, show: bool) -> AppResult<usize> {
    let state = app.state::<AppState>();
    let list = overlays::list(&*state.db.conn()?)?;
    let profile = target.parse::<i64>().ok();
    let mut n = 0;
    for o in list.iter().filter(|o| target == "all" || (profile.is_some() && o.profile_id == profile)) {
        crate::overlay::set_shown(app, o.id, show)?;
        n += 1;
    }
    let _ = app.emit("overlays://changed", ());
    Ok(n)
}

fn execute(app: &AppHandle, rule: &Rule, action: &Action, depth: u8) -> Result<String, AppError> {
    let state = app.state::<AppState>();
    let id = || action.value.parse::<i64>().map_err(|_| AppError::Invalid("invalid action target".into()));
    match action.kind.as_str() {
        "notify" => {
            let _ = app.emit("automation://notify", NotifyEvent { rule: rule.name.clone(), message: action.value.clone() });
            Ok("notification shown".into())
        }
        "launch_program" => {
            let exe = launcher::expand_env(&action.value);
            let path = std::path::Path::new(&exe);
            if path.is_absolute() && !path.exists() {
                return Err(AppError::Launch(format!("program not found: {exe}")));
            }
            // ShellExecute: programs that need administrator rights show the normal UAC prompt.
            launcher::shell_open(&exe, &action.args, path.parent())?;
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
            let show = action.kind == "show_overlay";
            crate::overlay::set_shown(app, id()?, show)?;
            let _ = app.emit("overlays://changed", ());
            Ok(if show { "overlay shown".into() } else { "overlay hidden".into() })
        }
        "show_overlay_set" | "hide_overlay_set" => {
            let show = action.kind == "show_overlay_set";
            let n = overlay_set(app, &action.value, show)?;
            Ok(format!("{} {n} overlay(s)", if show { "showed" } else { "hid" }))
        }
        "set_volume" => {
            let v: u8 = action.value.parse().map_err(|_| AppError::Invalid("invalid volume".into()))?;
            crate::system::audio::set_master_volume(v)?;
            Ok(format!("volume {v}%"))
        }
        "power_plan" => Ok(format!("power plan '{}'", crate::system::power::set_active(&action.value)?)),
        "open_url" => {
            crate::desktop::open_in_browser(app, &action.value)?;
            Ok(format!("opened {}", url::Url::parse(&action.value).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()))
        }
        "wait" => {
            let secs: u64 = action.value.parse().map_err(|_| AppError::Invalid("invalid wait".into()))?;
            std::thread::sleep(Duration::from_secs(secs.min(600)));
            Ok(format!("waited {secs} s"))
        }
        other => Err(AppError::Invalid(format!("unknown action '{other}'"))),
    }
}

// ---------- Dry run ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionCheck {
    pub kind: String,
    pub value: String,
    pub met: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRun {
    /// The rule as it would be saved (normalised values).
    pub trigger_value: String,
    pub conditions: Vec<ConditionCheck>,
    /// True when every condition holds right now.
    pub would_run: bool,
    /// One line per action: what it would do, or why it would fail.
    pub actions: Vec<String>,
}

/// Checks a rule without running anything: conditions against the current
/// state, and what each action would do. Works in development builds too.
pub fn dry_run(app: &AppHandle, input: RuleInput) -> AppResult<DryRun> {
    let rule = automation::check(input)?;
    let ctx = context(app, needs_processes(&rule.conditions));
    let conditions: Vec<ConditionCheck> = rule
        .conditions
        .iter()
        .map(|c| ConditionCheck { kind: c.kind.clone(), value: c.value.clone(), met: automation::condition_met(c, &ctx) })
        .collect();
    let state = app.state::<AppState>();
    let conn = state.db.conn()?;
    let actions = rule
        .actions
        .iter()
        .map(|a| {
            let id = a.value.parse::<i64>().unwrap_or(-1);
            match a.kind.as_str() {
                "launch_program" => {
                    let exe = launcher::expand_env(&a.value);
                    let p = std::path::Path::new(&exe);
                    if p.is_absolute() && !p.exists() {
                        format!("✗ program not found: {exe}")
                    } else {
                        format!("launch {exe} {}", a.args)
                    }
                }
                "launch_entry" => match quick_access::get(&conn, id) {
                    Ok(e) => format!("launch Quick Access entry '{}'", e.name),
                    Err(_) => "✗ the Quick Access entry no longer exists".into(),
                },
                "switch_profile" => match profiles::get(&conn, id) {
                    Ok(p) => format!("switch to profile '{}'", p.name),
                    Err(_) => "✗ the profile no longer exists".into(),
                },
                "notify" => format!("show notification \"{}\"", a.value),
                "show_overlay" | "hide_overlay" => match overlays::get(&conn, id) {
                    Ok(o) => format!("{} overlay #{} ({})", if a.kind == "show_overlay" { "show" } else { "hide" }, o.id, o.widget_type),
                    Err(_) => "✗ the overlay no longer exists".into(),
                },
                "show_overlay_set" | "hide_overlay_set" => {
                    let n = overlays::list(&conn)
                        .unwrap_or_default()
                        .iter()
                        .filter(|o| a.value == "all" || o.profile_id == a.value.parse::<i64>().ok())
                        .count();
                    format!("{} {n} overlay(s)", if a.kind == "show_overlay_set" { "show" } else { "hide" })
                }
                "set_volume" => format!("set the volume to {}%", a.value),
                "power_plan" => match crate::system::power::info().plans.into_iter().find(|p| p.guid.eq_ignore_ascii_case(&a.value)) {
                    Some(p) => format!("switch power plan to '{}'", p.name),
                    None => "✗ the power plan no longer exists".into(),
                },
                "open_url" => format!("open {} in BROWSER", a.value),
                "wait" => format!("wait {} s", a.value),
                other => format!("✗ unknown action {other}"),
            }
        })
        .collect();
    Ok(DryRun { trigger_value: rule.trigger_value, would_run: conditions.iter().all(|c| c.met), conditions, actions })
}

// ---------- Event sources ----------

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
                let wanted: HashSet<String> = enabled_rules(&app)
                    .into_iter()
                    .filter(|r| matches!(r.trigger_kind.as_str(), "app_started" | "app_stopped"))
                    .map(|r| r.trigger_value)
                    .collect();
                if wanted.is_empty() {
                    previous = None;
                    std::thread::sleep(Duration::from_secs(10));
                    continue;
                }
                sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
                let now: HashSet<String> =
                    sys.processes().values().map(|p| p.name().to_string_lossy().to_lowercase()).filter(|n| wanted.contains(n)).collect();
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

fn enabled_rules(app: &AppHandle) -> Vec<Rule> {
    app.state::<AppState>().db.conn().and_then(|c| automation::list(&c)).unwrap_or_default().into_iter().filter(|r| r.enabled).collect()
}

/// Names of files directly in a folder, skipping downloads still in progress.
fn folder_files(dir: &str) -> HashSet<String> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| {
            let l = n.to_lowercase();
            !(l.ends_with(".crdownload") || l.ends_with(".part") || l.ends_with(".tmp") || l.starts_with("~$"))
        })
        .take(20_000)
        .collect()
}

/// Time, interval, folder, network and power triggers. Checks every 5 s, and
/// only gathers what the enabled rules need.
pub fn start_event_watcher(app: AppHandle) {
    if disabled_in_dev() {
        return;
    }
    std::thread::Builder::new()
        .name("nr-automation-events".into())
        .spawn(move || {
            let mut last_tick = Local::now().naive_local();
            let mut interval_last: HashMap<i64, Instant> = HashMap::new();
            let mut folders: HashMap<String, HashSet<String>> = HashMap::new();
            let mut adapters: Option<HashMap<String, (bool, bool)>> = None;
            let mut on_ac: Option<Option<bool>> = None;
            let mut plan: Option<Option<String>> = None;
            loop {
                std::thread::sleep(Duration::from_secs(5));
                let rules = enabled_rules(&app);
                let has = |k: &str| rules.iter().any(|r| r.trigger_kind == k);
                let now = Local::now().naive_local();

                // Time of day: rules whose HH:MM fell into (last tick, now].
                for r in rules.iter().filter(|r| r.trigger_kind == "time") {
                    if let Ok(t) = NaiveTime::parse_from_str(&r.trigger_value, "%H:%M") {
                        let at = now.date().and_time(t);
                        let at_prev = last_tick.date().and_time(t);
                        if (at > last_tick && at <= now) || (at_prev > last_tick && at_prev <= now) {
                            fire_rule(&app, r, &r.trigger_value);
                        }
                    }
                }
                last_tick = now;

                // Every N minutes, counted from NETRUNNER's start or the rule's creation.
                let ids: HashSet<i64> = rules.iter().filter(|r| r.trigger_kind == "interval").map(|r| r.id).collect();
                interval_last.retain(|id, _| ids.contains(id));
                for r in rules.iter().filter(|r| r.trigger_kind == "interval") {
                    let minutes: u64 = r.trigger_value.parse().unwrap_or(60);
                    let last = interval_last.entry(r.id).or_insert_with(Instant::now);
                    if last.elapsed() >= Duration::from_secs(minutes * 60) {
                        *last = Instant::now();
                        fire_rule(&app, r, "");
                    }
                }

                // New files in watched folders (first look is the baseline).
                let watched: HashSet<String> = rules.iter().filter(|r| r.trigger_kind == "file_created").map(|r| r.trigger_value.clone()).collect();
                folders.retain(|d, _| watched.contains(d));
                for dir in &watched {
                    let files = folder_files(dir);
                    if let Some(before) = folders.get(dir) {
                        for name in files.difference(before) {
                            let path = PathBuf::from(dir).join(name).display().to_string();
                            for r in rules.iter().filter(|r| r.trigger_kind == "file_created" && &r.trigger_value == dir) {
                                fire_rule(&app, r, &path);
                            }
                        }
                    }
                    folders.insert(dir.clone(), files);
                }

                // Network adapters going up or down.
                if has("network_up") || has("network_down") {
                    let current: HashMap<String, (bool, bool)> =
                        crate::system::network::status().adapters.into_iter().map(|a| (a.name, (a.up, a.vpn_like))).collect();
                    if let Some(prev) = &adapters {
                        for (name, (up, vpn)) in &current {
                            let was = prev.get(name).map(|(u, _)| *u).unwrap_or(false);
                            if *up != was {
                                let value = if *vpn { format!("vpn|{name}") } else { name.clone() };
                                fire(&app, if *up { "network_up" } else { "network_down" }, &value);
                            }
                        }
                    }
                    adapters = Some(current);
                } else {
                    adapters = None;
                }

                // AC power / battery, and the active power plan.
                if has("power_source") || has("power_plan") {
                    let info = crate::system::power::info();
                    if has("power_source") {
                        if let Some(prev) = on_ac {
                            if prev != info.on_ac_power {
                                if let Some(ac) = info.on_ac_power {
                                    fire(&app, "power_source", if ac { "ac" } else { "battery" });
                                }
                            }
                        }
                        on_ac = Some(info.on_ac_power);
                    }
                    if has("power_plan") {
                        let active = info.plans.iter().find(|p| p.active).map(|p| p.guid.clone());
                        if let Some(prev) = &plan {
                            if prev != &active {
                                if let Some(g) = &active {
                                    fire(&app, "power_plan", g);
                                }
                            }
                        }
                        plan = Some(active);
                    }
                } else {
                    on_ac = None;
                    plan = None;
                }
            }
        })
        .expect("failed to start automation event watcher");
}

/// Runs one rule found by a watcher (its trigger already matched), on its own thread.
fn fire_rule(app: &AppHandle, rule: &Rule, _value: &str) {
    let (app, rule) = (app.clone(), rule.clone());
    std::thread::spawn(move || {
        let _ = run_rule(&app, &rule, 0, false);
    });
}
