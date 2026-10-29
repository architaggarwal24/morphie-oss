import { db, now } from "../db";

/** Payments storage: plan orders (by verified email) and the bank alert inbox. */

export interface OrderRow {
  id: string; email: string; plan: string; period: string; currency: string; amount: number; method: string; status: string; utr: string | null;
  created_at: number; updated_at: number; expires_at: number; paid_at: number | null; decided_by: string | null; reason: string | null;
}

export async function insertOrder(o: Omit<OrderRow, "updated_at" | "paid_at" | "decided_by" | "reason" | "utr">): Promise<void> {
  await db().run("INSERT INTO orders (id, email, plan, period, currency, amount, method, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    o.id, o.email, o.plan, o.period, o.currency, o.amount, o.method, o.status, o.created_at, o.created_at, o.expires_at);
}

export async function getOrder(id: string): Promise<OrderRow | undefined> {
  return db().get<OrderRow>("SELECT * FROM orders WHERE id = ?", id);
}

/** One person's order: undefined unless it belongs to this email. */
export async function getOwnOrder(email: string, id: string): Promise<OrderRow | undefined> {
  return db().get<OrderRow>("SELECT * FROM orders WHERE id = ? AND email = ?", id, email);
}

export async function listOrdersFor(email: string, limit = 20): Promise<OrderRow[]> {
  return db().all<OrderRow>("SELECT * FROM orders WHERE email = ? ORDER BY created_at DESC LIMIT ?", email, limit);
}

/** Orders that could still be paid (pending or awaiting a check), newest first. */
export async function openOrders(t = now()): Promise<OrderRow[]> {
  return db().all<OrderRow>("SELECT * FROM orders WHERE (status = 'pending' AND expires_at > ?) OR status = 'submitted' ORDER BY created_at DESC LIMIT 500", t);
}

export async function recentOrders(limit = 100): Promise<OrderRow[]> {
  return db().all<OrderRow>("SELECT * FROM orders ORDER BY CASE status WHEN 'submitted' THEN 0 ELSE 1 END, created_at DESC LIMIT ?", limit);
}

export async function orderByUtr(utr: string): Promise<OrderRow | undefined> {
  return db().get<OrderRow>("SELECT * FROM orders WHERE utr = ?", utr);
}

/** Move an order on, only from the statuses given (so two deciders can't both win). True when it changed. */
export async function updateOrder(id: string, from: string[], patch: { status: string; utr?: string | null; paidAt?: number | null; decidedBy?: string | null; reason?: string | null }): Promise<boolean> {
  const sets = ["status = ?", "updated_at = ?"];
  const vals: unknown[] = [patch.status, now()];
  if (patch.utr !== undefined) { sets.push("utr = ?"); vals.push(patch.utr); }
  if (patch.paidAt !== undefined) { sets.push("paid_at = ?"); vals.push(patch.paidAt); }
  if (patch.decidedBy !== undefined) { sets.push("decided_by = ?"); vals.push(patch.decidedBy); }
  if (patch.reason !== undefined) { sets.push("reason = ?"); vals.push(patch.reason); }
  const r = await db().run(`UPDATE orders SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`, ...vals, id, ...from);
  return r.changes > 0;
}

/** Close this email's other unpaid orders (a new checkout replaces them). */
export async function cancelOpenOrders(email: string, except: string): Promise<void> {
  await db().run("UPDATE orders SET status = 'canceled', updated_at = ? WHERE email = ? AND id != ? AND status = 'pending'", now(), email, except);
}

export async function insertInbox(r: { sender: string; dkim: string; subject: string; amount: number | null; utr: string | null; orderId: string | null; outcome: string; excerpt: string }): Promise<void> {
  await db().run("INSERT INTO payment_inbox (at, sender, dkim, subject, amount, utr, order_id, outcome, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    now(), r.sender.slice(0, 200), r.dkim.slice(0, 200), r.subject.slice(0, 300), r.amount, r.utr, r.orderId, r.outcome, r.excerpt.slice(0, 1500));
  await db().run("DELETE FROM payment_inbox WHERE at < ?", now() - 180 * 86_400_000).catch(() => {});
}

export async function listInbox(limit = 50): Promise<Array<{ id: number; at: number; sender: string; dkim: string; subject: string; amount: number | null; utr: string | null; order_id: string | null; outcome: string; excerpt: string }>> {
  return db().all("SELECT * FROM payment_inbox ORDER BY at DESC LIMIT ?", limit);
}
