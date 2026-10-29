/**
 * Stand-in for "@opennextjs/cloudflare" under vitest (aliased in vitest.config.mts).
 *
 * Normally there is no Workers runtime, so getCloudflareContext() throws and the server falls back to the local SQLite
 * file, local file storage and the in-process coordinator, exactly as under `next dev`.
 *
 * With MORPHIE_TEST_CLOUDFLARE=1 (`npm run test:cloudflare`) it hands out Workers-shaped bindings instead, so the whole
 * suite runs through the D1 and R2 code paths: DB is a D1 look-alike (prepare/bind/first/all/run/batch, NULL for
 * missing rows, atomic batches) over the same SQLite connection the tests inspect, and FILES is an in-memory R2 bucket.
 */
import { sqliteConn } from "@/server/db";

class FakeStatement {
  constructor(private sql: string, private params: unknown[] = []) {}
  bind(...values: unknown[]) {
    for (const v of values) if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
    return new FakeStatement(this.sql, values);
  }
  private stmt() { return sqliteConn().prepare(this.sql); }
  async first<T>() { return (this.stmt().get(...(this.params as never[])) ?? null) as T | null; }
  async all<T>() { return { results: this.stmt().all(...(this.params as never[])) as T[], success: true }; }
  async run() {
    const r = this.stmt().run(...(this.params as never[]));
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  /** Used by batch: run inside the caller's transaction. */
  runSync() {
    const r = this.stmt().run(...(this.params as never[]));
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

const fakeD1 = {
  prepare: (sql: string) => new FakeStatement(sql),
  async batch(stmts: FakeStatement[]) {
    const conn = sqliteConn();
    return conn.transaction(() => stmts.map((s) => s.runSync()))();
  },
};

const objects = new Map<string, { data: Uint8Array; uploaded: Date }>();
const fakeR2 = {
  async get(key: string) {
    const o = objects.get(key);
    return o ? { key, size: o.data.byteLength, uploaded: o.uploaded, arrayBuffer: async () => o.data.slice().buffer } : null;
  },
  async head(key: string) { const o = objects.get(key); return o ? { key, size: o.data.byteLength, uploaded: o.uploaded } : null; },
  async put(key: string, value: Uint8Array | string) {
    objects.set(key, { data: typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value), uploaded: new Date() });
  },
  async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k); },
  async list({ prefix = "", cursor, limit = 1000 }: { prefix?: string; cursor?: string; limit?: number }) {
    const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + limit);
    const truncated = start + limit < all.length;
    return { objects: page.map((key) => ({ key, size: objects.get(key)!.data.byteLength, uploaded: objects.get(key)!.uploaded })), truncated, cursor: truncated ? String(start + limit) : undefined };
  },
};

export function getCloudflareContext(): { env: Partial<CloudflareEnv> } {
  if (process.env.MORPHIE_TEST_CLOUDFLARE !== "1") {
    throw new Error("getCloudflareContext() is not available in tests. The sqlite Db and in-process coordinator are used instead.");
  }
  return { env: { DB: fakeD1 as never, FILES: fakeR2 as never } };
}
export function initOpenNextCloudflareForDev(): void {}
