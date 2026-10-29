import type { UsageSummary } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { db, now } from "../db";

/** The token ledger (usage_events). Every query is scoped to the owner. */

let lastPrune = 0;
const KEEP_MS = 400 * 24 * 3600_000;

export interface UsageRow { credits: number; billing: "" | "free" | "paid"; userId: string; feature: string; conversationId: string | null; designId: string | null; provider: string; model: string; input: number; output: number; cached: number; estimated: boolean }

export async function insertUsage(r: UsageRow): Promise<void> {
  await db().run(
    "INSERT INTO usage_events (user_id, at, feature, conversation_id, design_id, provider, model, input, output, cached, estimated, credits, billing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    r.userId, now(), r.feature, r.conversationId, r.designId, r.provider, r.model, r.input, r.output, r.cached, r.estimated ? 1 : 0, r.credits, r.billing,
  );
  if (Date.now() - lastPrune > 6 * 3600_000) {
    lastPrune = Date.now();
    await db().run("DELETE FROM usage_events WHERE at < ?", now() - KEEP_MS).catch(() => {});
  }
}

/** Totals for the Usage page: by day, feature, model, and the conversations and designs that used the most. */
export async function usageSummary(actor: Actor, days: number): Promise<UsageSummary> {
  const span = Math.min(365, Math.max(1, Math.round(days)));
  const since = now() - span * 24 * 3600_000;
  const where = "user_id = ? AND at >= ?";
  type Row = { k: string | null; input: number; output: number; cached: number; calls: number; estimated: number };
  const agg = "COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output, COALESCE(SUM(cached),0) AS cached, COUNT(*) AS calls, COALESCE(SUM(estimated),0) AS estimated";
  const [total, byDayRaw, byFeature, byModel, byConv, byDesign] = await Promise.all([
    db().get<Row>(`SELECT NULL AS k, ${agg} FROM usage_events WHERE ${where}`, actor.userId, since),
    db().all<Row & { k: number }>(`SELECT CAST((at / 86400000) AS INTEGER) AS k, ${agg} FROM usage_events WHERE ${where} GROUP BY k ORDER BY k`, actor.userId, since),
    db().all<Row>(`SELECT feature AS k, ${agg} FROM usage_events WHERE ${where} GROUP BY feature ORDER BY (SUM(input) + SUM(output)) DESC`, actor.userId, since),
    db().all<Row>(`SELECT model AS k, ${agg} FROM usage_events WHERE ${where} GROUP BY model ORDER BY (SUM(input) + SUM(output)) DESC LIMIT 12`, actor.userId, since),
    db().all<Row & { title: string | null }>(
      `SELECT u.conversation_id AS k, c.title AS title, COALESCE(SUM(u.input),0) AS input, COALESCE(SUM(u.output),0) AS output, COALESCE(SUM(u.cached),0) AS cached, COUNT(*) AS calls, COALESCE(SUM(u.estimated),0) AS estimated
       FROM usage_events u LEFT JOIN conversations c ON c.id = u.conversation_id AND c.user_id = u.user_id
       WHERE u.user_id = ? AND u.at >= ? AND u.conversation_id IS NOT NULL GROUP BY u.conversation_id ORDER BY (SUM(u.input) + SUM(u.output)) DESC LIMIT 10`, actor.userId, since),
    db().all<Row & { title: string | null }>(
      `SELECT u.design_id AS k, d.name AS title, COALESCE(SUM(u.input),0) AS input, COALESCE(SUM(u.output),0) AS output, COALESCE(SUM(u.cached),0) AS cached, COUNT(*) AS calls, COALESCE(SUM(u.estimated),0) AS estimated
       FROM usage_events u LEFT JOIN designs d ON d.id = u.design_id AND d.user_id = u.user_id
       WHERE u.user_id = ? AND u.at >= ? AND u.design_id IS NOT NULL GROUP BY u.design_id ORDER BY (SUM(u.input) + SUM(u.output)) DESC LIMIT 10`, actor.userId, since),
  ]);
  const t = (r: Row | undefined) => ({ input: Number(r?.input ?? 0), output: Number(r?.output ?? 0), cached: Number(r?.cached ?? 0), calls: Number(r?.calls ?? 0), estimated: Number(r?.estimated ?? 0) });
  // Every day in the window, including the quiet ones, so a chart has a continuous axis.
  const firstDay = Math.floor(since / 86400000) + 1;
  const lastDay = Math.floor(now() / 86400000);
  const map = new Map(byDayRaw.map((r) => [Number(r.k), r]));
  const byDay = [];
  for (let d = firstDay; d <= lastDay; d++) byDay.push({ day: new Date(d * 86400000).toISOString().slice(0, 10), ...t(map.get(d)) });
  return {
    days: span,
    total: t(total),
    byDay,
    byFeature: byFeature.map((r) => ({ key: r.k ?? "other", ...t(r) })),
    byModel: byModel.map((r) => ({ key: r.k || "unknown", ...t(r) })),
    conversations: byConv.map((r) => ({ id: r.k ?? "", title: r.title ?? "Deleted conversation", ...t(r) })),
    designs: byDesign.map((r) => ({ id: r.k ?? "", title: r.title ?? "Deleted design", ...t(r) })),
  };
}

/** What one conversation has used so far (the agent's header shows it). */
export async function conversationUsage(actor: Actor, conversationId: string): Promise<{ input: number; output: number; cached: number }> {
  const r = await db().get<{ input: number; output: number; cached: number }>(
    "SELECT COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output, COALESCE(SUM(cached),0) AS cached FROM usage_events WHERE user_id = ? AND conversation_id = ?", actor.userId, conversationId);
  return { input: Number(r?.input ?? 0), output: Number(r?.output ?? 0), cached: Number(r?.cached ?? 0) };
}
