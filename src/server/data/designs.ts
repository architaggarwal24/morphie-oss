import type { Actor } from "../auth/actor";
import { db, stmt } from "../db";
import { NotFoundError } from "./errors";

/** Design projects and their version history. design_versions has no user_id: every access goes through the owning design. */

export interface DesignRow { id: string; user_id: string; name: string; cursor: number; next_version: number; revision: number; created_at: number; updated_at: number; system_id?: string | null }
export interface VersionRow { version: number; json: string; prompt: string; summary: string; created_at: number }

const OWNED = "EXISTS (SELECT 1 FROM designs WHERE id = ? AND user_id = ?)";

export async function getDesignRow(actor: Actor, id: string): Promise<DesignRow | undefined> {
  return db().get<DesignRow>("SELECT * FROM designs WHERE id = ? AND user_id = ?", id, actor.userId);
}

export async function listDesignRows(actor: Actor): Promise<Array<DesignRow & { n: number }>> {
  return db().all<DesignRow & { n: number }>(
    `SELECT d.*, (SELECT COUNT(*) FROM design_versions v WHERE v.design_id = d.id) AS n
       FROM designs d WHERE d.user_id = ? ORDER BY d.updated_at DESC`,
    actor.userId,
  );
}

export async function loadVersionRows(actor: Actor, designId: string): Promise<VersionRow[]> {
  return db().all<VersionRow>(
    `SELECT v.version, v.json, v.prompt, v.summary, v.created_at
       FROM design_versions v JOIN designs d ON d.id = v.design_id
      WHERE v.design_id = ? AND d.user_id = ? ORDER BY v.version ASC`,
    designId, actor.userId,
  );
}

export async function insertDesign(actor: Actor, d: { id: string; name: string; now: number }): Promise<void> {
  await db().run("INSERT INTO designs (id, user_id, name, cursor, next_version, revision, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 0, ?, ?)",
    d.id, actor.userId, d.name, d.now, d.now);
}

/**
 * Add a version (dropping the redo branch and, once full, the oldest) and move the cursor to it, atomically.
 * Every statement is guarded by ownership, so for someone else's design the whole batch changes nothing.
 */
export async function pushVersion(
  actor: Actor,
  row: Pick<DesignRow, "id" | "next_version">,
  v: { json: string; prompt: string; summary: string; name: string; keepUpTo: number; historyLimit: number; now: number },
): Promise<void> {
  const own = [row.id, actor.userId];
  const results = await db().batch([
    stmt(`DELETE FROM design_versions WHERE design_id = ? AND version > ? AND ${OWNED}`, row.id, v.keepUpTo, ...own),
    stmt(`INSERT INTO design_versions (design_id, version, json, prompt, summary, created_at)
          SELECT id, ?, ?, ?, ?, ? FROM designs WHERE id = ? AND user_id = ?`, row.next_version, v.json, v.prompt, v.summary, v.now, ...own),
    stmt(`DELETE FROM design_versions WHERE design_id = ? AND ${OWNED} AND version <= (
            SELECT version FROM design_versions WHERE design_id = ? ORDER BY version DESC LIMIT 1 OFFSET ?)`, row.id, ...own, row.id, v.historyLimit),
    stmt("UPDATE designs SET cursor = ?, next_version = ?, revision = revision + 1, name = ?, updated_at = ? WHERE id = ? AND user_id = ?",
      row.next_version, row.next_version + 1, v.name, v.now, ...own),
  ]);
  if (results[3].changes !== 1) throw new NotFoundError("Design not found");
}

export async function setCursor(actor: Actor, id: string, version: number, now: number): Promise<void> {
  const info = await db().run("UPDATE designs SET cursor = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND user_id = ?", version, now, id, actor.userId);
  if (info.changes !== 1) throw new NotFoundError("Design not found");
}

export async function deleteDesign(actor: Actor, id: string): Promise<void> {
  if (!(await getDesignRow(actor, id))) throw new NotFoundError("Design not found");
  await db().batch([
    stmt("DELETE FROM design_versions WHERE design_id IN (SELECT id FROM designs WHERE id = ? AND user_id = ?)", id, actor.userId),
    stmt("DELETE FROM designs WHERE id = ? AND user_id = ?", id, actor.userId),
  ]);
}

/** Link a design to one of the user's design systems (NULL unlinks). The subselect re-checks the system's owner. */
export async function setDesignSystem(actor: Actor, designId: string, systemId: string | null): Promise<void> {
  await db().run("UPDATE designs SET system_id = (SELECT id FROM design_systems WHERE id = ? AND user_id = ?) WHERE id = ? AND user_id = ?",
    systemId, actor.userId, designId, actor.userId);
}
