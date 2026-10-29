import { clearSessionCookie, revokeSession } from "@/server/auth/session";
import { route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** End this browser's session. Idempotent: always clears the cookie, even if there was nothing to revoke. */
export const POST = route({ auth: "public" }, async (c) => {
  if (c.actor) await revokeSession(c.actor.sessionId);
  c.cookies.push(clearSessionCookie(c.req));
  return { ok: true };
});
