-- Token usage ledger: one row per model call (the Usage page, per-task budgets). Mirrors the usage_events base table in
-- src/server/db.ts (local SQLite).
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  feature TEXT NOT NULL,
  conversation_id TEXT,
  design_id TEXT,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_user_at ON usage_events(user_id, at);
