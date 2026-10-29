import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { DB } from "./db";

/**
 * Idempotent, ordered schema migrations. Each runs once inside a transaction and is recorded in schema_migrations.
 * Every step also checks what already exists, so re-running it (or running it on a half-migrated copy) is harmless.
 * The base tables are still created by SCHEMA in db.ts (CREATE TABLE IF NOT EXISTS); migrations only evolve them.
 */
interface Migration { id: string; up(conn: DB): void }

function hasColumn(conn: DB, table: string, column: string): boolean {
  return (conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

function addColumn(conn: DB, table: string, column: string, ddl: string): boolean {
  if (hasColumn(conn, table, column)) return false;
  conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}


/** Tables with a user_id column. Keep in step with USER_CONTENT_TABLES in data/users.ts (db.ts imports this file, so it can't import that one). */
const USER_DATA_TABLES = ["designs", "conversations", "chunks", "documents", "memories", "user_secrets", "user_settings", "provider_profiles", "projects", "design_systems", "usage_events", "skills", "runners", "credit_holds"] as const;

/**
 * Guests were users rows that never signed up. A row is only ever treated as one when everything agrees: it is flagged
 * is_guest and it has no email (accounts are only created from a proven email). So even a database whose
 * schema_migrations was lost and replayed (001 re-adds is_guest with DEFAULT 1 to every row) cannot lose an account.
 */
const GUEST_USERS = "SELECT id FROM users WHERE is_guest = 1 AND email IS NULL";

export interface GuestPurgePlan {
  userIds: string[];
  /** Of those, the ones that existed before sessions did (the old anonymous-cookie identities). */
  legacyAnonymous: number;
  sessions: number;
  /** Rows that belong to those users, by table (messages and design_versions are counted through their parents). */
  rows: Record<string, number>;
}

/** Read-only: what migration 003 is about to delete. */
export function planGuestPurge(conn: DB): GuestPurgePlan {
  if (!hasColumn(conn, "users", "is_guest")) return { userIds: [], legacyAnonymous: 0, sessions: 0, rows: {} };
  const count = (sql: string): number => conn.prepare(sql).get().n as number;
  const rows: Record<string, number> = {};
  for (const t of USER_DATA_TABLES) rows[t] = count(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id IN (${GUEST_USERS})`);
  rows.messages = count(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id IN (${GUEST_USERS}))`);
  rows.design_versions = count(`SELECT COUNT(*) AS n FROM design_versions WHERE design_id IN (SELECT id FROM designs WHERE user_id IN (${GUEST_USERS}))`);
  rows.user_identities = count(`SELECT COUNT(*) AS n FROM user_identities WHERE user_id IN (${GUEST_USERS})`);
  return {
    userIds: (conn.prepare(GUEST_USERS).all() as Array<{ id: string }>).map((r) => r.id),
    legacyAnonymous: hasColumn(conn, "users", "legacy_anonymous") ? count(`SELECT COUNT(*) AS n FROM users WHERE id IN (${GUEST_USERS}) AND legacy_anonymous = 1`) : 0,
    sessions: count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id IN (${GUEST_USERS})`),
    rows,
  };
}

function describePlan(p: GuestPurgePlan): string {
  if (!p.userIds.length) return "0 guest users. Nothing to delete";
  const data = Object.entries(p.rows).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t}`).join(", ") || "no data rows";
  const legacy = p.legacyAnonymous ? ` (${p.legacyAnonymous} of them old pre-session identities)` : "";
  return `${p.userIds.length} guest user(s)${legacy}, ${p.sessions} session(s), ${data}, plus their workspace folders. Deleting them now`;
}

/** Remove the workspace folders of deleted users. Ids are re-validated so a corrupt row can never point outside data/workspace. */
function removeWorkspaces(userIds: string[]): void {
  const root = path.resolve(config.dataDir, "workspace");
  for (const id of userIds) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) continue;
    const dir = path.resolve(root, id);
    if (!dir.startsWith(root + path.sep)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function dropColumn(conn: DB, table: string, column: string): void {
  if (hasColumn(conn, table, column)) conn.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

export const MIGRATIONS: Migration[] = [
  {
    id: "001_users_and_sessions",
    up(conn) {
      // A database that already has `email` has been through this step (003 later drops is_guest again), so it is not a first run.
      const firstRun = !hasColumn(conn, "users", "is_guest") && !hasColumn(conn, "users", "email");
      addColumn(conn, "users", "email", "TEXT");
      addColumn(conn, "users", "email_verified_at", "INTEGER");
      addColumn(conn, "users", "display_name", "TEXT");
      addColumn(conn, "users", "is_guest", "INTEGER NOT NULL DEFAULT 1");
      addColumn(conn, "users", "last_seen_at", "INTEGER");
      addColumn(conn, "users", "legacy_anonymous", "INTEGER NOT NULL DEFAULT 0");
      if (firstRun) {
        // Every identity that existed before sessions did was an anonymous browser with long-lived data.
        // They stay guests, but are flagged so a future guest sweeper never deletes their data behind their back.
        conn.exec("UPDATE users SET legacy_anonymous = 1, last_seen_at = created_at");
      }
      conn.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,                 -- SHA-256 (hex) of the cookie token; the token itself is never stored
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
      `);
    },
  },
  {
    id: "002_login_methods",
    up(conn) {
      addColumn(conn, "sessions", "linked_guest_user_id", "TEXT");
      conn.exec(`
        CREATE TABLE IF NOT EXISTS user_identities (
          provider TEXT NOT NULL,              -- google | github
          provider_user_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          email TEXT NOT NULL,                 -- the verified email at link time
          created_at INTEGER NOT NULL,
          PRIMARY KEY (provider, provider_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);

        CREATE TABLE IF NOT EXISTS email_codes (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          code_hash TEXT NOT NULL,             -- HMAC of the code; the code is never stored
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          ip TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_codes_email ON email_codes(email, created_at DESC);

        CREATE TABLE IF NOT EXISTS oauth_states (
          state_hash TEXT PRIMARY KEY,         -- SHA-256 of the state value held in the browser cookie
          provider TEXT NOT NULL,
          verifier_enc TEXT NOT NULL,          -- PKCE code verifier, encrypted
          return_to TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER
        );
      `);
    },
  },
  {
    // There is no guest mode: no anonymous identity, no cookie and no rows for a visitor who has not signed in.
    // This removes whatever guest users an earlier build may have created, with their sessions and data, and then the
    // columns that only existed for them. Replaying it is harmless (it finds nothing and the columns are already gone).
    id: "003_remove_guests",
    up(conn) {
      const plan = planGuestPurge(conn);
      const anyUsers = (conn.prepare("SELECT COUNT(*) AS n FROM users").get().n as number) > 0;
      // The count is printed BEFORE anything is deleted. A brand-new, empty database has nothing worth reporting.
      if (anyUsers) console.info(`[migrate] 003_remove_guests dry-run count: ${describePlan(plan)}.`);

      if (plan.userIds.length) {
        const guests = `(${GUEST_USERS})`;
        conn.exec(`
          DELETE FROM design_versions WHERE design_id IN (SELECT id FROM designs WHERE user_id IN ${guests});
          DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id IN ${guests});
          ${USER_DATA_TABLES.map((t) => `DELETE FROM ${t} WHERE user_id IN ${guests};`).join("\n          ")}
          DELETE FROM user_identities WHERE user_id IN ${guests};
          DELETE FROM sessions WHERE user_id IN ${guests};
          DELETE FROM users WHERE id IN ${guests};
        `);
      }
      dropColumn(conn, "users", "is_guest");
      dropColumn(conn, "users", "legacy_anonymous");
      dropColumn(conn, "sessions", "linked_guest_user_id");
      // Files last: if anything above failed the whole step rolls back and no file has been touched.
      removeWorkspaces(plan.userIds);
    },
  },
  {
    // Email + password accounts (src/server/auth/password.ts). Only a scrypt hash is stored. An account made this way
    // has email_verified_at NULL until some login method proves the address.
    id: "004_passwords",
    up(conn) {
      addColumn(conn, "users", "password_hash", "TEXT");
      addColumn(conn, "users", "password_updated_at", "INTEGER");
    },
  },
  {
    // "Connect Google/GitHub" from the Account page: an OAuth round trip that links the identity to the account that
    // started it (instead of signing in). The state row remembers that account; NULL means an ordinary login.
    id: "005_oauth_link",
    up(conn) {
      addColumn(conn, "oauth_states", "link_user_id", "TEXT");
    },
  },
  {
    // Code projects for the agent: a sandboxed folder (optionally a cloned Git repository) that agent tasks work in.
    // A task (conversation in agent mode) can belong to one project. Mirrors migrations/0003_projects.sql (D1).
    id: "006_projects",
    up(conn) {
      // The projects table itself is a base table (BASE_SCHEMA in db.ts); tasks gain a link to one.
      addColumn(conn, "conversations", "project_id", "TEXT");
    },
  },
  {
    // Design systems (a base table in db.ts); a design can follow one. Mirrors migrations/0004_design_systems.sql (D1).
    id: "007_design_systems",
    up(conn) {
      addColumn(conn, "designs", "system_id", "TEXT");
    },
  },
  {
    // Plans and credits: what each model call cost and how it was paid for ('' = the user's own key, 'free' or 'paid'
    // = Morphie AI). The plan tables themselves are base tables (db.ts). Mirrors migrations/0007_plans.sql (D1).
    id: "008_plans",
    up(conn) {
      addColumn(conn, "usage_events", "credits", "REAL NOT NULL DEFAULT 0");
      addColumn(conn, "usage_events", "billing", "TEXT NOT NULL DEFAULT ''");
      conn.exec("CREATE INDEX IF NOT EXISTS idx_usage_billing_at ON usage_events(billing, at)");
    },
  },
  {
    // Where each code project runs: '' (the server's sandbox), 'lite' (files only) or 'runner:<id>' (a Morphie Runner).
    // The runners table is a base table (db.ts). Mirrors migrations/0009_sandboxes.sql (D1).
    id: "009_sandboxes",
    up(conn) {
      addColumn(conn, "projects", "sandbox", "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    // Security hardening: a site-wide cap on sign-in emails counts codes by time. The rate_limits and credit_holds
    // tables are base tables (db.ts). Mirrors migrations/0010_security.sql.
    id: "010_security",
    up(conn) {
      conn.exec("CREATE INDEX IF NOT EXISTS idx_codes_created ON email_codes(created_at)");
    },
  },
];

export function migrate(conn: DB): void {
  conn.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const m of MIGRATIONS) {
    if (conn.prepare("SELECT 1 AS x FROM schema_migrations WHERE id = ?").get(m.id)) continue;
    conn.transaction(() => {
      m.up(conn);
      conn.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, Date.now());
    })();
  }
}
