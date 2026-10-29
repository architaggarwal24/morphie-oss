import type { Actor } from "../auth/actor";
import { db } from "../db";

/** Agent settings JSON and per-user secrets. Secrets are stored encrypted; callers pass and receive ciphertext. */

export async function readSettingsJson(actor: Actor): Promise<string | undefined> {
  return (await db().get<{ json: string }>("SELECT json FROM user_settings WHERE user_id = ?", actor.userId))?.json;
}

export async function writeSettingsJson(actor: Actor, json: string): Promise<void> {
  await db().run(`INSERT INTO user_settings (user_id, json) VALUES (?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET json = excluded.json`, actor.userId, json);
}

export async function readSecretEnc(actor: Actor, name: string): Promise<string | undefined> {
  return (await db().get<{ value_enc: string }>("SELECT value_enc FROM user_secrets WHERE user_id = ? AND name = ?", actor.userId, name))?.value_enc;
}

export async function writeSecretEnc(actor: Actor, name: string, valueEnc: string): Promise<void> {
  await db().run(`INSERT INTO user_secrets (user_id, name, value_enc) VALUES (?, ?, ?)
                  ON CONFLICT(user_id, name) DO UPDATE SET value_enc = excluded.value_enc`, actor.userId, name, valueEnc);
}

export async function deleteSecret(actor: Actor, name: string): Promise<void> {
  await db().run("DELETE FROM user_secrets WHERE user_id = ? AND name = ?", actor.userId, name);
}
