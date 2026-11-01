-- NETRUNNER schema v6: per-profile overlay sets.

-- NULL = shown in every profile (all overlays created before 0.6). Otherwise
-- the overlay belongs to that profile's set and opens only while it is active.
ALTER TABLE overlays ADD COLUMN profile_id INTEGER REFERENCES profiles (id) ON DELETE CASCADE;
