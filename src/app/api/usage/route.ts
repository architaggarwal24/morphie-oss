import { route } from "@/server/http";
import { usageSummary } from "@/server/usage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Token usage over the last `days` (default 30): totals, by day, feature and model, top conversations and designs. */
export const GET = route({ auth: "user" }, async (c) => {
  const days = Number(c.url.searchParams.get("days") ?? 30);
  return await usageSummary(c.actor, Number.isFinite(days) ? days : 30);
});
