import { clearSessionCookie, revokeAllSessions } from "@/server/auth/session";
import { route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign out everywhere: revoke every session of the signed-in user, including this one. */
export const POST = route({ auth: "user" }, async (c) => {
  const revoked = await revokeAllSessions(c.actor.userId);
  c.cookies.push(clearSessionCookie(c.req));
  return { ok: true, revoked };
});
