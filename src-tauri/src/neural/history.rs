//! Local NEURAL chat history in SQLite.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::context::Attachment;
use super::tools::Action;
use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: i64,
    pub title: String,
    pub updated_at: String,
    pub message_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: i64,
    pub role: String,
    pub text: String,
    pub model: Option<String>,
    pub sent: Vec<String>,
    pub images: Vec<String>,
    pub actions: Vec<Action>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMessage {
    pub role: String,
    pub text: String,
    pub model: Option<String>,
    #[serde(default)]
    pub sent: Vec<String>,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub actions: Vec<Action>,
}

pub fn list(conn: &Connection) -> AppResult<Vec<Chat>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.title, c.updated_at, (SELECT COUNT(*) FROM neural_messages m WHERE m.chat_id = c.id)
         FROM neural_chats c ORDER BY c.updated_at DESC, c.id DESC",
    )?;
    let rows = stmt.query_map([], |r| Ok(Chat { id: r.get(0)?, title: r.get(1)?, updated_at: r.get(2)?, message_count: r.get(3)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn create(conn: &Connection) -> AppResult<i64> {
    conn.execute("INSERT INTO neural_chats DEFAULT VALUES", [])?;
    Ok(conn.last_insert_rowid())
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM neural_chats WHERE id = ?1", [id])?;
    Ok(())
}

pub fn rename(conn: &Connection, id: i64, title: &str) -> AppResult<()> {
    let t = title.trim();
    if t.is_empty() || t.chars().count() > 80 {
        return Err(AppError::Invalid("title must be 1–80 characters".into()));
    }
    conn.execute("UPDATE neural_chats SET title = ?1 WHERE id = ?2", params![t, id])?;
    Ok(())
}

pub fn exists(conn: &Connection, id: i64) -> AppResult<bool> {
    Ok(conn.query_row("SELECT 1 FROM neural_chats WHERE id = ?1", [id], |_| Ok(())).optional()?.is_some())
}

pub fn messages(conn: &Connection, chat_id: i64) -> AppResult<Vec<StoredMessage>> {
    let mut stmt = conn.prepare("SELECT id, role, text, model, sent_json, images_json, actions_json FROM neural_messages WHERE chat_id = ?1 ORDER BY id")?;
    let rows = stmt.query_map([chat_id], |r| {
        let (sent, images, actions): (String, String, String) = (r.get(4)?, r.get(5)?, r.get(6)?);
        Ok(StoredMessage {
            id: r.get(0)?,
            role: r.get(1)?,
            text: r.get(2)?,
            model: r.get(3)?,
            sent: serde_json::from_str(&sent).unwrap_or_default(),
            images: serde_json::from_str(&images).unwrap_or_default(),
            actions: serde_json::from_str(&actions).unwrap_or_default(),
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// "work" or "play". A chat keeps its own mode; a new chat is always "work".
pub fn mode(conn: &Connection, id: i64) -> AppResult<String> {
    Ok(conn.query_row("SELECT mode FROM neural_chats WHERE id = ?1", [id], |r| r.get(0)).optional()?.unwrap_or_else(|| "work".to_string()))
}

pub fn set_mode(conn: &Connection, id: i64, mode: &str) -> AppResult<()> {
    if !matches!(mode, "work" | "play") {
        return Err(AppError::Invalid("invalid mode".into()));
    }
    conn.execute("UPDATE neural_chats SET mode = ?1 WHERE id = ?2", params![mode, id])?;
    Ok(())
}

/// Attachments the user keeps in context: they go with every message of the chat.
pub fn kept(conn: &Connection, id: i64) -> AppResult<Vec<Attachment>> {
    let json: Option<String> = conn.query_row("SELECT kept_json FROM neural_chats WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default())
}

pub fn set_kept(conn: &Connection, id: i64, kept: &[Attachment]) -> AppResult<()> {
    conn.execute("UPDATE neural_chats SET kept_json = ?1 WHERE id = ?2", params![serde_json::to_string(kept)?, id])?;
    Ok(())
}

/// Appends a message; the first user message becomes the chat title.
pub fn append(conn: &Connection, chat_id: i64, m: &NewMessage) -> AppResult<i64> {
    if !matches!(m.role.as_str(), "user" | "model") {
        return Err(AppError::Invalid("invalid role".into()));
    }
    if !exists(conn, chat_id)? {
        return Err(AppError::NotFound("chat not found".into()));
    }
    conn.execute(
        "INSERT INTO neural_messages (chat_id, role, text, model, sent_json, images_json, actions_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![chat_id, m.role, m.text, m.model, serde_json::to_string(&m.sent)?, serde_json::to_string(&m.images)?, serde_json::to_string(&m.actions)?],
    )?;
    let id = conn.last_insert_rowid();
    if m.role == "user" {
        let title: String = m.text.lines().next().unwrap_or("").chars().take(60).collect();
        conn.execute(
            "UPDATE neural_chats SET title = CASE WHEN title = 'New chat' AND ?1 <> '' THEN ?1 ELSE title END WHERE id = ?2",
            params![title.trim(), chat_id],
        )?;
    }
    conn.execute("UPDATE neural_chats SET updated_at = datetime('now') WHERE id = ?1", [chat_id])?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;

    #[test]
    fn chat_history_round_trip() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        let id = create(&conn).unwrap();
        append(&conn, id, &NewMessage { role: "user".into(), text: "Как сделать X?\nподробно".into(), model: None, sent: vec!["File a.py".into()], images: vec!["img-a.jpg".into()], actions: vec![] }).unwrap();
        append(&conn, id, &NewMessage { role: "model".into(), text: "Так".into(), model: Some("gemini".into()), sent: vec![], images: vec![], actions: vec![Action { kind: "dice".into(), label: "1d20 → 7".into(), ..Action::default() }] }).unwrap();
        let chats = list(&conn).unwrap();
        assert_eq!(chats[0].title, "Как сделать X?");
        assert_eq!(chats[0].message_count, 2);
        let msgs = messages(&conn, id).unwrap();
        assert_eq!(msgs[0].sent, vec!["File a.py"]);
        assert_eq!(msgs[1].model.as_deref(), Some("gemini"));
        assert_eq!(msgs[0].images, vec!["img-a.jpg"]);
        assert_eq!(msgs[1].actions[0].label, "1d20 → 7");
        assert_eq!(mode(&conn, id).unwrap(), "work", "chats start in Work");
        set_mode(&conn, id, "play").unwrap();
        assert_eq!(mode(&conn, id).unwrap(), "play");
        assert!(set_mode(&conn, id, "root").is_err());
        set_kept(&conn, id, &[Attachment::File { path: "a.md".into() }]).unwrap();
        assert_eq!(kept(&conn, id).unwrap().len(), 1);
        assert!(append(&conn, id, &NewMessage { role: "system".into(), text: "x".into(), model: None, sent: vec![], images: vec![], actions: vec![] }).is_err());
        delete(&conn, id).unwrap();
        assert!(messages(&conn, id).unwrap().is_empty(), "messages cascade-deleted");
    }
}
