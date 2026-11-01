//! Playtime: which library games are running (matched by process paths) and
//! the play sessions recorded for them. The tracker thread is in `crate::playtime`.

use std::collections::{BTreeMap, HashSet};

use chrono::{Duration, Local, NaiveDate, TimeZone};
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::AppResult;

/// What identifies a running game.
#[derive(Debug, Clone)]
pub enum Rule {
    /// Any process whose executable lies inside this folder (Steam, Epic, GOG).
    Folder(String),
    /// This exact executable (your own games).
    Exe(String),
    /// A process whose command line mentions this folder (Prism / Minecraft instances run in Java).
    CommandLine(String),
}

#[derive(Debug, Clone)]
pub struct Watched {
    pub id: String,
    pub name: String,
    pub rule: Rule,
}

/// A running process: lower-case executable path and command line.
pub struct Proc {
    pub exe: Option<String>,
    pub cmd: String,
}

fn norm_dir(dir: &str) -> String {
    let d = dir.trim().to_lowercase().replace('/', "\\");
    if d.ends_with('\\') { d } else { format!("{d}\\") }
}

/// Builds the rule for a library game; games without a usable location are not tracked.
pub fn watched(id: &str, name: &str, source: &str, dir: Option<&str>) -> Option<Watched> {
    let rule = match (source, dir) {
        ("prism", Some(d)) if !d.trim().is_empty() => Rule::CommandLine(norm_dir(d)),
        (_, Some(d)) if d.trim().len() > 3 => Rule::Folder(norm_dir(d)),
        _ => return None,
    };
    Some(Watched { id: id.into(), name: name.into(), rule })
}

/// A Quick Access game is tracked when its target is an .exe file.
pub fn watched_exe(id: &str, name: &str, target: &str) -> Option<Watched> {
    let t = target.trim().trim_matches('"').to_lowercase().replace('/', "\\");
    (t.ends_with(".exe") && t.contains(":\\")).then(|| Watched { id: id.into(), name: name.into(), rule: Rule::Exe(t) })
}

/// Ids of the watched games that have a matching process.
pub fn running(games: &[Watched], procs: &[Proc]) -> HashSet<String> {
    games
        .iter()
        .filter(|g| {
            procs.iter().any(|p| match &g.rule {
                Rule::Folder(dir) => p.exe.as_deref().is_some_and(|e| e.starts_with(dir.as_str())),
                Rule::Exe(exe) => p.exe.as_deref() == Some(exe.as_str()),
                // With the trailing separator, so instance "abc" does not match "abcd".
                Rule::CommandLine(dir) => p.cmd.contains(dir.as_str()),
            })
        })
        .map(|g| g.id.clone())
        .collect()
}

