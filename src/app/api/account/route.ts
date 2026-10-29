import { z } from "zod";
import { clearSessionCookie } from "@/server/auth/session";
import { deleteAccount, getAccount, listSessions, setDisplayName } from "@/server/data/account";
import { ApiError, route } from "@/server/http";
import { destroyAllProjects } from "@/server/code/routes";
import { clearWorkspace } from "@/server/workspace";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const view = async (c: { actor: Parameters<typeof getAccount>[0] }) => {
  const account = await getAccount(c.actor);
  if (!account) throw new ApiError(404, "Account not found.", "not_found");
  return { account, sessions: await listSessions(c.actor) };
};

/** The signed-in person's account: profile, how they can log in, and where they're signed in. */
export const GET = route({ auth: "user" }, async (c) => view(c));

export const PATCH = route({ auth: "user" }, async (c) => {
  const b = await c.body(z.object({ displayName: z.string().trim().min(1, "Enter a name.").max(60) }), 2_000);
  await setDisplayName(c.actor, b.displayName);
  return view(c);
});

/** Delete the account for good. The body must repeat the account's email, so it can't happen by accident. */
export const DELETE = route({ auth: "user" }, async (c) => {
  const b = await c.body(z.object({ confirmEmail: z.string().max(254) }), 2_000);
  const account = await getAccount(c.actor);
  if (!account || b.confirmEmail.trim().toLowerCase() !== account.email) throw new ApiError(400, "Type your account's email exactly to confirm.", "confirm_mismatch");
  await clearWorkspace(c.actor);
  await destroyAllProjects(c.actor);
  await deleteAccount(c.actor);
  c.cookies.push(clearSessionCookie(c.req));
  return { ok: true };
});
