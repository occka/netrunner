//! Backups of the database: on demand, on a schedule, as an export to a file
//! the user picks, and restoring one.
//!
//! A database file is never replaced while it is open. Restoring checks the
//! backup first, then leaves a marker; at the next start, before anything opens
//! the database, the marker swaps the file in. The live file's `-wal` and `-shm`
//! go with it: a write-ahead log left next to another database corrupts it.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use super::migrations::LATEST_VERSION;
use crate::error::{AppError, AppResult};

const DB_FILE: &str = "netrunner.db";
const MARKER: &str = "restore-pending.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// Seconds since 1970.
    pub created: u64,
    /// `manual`, `auto`, `migration` (before a schema change), `damaged` (kept by a repair) or `restore` (the database a restore replaced).
    pub kind: &'static str,
}

#[derive(Serialize, Deserialize)]
struct Pending {
    source: PathBuf,
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// A consistent copy of the open database, even in WAL mode.
pub fn write_copy(conn: &Connection, target: &Path) -> AppResult<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // VACUUM INTO refuses an existing file; the user already agreed to replace it.
    if target.exists() {
        std::fs::remove_file(target)?;
    }
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    Ok(())
}

pub fn create(conn: &Connection, dir: &Path, kind: &str) -> AppResult<PathBuf> {
    let target = dir.join(format!("netrunner-{kind}-{}.db", stamp()));
    write_copy(conn, &target)?;
    Ok(target)
}

fn kind_of(name: &str) -> &'static str {
    ["manual", "auto", "damaged", "restore"]
        .into_iter()
        .find(|k| name.starts_with(&format!("netrunner-{k}-")) || (*k == "restore" && name.starts_with("netrunner-before-restore-")))
        .unwrap_or(if name.starts_with("netrunner-v") { "migration" } else { "manual" })
}

pub fn list(dir: &Path) -> Vec<Backup> {
    let mut out: Vec<Backup> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let meta = e.metadata().ok()?;
            (name.starts_with("netrunner-") && name.ends_with(".db") && meta.is_file()).then(|| Backup {
                kind: kind_of(&name),
                path: e.path().display().to_string(),
                size: meta.len(),
                created: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs()),
                name,
            })
        })
        .collect();
    out.sort_by(|a, b| b.created.cmp(&a.created).then(b.name.cmp(&a.name)));
    out
}

/// A backup in `dir`, by name only: the UI never passes a path.
pub fn in_dir(dir: &Path, name: &str) -> AppResult<PathBuf> {
    if name.contains(['/', '\\']) || name.contains("..") || !name.starts_with("netrunner-") || !name.ends_with(".db") {
        return Err(AppError::Invalid("invalid backup name".into()));
    }
    let path = dir.join(name);
    path.is_file().then_some(path).ok_or_else(|| AppError::NotFound("backup not found".into()))
}

/// Keeps the newest `keep` automatic backups; others are never deleted here.
pub fn prune(dir: &Path, keep: usize) -> usize {
    let autos: Vec<Backup> = list(dir).into_iter().filter(|b| b.kind == "auto").collect();
    autos.iter().skip(keep.max(1)).filter(|b| std::fs::remove_file(&b.path).is_ok()).count()
}

/// Whether an automatic backup is due: none yet, or the newest is older than `every`.
pub fn due(dir: &Path, every: Duration) -> bool {
    let newest = list(dir).into_iter().filter(|b| b.kind == "auto").map(|b| b.created).max();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    newest.map_or(true, |t| now.saturating_sub(t) >= every.as_secs())
}

/// Opens a database read-only and checks that NETRUNNER can use it.
pub fn validate(path: &Path) -> AppResult<i64> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| AppError::Invalid("not a database file".into()))?;
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|_| AppError::Invalid("not a NETRUNNER database".into()))?;
    if check != "ok" {
        return Err(AppError::Invalid(format!("the file is damaged ({check})")));
    }
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let has_settings: bool = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'settings'", [], |r| r.get::<_, i64>(0)).map(|n| n > 0)?;
    if version < 1 || !has_settings {
        return Err(AppError::Invalid("not a NETRUNNER database".into()));
    }
    if version > LATEST_VERSION {
        return Err(AppError::Invalid(format!("made by a newer NETRUNNER (schema v{version}); update first")));
    }
    Ok(version)
}

/// Checks the source, keeps a copy of the current database and asks the next
/// start to swap the source in. The caller then restarts the app.
pub fn schedule_restore(conn: &Connection, data_dir: &Path, source: &Path) -> AppResult<()> {
    validate(source)?;
    // The source may be a backup that is about to be pruned, or a file the user moves: work from a copy.
    let staged = data_dir.join("restore-staged.db");
    std::fs::copy(source, &staged)?;
    create(conn, &data_dir.join("backups"), "restore")?;
    std::fs::write(data_dir.join(MARKER), serde_json::to_vec(&Pending { source: staged })?)?;
    Ok(())
}

