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
    /// Profile whose overlay set this belongs to; `None` = every profile.
    pub profile_id: Option<i64>,
    /// Mouse passes through the window while it is locked.
    pub click_through: bool,
}

impl Overlay {
    /// Whether the overlay belongs to the set shown while `active` is the active profile.
    pub fn in_set(&self, active: Option<i64>) -> bool {
        self.profile_id.is_none() || self.profile_id == active
    }

    /// Click-through applies only to locked overlays, so an unlocked one can always be moved.
    pub fn ignores_cursor(&self) -> bool {
        self.locked && self.click_through
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPatch {
    pub opacity: Option<f64>,
    pub locked: Option<bool>,
    pub show_on_startup: Option<bool>,
    pub config: Option<Value>,
    pub title: Option<String>,
    pub click_through: Option<bool>,
}

const SELECT: &str =
    "SELECT id, widget_type, x, y, width, height, opacity, locked, visible, show_on_startup, config_json, url, title, profile_id, click_through FROM overlays";

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
        profile_id: r.get(13)?,
        click_through: r.get(14)?,
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

pub fn create(conn: &Connection, widget_type: &str, profile_id: Option<i64>) -> AppResult<Overlay> {
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
        "quick-access" | "activity" | "tasks" | "notes" => (360, 420),
        "music" => (380, 170),
        "alarm" => (340, 400),
        _ => (340, 260),
    };
    conn.execute(
        "INSERT INTO overlays (widget_type, x, y, width, height, profile_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![widget_type, 80 + offset, 80 + offset, w, h, profile_id],
    )?;
    get(conn, conn.last_insert_rowid())
}

fn check_capacity(conn: &Connection) -> AppResult<i64> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM overlays", [], |r| r.get(0))?;
    if count >= 32 {
        return Err(AppError::Invalid("at most 32 overlays are supported".into()));
    }
    Ok(count)
}

/// A floating window showing a web page (e.g. SoundCloud or a video), loaded
/// in the hardened BROWSER profile.
pub fn create_web(conn: &Connection, url: &str, title: &str, profile_id: Option<i64>) -> AppResult<Overlay> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| AppError::Invalid("enter a full http(s) address".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") || url.len() > 4096 {
        return Err(AppError::Invalid("web overlays show http(s) pages only".into()));
    }
    let count = check_capacity(conn)?;
    let offset = (count as i32) * 30;
    let title: String = title.trim().chars().take(80).collect();
    conn.execute(
        "INSERT INTO overlays (widget_type, x, y, width, height, opacity, url, title, profile_id) VALUES (?1, ?2, ?3, 560, 360, 1.0, ?4, ?5, ?6)",
        params![WEB_TYPE, 100 + offset, 100 + offset, parsed.as_str(), title, profile_id],
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
        "UPDATE overlays SET opacity = ?1, locked = ?2, show_on_startup = ?3, config_json = ?4, title = ?5, click_through = ?6 WHERE id = ?7",
        params![
            p.opacity.unwrap_or(cur.opacity).clamp(0.2, 1.0),
            p.locked.unwrap_or(cur.locked),
            p.show_on_startup.unwrap_or(cur.show_on_startup),
            serde_json::to_string(&config)?,
            title,
            p.click_through.unwrap_or(cur.click_through),
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

/// Moves an overlay into a profile's set, or into every set with `None`.
pub fn set_profile(conn: &Connection, id: i64, profile_id: Option<i64>) -> AppResult<Overlay> {
    if let Some(pid) = profile_id {
        crate::services::profiles::get(conn, pid)?;
    }
    get(conn, id)?;
    conn.execute("UPDATE overlays SET profile_id = ?1 WHERE id = ?2", params![profile_id, id])?;
    get(conn, id)
}

/// Unlocks every locked click-through overlay (they cannot be clicked to unlock
/// themselves). Their click-through flag stays, so locking one again restores it.
pub fn unlock_click_through(conn: &Connection) -> AppResult<Vec<Overlay>> {
    let ids: Vec<i64> = list(conn)?.into_iter().filter(Overlay::ignores_cursor).map(|o| o.id).collect();
    for id in &ids {
        conn.execute("UPDATE overlays SET locked = 0 WHERE id = ?1", [id])?;
    }
    ids.into_iter().map(|id| get(conn, id)).collect()
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
        let o = create(&conn, "cpu", None).unwrap();
        assert!(o.visible && !o.locked);
        let p = OverlayPatch {
            opacity: Some(5.0),
            locked: Some(true),
            show_on_startup: None,
            config: Some(serde_json::json!({"graph": false})),
            title: None,
            click_through: Some(true),
        };
        let o = patch(&conn, o.id, &p).unwrap();
        assert_eq!(o.opacity, 1.0);
        assert!(o.locked);
        assert_eq!(o.config["graph"], false);
        assert!(o.click_through && o.ignores_cursor());
        let unlocked = unlock_click_through(&conn).unwrap();
        assert_eq!(unlocked.len(), 1);
        assert!(!unlocked[0].locked && unlocked[0].click_through && !unlocked[0].ignores_cursor());
        let bad = OverlayPatch {
            opacity: None,
            locked: None,
            show_on_startup: None,
            config: Some(serde_json::json!(3)),
            title: None,
            click_through: None,
        };
        assert!(patch(&conn, o.id, &bad).is_err());
        set_geometry(&conn, o.id, 10, 20, 50, 5000).unwrap();
        let o = get(&conn, o.id).unwrap();
        assert_eq!((o.width, o.height), (140, 2000));
        assert!(create(&conn, "Bad Type", None).is_err());
        assert!(create(&conn, WEB_TYPE, None).is_err(), "web overlays need a URL");
        let web = create_web(&conn, "https://soundcloud.com/discover", " SoundCloud ", None).unwrap();
        assert_eq!((web.widget_type.as_str(), web.title.as_str()), (WEB_TYPE, "SoundCloud"));
        assert!(create_web(&conn, "file:///C:/x.html", "", None).is_err());
        assert!(create_web(&conn, "javascript:alert(1)", "", None).is_err());
        delete(&conn, web.id).unwrap();
        delete(&conn, o.id).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn overlay_profile_sets() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        crate::services::profiles::ensure_seeded(&conn).unwrap();
        let ids: Vec<i64> = crate::services::profiles::list(&conn).unwrap().iter().map(|p| p.id).collect();
        let (a, b) = (ids[0], ids[1]);
        let everywhere = create(&conn, "cpu", None).unwrap();
        let only_a = create(&conn, "clock", Some(a)).unwrap();
        assert!(everywhere.in_set(Some(a)) && everywhere.in_set(Some(b)));
        assert!(only_a.in_set(Some(a)) && !only_a.in_set(Some(b)));
        let moved = set_profile(&conn, only_a.id, Some(b)).unwrap();
        assert_eq!(moved.profile_id, Some(b));
        assert!(set_profile(&conn, only_a.id, Some(999_999)).is_err(), "unknown profile");
        assert_eq!(set_profile(&conn, only_a.id, None).unwrap().profile_id, None);
        // Deleting a profile removes its overlay set.
        let custom = crate::services::profiles::create(&conn, "Temp", None).unwrap();
        let o = create(&conn, "ram", Some(custom.id)).unwrap();
        crate::services::profiles::delete(&conn, custom.id).unwrap();
        assert!(get(&conn, o.id).is_err());
        assert_eq!(list(&conn).unwrap().len(), 2);
    }
}
