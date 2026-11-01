-- NETRUNNER schema v11: playtime per game.

-- One row per play session. `ended_at` is moved forward while the game runs,
-- so a crash or power loss loses at most one tracker interval.
CREATE TABLE game_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Library id (`steam:<appid>`, `epic:…`, `gog:…`, `prism:…`) or `qa:<entry id>` for your own games.
    game_id    TEXT NOT NULL,
    -- Name at the time, so history survives a game being uninstalled.
    name       TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER NOT NULL
);
CREATE INDEX game_sessions_game ON game_sessions (game_id, started_at);
CREATE INDEX game_sessions_ended ON game_sessions (ended_at);
