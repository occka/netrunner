use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::AppResult;

/// Rows kept in the activity log; older entries are trimmed on insert.
const MAX_ENTRIES: i64 = 2000;

#[derive(Debug, Clone, Copy)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: i64,
    pub ts: String,
    pub level: String,
    pub source: String,
    pub message: String,
}

/// Records an activity event. Failures are logged rather than propagated so a
/// logging problem never breaks the action that triggered it.
pub fn record(conn: &Connection, level: Level, source: &str, message: &str) {
    let result = conn
        .execute(
            "INSERT INTO activity_log (level, source, message) VALUES (?1, ?2, ?3)",
            params![level.as_str(), source, message],
        )
        .and_then(|_| {
            conn.execute(
                "DELETE FROM activity_log WHERE id <= (SELECT MAX(id) FROM activity_log) - ?1",
                [MAX_ENTRIES],
            )
        });
    if let Err(err) = result {
        log::error!("failed to record activity: {err}");
    }
    log::info!("[{source}] {message}");
}

pub fn list(conn: &Connection, limit: u32) -> AppResult<Vec<ActivityEntry>> {
    let mut stmt =
        conn.prepare("SELECT id, ts, level, source, message FROM activity_log ORDER BY id DESC LIMIT ?1")?;
    let rows = stmt.query_map([limit.min(500)], |row| {
        Ok(ActivityEntry {
            id: row.get(0)?,
            ts: row.get(1)?,
            level: row.get(2)?,
            source: row.get(3)?,
            message: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn clear(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM activity_log", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;

    #[test]
    fn records_and_lists_newest_first() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        record(&conn, Level::Info, "test", "first");
        record(&conn, Level::Warn, "test", "second");
        let entries = list(&conn, 10).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message, "second");
        assert_eq!(entries[0].level, "warn");
    }
}
