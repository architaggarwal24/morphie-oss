import type { Actor } from "../auth/actor";
import { db, now } from "../db";

/** Morphie Runners. Only the SHA-256 of a runner's token is stored. Scoped to the owner, except the token lookup. */
export interface RunnerRow { id: string; user_id: string; name: string; token_hash: string; platform: string; created_at: number; last_seen_at: number | null }

export async function insertRunner(actor: Actor, r: { id: string; name: string; tokenHash: string }): Promise<void> {
  await db().run("INSERT INTO runners (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", r.id, actor.userId, r.name, r.tokenHash, now());
}

export async function listRunnerRows(actor: Actor): Promise<RunnerRow[]> {
  return db().all<RunnerRow>("SELECT * FROM runners WHERE user_id = ? ORDER BY created_at DESC LIMIT 20", actor.userId);
}

export async function getRunnerRow(actor: Actor, id: string): Promise<RunnerRow | undefined> {
  return db().get<RunnerRow>("SELECT * FROM runners WHERE id = ? AND user_id = ?", id, actor.userId);
}

/** For the runner's own requests: the row its token names (the caller checks the hash). */
export async function runnerById(id: string): Promise<RunnerRow | undefined> {
  return db().get<RunnerRow>("SELECT * FROM runners WHERE id = ?", id);
}

export async function countRunners(actor: Actor): Promise<number> {
  return Number((await db().get<{ n: number }>("SELECT COUNT(*) AS n FROM runners WHERE user_id = ?", actor.userId))?.n ?? 0);
}

export async function touchRunner(id: string, platform: string): Promise<void> {
  await db().run("UPDATE runners SET last_seen_at = ?, platform = ? WHERE id = ?", now(), platform.slice(0, 80), id);
}

export async function deleteRunner(actor: Actor, id: string): Promise<boolean> {
  return (await db().run("DELETE FROM runners WHERE id = ? AND user_id = ?", id, actor.userId)).changes > 0;
}
