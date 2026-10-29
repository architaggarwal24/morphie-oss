-- Brings the D1 database up to the schema the app actually uses: accounts, sessions and sign-in methods.
-- (0001 created only the content tables; the local SQLite file grows the same way through src/server/migrations.ts.)
-- Apply with `npx wrangler d1 migrations apply morphie --remote` (or --local).
-- tests/d1-schema.test.ts fails if this folder and the local schema ever drift apart.

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_updated_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

-- Opaque sessions: only the SHA-256 of the cookie token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(absolute_expires_at);

-- Email one-time codes: an HMAC of the code, never the code.
CREATE TABLE IF NOT EXISTS email_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_codes_email ON email_codes(email, created_at DESC);

-- Google/GitHub OAuth round trips (state + PKCE verifier); link_user_id marks "Connect" from the Account page.
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  verifier_enc TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  link_user_id TEXT
);

CREATE TABLE IF NOT EXISTS user_identities (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);
