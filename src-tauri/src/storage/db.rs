use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use super::migrations;
use crate::error::{AppError, AppResult};

/// Single shared SQLite connection.
///
/// NETRUNNER's write volume is tiny (settings, layouts, launcher entries), so a
/// mutex-guarded connection is simpler and safer than a pool.
pub struct Database {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
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

        let current = migrations::current_version(&conn)?;
        if existed && current > 0 && current < migrations::LATEST_VERSION {
            backup(&conn, backup_dir, current)?;
        }
        migrations::apply(&mut conn)?;

        Ok(Self { conn: Mutex::new(conn), path: Some(path.to_path_buf()) })
    }

    /// In-memory database for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let mut conn = Connection::open_in_memory()?;
        configure(&conn)?;
        migrations::apply(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn), path: None })
    }

    pub fn conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| AppError::Internal("database lock poisoned".into()))
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn schema_version(&self) -> AppResult<i64> {
        migrations::current_version(&*self.conn()?)
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
