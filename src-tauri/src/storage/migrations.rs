//! Forward-only schema migrations tracked with `PRAGMA user_version`.
//!
//! To change the schema, add `migrations/NNNN_description.sql` and append it to
//! `MIGRATIONS`. Never edit a migration that has shipped.

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../../migrations/0001_init.sql")),
    (2, include_str!("../../migrations/0002_overlays_automation.sql")),
    (3, include_str!("../../migrations/0003_automation_launch_program.sql")),
    (4, include_str!("../../migrations/0004_neural_history.sql")),
    (5, include_str!("../../migrations/0005_browser_widget_settings.sql")),
    (6, include_str!("../../migrations/0006_overlay_profiles.sql")),
    (7, include_str!("../../migrations/0007_overlay_click_through.sql")),
    (8, include_str!("../../migrations/0008_notes.sql")),
    (9, include_str!("../../migrations/0009_alarms.sql")),
    (10, include_str!("../../migrations/0010_widget_studio.sql")),
    (11, include_str!("../../migrations/0011_game_playtime.sql")),
];

pub const LATEST_VERSION: i64 = MIGRATIONS[MIGRATIONS.len() - 1].0;

pub fn current_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

pub fn apply(conn: &mut Connection) -> AppResult<()> {
    let current = current_version(conn)?;
    if current > LATEST_VERSION {
        return Err(AppError::Internal(format!(
            "database schema v{current} is newer than this build supports (v{LATEST_VERSION}); refusing to modify it"
        )));
    }
    for (version, sql) in MIGRATIONS.iter().filter(|(v, _)| *v > current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
        log::info!("applied database migration v{version}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_fresh_database_to_latest() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn).unwrap();
        assert_eq!(current_version(&conn).unwrap(), LATEST_VERSION);
        // Re-applying is a no-op.
        apply(&mut conn).unwrap();
        assert_eq!(current_version(&conn).unwrap(), LATEST_VERSION);
    }

    #[test]
    fn refuses_newer_schema() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", LATEST_VERSION + 1).unwrap();
        assert!(apply(&mut conn).is_err());
    }
}
