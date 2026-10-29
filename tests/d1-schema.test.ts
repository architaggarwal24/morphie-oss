import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BASE_SCHEMA, DB } from "@/server/db";
import { migrate } from "@/server/migrations";

/**
 * The same data lives in two engines: a local SQLite file (schema = BASE_SCHEMA + src/server/migrations.ts) and
 * Cloudflare D1 (schema = migrations/*.sql, applied by wrangler). This keeps them in step: every table, column and
 * index one has, the other has too. Add a schema change to BOTH places, or this fails.
 */
type Shape = Record<string, { columns: string[]; indexes: string[] }>;

function shape(conn: DatabaseSync): Shape {
  const out: Shape = {};
  const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'd1_migrations')").all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const columns = (conn.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((c) => c.name).sort();
    const indexes = (conn.prepare(`PRAGMA index_list(${name})`).all() as Array<{ name: string; origin: string }>).filter((i) => i.origin === "c").map((i) => i.name).sort();
    out[name] = { columns, indexes };
  }
  return out;
}

function d1Schema(): DatabaseSync {
  const conn = new DatabaseSync(":memory:");
  const dir = path.resolve("migrations");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) conn.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  return conn;
}

function localSchema(): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  const conn = new DB(raw);
  conn.exec(BASE_SCHEMA);
  migrate(conn);
  return raw;
}

describe("D1 migrations match the local schema", () => {
  it("every table has the same columns and indexes in both engines", () => {
    const d1 = shape(d1Schema());
    const local = shape(localSchema());
    // The agent's files live in R2 / the data folder, not in a table; 0001 created this one before that existed.
    delete d1.workspace_files;
    expect(d1).toEqual(local);
  });

  it("migration files are numbered, in order, and never edited in place (new changes go in a new file)", () => {
    const files = fs.readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort();
    expect(files.map((f) => f.slice(0, 4))).toEqual(files.map((_, i) => String(i + 1).padStart(4, "0")));
    // 0001 has been applied to real databases; changing it would never reach them.
    expect(fs.readFileSync("migrations/0001_init.sql", "utf8")).toContain("CREATE TABLE IF NOT EXISTS workspace_files");
  });

  it("the D1 schema accepts the app's writes (uniqueness on email, composite keys)", () => {
    const conn = d1Schema();
    conn.prepare("INSERT INTO users (id, created_at, email) VALUES ('u1', 1, 'a@x.io')").run();
    expect(() => conn.prepare("INSERT INTO users (id, created_at, email) VALUES ('u2', 1, 'a@x.io')").run()).toThrow(/UNIQUE/);
    conn.prepare("INSERT INTO user_identities (provider, provider_user_id, user_id, email, created_at) VALUES ('github', '1', 'u1', 'a@x.io', 1)").run();
    expect(() => conn.prepare("INSERT INTO user_identities (provider, provider_user_id, user_id, email, created_at) VALUES ('github', '1', 'u2', 'b@x.io', 1)").run()).toThrow(/UNIQUE|PRIMARY/);
  });
});
