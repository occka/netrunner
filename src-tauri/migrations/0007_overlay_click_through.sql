-- NETRUNNER schema v7: click-through overlays.

-- When set, a locked overlay lets the mouse pass through to the window below.
ALTER TABLE overlays ADD COLUMN click_through INTEGER NOT NULL DEFAULT 0;
