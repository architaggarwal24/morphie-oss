import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_SCHEMA } from "@/server/db";
import { USER_CONTENT_TABLES } from "@/server/data/users";

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) sources(f, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(f);
  }
  return out;
}

describe("data-access boundary", () => {
  it("only the data layer, auth layer, migrations and db.ts call db()", async () => {
    const allowed = (f: string) => /^src\/server\/(db|migrations)\.ts$/.test(f) || f.startsWith("src/server/data/") || f.startsWith("src/server/auth/");
    const offenders = sources("src").filter((f) => !allowed(f) && /\bdb\(\)/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("wipeContent covers every table that has a user_id column", async () => {
    const tables = [...BASE_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)]
      .filter((m) => /\buser_id\b/.test(m[2]) && m[1] !== "users").map((m) => m[1]).sort();
    expect([...USER_CONTENT_TABLES].sort()).toEqual(tables);
  });
});
