import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { cfEnv } from "./cf";
import { config } from "./config";
import { migrate } from "./migrations";

/**
 * SQLite via Node's built-in `node:sqlite` (Node >= 22.13): no native module to compile, nothing to install.
 * This thin wrapper adds the two conveniences the rest of the code relies on: pragma() and transaction().
 */
/** Statement surface we use. Rows are untyped here; each store casts to its own row shape. */
export interface SqliteStmt {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export class DB {
  constructor(private conn: DatabaseSync) {}
  prepare(sql: string): SqliteStmt { return this.conn.prepare(sql) as unknown as SqliteStmt; }
  exec(sql: string): void { this.conn.exec(sql); }
  pragma(statement: string): void { this.conn.exec(`PRAGMA ${statement}`); }
  close(): void { this.conn.close(); }
  private depth = 0;
  /**
   * Returns a function that runs `fn` atomically (BEGIN IMMEDIATE … COMMIT, ROLLBACK on error). Re-entrant: called
   * inside another transaction it simply joins it, and the outermost one commits or rolls back everything.
   */
  transaction<T>(fn: () => T): () => T {
    return () => {
      if (this.depth > 0) { this.depth++; try { return fn(); } finally { this.depth--; } }
      this.conn.exec("BEGIN IMMEDIATE");
      this.depth = 1;
      try {
        const out = fn();
        this.conn.exec("COMMIT");
        return out;
      } catch (e) {
        try { this.conn.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw e;
      } finally {
        this.depth = 0;
      }
    };
  }
}

export const BASE_SCHEMA = `
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
  embedding BLOB NOT NULL
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

-- Code projects for the agent: a sandboxed folder, optionally a cloned Git repository. Mirrors migrations/0003_projects.sql.
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

-- Design systems: brand tokens, voice and guidelines that designs can follow. Mirrors migrations/0004_design_systems.sql.
CREATE TABLE IF NOT EXISTS design_systems (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_systems_user ON design_systems(user_id, updated_at DESC);

-- Token usage ledger: one row per model call. Mirrors migrations/0005_usage.sql.
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

-- Installed skills: SKILL.md here, other files in blob storage. Mirrors migrations/0006_skills.sql.
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

-- Plans (hosted edition): a plan per email, bonus credits, and admin-edited server settings. Mirrors migrations/0007_plans.sql.
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

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Payments: plan orders (by verified email) and the bank alerts that confirm them. Mirrors migrations/0008_payments.sql.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  plan TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'upi',
  status TEXT NOT NULL,
  utr TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  decided_by TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_utr ON orders(utr) WHERE utr IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  dkim TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  amount INTEGER,
  utr TEXT,
  order_id TEXT,
  outcome TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_payment_inbox_at ON payment_inbox(at);

-- Morphie Runners (a program on the user's own machine that runs their code projects). Mirrors migrations/0009_sandboxes.sql.
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

-- Rate limits that hold across every server instance (sign-in, sign-up, codes). Keys are hashed. Mirrors migrations/0010_security.sql.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- Morphie AI credits set aside for a model call in flight, so parallel runs can't spend the same credits twice.
-- Mirrors migrations/0010_security.sql.
CREATE TABLE IF NOT EXISTS credit_holds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  billing TEXT NOT NULL,
  credits REAL NOT NULL,
  at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_holds_user ON credit_holds(user_id, expires_at);
`;

const g = globalThis as unknown as { __morphieDb?: DB; __morphieDbPath?: string; __morphieSqlite?: { conn: DB; db: Db } };

/**
 * The local SQLite file (Node: `next dev`, `next start`, tests). One connection per process, kept across hot reloads.
 * Synchronous; only the SQLite driver below and the schema migrations use it directly.
 */
export function sqliteConn(): DB {
  const file = path.join(config.dataDir, "morphie.db");
  if (g.__morphieDb && g.__morphieDbPath === file) return g.__morphieDb;
  g.__morphieDb?.close();
  const conn = new DB(new DatabaseSync(file));
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 5000");
  conn.exec(BASE_SCHEMA);
  migrate(conn);
  g.__morphieDb = conn;
  g.__morphieDbPath = file;
  return conn;
}

// ------------------------------------------------------------------ the async database every store uses

export interface RunInfo { changes: number; lastRowId: number }
/** One statement for `batch`. Build it with `stmt(sql, ...params)`. */
export interface Stmt { sql: string; params: unknown[] }
export const stmt = (sql: string, ...params: unknown[]): Stmt => ({ sql, params });

/**
 * The database as the rest of the server sees it: the same four async calls on SQLite (local) and Cloudflare D1.
 * Only positional `?` parameters (D1 has no named ones). There are no interactive transactions (D1 has none):
 * `batch` runs its statements atomically (all or nothing), so read first, then write everything that must
 * happen together in one batch, using SQL conditions (WHERE / NOT EXISTS / ON CONFLICT) to stay race-safe.
 */
export interface Db {
  readonly kind: "sqlite" | "d1";
  get<T = any>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = any>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<RunInfo>;
  batch(stmts: Stmt[]): Promise<RunInfo[]>;
}

/** Both engines get the same values: undefined becomes NULL and booleans 0/1 (D1 rejects undefined outright). */
const clean = (params: unknown[]): any[] => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));

