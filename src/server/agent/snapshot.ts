/**
 * A run's working state, saved after every step: the model's full message list (tool calls and results), the timeline,
 * the plan and what changed. "Continue" resumes from it, and a run the server lost (restart, crash) is turned into a
 * paused reply from it. One object per conversation in blob storage (R2 on Cloudflare, the data folder locally).
 */
import type { Mode, PlanItem, SourceRef, StopReason, TimelineItem } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { blobs } from "../blobs";
import type { ChatMessage } from "../providers/types";

export interface RunSnapshot {
  v: 1;
  status: "running" | "paused" | "done";
  reason?: StopReason;
  mode: Mode;
  startedAt: number;
  updatedAt: number;
  /** What the user asked (shown when a lost run is recovered). */
  message: string;
  messages: ChatMessage[];
  timeline: TimelineItem[];
  plan?: PlanItem[];
  sources: SourceRef[];
  files: string[];
  changed: string[];
  used: number;
  projectId?: string | null;
  projectCreated?: boolean;
  dirty?: boolean;
  verified?: { passed: boolean; checks: string } | null;
}

const key = (actor: Actor, conversationId: string) => `runs/${actor.userId}/${conversationId}.json`;
const ok = (actor: Actor, id: string) => /^[A-Za-z0-9_-]{6,64}$/.test(actor.userId) && /^[A-Za-z0-9_-]{4,64}$/.test(id);
const MAX_BYTES = 6 * 1024 * 1024;

export async function saveSnapshot(actor: Actor, conversationId: string, snap: RunSnapshot): Promise<void> {
  if (!ok(actor, conversationId)) return;
  // Images are only for the model's next look; they don't need to survive a pause.
  const lean = { ...snap, messages: snap.messages.map((m) => (m.images ? { ...m, images: undefined } : m)) };
  let json = JSON.stringify(lean);
  if (json.length > MAX_BYTES) {
    // Keep the shape and the newest work; long tool results are the bulk.
    lean.messages = lean.messages.map((m, i) => (m.role === "tool" && i < lean.messages.length - 12 && m.content.length > 400 ? { ...m, content: m.content.slice(0, 300) + "\n…[trimmed]" } : m));
    json = JSON.stringify(lean);
  }
  await blobs().put(key(actor, conversationId), json);
}

export async function loadSnapshot(actor: Actor, conversationId: string): Promise<RunSnapshot | null> {
  if (!ok(actor, conversationId)) return null;
  try {
    const raw = await blobs().get(key(actor, conversationId));
    if (!raw) return null;
    const s = JSON.parse(new TextDecoder().decode(raw)) as RunSnapshot;
    return s?.v === 1 && Array.isArray(s.messages) ? s : null;
  } catch { return null; }
}

export async function deleteSnapshot(actor: Actor, conversationId: string): Promise<void> {
  if (!ok(actor, conversationId)) return;
  await blobs().delete(key(actor, conversationId)).catch(() => {});
}

/** Every tool call gets an answer: a run stopped mid-step leaves calls without results, which providers reject. */
export function repairToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") { answered.add(messages[j].toolCallId ?? ""); out.push(messages[j]); j++; }
    for (const c of m.toolCalls) if (!answered.has(c.id)) out.push({ role: "tool", toolCallId: c.id, name: c.name, content: "Error: the run stopped before this finished. Check its effect before repeating it." });
    i = j - 1;
  }
  return out;
}
