-- NETRUNNER schema v1
-- Key/value application settings. Values are JSON documents.
CREATE TABLE settings (
    key        TEXT PRIMARY KEY NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Workspace profiles. layout_json holds the COMMAND dashboard layout.
CREATE TABLE profiles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('default', 'development', 'gaming', 'media', 'custom')),
    is_builtin  INTEGER NOT NULL DEFAULT 0,
    layout_json TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Universal Quick Access entries.
CREATE TABLE quick_access (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind             TEXT NOT NULL CHECK (kind IN ('app', 'game', 'file', 'folder', 'website', 'command', 'project')),
    name             TEXT NOT NULL,
    target           TEXT NOT NULL,
    args             TEXT NOT NULL DEFAULT '',
    working_dir      TEXT NOT NULL DEFAULT '',
    shell            TEXT NOT NULL DEFAULT '' CHECK (shell IN ('', 'cmd', 'powershell')),
    icon             TEXT NOT NULL DEFAULT '',
    category         TEXT NOT NULL DEFAULT '',
    favorite         INTEGER NOT NULL DEFAULT 0,
    require_confirm  INTEGER NOT NULL DEFAULT 0,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    launch_count     INTEGER NOT NULL DEFAULT 0,
    last_launched_at TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Persistent activity log shown by the ACTIVITY LOG widget.
CREATE TABLE activity_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    level   TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
    source  TEXT NOT NULL,
    message TEXT NOT NULL
);

CREATE INDEX idx_activity_ts ON activity_log (id DESC);