class SqliteDb implements Db {
  readonly kind = "sqlite" as const;
  constructor(private conn: DB) {}
  async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> { return (this.conn.prepare(sql).get(...clean(params)) ?? undefined) as T | undefined; }
  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> { return this.conn.prepare(sql).all(...clean(params)) as T[]; }
  async run(sql: string, ...params: unknown[]): Promise<RunInfo> {
    const r = this.conn.prepare(sql).run(...clean(params));
    return { changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
  }
  async batch(stmts: Stmt[]): Promise<RunInfo[]> {
    return this.conn.transaction(() => stmts.map((s) => {
      const r = this.conn.prepare(s.sql).run(...clean(s.params));
      return { changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
    }))();
  }
}

class D1Db implements Db {
  readonly kind = "d1" as const;
  constructor(private d1: D1DatabaseLike) {}
  private prep(sql: string, params: unknown[]) { return this.d1.prepare(sql).bind(...clean(params)); }
  async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> { return ((await this.prep(sql, params).first<T>()) ?? undefined) as T | undefined; }
  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> { return (await this.prep(sql, params).all<T>()).results ?? []; }
  async run(sql: string, ...params: unknown[]): Promise<RunInfo> {
    const r = await this.prep(sql, params).run();
    return { changes: Number(r.meta?.changes ?? 0), lastRowId: Number(r.meta?.last_row_id ?? 0) };
  }
  async batch(stmts: Stmt[]): Promise<RunInfo[]> {
    if (!stmts.length) return [];
    const out = (await this.d1.batch(stmts.map((s) => this.prep(s.sql, s.params)))) as Array<{ meta?: { changes?: number; last_row_id?: number } }>;
    return out.map((r) => ({ changes: Number(r?.meta?.changes ?? 0), lastRowId: Number(r?.meta?.last_row_id ?? 0) }));
  }
}

/** The D1 binding when running on Cloudflare Workers; undefined under Node (no Workers context). */
function d1Binding(): D1DatabaseLike | undefined {
  try { return cfEnv().DB; } catch { return undefined; }
}

/** The database for this request: D1 on Workers, the SQLite file everywhere else. */
export function db(): Db {
  const d1 = d1Binding();
  if (d1) return new D1Db(d1);
  const conn = sqliteConn();
  if (g.__morphieSqlite?.conn !== conn) g.__morphieSqlite = { conn, db: new SqliteDb(conn) };
  return g.__morphieSqlite.db;
}

/** True for a UNIQUE / PRIMARY KEY violation on either engine (their messages differ slightly). */
export function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)/i.test(String((e as Error)?.message ?? e));
}

export function now(): number {
  return Date.now();
}
