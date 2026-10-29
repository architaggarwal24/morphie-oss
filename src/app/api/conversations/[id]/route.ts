import { z } from "zod";
import { deleteConversation, getConversation, getMessages, updateConversation } from "@/server/conversations";
import { recoverInterrupted, runningConversations } from "@/server/agent/recover";
import { stopEverywhere } from "@/server/agent/runner";
import { deleteSnapshot } from "@/server/agent/snapshot";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ auth: "user" }, async (c) => {
  const conversation = await getConversation(c.actor, c.params.id);
  if (!conversation) throw new ApiError(404, "That conversation no longer exists.", "not_found");
  await recoverInterrupted(c.actor, conversation.id).catch((e) => console.error("[run] recover", e));
  const running = (await runningConversations(c.actor)).includes(conversation.id);
  return { conversation, messages: await getMessages(c.actor, c.params.id), running };
});

export const PATCH = route({ auth: "user" }, async (c) => {
  const b = await c.body(z.object({ title: z.string().trim().min(1).max(120).optional(), pinned: z.boolean().optional() }));
  const conversation = await updateConversation(c.actor, c.params.id, b);
  if (!conversation) throw new ApiError(404, "That conversation no longer exists.", "not_found");
  return { conversation };
});

export const DELETE = route({ auth: "user" }, async (c) => {
  // A run still working on it stops first (it would otherwise keep writing to a conversation that's gone).
  if (await getConversation(c.actor, c.params.id)) await stopEverywhere(c.req, c.params.id);
  await deleteConversation(c.actor, c.params.id);
  await deleteSnapshot(c.actor, c.params.id);
  return { ok: true };
});
