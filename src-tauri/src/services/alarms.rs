//! Alarms and countdown timers: storage and the schedule rules. Ringing,
//! sound and the scheduler thread are in `crate::alarm`.

use chrono::{Datelike, Duration, Local, NaiveDateTime, NaiveTime, TimeZone};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const BUILTIN_SOUNDS: &[(&str, &str)] = &[
    ("pulse", "Pulse (classic beeps)"),
    ("digital", "Digital (fast triple beep)"),
    ("chime", "Chime (two tones)"),
    ("soft", "Soft rise"),
    ("siren", "Siren sweep"),
];
const MAX_ALARMS: i64 = 64;
const MAX_TIMERS: i64 = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alarm {
    pub id: i64,
    pub label: String,
    pub time: String,
    pub days: u8,
    pub sound: String,
    pub volume: u8,
    pub snooze_minutes: u32,
    pub enabled: bool,
    pub snoozed_until: Option<i64>,
    /// Unix ms of the next ring (snooze first), for display. `None` when off.
    pub next_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmInput {
    pub label: String,
    pub time: String,
    pub days: u8,
    pub sound: String,
    pub volume: u8,
    pub snooze_minutes: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub id: i64,
    pub label: String,
    pub duration_ms: i64,
    pub ends_at: Option<i64>,
    pub remaining_ms: Option<i64>,
    pub sound: String,
    pub volume: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerInput {
    pub label: String,
    pub duration_ms: i64,
    pub sound: String,
    pub volume: u8,
}

pub fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn local_ms(t: NaiveDateTime) -> Option<i64> {
    Local.from_local_datetime(&t).earliest().map(|d| d.timestamp_millis())
}

pub fn parse_time(s: &str) -> AppResult<NaiveTime> {
    NaiveTime::parse_from_str(s.trim(), "%H:%M").map_err(|_| AppError::Invalid("time must be HH:MM".into()))
}

/// A built-in sound name or an imported sound file name.
pub fn check_sound(sound: &str) -> AppResult<()> {
    let file = sound.starts_with("snd-")
        && sound.len() <= 80
        && sound.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !sound.contains("..");
    if BUILTIN_SOUNDS.iter().any(|(id, _)| *id == sound) || file {
        Ok(())
    } else {
        Err(AppError::Invalid("unknown sound".into()))
    }
}

fn label(s: &str) -> String {
    s.trim().chars().take(60).collect()
}

/// Whether the alarm repeats on this weekday (0 = Monday).
fn on_day(days: u8, weekday_from_monday: u32) -> bool {
    days == 0 || days & (1 << weekday_from_monday) != 0
}

/// Next time the alarm rings strictly after `now` (local), ignoring snooze.
pub fn next_occurrence(time: NaiveTime, days: u8, now: NaiveDateTime) -> Option<NaiveDateTime> {
    (0..=7)
        .map(|d| (now.date() + Duration::days(d)).and_time(time))
        .find(|t| *t > now && on_day(days, t.weekday().num_days_from_monday()))
}

/// Alarms that ring in the window (from, to]: local times for the schedule,
/// unix ms for snoozes. Returns (alarm id, rang because of snooze).
pub fn due(alarms: &[Alarm], from: NaiveDateTime, to: NaiveDateTime, from_ms: i64, to_ms: i64) -> Vec<(i64, bool)> {
    let mut out = Vec::new();
    for a in alarms.iter().filter(|a| a.enabled) {
        if a.snoozed_until.is_some_and(|t| t > from_ms && t <= to_ms) {
            out.push((a.id, true));
            continue;
        }
        let Ok(time) = parse_time(&a.time) else { continue };
        let mut day = from.date();
        while day <= to.date() {
            let t = day.and_time(time);
            if t > from && t <= to && on_day(a.days, t.weekday().num_days_from_monday()) {
                out.push((a.id, false));
                break;
            }
            day += Duration::days(1);
        }
    }
    out
}

const ALARM_SELECT: &str =
    "SELECT id, label, time, days, sound, volume, snooze_minutes, enabled, snoozed_until FROM alarms";

fn alarm_row(r: &Row) -> rusqlite::Result<Alarm> {
    Ok(Alarm {
        id: r.get(0)?,
        label: r.get(1)?,
        time: r.get(2)?,
        days: r.get(3)?,
        sound: r.get(4)?,
        volume: r.get(5)?,
        snooze_minutes: r.get(6)?,
        enabled: r.get(7)?,
        snoozed_until: r.get(8)?,
        next_at: None,
    })
}

fn with_next(mut a: Alarm) -> Alarm {
    a.next_at = if !a.enabled {
        None
    } else {
        let scheduled = parse_time(&a.time).ok().and_then(|t| next_occurrence(t, a.days, Local::now().naive_local())).and_then(local_ms);
        match (a.snoozed_until, scheduled) {
            (Some(s), Some(n)) => Some(s.min(n)),
            (s, n) => s.or(n),
        }
    };
    a
}

pub fn list_alarms(conn: &Connection) -> AppResult<Vec<Alarm>> {
    let mut stmt = conn.prepare(&format!("{ALARM_SELECT} ORDER BY time, id"))?;
    let rows = stmt.query_map([], alarm_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?.into_iter().map(with_next).collect())
}

pub fn get_alarm(conn: &Connection, id: i64) -> AppResult<Alarm> {
    conn.query_row(&format!("{ALARM_SELECT} WHERE id = ?1"), [id], alarm_row)
        .optional()?
        .map(with_next)
        .ok_or_else(|| AppError::NotFound("this alarm no longer exists".into()))
}

/// Creates (`id` = None) or replaces an alarm. Saving switches it on.
pub fn save_alarm(conn: &Connection, id: Option<i64>, i: &AlarmInput) -> AppResult<Alarm> {
    let time = parse_time(&i.time)?.format("%H:%M").to_string();
    check_sound(&i.sound)?;
    if i.days > 127 || i.volume > 100 || !(1..=60).contains(&i.snooze_minutes) {
        return Err(AppError::Invalid("invalid alarm settings".into()));
    }
    let label = label(&i.label);
    let id = match id {
        Some(id) => {
            get_alarm(conn, id)?;
            conn.execute(
                "UPDATE alarms SET label = ?1, time = ?2, days = ?3, sound = ?4, volume = ?5, snooze_minutes = ?6,
                 enabled = 1, snoozed_until = NULL WHERE id = ?7",
                params![label, time, i.days, i.sound, i.volume, i.snooze_minutes, id],
            )?;
            id
        }
        None => {
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM alarms", [], |r| r.get(0))?;
            if count >= MAX_ALARMS {
                return Err(AppError::Invalid(format!("at most {MAX_ALARMS} alarms are supported")));
            }
            conn.execute(
                "INSERT INTO alarms (label, time, days, sound, volume, snooze_minutes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![label, time, i.days, i.sound, i.volume, i.snooze_minutes],
            )?;
            conn.last_insert_rowid()
        }
    };
    get_alarm(conn, id)
}

pub fn set_alarm_enabled(conn: &Connection, id: i64, enabled: bool) -> AppResult<Alarm> {
    conn.execute("UPDATE alarms SET enabled = ?1, snoozed_until = NULL WHERE id = ?2", params![enabled, id])?;
    get_alarm(conn, id)
}

pub fn delete_alarm(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM alarms WHERE id = ?1", [id])?;
    Ok(())
}

/// After an alarm rang: a one-time alarm switches off, any snooze is cleared.
pub fn mark_rang(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE alarms SET snoozed_until = NULL, enabled = CASE WHEN days = 0 THEN 0 ELSE enabled END WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// Rings again `snooze_minutes` from `now_ms` (and keeps a one-time alarm on until then).
pub fn snooze(conn: &Connection, id: i64, now_ms: i64) -> AppResult<Alarm> {
    let a = get_alarm(conn, id)?;
    conn.execute(
        "UPDATE alarms SET enabled = 1, snoozed_until = ?1 WHERE id = ?2",
        params![now_ms + i64::from(a.snooze_minutes) * 60_000, id],
    )?;
    get_alarm(conn, id)
}

const TIMER_SELECT: &str = "SELECT id, label, duration_ms, ends_at, remaining_ms, sound, volume FROM timers";

fn timer_row(r: &Row) -> rusqlite::Result<Timer> {
    Ok(Timer {
        id: r.get(0)?,
        label: r.get(1)?,
        duration_ms: r.get(2)?,
        ends_at: r.get(3)?,
        remaining_ms: r.get(4)?,
        sound: r.get(5)?,
        volume: r.get(6)?,
    })
}

pub fn list_timers(conn: &Connection) -> AppResult<Vec<Timer>> {
    let mut stmt = conn.prepare(&format!("{TIMER_SELECT} ORDER BY id"))?;
    let rows = stmt.query_map([], timer_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_timer(conn: &Connection, id: i64) -> AppResult<Timer> {
    conn.query_row(&format!("{TIMER_SELECT} WHERE id = ?1"), [id], timer_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound("this timer no longer exists".into()))
}

pub fn create_timer(conn: &Connection, i: &TimerInput, start_at: Option<i64>) -> AppResult<Timer> {
    check_sound(&i.sound)?;
    // Up to 99 h, at least one second.
    if !(1000..=99 * 3_600_000).contains(&i.duration_ms) || i.volume > 100 {
        return Err(AppError::Invalid("a timer runs from 1 second to 99 hours".into()));
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM timers", [], |r| r.get(0))?;
    if count >= MAX_TIMERS {
        return Err(AppError::Invalid(format!("at most {MAX_TIMERS} timers are supported")));
    }
    conn.execute(
        "INSERT INTO timers (label, duration_ms, ends_at, sound, volume) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![label(&i.label), i.duration_ms, start_at.map(|t| t + i.duration_ms), i.sound, i.volume],
    )?;
    get_timer(conn, conn.last_insert_rowid())
}

/// Starts or resumes a timer at `now_ms`.
pub fn start_timer(conn: &Connection, id: i64, now_ms: i64) -> AppResult<Timer> {
    let t = get_timer(conn, id)?;
    if t.ends_at.is_none() {
        let left = t.remaining_ms.unwrap_or(t.duration_ms);
        conn.execute("UPDATE timers SET ends_at = ?1, remaining_ms = NULL WHERE id = ?2", params![now_ms + left, id])?;
    }
    get_timer(conn, id)
}

pub fn pause_timer(conn: &Connection, id: i64, now_ms: i64) -> AppResult<Timer> {
    let t = get_timer(conn, id)?;
    if let Some(end) = t.ends_at {
        conn.execute("UPDATE timers SET ends_at = NULL, remaining_ms = ?1 WHERE id = ?2", params![(end - now_ms).max(0), id])?;
    }
    get_timer(conn, id)
}

/// Stops a timer and puts it back to its full duration.
pub fn reset_timer(conn: &Connection, id: i64) -> AppResult<Timer> {
    conn.execute("UPDATE timers SET ends_at = NULL, remaining_ms = NULL WHERE id = ?1", [id])?;
    get_timer(conn, id)
}

/// Runs a timer again for `ms` (the "+1 min" button while it rings).
pub fn extend_timer(conn: &Connection, id: i64, now_ms: i64, ms: i64) -> AppResult<Timer> {
    conn.execute("UPDATE timers SET ends_at = ?1, remaining_ms = NULL WHERE id = ?2", params![now_ms + ms, id])?;
    get_timer(conn, id)
}

pub fn delete_timer(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM timers WHERE id = ?1", [id])?;
    Ok(())
}

/// Running timers that have ended by `now_ms`; they are reset, ready to start again.
pub fn take_finished_timers(conn: &Connection, now_ms: i64) -> AppResult<Vec<Timer>> {
    let done: Vec<Timer> = list_timers(conn)?.into_iter().filter(|t| t.ends_at.is_some_and(|e| e <= now_ms)).collect();
    for t in &done {
        reset_timer(conn, t.id)?;
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;
    use chrono::NaiveDate;

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, min, 0).unwrap()
    }

    fn alarm(id: i64, time: &str, days: u8) -> Alarm {
        Alarm {
            id,
            label: String::new(),
            time: time.into(),
            days,
            sound: "pulse".into(),
            volume: 80,
            snooze_minutes: 5,
            enabled: true,
            snoozed_until: None,
            next_at: None,
        }
    }

    #[test]
    fn schedule_window_and_repeat_days() {
        // 2026-11-02 is a Monday.
        let mon_7 = alarm(1, "07:00", 0b0000001);
        let weekend_9 = alarm(2, "09:00", 0b1100000);
        let once_7 = alarm(3, "07:00", 0);
        let list = [mon_7, weekend_9, once_7];
        let ids = |from, to| due(&list, from, to, 0, 0).into_iter().map(|(id, _)| id).collect::<Vec<_>>();
        assert_eq!(ids(at(2026, 11, 2, 6, 59), at(2026, 11, 2, 7, 0)), [1, 3]);
        // Already past 07:00 at the start of the window: not again.
        assert!(ids(at(2026, 11, 2, 7, 0), at(2026, 11, 2, 7, 1)).is_empty());
        // Tuesday 07:00: only the one-time alarm.
        assert_eq!(ids(at(2026, 11, 3, 6, 59), at(2026, 11, 3, 7, 0)), [3]);
        // Window across midnight into Sunday 09:00 also catches the one-time 07:00.
        assert_eq!(ids(at(2026, 11, 7, 23, 0), at(2026, 11, 8, 9, 0)), [2, 3]);
        assert_eq!(ids(at(2026, 11, 8, 8, 0), at(2026, 11, 8, 9, 0)), [2]);
    }

    #[test]
    fn snooze_rings_by_timestamp() {
        let mut a = alarm(1, "07:00", 0);
        a.snoozed_until = Some(10_000);
        let w = (at(2026, 11, 2, 12, 0), at(2026, 11, 2, 12, 1));
        assert_eq!(due(&[a.clone()], w.0, w.1, 9_000, 10_000), [(1, true)]);
        assert!(due(&[a.clone()], w.0, w.1, 10_000, 11_000).is_empty());
        a.enabled = false;
        assert!(due(&[a], w.0, w.1, 9_000, 10_000).is_empty());
    }

    #[test]
    fn next_occurrence_skips_to_repeat_day() {
        let t = NaiveTime::from_hms_opt(7, 0, 0).unwrap();
        // Monday 08:00, weekdays only → Tuesday 07:00.
        assert_eq!(next_occurrence(t, 0b0011111, at(2026, 11, 2, 8, 0)), Some(at(2026, 11, 3, 7, 0)));
        // Friday 08:00, weekdays only → Monday.
        assert_eq!(next_occurrence(t, 0b0011111, at(2026, 11, 6, 8, 0)), Some(at(2026, 11, 9, 7, 0)));
        assert_eq!(next_occurrence(t, 0, at(2026, 11, 2, 6, 0)), Some(at(2026, 11, 2, 7, 0)));
    }

    #[test]
    fn alarm_and_timer_storage() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        let input = AlarmInput { label: " Wake ".into(), time: "7:05".into(), days: 0, sound: "pulse".into(), volume: 70, snooze_minutes: 9 };
        let a = save_alarm(&conn, None, &input).unwrap();
        assert_eq!((a.label.as_str(), a.time.as_str(), a.enabled), ("Wake", "07:05", true));
        assert!(a.next_at.is_some());
        let bad = AlarmInput { time: "25:00".into(), ..input };
        assert!(save_alarm(&conn, None, &bad).is_err());
        let bad = AlarmInput { time: "07:00".into(), sound: "../x".into(), ..bad };
        assert!(save_alarm(&conn, None, &bad).is_err());

        let s = snooze(&conn, a.id, 1_000).unwrap();
        assert_eq!(s.snoozed_until, Some(1_000 + 9 * 60_000));
        mark_rang(&conn, a.id).unwrap();
        let a = get_alarm(&conn, a.id).unwrap();
        assert!(!a.enabled && a.snoozed_until.is_none(), "one-time alarm switches off after ringing");

        let t = create_timer(&conn, &TimerInput { label: "Tea".into(), duration_ms: 180_000, sound: "chime".into(), volume: 80 }, Some(0)).unwrap();
        assert_eq!(t.ends_at, Some(180_000));
        let t = pause_timer(&conn, t.id, 60_000).unwrap();
        assert_eq!((t.ends_at, t.remaining_ms), (None, Some(120_000)));
        let t = start_timer(&conn, t.id, 100_000).unwrap();
        assert_eq!(t.ends_at, Some(220_000));
        assert!(take_finished_timers(&conn, 219_999).unwrap().is_empty());
        let done = take_finished_timers(&conn, 220_000).unwrap();
        assert_eq!(done.len(), 1);
        let t = get_timer(&conn, t.id).unwrap();
        assert_eq!((t.ends_at, t.remaining_ms), (None, None), "finished timers reset");
        assert!(create_timer(&conn, &TimerInput { label: String::new(), duration_ms: 10, sound: "chime".into(), volume: 80 }, None).is_err());
    }
}
