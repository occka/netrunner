-- NETRUNNER schema v3: automation can launch a program directly (path + arguments).
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt.
CREATE TABLE automations_v3 (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    enabled              INTEGER NOT NULL DEFAULT 1,
    trigger_kind         TEXT NOT NULL CHECK (trigger_kind IN ('netrunner_start', 'app_started', 'app_stopped', 'profile_changed', 'manual')),
    trigger_value        TEXT NOT NULL DEFAULT '',
    condition_profile_id INTEGER REFERENCES profiles (id) ON DELETE SET NULL,
    action_kind          TEXT NOT NULL CHECK (action_kind IN ('launch_program', 'launch_entry', 'switch_profile', 'notify', 'show_overlay', 'hide_overlay')),
    action_value         TEXT NOT NULL DEFAULT '',
    action_args          TEXT NOT NULL DEFAULT '',
    run_count            INTEGER NOT NULL DEFAULT 0,
    last_run_at          TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO automations_v3 (id, name, enabled, trigger_kind, trigger_value, condition_profile_id, action_kind, action_value, run_count, last_run_at, created_at)
SELECT id, name, enabled, trigger_kind, trigger_value, condition_profile_id, action_kind, action_value, run_count, last_run_at, created_at
FROM automations;

DROP TABLE automations;
ALTER TABLE automations_v3 RENAME TO automations;
