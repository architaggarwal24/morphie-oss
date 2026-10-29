import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db, RunInfo, StmtSpec } from "@/server/db";

/**
 * Test-only implementation of the `Db` interface on top of node:sqlite (in-memory), loading the exact same
 * migration the production D1 database uses, so tests exercise the real schema.
 */
export function createSqliteDb(): Db & { raw: DatabaseSync } {
  const conn = new DatabaseSync(":memory:");
  const migrations = path.resolve(process.cwd(), "migrations");
  for (const f of fs.readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) {
    conn.exec(fs.readFileSync(path.join(migrations, f), "utf8"));
  }
  const clean = (params: unknown[]) => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p)) as any[];
  return {
    raw: conn,
    async get(sql, ...params) { return conn.prepare(sql).get(...clean(params)) as any; },
    async all(sql, ...params) { return conn.prepare(sql).all(...clean(params)) as any[]; },
    async run(sql, ...params): Promise<RunInfo> {
      const r = conn.prepare(sql).run(...clean(params));
      return { changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
    },
    async batch(stmts: StmtSpec[]) {
      conn.exec("BEGIN IMMEDIATE");
      try {
        for (const s of stmts) conn.prepare(s.sql).run(...clean(s.params));
        conn.exec("COMMIT");
      } catch (e) {
        try { conn.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw e;
      }
    },
  };
}
