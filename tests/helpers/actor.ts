import type { Actor } from "@/server/auth/actor";
import { sqliteConn as db } from "@/server/db";

/**
 * An actor for calling data-access functions directly in tests: a normal account, like every real caller.
 * Creates the users row (with a verified email) if needed.
 */
export function testActor(userId: string): Actor {
  const t = Date.now();
  db().prepare("INSERT OR IGNORE INTO users (id, created_at, email, email_verified_at, display_name, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, t, `${userId.toLowerCase()}@test.example`, t, "Test User", t);
  return { userId, sessionId: `test-session-${userId}` };
}
