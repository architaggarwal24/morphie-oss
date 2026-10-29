import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "@/server/config";
import { BASE_SCHEMA, DB } from "@/server/db";
import { USER_CONTENT_TABLES } from "@/server/data/users";
import { MIGRATIONS, migrate, planGuestPurge } from "@/server/migrations";

/** A database exactly as the pre-sessions code left it: users(id, created_at) and no sessions table. */
function oldDb(): DB {
  const conn = new DB(new DatabaseSync(":memory:"));
  conn.exec(BASE_SCHEMA);
  return conn;
}
const cols = (conn: DB, t: string) => (conn.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
const n = (conn: DB, sql: string, ...p: unknown[]) => conn.prepare(sql).get(...p).n as number;

/** Apply migrations up to and including `id`, recording them, as migrate() would. Leaves later ones pending. */
function migrateThrough(conn: DB, id: string): void {
  conn.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const m of MIGRATIONS) {
    conn.transaction(() => { m.up(conn); conn.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, Date.now()); })();
    if (m.id === id) return;
  }
}

/** Give a user one of everything that carries user data, in the schema as it stood before 003. */
function seedData(conn: DB, userId: string, tag: string, withSession = true): void {
  const t = 1000;
  conn.prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(`c-${tag}`, userId, `chat ${tag}`, t, t);
  conn.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)").run(`c-${tag}`, `hello ${tag}`, t);
  conn.prepare("INSERT INTO designs (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(`d-${tag}`, userId, `design ${tag}`, t, t);
  conn.prepare("INSERT INTO design_versions (design_id, version, json, created_at) VALUES (?, 1, '{}', ?)").run(`d-${tag}`, t);
  conn.prepare("INSERT INTO memories (id, user_id, content, category, created_at, updated_at) VALUES (?, ?, ?, 'fact', ?, ?)").run(`m-${tag}`, userId, `memory ${tag}`, t, t);
  conn.prepare("INSERT INTO documents (id, user_id, name, kind, size, sha256, created_at) VALUES (?, ?, ?, 'txt', 1, ?, ?)").run(`doc-${tag}`, userId, `doc ${tag}`, `h-${tag}`, t);
  conn.prepare("INSERT INTO chunks (document_id, user_id, idx, text, embedding) VALUES (?, ?, 0, ?, x'00')").run(`doc-${tag}`, userId, `chunk ${tag}`);
  conn.prepare("INSERT INTO provider_profiles (id, user_id, kind, label, model, created_at, updated_at) VALUES (?, ?, 'custom', 'p', 'm', ?, ?)").run(`p-${tag}`, userId, t, t);
  conn.prepare("INSERT INTO user_settings (user_id, json) VALUES (?, '{}')").run(userId);
  conn.prepare("INSERT INTO user_secrets (user_id, name, value_enc) VALUES (?, 'tavily', 'v1.x')").run(userId);
  conn.prepare("INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(`pr-${tag}`, userId, `project ${tag}`, t, t);
  conn.prepare("INSERT INTO design_systems (id, user_id, name, json, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)").run(`ds-${tag}`, userId, `system ${tag}`, t, t);
  conn.prepare("INSERT INTO skills (id, user_id, name, markdown, created_at, updated_at) VALUES (?, ?, ?, '# x', ?, ?)").run(`sk-${tag}`, userId, `skill-${tag}`, t, t);
  conn.prepare("INSERT INTO usage_events (user_id, at, feature, input, output) VALUES (?, ?, 'chat', 10, 5)").run(userId, t);
  conn.prepare("INSERT INTO runners (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, 'h', ?)").run(`rn-${tag}`, userId, `runner ${tag}`, t);
  conn.prepare("INSERT INTO credit_holds (id, user_id, billing, credits, at, expires_at) VALUES (?, ?, 'paid', 1, ?, ?)").run(`ch-${tag}`, userId, t, t + 600_000);
  if (withSession) conn.prepare("INSERT INTO sessions (id, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(`s-${tag}`, userId, t, t, t + 1, t + 2);
}
const everyRowOf = (conn: DB, userId: string): number =>
  [...USER_CONTENT_TABLES, "sessions", "user_identities"].reduce((sum, tb) => sum + n(conn, `SELECT COUNT(*) AS n FROM ${tb} WHERE user_id = ?`, userId), 0);

afterEach(async () => vi.restoreAllMocks());

describe("schema migration", () => {
  it("upgrades a pre-sessions database in place: accounts and sessions arrive, guest-only columns never remain", async () => {
    const conn = oldDb();
    expect(cols(conn, "users")).toEqual(["id", "created_at"]);
    migrate(conn);
    expect(cols(conn, "users")).toEqual(expect.arrayContaining(["id", "created_at", "email", "email_verified_at", "display_name", "last_seen_at"]));
    expect(cols(conn, "users")).not.toEqual(expect.arrayContaining(["is_guest"]));
    expect(cols(conn, "users")).not.toEqual(expect.arrayContaining(["legacy_anonymous"]));
    expect(cols(conn, "sessions")).toEqual(expect.arrayContaining(["id", "user_id", "created_at", "last_seen_at", "idle_expires_at", "absolute_expires_at", "ip", "user_agent", "revoked_at"]));
    expect(cols(conn, "sessions")).not.toEqual(expect.arrayContaining(["linked_guest_user_id"]));
    expect(n(conn, "SELECT COUNT(*) AS n FROM schema_migrations")).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.map((m) => m.id)).toEqual(["001_users_and_sessions", "002_login_methods", "003_remove_guests", "004_passwords", "005_oauth_link", "006_projects", "007_design_systems", "008_plans", "009_sandboxes", "010_security"]);
    expect(cols(conn, "users")).toEqual(expect.arrayContaining(["password_hash", "password_updated_at"]));
  });

  it("removes the anonymous identities a pre-sessions database held (there should be none), with their data", async () => {
    const conn = oldDb();
    conn.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run("old_user_aaaaaaaaaaaa", 1000);
    seedData(conn, "old_user_aaaaaaaaaaaa", "old", false); // conversations etc. as the old code stored them; the pre-sessions schema had no sessions table
    vi.spyOn(console, "info").mockImplementation(() => {});
    migrate(conn);
    expect(n(conn, "SELECT COUNT(*) AS n FROM users")).toBe(0);
    for (const tb of ["conversations", "messages", "designs", "design_versions", "memories", "documents", "chunks", "provider_profiles", "user_settings", "user_secrets"]) {
      expect(n(conn, `SELECT COUNT(*) AS n FROM ${tb}`), tb).toBe(0);
    }
  });

  it("is idempotent: running it again changes nothing, including on a half-migrated copy", async () => {
    const conn = oldDb(); migrate(conn);
    conn.prepare("INSERT INTO users (id, created_at, email, email_verified_at, last_seen_at) VALUES ('acct1', 9, 'a@example.com', 9, 9)").run();
    const snapshot = JSON.stringify(conn.prepare("SELECT * FROM users ORDER BY id").all());
    migrate(conn); migrate(conn);
    expect(JSON.stringify(conn.prepare("SELECT * FROM users ORDER BY id").all())).toBe(snapshot);
    expect(n(conn, "SELECT COUNT(*) AS n FROM schema_migrations")).toBe(MIGRATIONS.length);
  });

  it("replaying every step after schema_migrations was lost can never delete an account", async () => {
    const conn = oldDb(); migrate(conn);
    conn.prepare("INSERT INTO users (id, created_at, email, email_verified_at, display_name, last_seen_at) VALUES ('acct1', 5, 'a@example.com', 6, 'Ada', 7)").run();
    seedData(conn, "acct1", "acct");
    const snapshot = JSON.stringify(conn.prepare("SELECT * FROM users ORDER BY id").all());
    // Replaying 001 re-adds is_guest with DEFAULT 1 to every row. 003 must still see an account (it has an email) and keep it.
    conn.exec("DELETE FROM schema_migrations");
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(() => migrate(conn)).not.toThrow();
    expect(JSON.stringify(conn.prepare("SELECT * FROM users ORDER BY id").all())).toBe(snapshot); // untouched, last_seen_at included
    expect(everyRowOf(conn, "acct1")).toBe(USER_CONTENT_TABLES.length + 1 /* sessions */);
    expect(cols(conn, "users")).not.toEqual(expect.arrayContaining(["is_guest"]));
  });

  it("enforces one account per email", async () => {
    const conn = oldDb(); migrate(conn);
    const ins = conn.prepare("INSERT INTO users (id, created_at, email) VALUES (?, 1, ?)");
    ins.run("a1", "ada@example.com");
    expect(() => ins.run("a2", "ada@example.com")).toThrow(/UNIQUE/);
  });
});

describe("003_remove_guests", () => {
  const guestId = "guest_user_aaaaaaaaaa", legacyId = "legacy_user_bbbbbbbbb", acctId = "account_user_ccccccc";

  /** A database at the schema before 003, holding two guests (one a pre-session legacy identity) and one account. */
  function before003(): DB {
    const conn = oldDb();
    migrateThrough(conn, "002_login_methods");
    const ins = conn.prepare("INSERT INTO users (id, created_at, email, email_verified_at, display_name, is_guest, legacy_anonymous, last_seen_at) VALUES (?, 1, ?, ?, ?, ?, ?, 1)");
    ins.run(guestId, null, null, null, 1, 0);
    ins.run(legacyId, null, null, null, 1, 1);
    ins.run(acctId, "ada@example.com", 5, "Ada", 0, 0);
    for (const [id, tag] of [[guestId, "g"], [legacyId, "l"], [acctId, "a"]]) seedData(conn, id, tag);
    return conn;
  }
  const only003 = (conn: DB) => migrate(conn);

  it("prints a dry-run count BEFORE deleting anything", async () => {
    const conn = before003();
    const seenAtPrint: Array<{ message: string; guestsStillThere: number; guestChatsStillThere: number }> = [];
    vi.spyOn(console, "info").mockImplementation((message: unknown) => {
      seenAtPrint.push({
        message: String(message),
        guestsStillThere: n(conn, "SELECT COUNT(*) AS n FROM users WHERE is_guest = 1"),
        guestChatsStillThere: n(conn, "SELECT COUNT(*) AS n FROM conversations WHERE user_id IN (?, ?)", guestId, legacyId),
      });
    });
    only003(conn);
    const line = seenAtPrint.find((l) => l.message.includes("003_remove_guests"));
    expect(line, "a dry-run line was logged").toBeTruthy();
    expect(line!.message).toContain("dry-run count");
    expect(line!.message).toContain("2 guest user(s)");
    expect(line!.message).toContain("1 of them old pre-session identities");
    expect(line!.message).toMatch(/2 session\(s\)/);
    expect(line!.message).toMatch(/2 conversations/);
    expect(line!.message).toMatch(/2 messages/);
    expect(line!.guestsStillThere).toBe(2);       // nothing had been deleted when the count was printed
    expect(line!.guestChatsStillThere).toBe(2);
    expect(n(conn, "SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?)", guestId, legacyId)).toBe(0); // and afterwards they are gone
  });

  it("deletes the guests' sessions and every kind of their data, and none of the account's", async () => {
    const conn = before003();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const accountRows = everyRowOf(conn, acctId);
    expect(accountRows).toBeGreaterThan(0);
    only003(conn);
    for (const id of [guestId, legacyId]) {
      expect(n(conn, "SELECT COUNT(*) AS n FROM users WHERE id = ?", id)).toBe(0);
      expect(everyRowOf(conn, id), `rows left for ${id}`).toBe(0);
    }
    expect(n(conn, "SELECT COUNT(*) AS n FROM messages WHERE conversation_id IN ('c-g', 'c-l')")).toBe(0);
    expect(n(conn, "SELECT COUNT(*) AS n FROM design_versions WHERE design_id IN ('d-g', 'd-l')")).toBe(0);
    expect(n(conn, "SELECT COUNT(*) AS n FROM users")).toBe(1);
    expect(conn.prepare("SELECT * FROM users").get()).toMatchObject({ id: acctId, email: "ada@example.com", display_name: "Ada" });
    expect(everyRowOf(conn, acctId)).toBe(accountRows);
    expect(n(conn, "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = 'c-a'")).toBe(1);
    expect(n(conn, "SELECT COUNT(*) AS n FROM design_versions WHERE design_id = 'd-a'")).toBe(1);
  });

  it("covers every table that holds user content (a new one must be added to the migration)", async () => {
    const conn = before003();
    const covered = [...USER_CONTENT_TABLES];
    const withUserId = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((t) => t.name).filter((t) => cols(conn, t).includes("user_id") && !["sessions", "user_identities"].includes(t)).sort();
    expect(withUserId).toEqual([...covered].sort());
  });

  it("removes the guests' workspace folders and leaves the account's alone", async () => {
    const conn = before003();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const root = path.join(config.dataDir, "workspace");
    for (const id of [guestId, legacyId, acctId]) { fs.mkdirSync(path.join(root, id, "notes"), { recursive: true }); fs.writeFileSync(path.join(root, id, "notes", "a.md"), "x"); }
    only003(conn);
    expect(fs.existsSync(path.join(root, guestId))).toBe(false);
    expect(fs.existsSync(path.join(root, legacyId))).toBe(false);
    expect(fs.existsSync(path.join(root, acctId, "notes", "a.md"))).toBe(true);
  });

  it("never treats a row as a guest unless it is flagged AND has no email", async () => {
    const conn = oldDb(); migrateThrough(conn, "002_login_methods");
    const ins = conn.prepare("INSERT INTO users (id, created_at, email, email_verified_at, is_guest, last_seen_at) VALUES (?, 1, ?, ?, ?, 1)");
    ins.run("flagged_with_email__", "x@example.com", 1, 1);   // inconsistent: flagged, yet someone proved an email
    ins.run("unflagged_no_email__", null, null, 0);           // inconsistent the other way
    ins.run("real_guest_aaaaaaaaa", null, null, 1);
    expect(planGuestPurge(conn).userIds).toEqual(["real_guest_aaaaaaaaa"]);
    vi.spyOn(console, "info").mockImplementation(() => {});
    only003(conn);
    expect((conn.prepare("SELECT id FROM users ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id)).toEqual(["flagged_with_email__", "unflagged_no_email__"]);
  });

  it("a guest id that is not a plain id can never point the folder removal outside data/workspace", async () => {
    const conn = oldDb(); migrateThrough(conn, "002_login_methods");
    const outside = path.join(config.dataDir, "do-not-touch"); fs.mkdirSync(outside, { recursive: true }); fs.writeFileSync(path.join(outside, "keep.txt"), "x");
    conn.prepare("INSERT INTO users (id, created_at, email, is_guest, last_seen_at) VALUES ('../do-not-touch', 1, NULL, 1, 1)").run();
    vi.spyOn(console, "info").mockImplementation(() => {});
    only003(conn);
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
    expect(n(conn, "SELECT COUNT(*) AS n FROM users")).toBe(0); // the row itself is still removed
  });

  it("says so plainly when there are no guests, and deletes nothing", async () => {
    const conn = oldDb(); migrateThrough(conn, "002_login_methods");
    conn.prepare("INSERT INTO users (id, created_at, email, email_verified_at, is_guest, last_seen_at) VALUES (?, 1, 'a@example.com', 1, 0, 1)").run(acctId);
    seedData(conn, acctId, "a");
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    only003(conn);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("0 guest users. Nothing to delete");
    expect(n(conn, "SELECT COUNT(*) AS n FROM conversations")).toBe(1);
  });

  it("stays quiet on a brand-new empty database (nothing to report)", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    migrate(oldDb());
    expect(spy).not.toHaveBeenCalled();
  });

  it("planGuestPurge finds nothing once the columns are gone", async () => {
    const conn = oldDb(); migrate(conn);
    expect(planGuestPurge(conn)).toEqual({ userIds: [], legacyAnonymous: 0, sessions: 0, rows: {} });
  });
});