/// Runs before the database is opened. Returns what happened, for the activity log.
pub fn apply_pending(data_dir: &Path) -> Option<String> {
    let marker = data_dir.join(MARKER);
    let text = std::fs::read(&marker).ok()?;
    // Never twice: whatever happens, the marker goes.
    let _ = std::fs::remove_file(&marker);
    let pending: Pending = match serde_json::from_slice(&text) {
        Ok(p) => p,
        Err(_) => return Some("A restore was requested, but its note was unreadable; nothing was changed.".into()),
    };
    if let Err(e) = validate(&pending.source) {
        let _ = std::fs::remove_file(&pending.source);
        return Some(format!("The backup was not restored: {e}"));
    }
    let db = data_dir.join(DB_FILE);
    for suffix in ["-wal", "-shm", ""] {
        let file = PathBuf::from(format!("{}{suffix}", db.display()));
        if file.exists() {
            if let Err(e) = std::fs::remove_file(&file) {
                return Some(format!("The backup was not restored: cannot replace {} ({e})", file.display()));
            }
        }
    }
    match std::fs::rename(&pending.source, &db) {
        Ok(()) => Some("Restored the database from a backup. The previous one is kept in backups as netrunner-restore-….".into()),
        Err(e) => Some(format!("Restoring failed while moving the backup in ({e}); the copy is in backups as netrunner-restore-….")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nr-backups-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn set(db: &Database, value: &str) {
        crate::services::settings::set(&db.conn().unwrap(), "test.value", &serde_json::json!(value)).unwrap();
    }

    fn get(db: &Database) -> Option<serde_json::Value> {
        crate::services::settings::get(&db.conn().unwrap(), "test.value").unwrap()
    }

    #[test]
    fn restores_a_backup_at_the_next_start() {
        let dir = temp("restore");
        let backups = dir.join("backups");
        let db = Database::open(&dir.join(DB_FILE), &backups).unwrap();
        set(&db, "before");
        let copy = create(&db.conn().unwrap(), &backups, "manual").unwrap();
        set(&db, "after");
        assert_eq!(validate(&copy).unwrap(), LATEST_VERSION);
        schedule_restore(&db.conn().unwrap(), &dir, &copy).unwrap();
        assert_eq!(get(&db).unwrap(), "after", "nothing changes while the app runs");
        drop(db);

        let report = apply_pending(&dir).unwrap();
        assert!(report.starts_with("Restored"), "{report}");
        assert!(apply_pending(&dir).is_none(), "only once");
        let db = Database::open(&dir.join(DB_FILE), &backups).unwrap();
        assert_eq!(get(&db).unwrap(), "before");
        assert!(list(&backups).iter().any(|b| b.kind == "restore"), "the replaced database is kept");
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_what_it_cannot_use() {
        let dir = temp("refuse");
        let junk = dir.join("junk.db");
        std::fs::write(&junk, b"definitely not sqlite").unwrap();
        assert!(validate(&junk).is_err());
        let other = dir.join("other.db");
        Connection::open(&other).unwrap().execute_batch("CREATE TABLE t(x); PRAGMA user_version = 3;").unwrap();
        assert!(validate(&other).unwrap_err().to_string().contains("not a NETRUNNER database"));
        let newer = dir.join("newer.db");
        Connection::open(&newer).unwrap().execute_batch(&format!("CREATE TABLE settings(k); PRAGMA user_version = {};", LATEST_VERSION + 1)).unwrap();
        assert!(validate(&newer).unwrap_err().to_string().contains("newer NETRUNNER"));

        // A bad note never touches the database.
        std::fs::write(dir.join(DB_FILE), b"live").unwrap();
        std::fs::write(dir.join(MARKER), serde_json::to_vec(&Pending { source: junk.clone() }).unwrap()).unwrap();
        assert!(apply_pending(&dir).unwrap().starts_with("The backup was not restored"));
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), b"live");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn schedules_and_prunes_automatic_backups() {
        let dir = temp("auto");
        let db = Database::open(&dir.join(DB_FILE), &dir.join("backups")).unwrap();
        let backups = dir.join("backups");
        assert!(due(&backups, Duration::from_secs(3600)));
        for i in 0..4 {
            std::fs::create_dir_all(&backups).unwrap();
            write_copy(&db.conn().unwrap(), &backups.join(format!("netrunner-auto-2026010{i}-000000.db"))).unwrap();
        }
        create(&db.conn().unwrap(), &backups, "manual").unwrap();
        assert!(!due(&backups, Duration::from_secs(3600)));
        assert!(due(&backups, Duration::ZERO));
        assert_eq!(prune(&backups, 2), 2);
        let left = list(&backups);
        assert_eq!(left.iter().filter(|b| b.kind == "auto").count(), 2);
        assert_eq!(left.iter().filter(|b| b.kind == "manual").count(), 1, "manual backups are never pruned");
        assert!(in_dir(&backups, "../netrunner.db").is_err() && in_dir(&backups, "x.db").is_err());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
