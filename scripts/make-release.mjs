#!/usr/bin/env node
/** Builds morphie.zip from the project tree (never data/, .env, node_modules, .next, .git) and re-checks the result. */
import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { forbiddenEntries, listTree } from "./release-check.mjs";

const root = process.cwd();
const out = path.resolve(process.argv[2] ?? "morphie.zip");
const all = listTree(root).filter((f) => !f.endsWith("/") && f !== path.basename(out));
const files = all.filter((f) => forbiddenEntries([f]).length === 0);
// Keep the single top-level folder the project has always shipped in.
const entries = {};
for (const f of files) entries[`morphie/${f}`] = new Uint8Array(fs.readFileSync(path.join(root, f)));
fs.writeFileSync(out, zipSync(entries, { level: 6 }));
const bad = forbiddenEntries(Object.keys(entries));
if (bad.length) { fs.rmSync(out); console.error("Refusing to publish:\n  " + bad.join("\n  ")); process.exit(1); }
console.log(`Wrote ${out} (${files.length} files; skipped ${all.length - files.length} forbidden).`);
