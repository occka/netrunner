//! GAMES, INTEGRATIONS and AUTOMATION commands.

use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::services::activity::{self, Level};
use crate::services::automation::{self, Rule, RuleInput};
use crate::services::games::{self, LibraryScan};
use crate::services::integrations::{self, Integration};
use crate::services::launcher;
use crate::state::AppState;
use crate::system::network;

#[tauri::command]
pub async fn games_scan() -> AppResult<LibraryScan> {
    Ok(games::scan())
}

/// Launches a game by library id; the target is resolved from launcher data,
/// never taken from the frontend.
#[tauri::command]
pub async fn games_launch(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let game = games::find(&id).ok_or_else(|| AppError::NotFound("game not found in any library".into()))?;
    launcher::shell_open(&game.launch_target, &games::launch_params(&game), game.launch_dir.as_deref())?;
    activity::record(&*state.db.conn()?, Level::Info, "games", &format!("Launched {} ({})", game.name, game.source));
    Ok(())
}

#[tauri::command]
pub async fn games_reveal(id: String) -> AppResult<()> {
    let game = games::find(&id).ok_or_else(|| AppError::NotFound("game not found".into()))?;
    let dir = game.install_dir.ok_or_else(|| AppError::Invalid("install location unknown".into()))?;
    launcher::shell_open(&dir, "", None)
}

#[tauri::command]
pub async fn integrations_list(state: State<'_, AppState>) -> AppResult<Vec<Integration>> {
    let running = state.with_monitor(|m| m.running_names())?;
    Ok(integrations::list(&running, &network::status().adapters))
}

#[tauri::command]
pub async fn integration_launch(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let (exe, args) = integrations::launch_target(&id).ok_or_else(|| AppError::NotFound("application not installed".into()))?;
    launcher::shell_open(&exe.to_string_lossy(), args, exe.parent())?;
    activity::record(&*state.db.conn()?, Level::Info, "integrations", &format!("Launched {id}"));
    Ok(())
}

#[tauri::command]
pub async fn automation_list(state: State<'_, AppState>) -> AppResult<Vec<Rule>> {
    automation::list(&*state.db.conn()?)
}

#[tauri::command]
pub async fn automation_create(state: State<'_, AppState>, input: RuleInput) -> AppResult<Rule> {
    let rule = automation::create(&*state.db.conn()?, input)?;
    activity::record(&*state.db.conn()?, Level::Info, "automation", &format!("Created rule '{}'", rule.name));
    Ok(rule)
}

#[tauri::command]
pub async fn automation_update(state: State<'_, AppState>, id: i64, input: RuleInput) -> AppResult<Rule> {
    automation::update(&*state.db.conn()?, id, input)
}

#[tauri::command]
pub async fn automation_delete(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    automation::delete(&*state.db.conn()?, id)
}

/// Runs a rule now and reports the outcome to the UI.
#[tauri::command]
pub async fn automation_run(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<String> {
    let rule = automation::get(&*state.db.conn()?, id)?;
    let outcome = tauri::async_runtime::spawn_blocking(move || crate::automation::run_rule(&app, &rule, 0, true))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    Ok(outcome.unwrap_or_else(|| "skipped".into()))
}

/// Checks a rule without running it: conditions now, and what each action would do.
#[tauri::command]
pub async fn automation_dry_run(app: AppHandle, input: RuleInput) -> AppResult<crate::automation::DryRun> {
    tauri::async_runtime::spawn_blocking(move || crate::automation::dry_run(&app, input))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Playtime per game since `from` (unix ms; None = all time).
#[tauri::command]
pub async fn games_playtime(state: State<'_, AppState>, from: Option<i64>) -> AppResult<Vec<crate::services::playtime::Playtime>> {
    crate::services::playtime::totals(&*state.db.conn()?, from)
}

/// Daily playtime of one game for the last `days` days.
#[tauri::command]
pub async fn games_history(state: State<'_, AppState>, id: String, days: i64) -> AppResult<Vec<crate::services::playtime::Day>> {
    crate::services::playtime::history(&*state.db.conn()?, &id, days)
}

/// Library games running right now (from the playtime tracker).
#[tauri::command]
pub async fn games_running() -> Vec<String> {
    crate::playtime::running()
}

/// Banner image for a library game (Steam artwork, local cache first) as a data URL.
#[tauri::command]
pub async fn games_banner(state: State<'_, AppState>, id: String) -> AppResult<String> {
    crate::services::artwork::banner(&state.data_dir, &id).await
}

/// Forgets the recorded playtime of one game.
#[tauri::command]
pub async fn games_clear_playtime(state: State<'_, AppState>, id: String) -> AppResult<usize> {
    crate::services::playtime::clear(&*state.db.conn()?, &id)
}
