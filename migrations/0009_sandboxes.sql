-- Pluggable sandboxes: where each code project runs. '' = the server's own (container or local folder), 'lite' =
-- files only in storage (works on every plan), 'runner:<id>' = a Morphie Runner on the user's own machine.
-- Mirrors migration 009_sandboxes in src/server/migrations.ts and the runners base table in src/server/db.ts.
ALTER TABLE projects ADD COLUMN sandbox TEXT NOT NULL DEFAULT '';

-- Morphie Runners: a small program on the user's computer or VM that runs their projects. Only a hash of its token.
CREATE TABLE IF NOT EXISTS runners (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runners_user ON runners(user_id);
