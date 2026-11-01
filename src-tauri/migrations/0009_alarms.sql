-- NETRUNNER schema v9: alarms and countdown timers (Timer / Alarm widget).
-- The schedule runs in the backend, so they ring while NETRUNNER is in the tray.

CREATE TABLE alarms (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    label          TEXT NOT NULL DEFAULT '',
    -- Local wall-clock time, 'HH:MM'.
    time           TEXT NOT NULL,
    -- Repeat days: bit 0 = Monday … bit 6 = Sunday. 0 = ring once, then switch off.
    days           INTEGER NOT NULL DEFAULT 0 CHECK (days BETWEEN 0 AND 127),
    -- A built-in sound name or an imported file (`snd-…`) from the sounds folder.
    sound          TEXT NOT NULL DEFAULT 'pulse',
    volume         INTEGER NOT NULL DEFAULT 80 CHECK (volume BETWEEN 0 AND 100),
    snooze_minutes INTEGER NOT NULL DEFAULT 5 CHECK (snooze_minutes BETWEEN 1 AND 60),
    enabled        INTEGER NOT NULL DEFAULT 1,
    -- Unix ms of the next ring after Snooze.
    snoozed_until  INTEGER,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE timers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    label        TEXT NOT NULL DEFAULT '',
    duration_ms  INTEGER NOT NULL CHECK (duration_ms > 0),
    -- Unix ms when a running timer ends; NULL when stopped or paused.
    ends_at      INTEGER,
    -- Time left while paused; NULL when running or reset.
    remaining_ms INTEGER,
    sound        TEXT NOT NULL DEFAULT 'chime',
    volume       INTEGER NOT NULL DEFAULT 80 CHECK (volume BETWEEN 0 AND 100),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
