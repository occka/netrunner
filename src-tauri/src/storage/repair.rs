//! Startup health check. A database file replaced while an old `-wal` file
//! stayed next to it mixes pages from two versions: rows and indexes stop
//! agreeing, and a write by key then lands in another key's row. SQLite can
//! run like that for a long time, so it is checked before anything uses it.

use std::path::Path;

use rusqlite::Connection;

use crate::error::AppResult;

/// Problems SQLite reports; empty when the database is healthy.
pub fn problems(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("PRAGMA integrity_check(20)")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let list: Vec<String> = rows.collect::<Result<_, _>>()?;
    Ok(list.into_iter().filter(|p| p != "ok").collect())
}

/// Rebuilds `settings` from a table scan (its index cannot be trusted). When a
/// key has several rows, because a damaged index let an insert through, the
/// newest one wins. Values are kept as stored: readers ignore those of the wrong type.
fn rebuild_settings(conn: &Connection) -> AppResult<usize> {
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE settings_repaired (
             key        TEXT PRIMARY KEY NOT NULL,
             value      TEXT NOT NULL,
             updated_at TEXT NOT NULL DEFAULT (datetime('now'))
         );
         INSERT INTO settings_repaired (key, value, updated_at)
             SELECT key, value, updated_at FROM settings NOT INDEXED WHERE true ORDER BY updated_at, rowid
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
         DROP TABLE settings;
         ALTER TABLE settings_repaired RENAME TO settings;
         COMMIT;",
    )
    .inspect_err(|_| {
        let _ = conn.execute_batch("ROLLBACK;");
    })?;
    Ok(conn.query_row("SELECT COUNT(*) FROM settings", [], |r| r.get::<_, i64>(0))? as usize)
}

/// Keeps the damaged file, then repairs: `settings` from a scan, indexes and
/// table order through REINDEX and VACUUM. Returns a report for the activity log.
pub fn repair(conn: &Connection, db_path: &Path, backup_dir: &Path, found: &[String]) -> AppResult<String> {
    std::fs::create_dir_all(backup_dir)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
    let keep = backup_dir.join(format!("netrunner-damaged-{stamp}.db"));
    // A plain copy: VACUUM INTO could refuse a damaged file. The checkpoint brings the journal's pages in first.
    let _ = conn.query_row("PRAGMA wal_checkpoint(FULL)", [], |_| Ok(()));
    std::fs::copy(db_path, &keep)?;
    log::error!("database damaged, kept a copy at {}: {found:?}", keep.display());

    if found.iter().any(|p| p.contains("settings")) {
        let n = rebuild_settings(conn)?;
        log::info!("settings rebuilt: {n} keys");
    }
    if let Err(e) = conn.execute_batch("REINDEX;") {
        log::warn!("reindex failed: {e}");
    }
    if let Err(e) = conn.execute_batch("VACUUM;") {
        log::warn!("vacuum failed: {e}");
    }
    let left = problems(conn)?;
    Ok(if left.is_empty() {
        format!("The database was damaged and has been repaired. Some settings may need setting again. A copy of the damaged file: {}", keep.display())
    } else {
        log::error!("database still damaged after repair: {left:?}");
        format!("The database is damaged and could not be fully repaired. A copy of the damaged file: {}", keep.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::settings;
    use crate::storage::Database;
    use rusqlite::params;
    use serde_json::json;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nr-repair-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn index_page(path: &Path) -> (usize, usize) {
        let c = Connection::open(path).unwrap();
        let root: i64 = c.query_row("SELECT rootpage FROM sqlite_master WHERE name = 'sqlite_autoindex_settings_1'", [], |r| r.get(0)).unwrap();
        let size: i64 = c.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        (root as usize, size as usize)
    }

    /// What the mixed files produced: an index page older than the table, then
    /// writes through it, so values land under other keys and keys get a second row.
    fn damaged_database(dir: &Path) -> PathBuf {
        let path = dir.join("netrunner.db");
        let backups = dir.join("backups");
        {
            let db = Database::open(&path, &backups).unwrap();
            let conn = db.conn().unwrap();
            settings::set(&conn, "appearance.radius", &json!(4)).unwrap();
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        }
        let (root, size) = index_page(&path);
        let old_index = std::fs::read(&path).unwrap()[(root - 1) * size..root * size].to_vec();
        {
            let c = Connection::open(&path).unwrap();
            for key in ["appearance.scale", "nav.pinned", "ui.motion"] {
                settings::set(&c, key, &json!(1)).unwrap();
            }
            c.execute_batch("PRAGMA journal_mode = DELETE;").unwrap();
        }
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[(root - 1) * size..root * size].copy_from_slice(&old_index);
        std::fs::write(&path, bytes).unwrap();
        // The index no longer knows nav.pinned, so this write adds a second row.
        let c = Connection::open(&path).unwrap();
        settings::set(&c, "nav.pinned", &json!(true)).unwrap();
        let rows: i64 = c.query_row("SELECT COUNT(*) FROM settings NOT INDEXED WHERE key = 'nav.pinned'", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 2, "the fixture must have a duplicate");
        assert!(!problems(&c).unwrap().is_empty());
        path
    }

    #[test]
    fn repairs_a_mixed_database_on_open() {
        let dir = temp_dir("mixed");
        let path = damaged_database(&dir);
        let backups = dir.join("backups");
        let db = Database::open(&path, &backups).unwrap();
        assert!(db.repair_report().unwrap().contains("repaired"));
        let conn = db.conn().unwrap();
        assert!(problems(&conn).unwrap().is_empty());
        // The newest row of the duplicated key won, and writes by key work again.
        assert_eq!(settings::get(&conn, "nav.pinned").unwrap(), Some(json!(true)));
        assert_eq!(settings::get(&conn, "appearance.radius").unwrap(), Some(json!(4)));
        settings::set(&conn, "appearance.scale", &json!(120)).unwrap();
        settings::set(&conn, "ui.motion", &json!("full")).unwrap();
        assert_eq!(settings::get(&conn, "appearance.scale").unwrap(), Some(json!(120)));
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM settings WHERE key = 'ui.motion'", params![], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // The damaged file was kept.
        assert!(std::fs::read_dir(&backups).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("netrunner-damaged-")));
        drop(conn);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_healthy_database_is_left_alone() {
        let dir = temp_dir("healthy");
        let path = dir.join("netrunner.db");
        {
            let db = Database::open(&path, &dir.join("backups")).unwrap();
            settings::set(&db.conn().unwrap(), "nav.pinned", &json!(true)).unwrap();
            assert!(db.repair_report().is_none());
        }
        let db = Database::open(&path, &dir.join("backups")).unwrap();
        assert!(db.repair_report().is_none());
        assert_eq!(settings::get(&db.conn().unwrap(), "nav.pinned").unwrap(), Some(json!(true)));
        assert!(!dir.join("backups").exists() || std::fs::read_dir(dir.join("backups")).unwrap().next().is_none());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
