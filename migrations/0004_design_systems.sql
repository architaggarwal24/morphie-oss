-- Design systems: brand tokens, voice and guidelines that designs can follow; a design can be linked to one.
-- Mirrors step 007_design_systems in src/server/migrations.ts.
CREATE TABLE IF NOT EXISTS design_systems (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_systems_user ON design_systems(user_id, updated_at DESC);
ALTER TABLE designs ADD COLUMN system_id TEXT;
