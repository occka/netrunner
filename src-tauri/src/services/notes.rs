//! Notes / to-do boards: a free-text note and a task list per board name.
//! Several widgets (dashboard and overlays) can show the same board.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{AppError, AppResult};

const MAX_TEXT: usize = 64 * 1024;
const MAX_ITEM: usize = 500;
const MAX_ITEMS: i64 = 500;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteItem {
    pub id: i64,
    pub text: String,
    pub done: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub name: String,
    pub text: String,
    pub items: Vec<NoteItem>,
}

/// Board names are what the user typed in the widget settings; blank means "Main".
pub fn board_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    let name = if name.is_empty() { "Main" } else { name };
    if name.chars().count() > 40 {
        return Err(AppError::Invalid("board name must be at most 40 characters".into()));
    }
    Ok(name.to_string())
}

pub fn board(conn: &Connection, name: &str) -> AppResult<Board> {
    let name = board_name(name)?;
    let text = conn
        .query_row("SELECT text FROM note_boards WHERE name = ?1", [&name], |r| r.get::<_, String>(0))
        .optional()?
        .unwrap_or_default();
    let mut stmt = conn.prepare("SELECT id, text, done FROM note_items WHERE board = ?1 ORDER BY position, id")?;
    let items = stmt
        .query_map([&name], |r| Ok(NoteItem { id: r.get(0)?, text: r.get(1)?, done: r.get(2)? }))?
        .collect::<Result<_, _>>()?;
    Ok(Board { name, text, items })
}

pub fn set_text(conn: &Connection, name: &str, text: &str) -> AppResult<()> {
    if text.len() > MAX_TEXT {
        return Err(AppError::Invalid("the note is too long (64 KB at most)".into()));
    }
    conn.execute(
        "INSERT INTO note_boards (name, text) VALUES (?1, ?2)
         ON CONFLICT (name) DO UPDATE SET text = excluded.text, updated_at = datetime('now')",
        params![board_name(name)?, text],
    )?;
    Ok(())
}

fn item_text(text: &str) -> AppResult<String> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > MAX_ITEM {
        return Err(AppError::Invalid(format!("a task must be 1–{MAX_ITEM} characters")));
    }
    Ok(text.to_string())
}

/// Adds a task at the end of the list (or at the top with `first`).
pub fn add(conn: &Connection, name: &str, text: &str, first: bool) -> AppResult<NoteItem> {
    let name = board_name(name)?;
    let text = item_text(text)?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM note_items WHERE board = ?1", [&name], |r| r.get(0))?;
    if count >= MAX_ITEMS {
        return Err(AppError::Invalid(format!("a board holds at most {MAX_ITEMS} tasks")));
    }
    let (min, max): (Option<i64>, Option<i64>) =
        conn.query_row("SELECT MIN(position), MAX(position) FROM note_items WHERE board = ?1", [&name], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    let position = if first { min.unwrap_or(0) - 1 } else { max.unwrap_or(-1) + 1 };
    conn.execute("INSERT INTO note_items (board, text, position) VALUES (?1, ?2, ?3)", params![name, text, position])?;
    Ok(NoteItem { id: conn.last_insert_rowid(), text, done: false })
}

/// Changes a task's text and/or done state; returns its board.
pub fn update(conn: &Connection, id: i64, text: Option<&str>, done: Option<bool>) -> AppResult<String> {
    let board: String = conn
        .query_row("SELECT board FROM note_items WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::NotFound("this task no longer exists".into()))?;
    if let Some(text) = text {
        conn.execute("UPDATE note_items SET text = ?1 WHERE id = ?2", params![item_text(text)?, id])?;
    }
    if let Some(done) = done {
        conn.execute(
            "UPDATE note_items SET done = ?1, done_at = CASE WHEN ?1 THEN datetime('now') END WHERE id = ?2",
            params![done, id],
        )?;
    }
    Ok(board)
}

/// Deletes a task; returns its board (if it still existed).
pub fn delete(conn: &Connection, id: i64) -> AppResult<Option<String>> {
    let board: Option<String> = conn.query_row("SELECT board FROM note_items WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    conn.execute("DELETE FROM note_items WHERE id = ?1", [id])?;
    Ok(board)
}

/// Puts the board's tasks in the given order. Ids from other boards are ignored;
/// tasks missing from `ids` keep their place after the listed ones.
pub fn reorder(conn: &Connection, name: &str, ids: &[i64]) -> AppResult<()> {
    let name = board_name(name)?;
    let tx = conn.unchecked_transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute("UPDATE note_items SET position = ?1 WHERE id = ?2 AND board = ?3", params![i as i64, id, name])?;
    }
    let listed = ids.len() as i64;
    tx.execute(
        &format!(
            "UPDATE note_items SET position = position + {listed} + 1000000 WHERE board = ?1 AND id NOT IN ({})",
            if ids.is_empty() { "NULL".to_string() } else { ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",") }
        ),
        [&name],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn clear_done(conn: &Connection, name: &str) -> AppResult<usize> {
    Ok(conn.execute("DELETE FROM note_items WHERE board = ?1 AND done = 1", [board_name(name)?])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;

    #[test]
    fn boards_items_and_order() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        assert_eq!(board(&conn, "  ").unwrap().name, "Main");
        set_text(&conn, "", "shopping: milk").unwrap();
        set_text(&conn, "Main", "shopping: milk, bread").unwrap();
        assert_eq!(board(&conn, "Main").unwrap().text, "shopping: milk, bread");

        let a = add(&conn, "Main", " first ", false).unwrap();
        let b = add(&conn, "Main", "second", false).unwrap();
        let top = add(&conn, "Main", "urgent", true).unwrap();
        add(&conn, "Work", "other board", false).unwrap();
        assert!(add(&conn, "Main", "   ", false).is_err());
        let texts = |n: &str| board(&conn, n).unwrap().items.into_iter().map(|i| i.text).collect::<Vec<_>>();
        assert_eq!(texts("Main"), ["urgent", "first", "second"]);

        assert_eq!(update(&conn, a.id, Some("first!"), Some(true)).unwrap(), "Main");
        assert!(board(&conn, "Main").unwrap().items.iter().any(|i| i.text == "first!" && i.done));
        assert!(update(&conn, 999, None, Some(true)).is_err());

        reorder(&conn, "Main", &[b.id, top.id]).unwrap();
        assert_eq!(texts("Main"), ["second", "urgent", "first!"]);

        assert_eq!(clear_done(&conn, "Main").unwrap(), 1);
        assert_eq!(texts("Main"), ["second", "urgent"]);
        assert_eq!(delete(&conn, b.id).unwrap().as_deref(), Some("Main"));
        assert_eq!(texts("Main"), ["urgent"]);
        assert_eq!(texts("Work"), ["other board"]);
        assert!(set_text(&conn, "Main", &"x".repeat(MAX_TEXT + 1)).is_err());
        assert!(board(&conn, &"n".repeat(41)).is_err());
    }
}