pub fn start_session(conn: &Connection, game_id: &str, name: &str, now: i64) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO game_sessions (game_id, name, started_at, ended_at) VALUES (?1, ?2, ?3, ?3)",
        params![game_id, name, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn touch_session(conn: &Connection, id: i64, now: i64) -> AppResult<()> {
    conn.execute("UPDATE game_sessions SET ended_at = MAX(ended_at, ?1) WHERE id = ?2", params![now, id])?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playtime {
    pub game_id: String,
    pub name: String,
    /// Seconds played since `from` (all time when `from` is None).
    pub seconds: i64,
    pub sessions: i64,
    /// Unix ms of the last moment played, any time.
    pub last_played: i64,
}

/// Playtime per game since `from` (unix ms; None = all time). Sessions that
/// started before `from` count only their part after it.
pub fn totals(conn: &Connection, from: Option<i64>) -> AppResult<Vec<Playtime>> {
    let from = from.unwrap_or(0);
    let mut stmt = conn.prepare(
        "SELECT game_id, MAX(name),
                SUM(CASE WHEN ended_at > ?1 THEN ended_at - MAX(started_at, ?1) ELSE 0 END) / 1000,
                SUM(CASE WHEN ended_at > ?1 THEN 1 ELSE 0 END),
                MAX(ended_at)
         FROM game_sessions GROUP BY game_id",
    )?;
    let rows = stmt.query_map([from], |r| {
        Ok(Playtime { game_id: r.get(0)?, name: r.get(1)?, seconds: r.get(2)?, sessions: r.get(3)?, last_played: r.get(4)? })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    /// Local date, YYYY-MM-DD.
    pub date: String,
    pub seconds: i64,
}

fn local_midnight_ms(d: NaiveDate) -> i64 {
    Local
        .from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap_or_default())
        .earliest()
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}

/// Seconds per local day over the last `days` days ending `today`; sessions are split at midnight.
pub fn split_days(sessions: &[(i64, i64)], today: NaiveDate, days: i64) -> Vec<Day> {
    let first = today - Duration::days(days - 1);
    let mut out: BTreeMap<NaiveDate, i64> = (0..days).map(|i| (first + Duration::days(i), 0)).collect();
    for &(start, end) in sessions {
        for (&day, total) in out.iter_mut() {
            let (a, b) = (local_midnight_ms(day), local_midnight_ms(day + Duration::days(1)));
            let overlap = end.min(b) - start.max(a);
            if overlap > 0 {
                *total += overlap / 1000;
            }
        }
    }
    out.into_iter().map(|(d, s)| Day { date: d.format("%Y-%m-%d").to_string(), seconds: s }).collect()
}

/// Daily playtime of one game for the last `days` days.
pub fn history(conn: &Connection, game_id: &str, days: i64) -> AppResult<Vec<Day>> {
    let days = days.clamp(1, 366);
    let today = Local::now().date_naive();
    let since = local_midnight_ms(today - Duration::days(days - 1));
    let mut stmt = conn.prepare("SELECT started_at, ended_at FROM game_sessions WHERE game_id = ?1 AND ended_at > ?2")?;
    let sessions = stmt.query_map(params![game_id, since], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
    Ok(split_days(&sessions, today, days))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;

    #[test]
    fn matches_processes_to_games() {
        let games = vec![
            watched("steam:1", "Valheim", "steam", Some(r"D:\SteamLibrary\steamapps\common\Valheim")).unwrap(),
            watched("prism:abc", "Minecraft", "prism", Some(r"C:\Users\me\AppData\Roaming\PrismLauncher\instances\abc")).unwrap(),
            watched_exe("qa:3", "Own", r#""C:\Games\Own\own.exe""#).unwrap(),
        ];
        assert!(watched("epic:x", "No dir", "epic", None).is_none());
        assert!(watched_exe("qa:4", "Uri", "steam://rungameid/1").is_none());
        let p = |exe: &str, cmd: &str| Proc { exe: Some(exe.to_lowercase()), cmd: cmd.to_lowercase() };
        let procs = vec![
            p(r"D:\SteamLibrary\steamapps\common\Valheim\valheim.exe", ""),
            p(r"C:\Program Files\Java\bin\javaw.exe", r"javaw --gameDir C:\Users\me\AppData\Roaming\PrismLauncher\instances\abc\minecraft"),
        ];
        let ids = running(&games, &procs);
        assert!(ids.contains("steam:1") && ids.contains("prism:abc") && !ids.contains("qa:3"));
        // A sibling folder with a longer name is not the same game.
        let other = vec![p(r"D:\SteamLibrary\steamapps\common\Valheim Dedicated Server\server.exe", "")];
        assert!(running(&games, &other).is_empty());
        assert!(running(&games, &[p(r"C:\Games\Own\own.exe", "")]).contains("qa:3"));
    }

    #[test]
    fn totals_count_only_the_period() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        let s = start_session(&conn, "steam:1", "Valheim", 1_000_000).unwrap();
        touch_session(&conn, s, 1_000_000 + 3_600_000).unwrap();
        touch_session(&conn, s, 1_000_000).unwrap(); // never moves back
        start_session(&conn, "steam:2", "Other", 5_000_000).unwrap();
        let all = totals(&conn, None).unwrap();
        let v = all.iter().find(|p| p.game_id == "steam:1").unwrap();
        assert_eq!((v.seconds, v.sessions, v.last_played), (3600, 1, 4_600_000));
        // From the middle of the session: only the second half counts.
        let half = totals(&conn, Some(1_000_000 + 1_800_000)).unwrap();
        assert_eq!(half.iter().find(|p| p.game_id == "steam:1").unwrap().seconds, 1800);
        let later = totals(&conn, Some(10_000_000)).unwrap();
        assert!(later.iter().all(|p| p.seconds == 0 && p.sessions == 0));
    }

    #[test]
    fn days_split_at_local_midnight() {
        let today = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap();
        let midnight = local_midnight_ms(today);
        // 23:30 yesterday → 00:45 today.
        let days = split_days(&[(midnight - 30 * 60_000, midnight + 45 * 60_000)], today, 3);
        assert_eq!(days.len(), 3);
        assert_eq!(days[1], Day { date: "2026-11-01".into(), seconds: 1800 });
        assert_eq!(days[2], Day { date: "2026-11-02".into(), seconds: 2700 });
        assert_eq!(days[0].seconds, 0);
    }
}
