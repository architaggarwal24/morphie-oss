import { z } from "zod";
import { revokeOtherSessions } from "@/server/data/account";
import { setPassword } from "@/server/auth/password";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Set a first password, or change it (then `current` is required). Every other session is signed out afterwards. */
export const POST = route({ auth: "user", rate: { bucket: "account-password", limit: 10, windowMs: 900_000 } }, async (c) => {
  const b = await c.body(z.object({ next: z.string().max(400), current: z.string().max(400).optional() }), 4_000);
  const r = await setPassword(c.actor.userId, b.next, b.current);
  if (!r.ok) throw new ApiError(r.status, r.message, r.status === 400 ? "invalid" : "not_found");
  const signedOut = await revokeOtherSessions(c.actor);
  return { ok: true, signedOutOthers: signedOut };
});
