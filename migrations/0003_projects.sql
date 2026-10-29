-- Code projects for the agent: a sandboxed folder (optionally a cloned Git repository) that agent tasks work in.
-- A task (conversation in agent mode) can belong to one project. Mirrors step 006_projects in src/server/migrations.ts.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  repo_url TEXT,
  branch TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);
ALTER TABLE conversations ADD COLUMN project_id TEXT;
