import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as identityRoute from "@/app/api/account/identities/[provider]/route";
import * as oauthStart from "@/app/api/auth/oauth/[provider]/start/route";
import * as oauthCallback from "@/app/api/auth/oauth/[provider]/callback/route";
import { loginWithProvider, type Provider, type VerifiedProfile } from "@/server/auth/accounts";
import { setProviderOverrides, type OAuthProvider } from "@/server/auth/oauth";
import { resolveSession } from "@/server/auth/session";
import { sqliteConn as db } from "@/server/db";
import { _resetRateLimits } from "@/server/security";
import { Client } from "./helpers/client";
import { makeUser, signIn } from "./helpers/users";

/** Account → Connect Google/GitHub (an OAuth round trip that links instead of logging in) and → Disconnect. */

let seq = 0;
function fakeProvider(id: Provider, email = `linked-${++seq}@elsewhere.example`) {
  const profile: VerifiedProfile = { providerUserId: `${id}-link-${++seq}`, email, name: "Linked Person" };
  const p: OAuthProvider = { id, authorizationUrl: (a) => new URL(`https://fake-${id}.test/authorize?state=${a.state}`), exchange: async () => profile };
  return { p, profile };
}
const start = (c: Client, provider: Provider, q = "") => c.call(oauthStart.GET, `/api/auth/oauth/${provider}/start${q}`, { params: { provider } });
const callback = (c: Client, provider: Provider, q: string) => c.call(oauthCallback.GET, `/api/auth/oauth/${provider}/callback?${q}`, { params: { provider } });
const stateOf = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("state")!;
const identities = (userId: string) => db().prepare("SELECT provider, provider_user_id, email FROM user_identities WHERE user_id = ?").all(userId) as Array<{ provider: string; provider_user_id: string; email: string }>;
const unlink = (c: Client, provider: string) => c.json(identityRoute.DELETE, `/api/account/identities/${provider}`, { method: "DELETE", params: { provider } });

beforeEach(async () => { _resetRateLimits(); setProviderOverrides(undefined); });
afterEach(async () => setProviderOverrides(undefined));

describe("Connect (link mode)", () => {
  it("links the provider to the signed-in account even when its email differs, without logging in again", async () => {
    const g = fakeProvider("google"); setProviderOverrides({ google: g.p });
    const me = makeUser(); const c = new Client(); const session = signIn(c, me.userId);
    const res = await callback(c, "google", `code=abc&state=${stateOf(await start(c, "google", "?link=1"))}`);
    expect(res.headers.get("location")).toBe("/?linked=google");
    expect(identities(me.userId)).toEqual([{ provider: "google", provider_user_id: g.profile.providerUserId, email: g.profile.email }]);
    expect(c.sessionToken).toBe(session.token);                 // same session: nothing was rotated
    expect((await resolveSession(session.token))!.actor.userId).toBe(me.userId);
    // and the provider now signs in to this account
    expect((await loginWithProvider("google", g.profile)).user.id).toBe(me.userId);
  });

  it("needs a session to start, and refuses to finish in a browser now signed in as someone else", async () => {
    const g = fakeProvider("google"); setProviderOverrides({ google: g.p });
    expect((await start(new Client(), "google", "?link=1")).status).toBe(401);
    const a = makeUser(), b = makeUser();
    const c = new Client(); signIn(c, a.userId);
    const s = stateOf(await start(c, "google", "?link=1"));
    signIn(c, b.userId);                                         // the browser switched accounts mid-flow
    expect((await callback(c, "google", `code=abc&state=${s}`)).headers.get("location")).toBe("/?auth_error=link_session");
    expect(identities(a.userId)).toEqual([]);
    expect(identities(b.userId)).toEqual([]);
  });

  it("won't move an identity that already belongs to another account", async () => {
    const g = fakeProvider("github"); setProviderOverrides({ github: g.p });
    const owner = (await loginWithProvider("github", g.profile)).user;  // someone already signs in with it
    const me = makeUser(); const c = new Client(); signIn(c, me.userId);
    const res = await callback(c, "github", `code=abc&state=${stateOf(await start(c, "github", "?link=1"))}`);
    expect(res.headers.get("location")).toBe("/?auth_error=identity_taken");
    expect(identities(me.userId)).toEqual([]);
    expect(identities(owner.id)).toHaveLength(1);
  });

  it("an ordinary login (no link=1) still behaves as before", async () => {
    const g = fakeProvider("google"); setProviderOverrides({ google: g.p });
    const c = new Client();
    expect((await callback(c, "google", `code=abc&state=${stateOf(await start(c, "google"))}`)).headers.get("location")).toBe("/");
    expect((await resolveSession(c.sessionToken!))!.user.email).toBe(g.profile.email);
  });
});

describe("Disconnect", () => {
  it("removes the caller's own identity and returns the updated account", async () => {
    const me = makeUser(); const c = new Client(); signIn(c, me.userId);
    db().prepare("UPDATE users SET password_hash = 'x' WHERE id = ?").run(me.userId); // still has a password
    await loginWithProvider("google", { providerUserId: "g-unlink-1", email: me.email });
    const res = await unlink(c, "google");
    expect(res.status).toBe(200);
    expect(res.data.account.identities).toEqual([]);
    expect(identities(me.userId)).toEqual([]);
  });

  it("refuses to remove the last way to sign in", async () => {
    const me = makeUser(); const c = new Client(); signIn(c, me.userId);
    db().prepare("UPDATE users SET email_verified_at = NULL, password_hash = NULL WHERE id = ?").run(me.userId);
    db().prepare("INSERT INTO user_identities (provider, provider_user_id, user_id, email, created_at) VALUES ('github', 'h-last', ?, ?, ?)").run(me.userId, me.email, Date.now());
    setProviderOverrides({ github: fakeProvider("github").p });
    const res = await unlink(c, "github");
    expect(res.status).toBe(409);
    expect(identities(me.userId)).toHaveLength(1);
  });

  it("only touches the caller's identities, and 404s on unknown or unlinked providers", async () => {
    const other = makeUser(); await loginWithProvider("google", { providerUserId: "g-other", email: other.email });
    const me = makeUser(); const c = new Client(); signIn(c, me.userId);
    expect((await unlink(c, "google")).status).toBe(404);
    expect((await unlink(c, "facebook")).status).toBe(404);
    expect(identities(other.userId)).toHaveLength(1);
    expect((await unlink(new Client(), "google")).status).toBe(401);
  });
});
