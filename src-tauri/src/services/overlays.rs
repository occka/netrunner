//! Overlay definitions (which widget, where, how). Window handling is in
//! `crate::overlay`.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// `widget_type` of overlays that show a web page (music / video sites).
pub const WEB_TYPE: &str = "web";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    pub id: i64,
    pub widget_type: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub opacity: f64,
    pub locked: bool,
    pub visible: bool,
    pub show_on_startup: bool,
    /// Widget settings (frame and content), as in a dashboard layout.
    pub config: Value,
    /// Page shown by a web overlay; empty for widget overlays.
    pub url: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPatch {
    pub opacity: Option<f64>,
    pub locked: Option<bool>,
    pub show_on_startup: Option<bool>,
    pub config: Option<Value>,
    pub title: Option<String>,
}

const SELECT: &str =
    "SELECT id, widget_type, x, y, width, height, opacity, locked, visible, show_on_startup, config_json, url, title FROM overlays";

fn from_row(r: &Row) -> rusqlite::Result<Overlay> {
    Ok(Overlay {
        id: r.get(0)?,
        widget_type: r.get(1)?,
        x: r.get(2)?,
        y: r.get(3)?,
        width: r.get(4)?,
        height: r.get(5)?,
        opacity: r.get(6)?,
        locked: r.get(7)?,
        visible: r.get(8)?,
        show_on_startup: r.get(9)?,
        config: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_else(|_| Value::Object(Default::default())),
        url: r.get(11)?,
        title: r.get(12)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<Overlay>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY id"))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Overlay> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("overlay {id} does not exist")))
}

pub fn create(conn: &Connection, widget_type: &str) -> AppResult<Overlay> {
    if widget_type.is_empty()
        || widget_type == WEB_TYPE
        || widget_type.len() > 40
        || !widget_type.chars().all(|c| c.is_ascii_lowercase() || c == '-')
    {
        return Err(AppError::Invalid("invalid widget type".into()));
    }
    let count = check_capacity(conn)?;
    let offset = (count as i32) * 30;
    // Chat-like widgets need more room than gauges.
    let (w, h) = match widget_type {
        "neural" => (420, 600),
        "quick-access" | "activity" | "tasks" => (360, 420),
        "music" => (380, 170),
        _ => (340, 260),
    };
    conn.execute(
        "INSERT INTO overlays (widget_type, x, y, width, height) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![widget_type, 80 + offset, 80 + offset, w, h],
    )?;
    get(conn, conn.last_insert_rowid())
}

fn check_capacity(conn: &Connection) -> AppResult<i64> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM overlays", [], |r| r.get(0))?;
    if count >= 16 {
        return Err(AppError::Invalid("at most 16 overlays are supported".into()));
    }
    Ok(count)
}

/// A floating window showing a web page (e.g. SoundCloud or a video), loaded
/// in the hardened BROWSER profile.
pub fn create_web(conn: &Connection, url: &str, title: &str) -> AppResult<Overlay> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| AppError::Invalid("enter a full http(s) address".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") || url.len() > 4096 {
        return Err(AppError::Invalid("web overlays show http(s) pages only".into()));
    }
    let count = check_capacity(conn)?;
    let offset = (count as i32) * 30;
    let title: String = title.trim().chars().take(80).collect();
    conn.execute(
        "INSERT INTO overlays (widget_type, x, y, width, height, opacity, url, title) VALUES (?1, ?2, ?3, 560, 360, 1.0, ?4, ?5)",
        params![WEB_TYPE, 100 + offset, 100 + offset, parsed.as_str(), title],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn patch(conn: &Connection, id: i64, p: &OverlayPatch) -> AppResult<Overlay> {
    let cur = get(conn, id)?;
    let config = match &p.config {
        Some(c) => {
            crate::services::profiles::validate_config(c)?;
            c.clone()
        }
        None => cur.config,
    };
    let title = match p.title.as_deref() {
        Some(t) => t.trim().chars().take(80).collect::<String>(),
        None => cur.title,
    };
    conn.execute(
        "UPDATE overlays SET opacity = ?1, locked = ?2, show_on_startup = ?3, config_json = ?4, title = ?5 WHERE id = ?6",
        params![
            p.opacity.unwrap_or(cur.opacity).clamp(0.2, 1.0),
            p.locked.unwrap_or(cur.locked),
            p.show_on_startup.unwrap_or(cur.show_on_startup),
            serde_json::to_string(&config)?,
            title,
            id
        ],
    )?;
    get(conn, id)
}

pub fn set_geometry(conn: &Connection, id: i64, x: i32, y: i32, width: u32, height: u32) -> AppResult<()> {
    conn.execute(
        "UPDATE overlays SET x = ?1, y = ?2, width = ?3, height = ?4 WHERE id = ?5",
        params![x, y, width.clamp(140, 2000), height.clamp(80, 2000), id],
    )?;
    Ok(())
}

pub fn set_visible(conn: &Connection, id: i64, visible: bool) -> AppResult<()> {
    conn.execute("UPDATE overlays SET visible = ?1 WHERE id = ?2", params![visible, id])?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM overlays WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;

    #[test]
    fn overlay_crud() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        let o = create(&conn, "cpu").unwrap();
        assert!(o.visible && !o.locked);
        let p = OverlayPatch {
            opacity: Some(5.0),
            locked: Some(true),
            show_on_startup: None,
            config: Some(serde_json::json!({"graph": false})),
            title: None,
        };
        let o = patch(&conn, o.id, &p).unwrap();
        assert_eq!(o.opacity, 1.0);
        assert!(o.locked);
        assert_eq!(o.config["graph"], false);
        let bad = OverlayPatch { opacity: None, locked: None, show_on_startup: None, config: Some(serde_json::json!(3)), title: None };
        assert!(patch(&conn, o.id, &bad).is_err());
        set_geometry(&conn, o.id, 10, 20, 50, 5000).unwrap();
        let o = get(&conn, o.id).unwrap();
        assert_eq!((o.width, o.height), (140, 2000));
        assert!(create(&conn, "Bad Type").is_err());
        assert!(create(&conn, WEB_TYPE).is_err(), "web overlays need a URL");
        let web = create_web(&conn, "https://soundcloud.com/discover", " SoundCloud ").unwrap();
        assert_eq!((web.widget_type.as_str(), web.title.as_str()), (WEB_TYPE, "SoundCloud"));
        assert!(create_web(&conn, "file:///C:/x.html", "").is_err());
        assert!(create_web(&conn, "javascript:alert(1)", "").is_err());
        delete(&conn, web.id).unwrap();
        delete(&conn, o.id).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }
}
