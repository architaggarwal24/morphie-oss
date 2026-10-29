import type { Actor } from "../auth/actor";
import { db, stmt } from "../db";
import { NotFoundError } from "./errors";

export interface ProfileRow {
  id: string; user_id: string; kind: string; label: string; model: string;
  secret_enc: string | null; base_url: string | null; options_enc: string | null; updated_at: number;
}

export async function listProfileRows(actor: Actor): Promise<ProfileRow[]> {
  return db().all<ProfileRow>("SELECT * FROM provider_profiles WHERE user_id = ? ORDER BY updated_at DESC", actor.userId);
}

export async function getProfileRow(actor: Actor, id: string): Promise<ProfileRow | undefined> {
  return db().get<ProfileRow>("SELECT * FROM provider_profiles WHERE id = ? AND user_id = ?", id, actor.userId);
}

export async function countProfiles(actor: Actor): Promise<number> {
  return (await db().get<{ c: number }>("SELECT COUNT(*) AS c FROM provider_profiles WHERE user_id = ?", actor.userId))?.c ?? 0;
}

export async function getActiveProfileId(actor: Actor): Promise<string | null> {
  return (await db().get<{ active_profile_id: string | null }>("SELECT active_profile_id FROM user_settings WHERE user_id = ?", actor.userId))?.active_profile_id ?? null;
}

export async function upsertProfile(actor: Actor, p: Omit<ProfileRow, "user_id" | "updated_at"> & { now: number }): Promise<void> {
  // The conflict clause is owner-checked too: an id that belongs to someone else can never be overwritten.
  await db().run(`INSERT INTO provider_profiles (id, user_id, kind, label, model, secret_enc, base_url, options_enc, created_at, updated_at)
                  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                  ON CONFLICT(id) DO UPDATE SET label = ?4, model = ?5, secret_enc = ?6, base_url = ?7, options_enc = ?8, updated_at = ?9
                  WHERE provider_profiles.user_id = ?2`,
    p.id, actor.userId, p.kind, p.label, p.model, p.secret_enc, p.base_url, p.options_enc, p.now);
}

export async function setActiveProfileId(actor: Actor, id: string): Promise<void> {
  // Only an owned profile can become active: the row is written from a SELECT that finds nothing otherwise.
  const info = await db().run(`INSERT INTO user_settings (user_id, active_profile_id)
                                 SELECT ?, id FROM provider_profiles WHERE id = ? AND user_id = ?
                               ON CONFLICT(user_id) DO UPDATE SET active_profile_id = excluded.active_profile_id`, actor.userId, id, actor.userId);
  if (info.changes !== 1) throw new NotFoundError("Provider not found");
}

/** For ids that aren't rows here (Morphie AI models): the caller has already checked the user may pick it. */
export async function setActiveIdUnchecked(actor: Actor, id: string): Promise<void> {
  await db().run(`INSERT INTO user_settings (user_id, active_profile_id) VALUES (?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET active_profile_id = excluded.active_profile_id`, actor.userId, id);
}

export async function deleteProfile(actor: Actor, id: string): Promise<void> {
  const [info] = await db().batch([
    stmt("DELETE FROM provider_profiles WHERE id = ? AND user_id = ?", id, actor.userId),
    stmt("UPDATE user_settings SET active_profile_id = NULL WHERE user_id = ? AND active_profile_id = ?", actor.userId, id),
  ]);
  if (info.changes !== 1) throw new NotFoundError("Provider not found");
}
