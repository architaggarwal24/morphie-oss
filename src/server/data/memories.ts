import type { Actor } from "../auth/actor";
import { db } from "../db";
import { NotFoundError } from "./errors";

export interface MemoryRow { id: string; content: string; category: string; source: string; created_at: number; updated_at: number }

export async function listMemoryRows(actor: Actor): Promise<MemoryRow[]> {
  return db().all<MemoryRow>("SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC", actor.userId);
}

export async function insertMemory(actor: Actor, row: MemoryRow): Promise<void> {
  await db().run("INSERT INTO memories (id, user_id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    row.id, actor.userId, row.content, row.category, row.source, row.created_at, row.updated_at);
}

export async function deleteMemory(actor: Actor, id: string): Promise<void> {
  const info = await db().run("DELETE FROM memories WHERE id = ? AND user_id = ?", id, actor.userId);
  if (info.changes !== 1) throw new NotFoundError("Memory not found");
}

export async function clearMemories(actor: Actor): Promise<void> {
  await db().run("DELETE FROM memories WHERE user_id = ?", actor.userId);
}
