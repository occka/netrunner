-- NETRUNNER schema v13: Quick Access entries per profile.

-- NULL = shown in every profile (all entries created before 0.8). Deleting a
-- profile keeps its shortcuts: they become visible in every profile.
ALTER TABLE quick_access ADD COLUMN profile_id INTEGER REFERENCES profiles (id) ON DELETE SET NULL;
