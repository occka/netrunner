-- NETRUNNER schema v5: widget settings on overlays, web overlays (music /
-- video sites in a floating window) and BROWSER data.

-- Overlay widget settings (same shape as WidgetInstance.config) and, for
-- widget_type = 'web', the page the overlay shows.
ALTER TABLE overlays ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE overlays ADD COLUMN url TEXT NOT NULL DEFAULT '';
ALTER TABLE overlays ADD COLUMN title TEXT NOT NULL DEFAULT '';

CREATE TABLE browser_bookmarks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Private tabs never write here; the user can turn history off entirely.
CREATE TABLE browser_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    visited_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX browser_history_visited ON browser_history (visited_at DESC);

-- Permissions the user granted to a site (everything else is denied).
CREATE TABLE browser_site_permissions (
    host       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (host, kind)
);
