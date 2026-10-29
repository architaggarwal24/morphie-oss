import { sha256 } from "../crypto";
import { db, now } from "../db";
import { rateLimitEpoch } from "../security";

/**
 * Fixed-window counters in the database, so a limit holds across every server instance (on Cloudflare each isolate
 * has its own memory, which made in-memory limits easy to get around). Keys are hashed: they can contain addresses.
 * One statement counts the hit and reads the total, so concurrent requests can't both slip under the limit.
 * Returns the seconds to wait, or 0.
 */
export async function hitDurable(key: string, limit: number, windowMs: number, t = now()): Promise<number> {
  const start = Math.floor(t / windowMs) * windowMs;
  const row = await db().get<{ hits: number; window_start: number }>(
    `INSERT INTO rate_limits (key, window_start, hits) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET hits = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.hits + 1 ELSE 1 END,
                                    window_start = excluded.window_start
     RETURNING hits, window_start`,
    sha256(`${rateLimitEpoch()}|${key}`).slice(0, 40), start);
  if (!row || row.hits <= limit) return 0;
  return Math.max(1, Math.ceil((row.window_start + windowMs - t) / 1000));
}

/** Drop counters whose window ended more than a day ago. */
export async function purgeRateLimits(t = now()): Promise<number> {
  return (await db().run("DELETE FROM rate_limits WHERE window_start < ?", t - 86_400_000)).changes;
}

/** How many sign-in codes were made (and so emails sent) across the whole site since `since`. */
export async function codesSince(since: number): Promise<number> {
  return Number((await db().get<{ n: number }>("SELECT COUNT(*) AS n FROM email_codes WHERE created_at > ?", since))?.n ?? 0);
}
