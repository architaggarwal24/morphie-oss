import { z } from "zod";
import { deleteSnapshot } from "@/server/agent/snapshot";
import { restoreCheckpoint } from "@/server/code/checkpoints";
import { ownProject, withSandbox } from "@/server/code/routes";
import { deleteMessagesFrom, getConversation, getMessages } from "@/server/conversations";
import { holdLock } from "@/server/coordinator";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rewind to before one of your messages: the project's files (from the checkpoint taken when that message started a
 * run), the conversation (that message and everything after it), or both. `undo` restores the files to the checkpoint
 * a rewind saved, taking the rewind back.
 */
export const POST = route({ auth: "user" }, async (c) => {
  const b = await c.body(z.object({
    messageId: z.number().int().positive().optional(),
    code: z.boolean().default(true),
    conversation: z.boolean().default(true),
    undo: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  }));
  const conv = await getConversation(c.actor, c.params.id);
  if (!conv) throw new ApiError(404, "That conversation no longer exists.", "not_found");
  if (!b.undo && !b.messageId) throw new ApiError(400, "Pick a message to rewind to.", "invalid");
  if (!b.undo && !b.code && !b.conversation) throw new ApiError(400, "Choose what to rewind.", "invalid");

  const unlock = await holdLock(c.actor.userId, `conv:${conv.id}`);
  if (!unlock) throw new ApiError(409, "This conversation is still working on a reply. Stop it first.", "busy");
  try {
    const project = conv.projectId ? await ownProject(c.actor, conv.projectId) : null;
    if (b.undo) {
      if (!project) throw new ApiError(400, "This conversation has no project.", "invalid");
      const r = await withSandbox(c.actor, project, (sb) => restoreCheckpoint(sb, b.undo!));
      if (!r.restored) throw new ApiError(410, "That checkpoint is gone, so the rewind can't be undone.", "expired");
      return { ok: true, code: true, undo: r.undo };
    }

    const messages = await getMessages(c.actor, conv.id);
    const i = messages.findIndex((m) => m.id === b.messageId);
    const target = messages[i];
    if (!target || target.role !== "user") throw new ApiError(400, "You can only rewind to one of your own messages.", "invalid");
    let undo: string | null = null;
    let codeDone = false;
    if (b.code) {
      // The checkpoint lives on the reply that message started (or on a Continue of it).
      const reply = messages.slice(i + 1).find((m) => m.role === "user" || m.meta?.checkpoint);
      const sha = reply?.role === "assistant" ? reply.meta?.checkpoint : undefined;
      if (!project || !sha) throw new ApiError(400, "There's no checkpoint of the files for that message, so only the conversation can be rewound.", "no_checkpoint");
      const r = await withSandbox(c.actor, project, (sb) => restoreCheckpoint(sb, sha));
      if (!r.restored) throw new ApiError(410, "That checkpoint is no longer in the project (its git history was reset), so the files can't be rewound.", "expired");
      undo = r.undo;
      codeDone = true;
    }
    if (b.conversation) {
      await deleteMessagesFrom(c.actor, conv.id, target.id);
      await deleteSnapshot(c.actor, conv.id);
    }
    return { ok: true, code: codeDone, conversation: b.conversation, prompt: target.content, undo };
  } finally {
    await unlock();
  }
});
