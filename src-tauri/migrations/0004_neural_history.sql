-- NETRUNNER schema v4: local NEURAL chat history (never uploaded except as
-- conversation context of the same chat when the user sends a message).
CREATE TABLE neural_chats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE neural_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL REFERENCES neural_chats (id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'model')),
    text       TEXT NOT NULL,
    model      TEXT,
    sent_json  TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_neural_messages_chat ON neural_messages (chat_id, id);
