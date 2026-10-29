-- Skills the user installed (from GitHub, an upload, or written in the app). SKILL.md lives here; any other files of
-- the skill are in blob storage under skills/<user>/<id>/. Mirrors the skills base table in src/server/db.ts.
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'agent',
  manual INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '{}',
  markdown TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_user_name ON skills(user_id, name);
