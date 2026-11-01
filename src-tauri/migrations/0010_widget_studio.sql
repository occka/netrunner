-- NETRUNNER schema v10: Widget Studio (custom widgets).

-- A custom widget belongs to a profile (NULL = every profile). Dashboard and
-- overlay instances refer to it by id (`studio.id` in their widget config).
CREATE TABLE custom_widgets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id  INTEGER REFERENCES profiles (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- html: own HTML/CSS in a sandboxed frame; text, counter, links, feed: templates.
    kind        TEXT NOT NULL CHECK (kind IN ('html', 'text', 'counter', 'links', 'feed')),
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
