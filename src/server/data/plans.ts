import type { Actor } from "../auth/actor";
import { randomId } from "../crypto";
import { db, now } from "../db";

/** Plans storage: memberships (a plan per email), bonus credit grants, app_config, and the credit sums. */

export interface MembershipRow {
  email: string; plan: string; unlimited: number; source: string; billing: string | null;
  starts_at: number; ends_at: number | null; note: string; granted_by: string | null; created_at: number; updated_at: number;
}

export interface AccountPlanRow {
  email: string | null;
  email_verified_at: number | null;
  plan: string | null; unlimited: number | null; source: string | null; billing: string | null;
  starts_at: number | null; ends_at: number | null;
}

/** The user's email and (for a verified email) their membership row, in one read. */
export async function accountPlanRow(actor: Actor): Promise<AccountPlanRow | undefined> {
  return db().get<AccountPlanRow>(
    `SELECT u.email, u.email_verified_at, m.plan, m.unlimited, m.source, m.billing, m.starts_at, m.ends_at
       FROM users u LEFT JOIN memberships m ON u.email_verified_at IS NOT NULL AND m.email = lower(u.email)
      WHERE u.id = ?`, actor.userId);
}

/** Bonus credits that are live right now for this email. */
export async function bonusCredits(email: string, at = now()): Promise<number> {
  const r = await db().get<{ c: number }>("SELECT COALESCE(SUM(credits), 0) AS c FROM credit_grants WHERE email = ? AND at <= ? AND (expires_at IS NULL OR expires_at > ?)", email, at, at);
  return Number(r?.c ?? 0);
}

/**
 * Premium credits since `monthStart` and since `dayStart`, and free-model credits since `dayStart`. Credits on hold
 * for calls still in flight (credit_holds) count as spent now, so parallel runs can't use the same credits twice.
 */
export async function creditSums(actor: Actor, monthStart: number, dayStart: number, t = now()): Promise<{ month: number; today: number; freeToday: number }> {
  const r = await db().get<{ month: number; today: number; free_today: number; held_paid: number; held_free: number }>(
    `SELECT COALESCE(SUM(CASE WHEN billing = 'paid' AND at >= ? THEN credits END), 0) AS month,
            COALESCE(SUM(CASE WHEN billing = 'paid' AND at >= ? THEN credits END), 0) AS today,
            COALESCE(SUM(CASE WHEN billing = 'free' AND at >= ? THEN credits END), 0) AS free_today,
            (SELECT COALESCE(SUM(credits), 0) FROM credit_holds WHERE user_id = ? AND billing = 'paid' AND expires_at > ?) AS held_paid,
            (SELECT COALESCE(SUM(credits), 0) FROM credit_holds WHERE user_id = ? AND billing = 'free' AND expires_at > ?) AS held_free
       FROM usage_events WHERE user_id = ? AND at >= ?`,
    monthStart, dayStart, dayStart, actor.userId, t, actor.userId, t, actor.userId, Math.min(monthStart, dayStart));
  const heldPaid = Number(r?.held_paid ?? 0), heldFree = Number(r?.held_free ?? 0);
  return { month: Number(r?.month ?? 0) + heldPaid, today: Number(r?.today ?? 0) + heldPaid, freeToday: Number(r?.free_today ?? 0) + heldFree };
}

/** Set credits aside for one model call. It lapses on its own at `expiresAt` if never released. */
export async function placeHold(actor: Actor, billing: "free" | "paid", credits: number, at: number, expiresAt: number): Promise<string> {
  const id = randomId(12);
  await db().run("INSERT INTO credit_holds (id, user_id, billing, credits, at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", id, actor.userId, billing, credits, at, expiresAt);
  return id;
}

let lastHoldPurge = 0;
/** The call finished (and its real cost is in usage_events), or it was refused: drop the hold. */
export async function releaseHold(actor: Actor, id: string): Promise<void> {
  await db().run("DELETE FROM credit_holds WHERE id = ? AND user_id = ?", id, actor.userId);
  if (Date.now() - lastHoldPurge > 3_600_000) { lastHoldPurge = Date.now(); await db().run("DELETE FROM credit_holds WHERE expires_at < ?", now() - 3_600_000); }
}

/** Morphie AI spend across everyone since `since`, by model and billing kind. */
export async function hostedSpend(since: number): Promise<Array<{ model: string; billing: string; credits: number; calls: number }>> {
  const rows = await db().all<{ model: string; billing: string; credits: number; calls: number }>(
    "SELECT model, billing, COALESCE(SUM(credits), 0) AS credits, COUNT(*) AS calls FROM usage_events WHERE billing IN ('free', 'paid') AND at >= ? GROUP BY model, billing", since);
  return rows.map((r) => ({ model: r.model, billing: r.billing, credits: Number(r.credits), calls: Number(r.calls) }));
}

