use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::alarm::{self, Ringing};
use crate::error::AppResult;
use crate::services::alarms::{self, Alarm, AlarmInput, Timer, TimerInput};
use crate::services::activity::{self, Level};
use crate::services::sounds::{self, Sound};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmsState {
    pub alarms: Vec<Alarm>,
    pub timers: Vec<Timer>,
    pub ringing: Vec<Ringing>,
    /// Backend clock, so countdowns do not depend on the page's timer accuracy.
    pub now: i64,
}

fn changed(app: &AppHandle) {
    let _ = app.emit("alarms://changed", ());
}

#[tauri::command]
pub async fn alarms_state(state: State<'_, AppState>) -> AppResult<AlarmsState> {
    let conn = state.db.conn()?;
    Ok(AlarmsState {
        alarms: alarms::list_alarms(&conn)?,
        timers: alarms::list_timers(&conn)?,
        ringing: alarm::ringing(),
        now: alarms::now_ms(),
    })
}

#[tauri::command]
pub async fn alarm_save(app: AppHandle, state: State<'_, AppState>, id: Option<i64>, input: AlarmInput) -> AppResult<Alarm> {
    let a = {
        let conn = state.db.conn()?;
        let a = alarms::save_alarm(&conn, id, &input)?;
        activity::record(&conn, Level::Info, "alarms", &format!("Alarm set for {}", a.time));
        a
    };
    changed(&app);
    Ok(a)
}

#[tauri::command]
pub async fn alarm_set_enabled(app: AppHandle, state: State<'_, AppState>, id: i64, enabled: bool) -> AppResult<Alarm> {
    let a = alarms::set_alarm_enabled(&*state.db.conn()?, id, enabled)?;
    changed(&app);
    Ok(a)
}

#[tauri::command]
pub async fn alarm_delete(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<()> {
    alarms::delete_alarm(&*state.db.conn()?, id)?;
    alarm::stop(&app, &format!("alarm-{id}"));
    Ok(())
}

#[tauri::command]
pub async fn timer_create(app: AppHandle, state: State<'_, AppState>, input: TimerInput, start: bool) -> AppResult<Timer> {
    let t = alarms::create_timer(&*state.db.conn()?, &input, start.then(alarms::now_ms))?;
    changed(&app);
    Ok(t)
}

/// `action`: start (or resume), pause, reset.
#[tauri::command]
pub async fn timer_control(app: AppHandle, state: State<'_, AppState>, id: i64, action: String) -> AppResult<Timer> {
    let t = {
        let conn = state.db.conn()?;
        match action.as_str() {
            "start" => alarms::start_timer(&conn, id, alarms::now_ms())?,
            "pause" => alarms::pause_timer(&conn, id, alarms::now_ms())?,
            "reset" => alarms::reset_timer(&conn, id)?,
            _ => return Err(crate::error::AppError::Invalid("unknown timer action".into())),
        }
    };
    alarm::stop(&app, &format!("timer-{id}"));
    Ok(t)
}

#[tauri::command]
pub async fn timer_delete(app: AppHandle, state: State<'_, AppState>, id: i64) -> AppResult<()> {
    alarms::delete_timer(&*state.db.conn()?, id)?;
    alarm::stop(&app, &format!("timer-{id}"));
    Ok(())
}

#[tauri::command]
pub async fn alarm_stop(app: AppHandle, key: String) {
    alarm::stop(&app, &key);
}

#[tauri::command]
pub async fn alarm_snooze(app: AppHandle, key: String) -> AppResult<()> {
    alarm::snooze(&app, &key)
}

#[tauri::command]
pub async fn sounds_list(state: State<'_, AppState>) -> AppResult<Vec<Sound>> {
    sounds::list(&state.data_dir)
}

/// `path` comes from the native file picker; the file is copied, never referenced.
#[tauri::command]
pub async fn sound_import(state: State<'_, AppState>, path: String) -> AppResult<Sound> {
    sounds::import(&state.data_dir, std::path::Path::new(&path))
}

#[tauri::command]
pub async fn sound_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    sounds::delete(&state.data_dir, &id)
}

/// Plays a sound for a few seconds (settings preview).
#[tauri::command]
pub async fn sound_preview(sound: String, volume: u8) -> AppResult<()> {
    alarms::check_sound(&sound)?;
    alarm::play("preview", &sound, volume, Some(Duration::from_secs(4)));
    Ok(())
}

#[tauri::command]
pub async fn sound_preview_stop() {
    alarm::stop_sound("preview");
}
