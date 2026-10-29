import crypto from "node:crypto";
import { randomId } from "../crypto";
import { db, isUniqueViolation, now } from "../db";
import { normalizeEmail, type AccountUser } from "./accounts";
import { BREACHED_MESSAGE, timesBreached } from "./breached";
import { isPlausibleEmail } from "./otp";

/**
 * Email + password accounts: a way in that needs no mail server.
 *
 * - New passwords that appear in known breaches are refused (breached.ts, k-anonymity: the password never leaves).
 * - Hashes are scrypt (N=2^15, r=8, p=1, 32-byte salt), stored as `scrypt$N$r$p$salt$hash`. Never the password.
 * - Unknown address and wrong password answer identically and take the same time (a dummy hash is checked).
 * - A password account's email is NOT verified: nobody proved they own it. So it never links to Google/GitHub/email-code
 *   logins by itself. When one of those later proves the address, the proven owner takes the account over: the
 *   password is cleared and every session is signed out (accounts.ts, claimVerifiedEmail). Without that, someone could
 *   register a stranger's address first and be inside their account the day they sign in with Google.
 */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
const N = 1 << 15, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const got = crypto.scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return crypto.timingSafeEqual(expected, got);
}

let dummy: string | undefined;
const dummyHash = () => (dummy ??= hashPassword("not-a-real-password-just-for-timing"));

/** Why a new password isn't acceptable, or null. Kept simple and explainable: length, and not the email itself. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (/^(.)\1+$/.test(password)) return "That's one character repeated. Pick something harder to guess.";
  if (email && password.toLowerCase().includes(normalizeEmail(email).split("@")[0]) && normalizeEmail(email).split("@")[0].length >= 4) return "Don't use your email address in your password.";
  return null;
}

export type SignupResult = { ok: true; user: AccountUser } | { ok: false; reason: "invalid_email" | "weak" | "exists"; message: string };

export async function signUpWithPassword(rawEmail: string, password: string, name?: string | null): Promise<SignupResult> {
  const email = normalizeEmail(rawEmail);
  if (!isPlausibleEmail(email)) return { ok: false, reason: "invalid_email", message: "Enter a valid email address." };
  const weak = passwordProblem(password, email);
  if (weak) return { ok: false, reason: "weak", message: weak };
  if (await timesBreached(password)) return { ok: false, reason: "weak", message: BREACHED_MESSAGE };
  const id = randomId(18);
  const t = now();
  const displayName = (name?.trim() || email.split("@")[0]).slice(0, 60);
  try {
    await db().run("INSERT INTO users (id, created_at, email, email_verified_at, display_name, last_seen_at, password_hash, password_updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)",
      id, t, email, displayName, t, hashPassword(password), t);
  } catch (e) {
    // The unique index on email: there is already an account for this address. Anything else is a real failure.
    if (!isUniqueViolation(e)) throw e;
    return { ok: false, reason: "exists", message: "There's already an account for that email. Log in instead." };
  }
  return { ok: true, user: { id, email, displayName } };
}

/** Every failure is the same `null`, after the same amount of work. */
export async function logInWithPassword(rawEmail: string, password: string): Promise<AccountUser | null> {
  const email = normalizeEmail(rawEmail);
  const row = await db().get<{ id: string; email: string; display_name: string | null; password_hash: string | null }>(
    "SELECT id, email, display_name, password_hash FROM users WHERE email = ?", email);
  const ok = verifyPassword(password.slice(0, PASSWORD_MAX), row?.password_hash ?? dummyHash());
  if (!ok || !row?.password_hash) return null;
  return { id: row.id, email: row.email, displayName: row.display_name };
}

export async function hasPassword(userId: string): Promise<boolean> {
  return !!(await db().get<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = ?", userId))?.password_hash;
}

/** Set or change a password. Changing one requires the current password; setting the first one doesn't (the session proves who it is). */
export async function setPassword(userId: string, next: string, current?: string): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const row = await db().get<{ email: string; password_hash: string | null }>("SELECT email, password_hash FROM users WHERE id = ?", userId);
  if (!row) return { ok: false, status: 404, message: "Account not found." };
  if (row.password_hash && !(current && verifyPassword(current.slice(0, PASSWORD_MAX), row.password_hash))) return { ok: false, status: 400, message: "Your current password isn't right." };
  const weak = passwordProblem(next, row.email);
  if (weak) return { ok: false, status: 400, message: weak };
  if (await timesBreached(next)) return { ok: false, status: 400, message: BREACHED_MESSAGE };
  await db().run("UPDATE users SET password_hash = ?, password_updated_at = ? WHERE id = ?", hashPassword(next), now(), userId);
  return { ok: true };
}

export async function removePassword(userId: string): Promise<void> {
  await db().run("UPDATE users SET password_hash = NULL, password_updated_at = ? WHERE id = ?", now(), userId);
}
