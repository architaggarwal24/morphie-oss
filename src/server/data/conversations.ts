import type { AssistantMeta, ConversationView, MessageView, Mode } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { randomId } from "../crypto";
import { db, now, stmt } from "../db";
import { NotFoundError } from "./errors";

/**
 * Conversations and messages. Messages carry no user_id of their own, so every message query joins through the
 * parent conversation and its owner: possession of a conversation or message id proves nothing.
 */

interface ConvRow { id: string; title: string; mode: string; pinned: number; created_at: number; updated_at: number; project_id?: string | null }
interface MsgRow { id: number; role: string; content: string; meta: string | null; created_at: number }

const toView = (r: ConvRow): ConversationView => ({
  id: r.id, title: r.title, mode: r.mode === "agent" ? "agent" : "chat", pinned: !!r.pinned, createdAt: r.created_at, updatedAt: r.updated_at,
  projectId: r.project_id ?? null,
});

export async function listConversations(actor: Actor, q?: string): Promise<ConversationView[]> {
  const like = q?.trim() ? `%${q.trim().replace(/[%_]/g, "")}%` : null;
  const rows = like
    ? await db().all<ConvRow>(`SELECT c.* FROM conversations c WHERE c.user_id = ? AND (c.title LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?))
                    ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 100`, actor.userId, like, like)
    : await db().all<ConvRow>("SELECT * FROM conversations WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT 200", actor.userId);
  return rows.map(toView);
}

export async function countConversations(actor: Actor): Promise<number> {
  return (await db().get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?", actor.userId))?.n ?? 0;
}

export async function getConversation(actor: Actor, id: string): Promise<ConversationView | null> {
  const r = await db().get<ConvRow>("SELECT * FROM conversations WHERE id = ? AND user_id = ?", id, actor.userId);
  return r ? toView(r) : null;
}

/** `projectId` must already be checked as the actor's own project (the insert re-checks it and stores NULL otherwise). */
export async function createConversation(actor: Actor, mode: Mode, title = "New conversation", projectId: string | null = null): Promise<ConversationView> {
  const id = randomId(9);
  const t = now();
  await db().run(
    `INSERT INTO conversations (id, user_id, title, mode, created_at, updated_at, project_id)
     VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM projects WHERE id = ? AND user_id = ?))`,
    id, actor.userId, title, mode, t, t, projectId, actor.userId);
  return (await getConversation(actor, id))!;
}

export async function updateConversation(actor: Actor, id: string, patch: { title?: string; pinned?: boolean }): Promise<ConversationView> {
  const cur = await getConversation(actor, id);
  if (!cur) throw new NotFoundError("Conversation not found");
  await db().run("UPDATE conversations SET title = ?, pinned = ? WHERE id = ? AND user_id = ?",
    (patch.title ?? cur.title).slice(0, 120), (patch.pinned ?? cur.pinned) ? 1 : 0, id, actor.userId);
  return (await getConversation(actor, id))!;
}

/** Attach a task to one of the user's projects (the agent created one mid-task). */
export async function setConversationProject(actor: Actor, id: string, projectId: string): Promise<void> {
  await db().run("UPDATE conversations SET project_id = (SELECT id FROM projects WHERE id = ? AND user_id = ?) WHERE id = ? AND user_id = ?", projectId, actor.userId, id, actor.userId);
}

export async function deleteConversation(actor: Actor, id: string): Promise<void> {
  if (!(await getConversation(actor, id))) throw new NotFoundError("Conversation not found");
  await db().batch([
    stmt("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE id = ? AND user_id = ?)", id, actor.userId),
    stmt("DELETE FROM conversations WHERE id = ? AND user_id = ?", id, actor.userId),
  ]);
}

export async function getMessages(actor: Actor, conversationId: string, limit = 500): Promise<MessageView[]> {
  const rows = await db().all<MsgRow>(
    `SELECT * FROM (
       SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = ? AND c.user_id = ? ORDER BY m.id DESC LIMIT ?
     ) ORDER BY id ASC`,
    conversationId, actor.userId, limit,
  );
  return rows.map((r) => ({
    id: r.id, role: r.role === "assistant" ? "assistant" : "user", content: r.content, createdAt: r.created_at,
    meta: r.meta ? safeParse(r.meta) : undefined,
  }));
}

export async function addMessage(actor: Actor, conversationId: string, role: "user" | "assistant", content: string, meta?: AssistantMeta): Promise<number> {
  const t = now();
  // Insert only through an owned conversation, and bump it, atomically. A foreign id inserts nothing.
  const [info] = await db().batch([
    stmt(`INSERT INTO messages (conversation_id, role, content, meta, created_at)
          SELECT id, ?, ?, ?, ? FROM conversations WHERE id = ? AND user_id = ?`,
      role, content, meta ? JSON.stringify(meta) : null, t, conversationId, actor.userId),
    stmt("UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?", t, conversationId, actor.userId),
  ]);
  if (info.changes !== 1) throw new NotFoundError("Conversation not found");
  return info.lastRowId;
}

export async function deleteMessagesFrom(actor: Actor, conversationId: string, messageId: number): Promise<void> {
  await db().run(
    "DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE id = ? AND user_id = ?) AND conversation_id = ? AND id >= ?",
    conversationId, actor.userId, conversationId, messageId,
  );
}

export async function updateMessageMeta(actor: Actor, conversationId: string, messageId: number, meta: AssistantMeta): Promise<void> {
  const info = await db().run(
    "UPDATE messages SET meta = ? WHERE id = ? AND conversation_id IN (SELECT id FROM conversations WHERE id = ? AND user_id = ?)",
    JSON.stringify(meta), messageId, conversationId, actor.userId,
  );
  if (info.changes !== 1) throw new NotFoundError("Message not found");
}

export async function setTitle(actor: Actor, id: string, title: string): Promise<void> {
  await db().run("UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?", title.slice(0, 120), id, actor.userId);
}

function safeParse(s: string): AssistantMeta | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}
