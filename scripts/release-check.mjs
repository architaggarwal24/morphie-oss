#!/usr/bin/env node
/**
 * Fails if a release artifact (zip) or the working tree would ship local state or secrets:
 * data/, .env files, SQLite files, key files, node_modules, .next.
 *
 *   node scripts/release-check.mjs <file.zip>     check an existing archive
 *   node scripts/release-check.mjs --tree         check the project directory
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const FORBIDDEN = [
  // the project's own data dir: at the root or one wrapper folder down (not a source folder like src/app/api/data)
  [/^(?!src\/)([^/]+\/)?data\//, "data/ directory (database, keys, workspace)"],
  [/(^|\/)data\/workspace\//, "workspace files"],
  [/(^|\/)\.env(\..*)?$/, ".env file"],
  [/\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i, "SQLite database file"],
  [/(^|\/)\.(encryption_key|session_secret)$/, "key file"],
  [/\.(pem|key|p12|pfx)$/i, "private key file"],
  [/(^|\/)node_modules\//, "node_modules"],
  [/(^|\/)\.next\//, ".next build output"],
  [/(^|\/)\.git\//, ".git directory"],
  [/\.tsbuildinfo$/, "TypeScript build cache"],
  [/(^|\/)\.dev\.vars(\..*)?$/, ".dev.vars file (local Worker secrets)"],
  [/(^|\/)\.open-next\//, ".open-next build output"],
  [/(^|\/)\.wrangler\//, ".wrangler local state"],
];
const ALLOWED = [/(^|\/)\.env\.example$/, /(^|\/)\.dev\.vars\.example$/];

export function forbiddenEntries(names) {
  const bad = [];
  for (const raw of names) {
    const name = raw.replace(/\\/g, "/");
    if (ALLOWED.some((r) => r.test(name))) continue;
    const hit = FORBIDDEN.find(([r]) => r.test(name));
    if (hit) bad.push(`${name}  (${hit[1]})`);
  }
  return bad;
}

export function listTree(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (/(^|\/)(node_modules|\.next|\.git|\.open-next|\.wrangler)$/.test(rel)) continue; // ignored by the release zip anyway
      if (rel === "data") { out.push("data/"); continue; }
      listTree(full, base, out);
    } else out.push(rel);
  }
  return out;
}

export function zipNames(file) {
  return zipNamesViaFilter(file);
}
function zipNamesViaFilter(file) {
  const names = [];
  unzipSync(new Uint8Array(fs.readFileSync(file)), { filter: (f) => { names.push(f.name); return false; } });
  return names;
}

// Run as a script (also on Windows, where argv[1] is C:\\…\\release-check.mjs and the URL is file:///C:/…).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (!arg) { console.error("usage: release-check.mjs <file.zip> | --tree"); process.exit(2); }
  const names = arg === "--tree" ? listTree(process.cwd()) : zipNames(arg);
  const bad = forbiddenEntries(names);
  if (bad.length) {
    console.error(`Release check FAILED. ${bad.length} forbidden entr${bad.length === 1 ? "y" : "ies"}:\n  ` + bad.slice(0, 30).join("\n  "));
    process.exit(1);
  }
  console.log(`Release check passed (${names.length} entries).`);
}
