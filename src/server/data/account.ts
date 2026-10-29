import type { Actor } from "../auth/actor";
import { identitiesOf } from "../auth/accounts";
import { db, now, stmt } from "../db";
import { wipeContentStatements } from "./users";

export interface AccountView {
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  createdAt: number;
  identities: Array<{ provider: string; email: string }>;
}
export interface SessionRow { id: string; current: boolean; createdAt: number; lastSeenAt: number; ip: string | null; userAgent: string | null }

/** Everything the Account page shows about the signed-in person. Scoped to the actor; never takes an id. */
export async function getAccount(actor: Actor): Promise<AccountView | null> {
  const r = await db().get<{ email: string; display_name: string | null; email_verified_at: number | null; password_hash: string | null; created_at: number }>(
    "SELECT email, display_name, email_verified_at, password_hash, created_at FROM users WHERE id = ?", actor.userId);
  if (!r) return null;
  return { email: r.email, displayName: r.display_name, emailVerified: r.email_verified_at != null, hasPassword: !!r.password_hash, createdAt: r.created_at, identities: await identitiesOf(actor.userId) };
}

export async function setDisplayName(actor: Actor, name: string): Promise<void> {
  await db().run("UPDATE users SET display_name = ? WHERE id = ?", name.trim().slice(0, 60) || null, actor.userId);
}

/** Live sessions of this account (not revoked, not expired), newest activity first. */
export async function listSessions(actor: Actor, at = now()): Promise<SessionRow[]> {
  const rows = await db().all<{ id: string; created_at: number; last_seen_at: number; ip: string | null; user_agent: string | null }>(
    "SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ? ORDER BY last_seen_at DESC LIMIT 50",
    actor.userId, at, at);
  return rows.map((r) => ({ id: r.id, current: r.id === actor.sessionId, createdAt: r.created_at, lastSeenAt: r.last_seen_at, ip: r.ip === "unknown" ? null : r.ip, userAgent: r.user_agent }));
}

/** Sign one of your own sessions out. Someone else's session id simply isn't found (false). */
export async function revokeOwnSession(actor: Actor, sessionId: string, at = now()): Promise<boolean> {
  return (await db().run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL", at, sessionId, actor.userId)).changes > 0;
}

/** Sign out every session except the one making the request. */
export async function revokeOtherSessions(actor: Actor, at = now()): Promise<number> {
  return (await db().run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL", at, actor.userId, actor.sessionId)).changes;
}

/** Delete the account itself: all content, linked logins, codes, sessions and the user row. Files are the caller's job. */
export async function deleteAccount(actor: Actor): Promise<void> {
  const d = db();
  const email = (await d.get<{ email: string }>("SELECT email FROM users WHERE id = ?", actor.userId))?.email;
  await d.batch([
    ...wipeContentStatements(actor),
    stmt("DELETE FROM user_identities WHERE user_id = ?", actor.userId),
    ...(email ? [stmt("DELETE FROM email_codes WHERE email = ?", email)] : []),
    stmt("DELETE FROM sessions WHERE user_id = ?", actor.userId),
    stmt("DELETE FROM users WHERE id = ?", actor.userId),
  ]);
}
