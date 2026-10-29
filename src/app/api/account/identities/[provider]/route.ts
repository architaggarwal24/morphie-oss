import { identitiesOf, unlinkIdentity } from "@/server/auth/accounts";
import { loginMethods } from "@/server/auth/methods";
import { getAccount, listSessions } from "@/server/data/account";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Disconnect Google or GitHub from your own account. Refused when it is the last way left to sign in (no usable
 * password, no email code for a verified address, no other connected provider), so nobody locks themselves out.
 */
export const DELETE = route({ auth: "user" }, async (c) => {
  const provider = c.params.provider;
  if (provider !== "google" && provider !== "github") throw new ApiError(404, "Unknown sign-in method.", "not_found");
  const account = await getAccount(c.actor);
  if (!account) throw new ApiError(404, "Account not found.", "not_found");
  if (!account.identities.some((i) => i.provider === provider)) throw new ApiError(404, "That method isn't connected.", "not_found");
  const m = loginMethods();
  const others = (await identitiesOf(c.actor.userId)).filter((i) => i.provider !== provider && m[i.provider as "google" | "github"]);
  const canStillSignIn = (account.hasPassword && m.password) || (account.emailVerified && m.email) || others.length > 0;
  if (!canStillSignIn) throw new ApiError(409, "This is your only way to sign in. Set a password first, then disconnect.", "last_method");
  await unlinkIdentity(c.actor.userId, provider);
  return { account: await getAccount(c.actor), sessions: await listSessions(c.actor) };
});
