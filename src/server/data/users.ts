import type { Actor } from "../auth/actor";
import { db, stmt } from "../db";

/** Content tables that hold a user_id column. Keep in sync with the schema; the wipe test fails if one is missed. */
export const USER_CONTENT_TABLES = [
  "designs", "conversations", "chunks", "documents", "memories", "user_secrets", "user_settings", "provider_profiles", "projects", "design_systems", "usage_events", "skills", "runners", "credit_holds",
] as const;

/** The statements that delete every piece of this user's content, children first. Shared with account deletion. */
export function wipeContentStatements(actor: Actor) {
  return [
    stmt("DELETE FROM design_versions WHERE design_id IN (SELECT id FROM designs WHERE user_id = ?)", actor.userId),
    stmt("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)", actor.userId),
    ...USER_CONTENT_TABLES.map((table) => stmt(`DELETE FROM ${table} WHERE user_id = ?`, actor.userId)),
  ];
}

/** Delete every piece of this user's content ("Delete all my data"). The account and its sessions are untouched. */
export async function wipeContent(actor: Actor): Promise<void> {
  await db().batch(wipeContentStatements(actor));
}
