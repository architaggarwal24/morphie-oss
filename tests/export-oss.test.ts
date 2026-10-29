/** The Community (open-source) export: same code, plans off, no private identifiers, nothing from hosted/. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportOss, PLACEHOLDER_D1, privateStrings } from "../scripts/export-oss.mjs";

describe("export:oss", () => {
  it("copies the project with placeholders for the deployment's ids, and without hosted/ or local state", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "morphie-oss-"));
    fs.mkdirSync(path.join(out, ".git"));
    fs.writeFileSync(path.join(out, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(out, "stale.txt"), "from an older export");
    const r = exportOss(process.cwd(), out);
    expect(r.files).toBeGreaterThan(200);
    const wr = fs.readFileSync(path.join(out, "wrangler.jsonc"), "utf8");
    expect(wr).toContain(`"database_id": "${PLACEHOLDER_D1}"`);
    for (const s of privateStrings(process.cwd())) expect(wr).not.toContain(s);
    expect(fs.existsSync(path.join(out, "hosted"))).toBe(false);
    expect(fs.existsSync(path.join(out, ".dev.vars"))).toBe(false);
    expect(fs.existsSync(path.join(out, "data"))).toBe(false);
    // Core keeps everything, off by default (MORPHIE_PLANS), so the editions never drift apart.
    expect(fs.existsSync(path.join(out, "src/server/plans/index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(out, "public/morphie-runner.mjs"))).toBe(true);
    // A re-export removes what's gone and keeps the public repo's git history.
    expect(fs.existsSync(path.join(out, "stale.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(out, ".git", "HEAD"), "utf8")).toContain("main");
  }, 60_000);

  it("from a git repository, exports only what git tracks: no scratch files, nothing .gitignore'd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "morphie-git-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    fs.writeFileSync(path.join(root, "app.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "notes/\n");
    git("add", "app.ts", ".gitignore");
    fs.writeFileSync(path.join(root, "errors.txt"), "my local test output");
    fs.mkdirSync(path.join(root, "notes")); fs.writeFileSync(path.join(root, "notes", "todo.md"), "private");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "morphie-oss-"));
    exportOss(root, out);
    expect(fs.readdirSync(out).sort()).toEqual([".gitignore", "app.ts"]);
  });

  it("refuses to publish a private string, and to export into the repository itself", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "morphie-src-"));
    fs.mkdirSync(path.join(root, "hosted"));
    fs.writeFileSync(path.join(root, "hosted", "private-strings.txt"), "# private\nacme-secret.example\n");
    fs.writeFileSync(path.join(root, "notes.md"), "Deployed at acme-secret.example");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "morphie-out-"));
    expect(() => exportOss(root, target)).toThrow(/Private strings would be published/);
    expect(fs.readdirSync(target)).toEqual([]); // nothing was written, so nothing can be committed by mistake
    expect(() => exportOss(root, path.join(root, "sub"))).toThrow(/outside this repository/);
  });
});
