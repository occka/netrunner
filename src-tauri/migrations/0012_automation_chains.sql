-- NETRUNNER schema v12: automation rules with several conditions and a chain
-- of actions. Trigger and action kinds are validated in Rust (services/automation.rs),
-- so new kinds no longer need a table rebuild. Existing rules keep their single
-- action and their profile condition.
CREATE TABLE automations_v12 (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    trigger_kind    TEXT NOT NULL,
    trigger_value   TEXT NOT NULL DEFAULT '',
    -- [{ "kind": "profile", "value": "3" }, …] — all must hold.
    conditions_json TEXT NOT NULL DEFAULT '[]',
    -- [{ "kind": "launch_program", "value": "C:\\x.exe", "args": "" }, …] — run in order.
    actions_json    TEXT NOT NULL DEFAULT '[]',
    run_count       INTEGER NOT NULL DEFAULT 0,
    last_run_at     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO automations_v12 (id, name, enabled, trigger_kind, trigger_value, conditions_json, actions_json, run_count, last_run_at, created_at)
SELECT id, name, enabled, trigger_kind, trigger_value,
       CASE WHEN condition_profile_id IS NULL THEN '[]'
            ELSE json_array(json_object('kind', 'profile', 'value', CAST(condition_profile_id AS TEXT))) END,
       json_array(json_object('kind', action_kind, 'value', action_value, 'args', action_args)),
       run_count, last_run_at, created_at
FROM automations;

DROP TABLE automations;
ALTER TABLE automations_v12 RENAME TO automations;
