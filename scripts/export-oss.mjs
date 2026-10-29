#!/usr/bin/env node
/**
 * Morphie Community edition: copies this repository into the folder of your public (open-source) repository.
 *
 *   npm run export:oss -- ../morphie-oss
 *
 * This repo is the hosted one (Morphie Cloud). The public repo gets the same code, with:
 *   - plans, credits, payments and Morphie AI present but OFF (they only turn on with MORPHIE_PLANS=on);
 *   - your deployment's identifiers replaced by placeholders (the D1 database ids in wrangler*.jsonc);
 *   - nothing from hosted/ (your private overlay: legal pages, notes, anything that isn't for the public);
 *   - nothing the release check forbids (data/, .env, .dev.vars, databases, keys, build output).
 * The target's .git folder is kept and files that no longer exist here are removed, so you can commit the result.
 * Only files git tracks are exported (commit first), so scratch files and anything .gitignore'd stay private.
 * It refuses to start if any of your private identifiers (or a line from hosted/private-strings.txt) would leak.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forbiddenEntries, listTree } from "./release-check.mjs";

export const PLACEHOLDER_D1 = "YOUR_D1_DATABASE_ID";
const SKIP = [/^hosted\//, /^dist\//, /^morphie\.zip$/, /^wrangler\.e2e\.jsonc$/, /(^|\/)\.DS_Store$/];

/** What must never appear in the public copy: the D1 ids from the wrangler configs, plus hosted/private-strings.txt. */
export function privateStrings(root) {
  const out = new Set();
  for (const f of ["wrangler.jsonc", "wrangler.free.jsonc"]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const m of fs.readFileSync(p, "utf8").matchAll(/"database_id"\s*:\s*"([^"]+)"/g)) if (m[1] !== PLACEHOLDER_D1) out.add(m[1]);
  }
  const extra = path.join(root, "hosted", "private-strings.txt");
  if (fs.existsSync(extra)) for (const line of fs.readFileSync(extra, "utf8").split(/\r?\n/)) if (line.trim() && !line.startsWith("#")) out.add(line.trim());
  return [...out];
}

const transform = (rel, text) => (/^wrangler(\.[a-z]+)?\.jsonc$/.test(rel) ? text.replace(/("database_id"\s*:\s*)"[^"]+"/g, `$1"${PLACEHOLDER_D1}"`) : text);
const isText = (buf) => !buf.subarray(0, 8000).includes(0);

/**
 * What to publish: in a git repository, only the files git tracks (so scratch files, logs and anything .gitignore'd
 * never go public: commit first, then export); elsewhere every file in the tree.
 */
function sourceFiles(root) {
  if (!fs.existsSync(path.join(root, ".git"))) return listTree(root);
  const out = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter((f) => f && fs.existsSync(path.join(root, f)));
}

export function exportOss(root, out) {
  const absOut = path.resolve(out);
  if (absOut === path.resolve(root) || absOut.startsWith(path.resolve(root) + path.sep) && !absOut.startsWith(path.join(path.resolve(root), "dist") + path.sep)) {
    throw new Error("Export to a folder outside this repository (or under dist/).");
  }
  const rel = path.relative(root, absOut).split(path.sep).join("/");
  const files = sourceFiles(root).filter((f) => !f.endsWith("/") && !SKIP.some((r) => r.test(f)) && !(rel && !rel.startsWith("..") && f.startsWith(`${rel}/`)) && forbiddenEntries([f]).length === 0 && fs.lstatSync(path.join(root, f)).isFile());
  const secrets = privateStrings(root);
  // Everything is read and checked before anything is written: a leak leaves the public folder untouched.
  const leaks = [];
  const outputs = files.map((f) => {
    const src = fs.readFileSync(path.join(root, f));
    const data = isText(src) ? Buffer.from(transform(f, src.toString("utf8")), "utf8") : src;
    if (isText(data)) { const t = data.toString("utf8"); for (const s of secrets) if (t.includes(s)) leaks.push(`${f}: ${s.slice(0, 6)}…`); }
    return { f, data };
  });
  if (leaks.length) throw new Error(`Private strings would be published (nothing was written):\n  ${leaks.join("\n  ")}`);
  fs.mkdirSync(absOut, { recursive: true });
  for (const { f, data } of outputs) {
    const dst = path.join(absOut, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
  }
  // Files that are gone here go there too (the public repo's .git and installed modules stay).
  const keep = new Set(files);
  let removed = 0;
  for (const f of listTree(absOut)) {
    if (f.endsWith("/") || keep.has(f) || /^(\.git|node_modules)\//.test(f)) continue;
    fs.rmSync(path.join(absOut, f), { force: true });
    removed++;
  }
  return { files: files.length, removed, out: absOut };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) { console.error("Usage: npm run export:oss -- <folder of your public repository>"); process.exit(2); }
  try {
    const r = exportOss(process.cwd(), out);
    console.log(`Exported ${r.files} files to ${r.out}${r.removed ? ` (removed ${r.removed} that no longer exist)` : ""}.\nNext: cd ${out} && git add -A && git commit -m "Sync from Morphie" && git push`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
