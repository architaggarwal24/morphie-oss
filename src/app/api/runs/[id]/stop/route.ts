import { stopRun } from "@/server/agent/runs";
import { viaRunner } from "@/server/agent/runner";
import { getConversation } from "@/server/conversations";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stop a conversation's run (the Stop button). Closing the page doesn't stop a run; this does. */
export const POST = route({ auth: "user" }, async (c) => {
  const conv = await getConversation(c.actor, c.params.id);
  if (!conv) throw new ApiError(404, "That conversation no longer exists.", "not_found");
  const forwarded = await viaRunner(c.req, conv.id, {});
  if (forwarded) return forwarded;
  return { stopped: stopRun(conv.id) };
});
