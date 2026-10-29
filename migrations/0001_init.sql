-- Morphie schema for Cloudflare D1. Applied with `npx wrangler d1 migrations apply morphie --remote`
-- (or --local for dev/preview). Same tables the SQLite file used, plus:
--   * chunks.embedding is base64 TEXT (D1 returns BLOBs as number arrays, which is slow and bulky)
--   * workspace_files replaces the on-disk workspace folder

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  model TEXT NOT NULL,
  secret_enc TEXT,
  base_url TEXT,
  options_enc TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_user ON provider_profiles(user_id);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  active_profile_id TEXT,
  json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS user_secrets (
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'chat',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_user ON documents(user_id);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_user ON chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);

CREATE TABLE IF NOT EXISTS designs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  next_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_designs_user ON designs(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS design_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dv_design ON design_versions(design_id, version);

-- The agent's sandboxed "folder": one row per file, scoped to the user. Replaces data/workspace/<user>/.
CREATE TABLE IF NOT EXISTS workspace_files (
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  size INTEGER NOT NULL,
  modified INTEGER NOT NULL,
  PRIMARY KEY (user_id, path)
);
