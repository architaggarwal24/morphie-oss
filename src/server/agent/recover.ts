import type { Actor } from "../auth/actor";
import { addMessage } from "../conversations";
import { coordinator } from "../coordinator";
import { activeRun } from "./runs";
import { loadSnapshot, saveSnapshot } from "./snapshot";

/** The conversations of this user with a run in progress anywhere (their lock is held in the user's Coordinator). */
export async function runningConversations(actor: Actor): Promise<string[]> {
  try { return (await coordinator(actor.userId).heldKeys("conv:")).map((k) => k.slice(5)); }
  catch { return []; }
}

/**
 * A run the server lost (restart, crash, evicted object) left a snapshot saying "running" and no lock. Turn it into a
 * paused reply with what it had done, so the conversation shows where it got to and offers Continue.
 */
export async function recoverInterrupted(actor: Actor, conversationId: string): Promise<boolean> {
  const snap = await loadSnapshot(actor, conversationId);
  if (!snap || snap.status !== "running" || activeRun(conversationId)) return false;
  if ((await runningConversations(actor)).includes(conversationId)) return false;
  for (const item of snap.timeline) if (item.kind === "tool" && (item.step.status === "running" || item.step.status === "waiting")) { item.step.status = "error"; item.step.error = "Interrupted."; }
  snap.status = "paused";
  snap.reason = "interrupted";
  await saveSnapshot(actor, conversationId, snap);
  // A run lost a moment ago (a dev server restarting, a deploy) is picked up again automatically by the page.
  const fresh = Date.now() - snap.updatedAt < AUTO_RESUME_MS;
  await addMessage(actor, conversationId, "assistant", "*The run was interrupted before it finished (the server restarted). Press Continue to pick it up where it stopped.*", {
    timeline: snap.timeline.length ? snap.timeline : undefined, plan: snap.plan, files: snap.files.length ? snap.files : undefined,
    changed: snap.changed.length ? snap.changed : undefined, reason: "interrupted", continuable: true, ms: snap.updatedAt - snap.startedAt,
    autoResume: fresh || undefined,
  });
  return true;
}

export const AUTO_RESUME_MS = 15 * 60_000;

/**
 * The run itself crashed (a bug, not the model): keep what it did as a reply that can be continued, instead of leaving
 * a "running" snapshot that would later look like a server restart.
 */
export async function failRun(actor: Actor, conversationId: string, err: unknown): Promise<void> {
  console.error("[run] crashed", err);
  const snap = await loadSnapshot(actor, conversationId);
  if (!snap || snap.status !== "running") return;
  for (const item of snap.timeline) if (item.kind === "tool" && (item.step.status === "running" || item.step.status === "waiting")) { item.step.status = "error"; item.step.error = "Stopped by an error."; }
  snap.status = "paused";
  snap.reason = "error";
  await saveSnapshot(actor, conversationId, snap);
  const why = err instanceof Error ? err.message.slice(0, 300) : "unknown error";
  await addMessage(actor, conversationId, "assistant", `*The run stopped because of an error on the server (${why}). Press Continue to pick it up where it stopped.*`, {
    timeline: snap.timeline.length ? snap.timeline : undefined, plan: snap.plan, files: snap.files.length ? snap.files : undefined,
    changed: snap.changed.length ? snap.changed : undefined, reason: "error", continuable: true, error: `Server error: ${why}`, ms: snap.updatedAt - snap.startedAt,
  });
}
