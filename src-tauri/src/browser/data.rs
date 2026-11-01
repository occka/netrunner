//! BROWSER data in SQLite: bookmarks, history and site permissions the user
//! granted. Cookies, cache and site storage live in the WebView2 profile.

use rusqlite::{params, Connection, Row};
use serde::Serialize;

use crate::error::{AppError, AppResult};

const HISTORY_LIMIT: i64 = 5000;

/// Permissions a site may ask for and the user may grant per site.
pub const PERMISSION_KINDS: &[&str] = &[
    "camera",
    "microphone",
    "geolocation",
    "notifications",
    "clipboard-read",
    "display-capture",
    "midi",
    "sensors",
    "local-fonts",
    "window-management",
    "pointer-lock",
    "automatic-downloads",
    "file-system",
    "autoplay",
    "protected-media",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub visited_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePermission {
    pub host: String,
    pub kind: String,
    pub granted_at: String,
}

fn bookmark(r: &Row) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark { id: r.get(0)?, url: r.get(1)?, title: r.get(2)?, created_at: r.get(3)? })
}

/// Only http(s) pages are stored; titles are capped so a page cannot bloat the database.
fn clean(url: &str, title: &str) -> AppResult<(String, String)> {
    let parsed = url::Url::parse(url).map_err(|_| AppError::Invalid("invalid URL".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") || url.len() > 4096 {
        return Err(AppError::Invalid("only http(s) pages can be saved".into()));
    }
    Ok((parsed.to_string(), title.chars().take(300).collect()))
}

pub fn bookmarks(conn: &Connection) -> AppResult<Vec<Bookmark>> {
    let mut stmt = conn.prepare("SELECT id, url, title, created_at FROM browser_bookmarks ORDER BY id")?;
    let rows = stmt.query_map([], bookmark)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn add_bookmark(conn: &Connection, url: &str, title: &str) -> AppResult<Bookmark> {
    let (url, title) = clean(url, title)?;
    conn.execute(
        "INSERT INTO browser_bookmarks (url, title) VALUES (?1, ?2) ON CONFLICT (url) DO UPDATE SET title = excluded.title",
        params![url, title],
    )?;
    Ok(conn.query_row("SELECT id, url, title, created_at FROM browser_bookmarks WHERE url = ?1", [url], bookmark)?)
}

pub fn rename_bookmark(conn: &Connection, id: i64, title: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE browser_bookmarks SET title = ?1 WHERE id = ?2",
        params![title.chars().take(300).collect::<String>(), id],
    )?;
    Ok(())
}

pub fn remove_bookmark(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM browser_bookmarks WHERE id = ?1", [id])?;
    Ok(())
}

/// Records a visit. Reloads of the most recent entry only refresh its title.
pub fn record_visit(conn: &Connection, url: &str, title: &str) -> AppResult<()> {
    let Ok((url, title)) = clean(url, title) else { return Ok(()) };
    let last: Option<(i64, String)> = conn
        .query_row("SELECT id, url FROM browser_history ORDER BY id DESC LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();
    match last {
        Some((id, last_url)) if last_url == url => {
            if !title.is_empty() {
                conn.execute("UPDATE browser_history SET title = ?1 WHERE id = ?2", params![title, id])?;
            }
        }
        _ => {
            conn.execute("INSERT INTO browser_history (url, title) VALUES (?1, ?2)", params![url, title])?;
            conn.execute(
                "DELETE FROM browser_history WHERE id <= (SELECT id FROM browser_history ORDER BY id DESC LIMIT 1 OFFSET ?1)",
                [HISTORY_LIMIT],
            )?;
        }
    }
    Ok(())
}

/// Updates the title of the latest visit to `url` (pages often retitle
/// themselves after loading); never adds an entry.
pub fn retitle(conn: &Connection, url: &str, title: &str) -> AppResult<()> {
    let Ok((url, title)) = clean(url, title) else { return Ok(()) };
    if title.is_empty() {
        return Ok(());
    }
    conn.execute(
        "UPDATE browser_history SET title = ?1 WHERE id = (SELECT MAX(id) FROM browser_history WHERE url = ?2)",
        params![title, url],
    )?;
    Ok(())
}

pub fn history(conn: &Connection, query: &str, limit: i64) -> AppResult<Vec<HistoryEntry>> {
    let pattern = format!("%{}%", query.trim().replace(['%', '_'], ""));
    let mut stmt = conn.prepare(
        "SELECT id, url, title, visited_at FROM browser_history WHERE url LIKE ?1 OR title LIKE ?1 ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![pattern, limit.clamp(1, 500)], |r| {
        Ok(HistoryEntry { id: r.get(0)?, url: r.get(1)?, title: r.get(2)?, visited_at: r.get(3)? })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn clear_history(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM browser_history", [])?;
    Ok(())
}

pub fn permissions(conn: &Connection) -> AppResult<Vec<SitePermission>> {
    let mut stmt = conn.prepare("SELECT host, kind, granted_at FROM browser_site_permissions ORDER BY host, kind")?;
    let rows = stmt.query_map([], |r| Ok(SitePermission { host: r.get(0)?, kind: r.get(1)?, granted_at: r.get(2)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn is_granted(conn: &Connection, host: &str, kind: &str) -> bool {
    conn.query_row("SELECT 1 FROM browser_site_permissions WHERE host = ?1 AND kind = ?2", params![host, kind], |_| Ok(()))
        .is_ok()
}

fn check_permission(host: &str, kind: &str) -> AppResult<()> {
    if !PERMISSION_KINDS.contains(&kind) {
        return Err(AppError::Invalid(format!("unknown permission {kind}")));
    }
    if host.is_empty() || host.len() > 253 || !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')) {
        return Err(AppError::Invalid("invalid site".into()));
    }
    Ok(())
}

pub fn grant(conn: &Connection, host: &str, kind: &str) -> AppResult<()> {
    check_permission(host, kind)?;
    conn.execute("INSERT OR IGNORE INTO browser_site_permissions (host, kind) VALUES (?1, ?2)", params![host, kind])?;
    Ok(())
}

pub fn revoke(conn: &Connection, host: &str, kind: &str) -> AppResult<()> {
    conn.execute("DELETE FROM browser_site_permissions WHERE host = ?1 AND kind = ?2", params![host, kind])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;

    #[test]
    fn bookmarks_and_history() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        let b = add_bookmark(&conn, "https://example.com", "Example").unwrap();
        add_bookmark(&conn, "https://example.com", "Renamed").unwrap();
        assert_eq!(bookmarks(&conn).unwrap().len(), 1);
        assert_eq!(bookmarks(&conn).unwrap()[0].title, "Renamed");
        assert!(add_bookmark(&conn, "file:///C:/secret.txt", "x").is_err());
        remove_bookmark(&conn, b.id).unwrap();
        assert!(bookmarks(&conn).unwrap().is_empty());

        record_visit(&conn, "https://a.example/", "").unwrap();
        record_visit(&conn, "https://a.example/", "A").unwrap();
        record_visit(&conn, "https://b.example/", "B").unwrap();
        retitle(&conn, "https://a.example/", "A2").unwrap();
        retitle(&conn, "https://never.example/", "X").unwrap();
        record_visit(&conn, "javascript:alert(1)", "x").unwrap();
        let h = history(&conn, "", 50).unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!(h[1].title, "A2", "retitle updates the latest visit without adding one");
        assert_eq!(history(&conn, "b.ex", 50).unwrap().len(), 1);
        clear_history(&conn).unwrap();
        assert!(history(&conn, "", 50).unwrap().is_empty());
    }

    #[test]
    fn site_permissions() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        grant(&conn, "meet.example.com", "camera").unwrap();
        assert!(is_granted(&conn, "meet.example.com", "camera"));
        assert!(!is_granted(&conn, "meet.example.com", "microphone"));
        assert!(grant(&conn, "meet.example.com", "root").is_err());
        assert!(grant(&conn, "bad host/", "camera").is_err());
        revoke(&conn, "meet.example.com", "camera").unwrap();
        assert!(permissions(&conn).unwrap().is_empty());
    }
}
