-- NETRUNNER schema v2: floating overlays and automation rules.
CREATE TABLE overlays (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    widget_type     TEXT NOT NULL,
    x               INTEGER NOT NULL DEFAULT 80,
    y               INTEGER NOT NULL DEFAULT 80,
    width           INTEGER NOT NULL DEFAULT 340,
    height          INTEGER NOT NULL DEFAULT 260,
    opacity         REAL NOT NULL DEFAULT 0.92 CHECK (opacity BETWEEN 0.2 AND 1.0),
    locked          INTEGER NOT NULL DEFAULT 0,
    visible         INTEGER NOT NULL DEFAULT 1,
    show_on_startup INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE automations (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    enabled              INTEGER NOT NULL DEFAULT 1,
    trigger_kind         TEXT NOT NULL CHECK (trigger_kind IN ('netrunner_start', 'app_started', 'app_stopped', 'profile_changed', 'manual')),
    trigger_value        TEXT NOT NULL DEFAULT '',
    condition_profile_id INTEGER REFERENCES profiles (id) ON DELETE SET NULL,
    action_kind          TEXT NOT NULL CHECK (action_kind IN ('launch_entry', 'switch_profile', 'notify', 'show_overlay', 'hide_overlay')),
    action_value         TEXT NOT NULL DEFAULT '',
    run_count            INTEGER NOT NULL DEFAULT 0,
    last_run_at          TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
