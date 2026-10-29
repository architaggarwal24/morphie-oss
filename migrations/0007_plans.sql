-- Plans and credits (hosted edition). Mirrors the memberships / credit_grants / app_config base tables in
-- src/server/db.ts and migration 008_plans in src/server/migrations.ts (local SQLite).

-- A plan given to an email address (by an admin now, by a payment later). Keyed by email so a plan can be granted
-- before the person signs up; it only applies to an account whose email is verified.
CREATE TABLE IF NOT EXISTS memberships (
  email TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  unlimited INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'admin',
  billing TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  note TEXT NOT NULL DEFAULT '',
  granted_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Bonus premium credits on top of a plan's monthly allowance, until they expire.
CREATE TABLE IF NOT EXISTS credit_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  credits REAL NOT NULL,
  at INTEGER NOT NULL,
  expires_at INTEGER,
  note TEXT NOT NULL DEFAULT '',
  granted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_credit_grants_email ON credit_grants(email);

-- Server-wide settings an admin edits in the app (plan limits, the hosted model list, spend budgets).
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- What each call cost in credits, and how it was paid for: '' (your own key), 'free' or 'paid' (Morphie AI).
ALTER TABLE usage_events ADD COLUMN credits REAL NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN billing TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_usage_billing_at ON usage_events(billing, at);
