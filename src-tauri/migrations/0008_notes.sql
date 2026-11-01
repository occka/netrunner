-- NETRUNNER schema v8: Notes / to-do widget. Stored only in this database.

-- A board is shared by every Notes widget (dashboard or overlay) set to its name.
CREATE TABLE note_boards (
    name       TEXT PRIMARY KEY,
    text       TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE note_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    board      TEXT NOT NULL,
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    done_at    TEXT
);
CREATE INDEX note_items_board ON note_items (board, position);
