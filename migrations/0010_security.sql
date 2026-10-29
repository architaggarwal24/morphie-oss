-- Security hardening. Mirrors migration 010_security in src/server/migrations.ts and the rate_limits / credit_holds
-- base tables in src/server/db.ts.

-- Rate limits that hold across every Worker instance (sign-in, sign-up, codes). Keys are hashed.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- Morphie AI credits set aside for a model call in flight, so parallel runs can't spend the same credits twice.
CREATE TABLE IF NOT EXISTS credit_holds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  billing TEXT NOT NULL,
  credits REAL NOT NULL,
  at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_holds_user ON credit_holds(user_id, expires_at);

-- The site-wide cap on sign-in emails counts codes by time.
CREATE INDEX IF NOT EXISTS idx_codes_created ON email_codes(created_at);
