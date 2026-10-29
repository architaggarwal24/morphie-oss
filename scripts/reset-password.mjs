#!/usr/bin/env node
/**
 * Set a new password for an account from the server, for when someone is locked out and email can't help.
 *
 *   npm run reset-password -- someone@example.com
 *
 * Asks for the new password twice (hidden), stores it exactly as the app does (scrypt, see src/server/auth/password.ts)
 * and signs the account out everywhere. Run it on the machine that holds the data directory (MORPHIE_DATA_DIR,
 * default ./data). It never prints the password or its hash.
 */
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes("@")) { console.error("Usage: npm run reset-password -- someone@example.com"); process.exit(2); }
const file = path.join(path.resolve(process.env.MORPHIE_DATA_DIR?.trim() || path.join(process.cwd(), "data")), "morphie.db");
if (!fs.existsSync(file)) { console.error(`No database at ${file}. Set MORPHIE_DATA_DIR to the server's data directory.`); process.exit(1); }

// One reader for both prompts (works typed at a terminal and piped from a script). Keystrokes aren't echoed.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let prompting = "";
rl._writeToOutput = (s) => { if (!prompting || s.includes(prompting)) rl.output.write(s); };
const lines = rl[Symbol.asyncIterator]();
async function hidden(question) {
  prompting = question;
  process.stdout.write(question);
  const { value } = await lines.next();
  prompting = "";
  process.stdout.write("\n");
  return value ?? "";
}

const db = new DatabaseSync(file);
const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
if (!user) { console.error(`No account for ${email}.`); process.exit(1); }
const pw = await hidden("New password (10+ characters): ");
if (pw.length < 10 || pw.length > 200) { console.error("Use 10 to 200 characters."); process.exit(1); }
if ((await hidden("Same password again: ")) !== pw) { console.error("The two entries differ. Nothing changed."); process.exit(1); }
rl.close();

const N = 1 << 15, r = 8, p = 1, salt = crypto.randomBytes(32);
const hash = crypto.scryptSync(pw.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
const stored = `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
const now = Date.now();
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE users SET password_hash = ?, password_updated_at = ? WHERE id = ?").run(stored, now, user.id);
const out = db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, user.id);
db.exec("COMMIT");
db.close();
console.log(`Password set for ${email}. Signed out ${out.changes} session(s). They can log in with it now.`);
