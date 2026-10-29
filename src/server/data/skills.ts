import type { Actor } from "../auth/actor";
import { randomId } from "../crypto";
import { db, now } from "../db";

/** Installed skills. Every query is scoped to the owner. */
export interface SkillRow {
  id: string; name: string; description: string; scope: string; manual: number; source: string; markdown: string; files: string; created_at: number; updated_at: number;
}
export interface SkillRecord { name: string; description: string; scope: string; manual: boolean; source: string; markdown: string; files: string }

export async function listSkillRows(actor: Actor): Promise<SkillRow[]> {
  return db().all<SkillRow>("SELECT * FROM skills WHERE user_id = ? ORDER BY name LIMIT 300", actor.userId);
}

export async function getSkillRow(actor: Actor, idOrName: string): Promise<SkillRow | undefined> {
  return db().get<SkillRow>("SELECT * FROM skills WHERE user_id = ? AND (id = ? OR name = ?)", actor.userId, idOrName, idOrName);
}

export async function countSkills(actor: Actor): Promise<number> {
  return (await db().get<{ n: number }>("SELECT COUNT(*) AS n FROM skills WHERE user_id = ?", actor.userId))?.n ?? 0;
}

export async function insertSkill(actor: Actor, r: SkillRecord): Promise<string> {
  const id = randomId(9);
  const t = now();
  await db().run("INSERT INTO skills (id, user_id, name, description, scope, manual, source, markdown, files, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, actor.userId, r.name, r.description, r.scope, r.manual ? 1 : 0, r.source, r.markdown, r.files, t, t);
  return id;
}

export async function updateSkillRow(actor: Actor, id: string, r: SkillRecord): Promise<void> {
  await db().run("UPDATE skills SET name = ?, description = ?, scope = ?, manual = ?, source = ?, markdown = ?, files = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    r.name, r.description, r.scope, r.manual ? 1 : 0, r.source, r.markdown, r.files, now(), id, actor.userId);
}

export async function deleteSkillRow(actor: Actor, id: string): Promise<void> {
  await db().run("DELETE FROM skills WHERE id = ? AND user_id = ?", id, actor.userId);
}
