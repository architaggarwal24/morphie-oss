import { linkIdentity, loginWithProvider } from "@/server/auth/accounts";
import { clearOauthCookie, finishLogin, readOauthState } from "@/server/auth/login";
import { completeLogin, getProvider, OAuthError, redirectUriFor } from "@/server/auth/oauth";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const back = (to: string) => new Response(null, { status: 302, headers: { location: to } });

/**
 * The provider sends the browser back here. Failures redirect to the app with a short error code (never provider
 * text); success signs in (or signs up) the account, rotating any session the browser already had, and returns to the page.
 */
export const GET = route({ auth: "public" }, async (c) => {
  const provider = getProvider(c.params.provider);
  if (!provider) throw new ApiError(404, "That sign-in method isn't available.", "disabled");
  c.cookies.push(clearOauthCookie(c.req)); // the state cookie is single-use whatever happens
  const q = c.url.searchParams;
  try {
    if (q.get("error")) throw new OAuthError("denied", "Sign-in was cancelled.");
    const code = q.get("code");
    if (!code || code.length > 2000) throw new OAuthError("provider_error", "The provider didn't send a code.");
    const { profile, returnTo, linkUserId } = await completeLogin(provider, {
      code, stateParam: q.get("state"), stateCookie: readOauthState(c.req), redirectUri: redirectUriFor(provider.id, c.req),
    });
    if (linkUserId) {
      // Connect, don't log in: only for the very account that started it, still signed in in this browser.
      if (c.actor?.userId !== linkUserId) throw new OAuthError("link_session", "Sign in again, then connect.");
      try { await linkIdentity(linkUserId, provider.id, profile); }
      catch (e) { if ((e as { code?: string }).code === "identity_taken") throw new OAuthError("identity_taken", (e as Error).message); throw e; }
      return back(returnTo);
    }
    const { user } = await loginWithProvider(provider.id, profile);
    const { cookie } = await finishLogin(c.req, c.ip, c.session, user.id);
    c.cookies.push(cookie);
    return back(returnTo);
  } catch (e) {
    const code = e instanceof OAuthError ? e.code : "provider_error";
    if (!(e instanceof OAuthError)) console.error("[auth] oauth callback failed:", (e as Error).message);
    return back(`/?auth_error=${code}`);
  }
});
