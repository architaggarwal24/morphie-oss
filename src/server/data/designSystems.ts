import type { Actor } from "../auth/actor";
import { randomId } from "../crypto";
import { db, now, stmt } from "../db";

/** Saved design systems. Every query is scoped to the owner. `json` is a validated DesignSystem plus its source. */
export interface SystemRow { id: string; name: string; json: string; created_at: number; updated_at: number }

export async function listSystemRows(actor: Actor): Promise<SystemRow[]> {
  return db().all<SystemRow>("SELECT * FROM design_systems WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100", actor.userId);
}

export async function getSystemRow(actor: Actor, id: string): Promise<SystemRow | undefined> {
  return db().get<SystemRow>("SELECT * FROM design_systems WHERE id = ? AND user_id = ?", id, actor.userId);
}

export async function countSystems(actor: Actor): Promise<number> {
  return (await db().get<{ n: number }>("SELECT COUNT(*) AS n FROM design_systems WHERE user_id = ?", actor.userId))?.n ?? 0;
}

export async function insertSystem(actor: Actor, name: string, json: string): Promise<string> {
  const id = randomId(9);
  const t = now();
  await db().run("INSERT INTO design_systems (id, user_id, name, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, actor.userId, name.slice(0, 60), json, t, t);
  return id;
}

export async function updateSystemRow(actor: Actor, id: string, name: string, json: string): Promise<void> {
  await db().run("UPDATE design_systems SET name = ?, json = ?, updated_at = ? WHERE id = ? AND user_id = ?", name.slice(0, 60), json, now(), id, actor.userId);
}

/** Designs that followed it keep their look; they just stop being linked. */
export async function deleteSystemRow(actor: Actor, id: string): Promise<void> {
  await db().batch([
    stmt("UPDATE designs SET system_id = NULL WHERE user_id = ? AND system_id = ?", actor.userId, id),
    stmt("DELETE FROM design_systems WHERE id = ? AND user_id = ?", id, actor.userId),
  ]);
}
