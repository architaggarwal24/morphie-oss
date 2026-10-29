import { listSessions, revokeOwnSession } from "@/server/data/account";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign out one of your own sessions (a lost laptop, an old browser). Another account's session is "not found". */
export const DELETE = route({ auth: "user" }, async (c) => {
  if (!/^[0-9a-f]{64}$/.test(c.params.id ?? "") || !await revokeOwnSession(c.actor, c.params.id)) throw new ApiError(404, "That session isn't active.", "not_found");
  return { sessions: await listSessions(c.actor) };
});