// ------------------------------------------------------------------ app_config

export async function readConfig(key: string): Promise<unknown> {
  const r = await db().get<{ json: string }>("SELECT json FROM app_config WHERE key = ?", key);
  if (!r) return undefined;
  try { return JSON.parse(r.json); } catch { return undefined; }
}

export async function writeConfig(key: string, value: unknown): Promise<void> {
  await db().run("INSERT INTO app_config (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
    key, JSON.stringify(value), now());
}

// ------------------------------------------------------------------ admin

export interface MemberListRow {
  id: string | null; email: string; verified: number; created_at: number | null; last_seen_at: number | null;
  plan: string | null; unlimited: number | null; source: string | null; billing: string | null; starts_at: number | null; ends_at: number | null; note: string | null;
  credits: number;
}

/** Accounts (newest activity first) with their membership and credits used since `since`; `q` filters by email. */
export async function listMembers(q: string, since: number, limit = 60): Promise<MemberListRow[]> {
  const like = `%${q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const accounts = await db().all<MemberListRow>(
    `SELECT u.id, lower(u.email) AS email, (u.email_verified_at IS NOT NULL) AS verified, u.created_at, u.last_seen_at,
            m.plan, m.unlimited, m.source, m.billing, m.starts_at, m.ends_at, m.note,
            (SELECT COALESCE(SUM(e.credits), 0) FROM usage_events e WHERE e.user_id = u.id AND e.at >= ? AND e.billing != '') AS credits
       FROM users u LEFT JOIN memberships m ON m.email = lower(u.email)
      WHERE u.email IS NOT NULL AND lower(u.email) LIKE ? ESCAPE '\\'
      ORDER BY COALESCE(u.last_seen_at, u.created_at) DESC LIMIT ?`, since, like, limit);
  // Plans granted to emails that haven't signed up yet.
  const pending = await db().all<MemberListRow>(
    `SELECT NULL AS id, m.email, 0 AS verified, NULL AS created_at, NULL AS last_seen_at, m.plan, m.unlimited, m.source, m.billing, m.starts_at, m.ends_at, m.note, 0 AS credits
       FROM memberships m WHERE m.email LIKE ? ESCAPE '\\' AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = m.email)
      ORDER BY m.updated_at DESC LIMIT ?`, like, limit);
  return [...pending, ...accounts];
}

export async function getMembership(email: string): Promise<MembershipRow | undefined> {
  return db().get<MembershipRow>("SELECT * FROM memberships WHERE email = ?", email);
}

export async function upsertMembership(m: Omit<MembershipRow, "created_at" | "updated_at">): Promise<void> {
  const t = now();
  await db().run(
    `INSERT INTO memberships (email, plan, unlimited, source, billing, starts_at, ends_at, note, granted_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET plan = excluded.plan, unlimited = excluded.unlimited, source = excluded.source, billing = excluded.billing,
       starts_at = excluded.starts_at, ends_at = excluded.ends_at, note = excluded.note, granted_by = excluded.granted_by, updated_at = excluded.updated_at`,
    m.email, m.plan, m.unlimited, m.source, m.billing, m.starts_at, m.ends_at, m.note, m.granted_by, t, t);
}

export async function deleteMembership(email: string): Promise<boolean> {
  return (await db().run("DELETE FROM memberships WHERE email = ?", email)).changes > 0;
}

export async function insertCreditGrant(g: { email: string; credits: number; expiresAt: number | null; note: string; by: string | null }): Promise<void> {
  await db().run("INSERT INTO credit_grants (email, credits, at, expires_at, note, granted_by) VALUES (?, ?, ?, ?, ?, ?)", g.email, g.credits, now(), g.expiresAt, g.note, g.by);
}

export async function listCreditGrants(email: string): Promise<Array<{ id: number; credits: number; at: number; expires_at: number | null; note: string }>> {
  return db().all("SELECT id, credits, at, expires_at, note FROM credit_grants WHERE email = ? ORDER BY at DESC LIMIT 20", email);
}

/** Totals for the admin overview. */
export async function memberCounts(): Promise<{ users: number; byPlan: Record<string, number> }> {
  const [u, rows] = await Promise.all([
    db().get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email IS NOT NULL"),
    db().all<{ plan: string; n: number }>("SELECT plan, COUNT(*) AS n FROM memberships WHERE ends_at IS NULL OR ends_at > ? GROUP BY plan", now()),
  ]);
  return { users: Number(u?.n ?? 0), byPlan: Object.fromEntries(rows.map((r) => [r.plan, Number(r.n)])) };
}
