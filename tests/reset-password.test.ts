import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { verifyPassword } from "@/server/auth/password";

/** A minimal copy of the two tables the command touches. */
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morphie-reset-"));
  const d = new DatabaseSync(path.join(dir, "morphie.db"));
  d.exec("CREATE TABLE users(id TEXT, email TEXT, password_hash TEXT, password_updated_at INTEGER); CREATE TABLE sessions(id TEXT, user_id TEXT, revoked_at INTEGER);");
  d.exec("INSERT INTO users VALUES ('u1','ada@example.com',NULL,NULL); INSERT INTO sessions VALUES ('s1','u1',NULL),('s2','u1',NULL)");
  d.close();
  return dir;
}
const run = (dir: string, input: string, email = "ada@example.com") =>
  execFileSync(process.execPath, ["scripts/reset-password.mjs", email], { input, env: { ...process.env, MORPHIE_DATA_DIR: dir, NODE_NO_WARNINGS: "1" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

describe("npm run reset-password", () => {
  it("stores a hash the app itself accepts and signs the account out everywhere, never printing the password", async () => {
    const dir = scratch();
    const out = run(dir, "a long new passphrase\na long new passphrase\n");
    expect(out).toContain("Password set for ada@example.com. Signed out 2 session(s).");
    expect(out).not.toContain("a long new passphrase");
    const d = new DatabaseSync(path.join(dir, "morphie.db"));
    const row = d.prepare("SELECT password_hash FROM users").get() as { password_hash: string };
    expect(verifyPassword("a long new passphrase", row.password_hash)).toBe(true);
    expect((d.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL").get() as { n: number }).n).toBe(0);
  });

  it("changes nothing when the two entries differ or the account doesn't exist", async () => {
    const dir = scratch();
    expect(() => run(dir, "a long new passphrase\nsomething else entirely\n")).toThrow();
    expect(() => run(dir, "a long new passphrase\na long new passphrase\n", "nobody@example.com")).toThrow();
    const d = new DatabaseSync(path.join(dir, "morphie.db"));
    expect((d.prepare("SELECT password_hash FROM users").get() as { password_hash: string | null }).password_hash).toBeNull();
  });
});
