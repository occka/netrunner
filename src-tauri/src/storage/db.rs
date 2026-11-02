use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use super::{migrations, repair};
use crate::error::{AppError, AppResult};

/// Single shared SQLite connection.
///
/// NETRUNNER's write volume is tiny (settings, layouts, launcher entries), so a
/// mutex-guarded connection is simpler and safer than a pool.
pub struct Database {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
    /// Set when the startup check found damage (see `repair`).
    repair_report: Option<String>,
}

impl Database {
    /// Opens (or creates) the database file and applies pending migrations.
    /// An existing database is backed up into `backup_dir` before migrating.
    pub fn open(path: &Path, backup_dir: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let existed = path.exists();
        let mut conn = Connection::open(path)?;
        configure(&conn)?;

        // Before anything reads or writes through a possibly damaged index.
        let found = if existed { repair::problems(&conn).unwrap_or_else(|e| vec![e.to_string()]) } else { Vec::new() };
        let repair_report = if found.is_empty() { None } else { Some(repair::repair(&conn, path, backup_dir, &found)?) };

        let current = migrations::current_version(&conn)?;
        if existed && current > 0 && current < migrations::LATEST_VERSION {
            backup(&conn, backup_dir, current)?;
        }
        migrations::apply(&mut conn)?;
        checkpoint(&conn);

        Ok(Self { conn: Mutex::new(conn), path: Some(path.to_path_buf()), repair_report })
    }

    /// In-memory database for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let mut conn = Connection::open_in_memory()?;
        configure(&conn)?;
        migrations::apply(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn), path: None, repair_report: None })
    }

    pub fn conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| AppError::Internal("database lock poisoned".into()))
    }

    pub fn repair_report(&self) -> Option<&str> {
        self.repair_report.as_deref()
    }

    /// Moves the journal into the database file. Called on exit, so the file
    /// on disk is complete and no long-lived `-wal` file has to stay next to it.
    pub fn checkpoint(&self) {
        if let Ok(conn) = self.conn() {
            checkpoint(&conn);
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn schema_version(&self) -> AppResult<i64> {
        migrations::current_version(&*self.conn()?)
    }
}

fn checkpoint(conn: &Connection) {
    if let Err(e) = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
        log::warn!("database checkpoint failed: {e}");
    }
}

fn configure(conn: &Connection) -> AppResult<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(3))?;
    Ok(())
}

/// Copies the live database into the backup directory using SQLite's
/// `VACUUM INTO`, which produces a consistent snapshot even in WAL mode.
fn backup(conn: &Connection, backup_dir: &Path, version: i64) -> AppResult<()> {
    std::fs::create_dir_all(backup_dir)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let target = backup_dir.join(format!("netrunner-v{version}-{stamp}.db"));
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    log::info!("database backup written to {}", target.display());
    Ok(())
}
