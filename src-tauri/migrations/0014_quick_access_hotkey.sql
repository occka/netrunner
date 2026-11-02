-- NETRUNNER schema v14: a global key per Quick Access entry (normalised, e.g. Ctrl+Alt+1; '' = none).
ALTER TABLE quick_access ADD COLUMN hotkey TEXT NOT NULL DEFAULT '';
