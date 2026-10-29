import { beginLogin, getProvider, redirectUriFor, safeReturnTo } from "@/server/auth/oauth";
import { oauthCookie } from "@/server/auth/login";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send the browser to Google/GitHub. A random state (and PKCE verifier) is stored server-side; the state is also set as a cookie.
 * `?link=1` (signed in only) connects the identity to the current account instead of logging in; it comes back to
 * Settings → Account with `?linked=<provider>`.
 */
export const GET = route({ auth: "public", rate: { bucket: "auth-oauth-start", limit: 20, windowMs: 3_600_000, durable: true } }, async (c) => {
  const provider = getProvider(c.params.provider);
  if (!provider) throw new ApiError(404, "That sign-in method isn't available.", "disabled");
  const link = c.url.searchParams.get("link") === "1";
  if (link && !c.actor) throw new ApiError(401, "Sign in first to connect an account.", "unauthorized");
  const returnTo = link ? `/?linked=${provider.id}` : safeReturnTo(c.url.searchParams.get("returnTo"));
  const { url, state } = await beginLogin(provider, redirectUriFor(provider.id, c.req), returnTo, undefined, link ? c.actor!.userId : null);
  c.cookies.push(oauthCookie(state, c.req));
  return new Response(null, { status: 302, headers: { location: url.toString() } });
});
