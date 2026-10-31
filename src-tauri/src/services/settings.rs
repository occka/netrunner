use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::error::{AppError, AppResult};

pub fn get_all(conn: &Connection) -> AppResult<HashMap<String, Value>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut out = HashMap::new();
    for row in rows {
        let (key, raw) = row?;
        match serde_json::from_str(&raw) {
            Ok(value) => {
                out.insert(key, value);
            }
            Err(err) => log::warn!("ignoring unreadable setting '{key}': {err}"),
        }
    }
    Ok(out)
}

pub fn get(conn: &Connection, key: &str) -> AppResult<Option<Value>> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0))
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(match raw {
        Some(raw) => Some(serde_json::from_str(&raw)?),
        None => None,
    })
}

pub fn set(conn: &Connection, key: &str, value: &Value) -> AppResult<()> {
    validate_key(key)?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, serde_json::to_string(value)?],
    )?;
    Ok(())
}

fn validate_key(key: &str) -> AppResult<()> {
    let valid = !key.is_empty()
        && key.len() <= 64
        && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
    if valid {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("invalid settings key '{key}'")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;
    use serde_json::json;

    #[test]
    fn round_trips_json_values() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        set(&conn, "nav.pinned", &json!(true)).unwrap();
        set(&conn, "theme", &json!({"primary": "#fff"})).unwrap();
        set(&conn, "nav.pinned", &json!(false)).unwrap();
        let all = get_all(&conn).unwrap();
        assert_eq!(all["nav.pinned"], json!(false));
        assert_eq!(get(&conn, "theme").unwrap(), Some(json!({"primary": "#fff"})));
        assert_eq!(get(&conn, "missing").unwrap(), None);
    }

    #[test]
    fn rejects_bad_keys() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        assert!(set(&conn, "Bad Key", &json!(1)).is_err());
        assert!(set(&conn, "", &json!(1)).is_err());
    }
}
