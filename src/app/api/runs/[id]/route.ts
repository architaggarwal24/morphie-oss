import { followRun } from "@/server/agent/runs";
import { viaRunner } from "@/server/agent/runner";
import { getConversation } from "@/server/conversations";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Follow a conversation's run: replays its events after `from` (a seq) and streams the rest live. When nothing is
 * running there, answers { active: false } (JSON).
 */
export const GET = route({ auth: "user" }, async (c) => {
  const conv = await getConversation(c.actor, c.params.id);
  if (!conv) throw new ApiError(404, "That conversation no longer exists.", "not_found");
  const forwarded = await viaRunner(c.req, conv.id);
  if (forwarded) return forwarded;
  const from = Math.max(0, Math.floor(Number(c.url.searchParams.get("from") ?? 0)) || 0);
  return followRun(c.req, conv.id, from) ?? { active: false };
});
