import { config } from "../config";
import { db, now, stmt } from "../db";
import { randomToken, sha256 } from "../crypto";
import { isSecureRequest } from "../security";
import type { Actor } from "./actor";

/**
 * Sessions are opaque: the cookie holds 32 random bytes, the database holds only their SHA-256.
 * A leaked database (or backup) therefore cannot be replayed as cookies.
 */

export const COOKIE_PLAIN = "morphie_session";
export const COOKIE_SECURE = "__Host-morphie_session";
/** last_seen_at / idle expiry are written at most this often per session, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60_000;
const PURGE_AFTER_MS = 7 * 86_400_000;

export interface SessionMeta { ip?: string; userAgent?: string }

export interface StartedSession {
  token: string;
  sessionId: string;
  userId: string;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
}

export interface ResolvedSession {
  actor: Actor;
  user: { id: string; email: string | null; displayName: string | null };
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export function hashToken(token: string): string {
  return sha256(token);
}

function lifetimes(): { idle: number; max: number } {
  return { idle: config.userIdleMs, max: config.userMaxMs };
}

function clip(v: string | undefined, n: number): string | null {
  return v ? v.slice(0, n) : null;
}

/** Start a session for an account that has just proven who it is (see login.ts). Nothing else creates sessions. */
/** The new session's token and the INSERT that stores it (callers run it alone or inside a batch). */
export function newSession(userId: string, meta: SessionMeta, at: number) {
  const token = randomToken();
  const sessionId = hashToken(token);
  const { idle, max } = lifetimes();
  const absoluteExpiresAt = at + max;
  const idleExpiresAt = Math.min(at + idle, absoluteExpiresAt);
  const insert = stmt(
    `INSERT INTO sessions (id, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId, userId, at, at, idleExpiresAt, absoluteExpiresAt, clip(meta.ip, 64), clip(meta.userAgent, 200));
  return { started: { token, sessionId, userId, absoluteExpiresAt, idleExpiresAt } as StartedSession, insert };
}

/** Start a session for an account that has just proven who it is (see login.ts). Nothing else creates sessions. */
export async function startSession(userId: string, meta: SessionMeta = {}, at = now()): Promise<StartedSession> {
  const { started, insert } = newSession(userId, meta, at);
  await db().run(insert.sql, ...insert.params);
  return started;
}

/** Look a token up. Returns null for unknown, revoked, idle-expired or absolutely-expired sessions. */
export async function resolveSession(token: string, at = now()): Promise<ResolvedSession | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const d = db();
  const sessionId = hashToken(token);
  const row = await d.get(
    `SELECT s.id, s.user_id, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at, s.revoked_at, u.email, u.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    sessionId);
  if (!row || row.revoked_at != null || row.idle_expires_at <= at || row.absolute_expires_at <= at) return null;
  let idleExpiresAt = row.idle_expires_at as number;
  if (at - row.last_seen_at >= TOUCH_INTERVAL_MS) {
    idleExpiresAt = Math.min(at + lifetimes().idle, row.absolute_expires_at);
    await d.batch([
      stmt("UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?", at, idleExpiresAt, sessionId),
      stmt("UPDATE users SET last_seen_at = ? WHERE id = ?", at, row.user_id),
    ]);
  }
  return {
    actor: { userId: row.user_id, sessionId },
    user: { id: row.user_id, email: row.email ?? null, displayName: row.display_name ?? null },
    idleExpiresAt,
    absoluteExpiresAt: row.absolute_expires_at,
  };
}

/**
 * Replace a session with a fresh token (login). The old token, if the caller had one, stops working immediately;
 * the old row is kept (revoked) for audit until purged.
 */
export async function rotateSession(oldSessionId: string | null, next: { userId: string; meta?: SessionMeta }, at = now()): Promise<StartedSession> {
  const { started, insert } = newSession(next.userId, next.meta ?? {}, at);
  await db().batch([
    ...(oldSessionId ? [stmt("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", at, oldSessionId)] : []),
    insert,
  ]);
  return started;
}

export async function revokeSession(sessionId: string, at = now()): Promise<boolean> {
  return (await db().run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", at, sessionId)).changes > 0;
}

export async function revokeAllSessions(userId: string, at = now()): Promise<number> {
  return (await db().run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", at, userId)).changes;
}

/** Drop long-dead session rows (expired or revoked more than a week ago). Cheap; called opportunistically. */
export async function purgeSessions(at = now()): Promise<number> {
  return (await db().run("DELETE FROM sessions WHERE absolute_expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)", at - PURGE_AFTER_MS, at - PURGE_AFTER_MS)).changes;
}

// ------------------------------------------------------------------ cookies

function parseCookies(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { const k = part.slice(0, i).trim(); if (!out.has(k)) out.set(k, part.slice(i + 1).trim()); }
  }
  return out;
}

export function readCookie(req: Request, name: string): string | undefined {
  return parseCookies(req).get(name);
}

/**
 * Over https only the __Host- cookie is read: the prefix guarantees it was set by this exact origin with Secure,
 * so a sibling subdomain cannot plant a plain-named cookie (session fixation). Over plain http only the plain name.
 */
export function readSessionToken(req: Request): string | undefined {
  return readCookie(req, isSecureRequest(req) ? COOKIE_SECURE : COOKIE_PLAIN);
}

export function sessionCookie(token: string, session: Pick<StartedSession, "absoluteExpiresAt">, req: Request, at = now()): string {
  const secure = isSecureRequest(req);
  const parts = [`${secure ? COOKIE_SECURE : COOKIE_PLAIN}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  // Persistent, ending when the session absolutely expires.
  parts.push(`Max-Age=${Math.max(0, Math.floor((session.absoluteExpiresAt - at) / 1000))}`);
  return parts.join("; ");
}

export function clearSessionCookie(req: Request): string {
  const secure = isSecureRequest(req);
  return `${secure ? COOKIE_SECURE : COOKIE_PLAIN}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
