import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logout from "@/app/api/auth/logout/route";
import * as logoutAll from "@/app/api/auth/logout-all/route";
import * as sessionRoute from "@/app/api/auth/session/route";
import * as providerTest from "@/app/api/providers/test/route";
import * as conversations from "@/app/api/conversations/route";
import { config } from "@/server/config";
import { finishLogin } from "@/server/auth/login";
import { hashToken, resolveSession, revokeAllSessions, revokeSession, rotateSession, sessionCookie, startSession } from "@/server/auth/session";
import { createConversation } from "@/server/conversations";
import { sha256 } from "@/server/crypto";
import { sqliteConn as db } from "@/server/db";
import { _resetRateLimits } from "@/server/security";
import { Client } from "./helpers/client";
import { testActor } from "./helpers/actor";
import { accountClient, makeUser, signIn } from "./helpers/users";

const HTTPS = "https://morphie.test";
const ORIGIN_HTTP = "http://localhost:3000";
const count = (sql: string, ...p: unknown[]) => db().prepare(sql).get(...p).n as number;
const DAY = 86_400_000;

beforeEach(async () => _resetRateLimits());
afterEach(async () => { vi.unstubAllEnvs(); vi.useRealTimers(); });

/** The Set-Cookie value a completed login would send for this request. */
const loginCookie = async (req: Request, userId = makeUser().userId) => (await finishLogin(req, "test", null, userId)).cookie;

describe("session cookies", () => {
  it("over http: plain name, HttpOnly, SameSite=Lax, persistent, no Secure, no Domain", async () => {
    const cookie = await loginCookie(new Request(`${ORIGIN_HTTP}/api/auth/email/verify`));
    expect(cookie).toMatch(/^morphie_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/Path=\//); expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(cookie).not.toMatch(/Secure|Domain|Expires/i);
  });

  it("over https: __Host- prefix, Secure, no Domain; and the plain cookie is never accepted", async () => {
    const cookie = await loginCookie(new Request(`${HTTPS}/api/auth/email/verify`));
    expect(cookie).toMatch(/^__Host-morphie_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/Secure/); expect(cookie).toMatch(/Path=\//); expect(cookie).not.toMatch(/Domain/i);
    // A plain-named cookie (e.g. planted by a sibling subdomain) must be ignored over https, even if the token is a live session.
    const { userId } = makeUser(); const live = await startSession(userId);
    const planted = new Client(HTTPS);
    planted.jar.set("morphie_session", live.token);
    const r = await planted.call(conversations.GET, "/api/conversations");
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
    // The same token under the __Host- name is accepted.
    const real = new Client(HTTPS); real.jar.set("__Host-morphie_session", live.token);
    expect((await real.call(conversations.GET, "/api/conversations")).status).toBe(200);
  });

  it("trusts x-forwarded-proto only behind a trusted proxy", async () => {
    const spoofed = () => new Request(`${ORIGIN_HTTP}/api/auth/email/verify`, { headers: { "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.1" } });
    expect(await loginCookie(spoofed())).toMatch(/^morphie_session=/);
    vi.stubEnv("MORPHIE_TRUSTED_PROXY", "1");
    expect(await loginCookie(spoofed())).toMatch(/^__Host-morphie_session=.*Secure/);
  });

  it("the cookie's Max-Age equals the session's absolute expiry", async () => {
    const { userId } = makeUser();
    const s = await startSession(userId);
    const cookie = sessionCookie(s.token, s, new Request("http://localhost:3000/"));
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);
    expect(Math.abs(maxAge - config.userMaxMs / 1000)).toBeLessThan(5);
  });

  it("stores only the SHA-256 of the token, never the token", async () => {
    const { userId } = makeUser();
    const s = await startSession(userId);
    const rows = db().prepare("SELECT * FROM sessions WHERE user_id = ?").all(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(sha256(s.token));
    expect(JSON.stringify(rows)).not.toContain(s.token);
    expect(hashToken(s.token)).toBe(s.sessionId);
  });

  it("ignores forged, truncated and unknown tokens: no session, 401 on user routes, nothing created", async () => {
    const users = count("SELECT COUNT(*) AS n FROM users"), sessions = count("SELECT COUNT(*) AS n FROM sessions");
    for (const bad of ["x", "A".repeat(43), "A".repeat(42), "../../etc/passwd", "A".repeat(300)]) {
      const c = new Client(); c.jar.set("morphie_session", bad);
      expect((await c.json(sessionRoute.GET, "/api/auth/session")).data.authenticated).toBe(false);
      const res = await c.call(conversations.GET, "/api/conversations");
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(c.sessionToken).toBe(bad); // the server issued nothing in its place
    }
    expect(count("SELECT COUNT(*) AS n FROM users")).toBe(users);
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(sessions);
  });
});

describe("expiry", () => {
  it("accounts: 14 days idle, 30 days absolute", async () => {
    const { userId } = makeUser();
    const s = await startSession(userId, {}, 0);
    expect(s.idleExpiresAt).toBe(14 * DAY);
    expect(s.absoluteExpiresAt).toBe(30 * DAY);
    expect(await resolveSession(s.token, 13 * DAY)).not.toBeNull();
    expect(await resolveSession(s.token, 40 * DAY)).toBeNull();
  });

  it("the idle window slides with activity but never passes the absolute maximum", async () => {
    const s = await startSession(makeUser().userId, {}, 0);
    expect(await resolveSession(s.token, 13 * DAY)).not.toBeNull();            // active just inside the idle window
    expect(await resolveSession(s.token, 13 * DAY + 61_000)).not.toBeNull();   // the touch slid the window forward
    let t = 13 * DAY + 61_000;
    while (t + 10 * DAY < 30 * DAY) { t += 10 * DAY; expect(await resolveSession(s.token, t)).not.toBeNull(); }
    expect(await resolveSession(s.token, 30 * DAY)).toBeNull();                // absolute expiry wins over activity
  });

  it("expires after the idle period with no activity", async () => {
    const s = await startSession(makeUser().userId, {}, 0);
    expect(await resolveSession(s.token, 14 * DAY + 1)).toBeNull();
  });

  it("idle and maximum lifetimes are configurable", async () => {
    vi.stubEnv("MORPHIE_SESSION_IDLE_DAYS", "1"); vi.stubEnv("MORPHIE_SESSION_MAX_DAYS", "2");
    const s = await startSession(makeUser().userId, {}, 0);
    expect(s.idleExpiresAt).toBe(DAY);
    expect(s.absoluteExpiresAt).toBe(2 * DAY);
    expect(await resolveSession(s.token, DAY + 1)).toBeNull();
  });

  it("an expired session is nobody: 401 on user routes, not a fresh identity, and the data stays out of reach", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const c = new Client();
    const { userId } = makeUser(); signIn(c, userId);
    await createConversation(testActor(userId), "chat", "Mine");
    expect((await c.json(conversations.GET, "/api/conversations")).data.conversations).toHaveLength(1);
    const users = count("SELECT COUNT(*) AS n FROM users"), sessions = count("SELECT COUNT(*) AS n FROM sessions");
    vi.setSystemTime(new Date("2026-01-16T00:00:01Z")); // just over 14 days idle
    expect((await c.json(sessionRoute.GET, "/api/auth/session")).data.authenticated).toBe(false); // public route: sees no session
    const again = await c.call(conversations.GET, "/api/conversations");
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM users")).toBe(users);
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(sessions);
  });
});

describe("rotation and revocation", () => {
  it("rotation issues a fresh token, kills the old one immediately and keeps the user", async () => {
    const { userId } = makeUser();
    const a = await startSession(userId);
    const b = await rotateSession(a.sessionId, { userId });
    expect(b.token).not.toBe(a.token);
    expect(await resolveSession(a.token)).toBeNull();
    expect((await resolveSession(b.token))?.actor.userId).toBe(userId);
    expect(db().prepare("SELECT revoked_at FROM sessions WHERE id = ?").get(a.sessionId).revoked_at).not.toBeNull();
  });

  it("logging in as someone else in the same browser rotates into the new user's session and kills the old one", async () => {
    const first = makeUser(), second = makeUser();
    const a = await startSession(first.userId);
    const b = await rotateSession(a.sessionId, { userId: second.userId });
    expect(await resolveSession(a.token)).toBeNull();
    expect((await resolveSession(b.token))!.actor.userId).toBe(second.userId);
    expect((await resolveSession(b.token))!.actor).not.toHaveProperty("isGuest");
  });

  it("revokeSession and revokeAllSessions take effect on the next request", async () => {
    const { userId } = makeUser();
    const [a, b, c] = [await startSession(userId), await startSession(userId), await startSession(userId)];
    expect(await revokeSession(a.sessionId)).toBe(true);
    expect(await revokeSession(a.sessionId)).toBe(false); // already revoked
    expect(await resolveSession(a.token)).toBeNull();
    expect(await revokeAllSessions(userId)).toBe(2);
    expect(await resolveSession(b.token)).toBeNull(); expect(await resolveSession(c.token)).toBeNull();
  });

  it("a revoked cookie does not resurrect: 401, and no replacement session is started", async () => {
    const c = new Client(); const s = signIn(c, makeUser().userId);
    await revokeSession(s.sessionId);
    const sessions = count("SELECT COUNT(*) AS n FROM sessions");
    const res = await c.call(conversations.GET, "/api/conversations");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(sessions);
  });
});

describe("logout and logout-all", () => {
  it("logout revokes the session, clears the cookie, and is idempotent", async () => {
    const c = accountClient();
    const token = c.sessionToken!;
    const res = await c.call(logout.POST, "/api/auth/logout", { method: "POST" });
    expect(res.headers.get("set-cookie")).toMatch(/^morphie_session=;.*Max-Age=0/);
    expect(await resolveSession(token)).toBeNull();
    expect(c.sessionToken).toBeUndefined();
    expect((await c.json(logout.POST, "/api/auth/logout", { method: "POST" })).status).toBe(200); // nothing to revoke: still fine
    expect(count("SELECT COUNT(*) AS n FROM users")).toBeGreaterThan(0); // signing out never deletes the account
  });

  it("logout needs a same-origin request (CSRF)", async () => {
    const c = accountClient();
    expect((await c.json(logout.POST, "/api/auth/logout", { method: "POST", origin: "https://evil.example" })).status).toBe(403);
    expect(await resolveSession(c.sessionToken!)).not.toBeNull();
  });

  it("logout-all signs the user out of every browser and leaves other users alone", async () => {
    const { userId } = makeUser();
    const other = makeUser();
    const [a, b, c] = [new Client(), new Client(), new Client()];
    const sa = signIn(a, userId), sb = signIn(b, userId), sc = signIn(c, userId);
    const bystander = new Client(); signIn(bystander, other.userId);
    const res = await a.json(logoutAll.POST, "/api/auth/logout-all", { method: "POST" });
    expect(res.status).toBe(200); expect(res.data.revoked).toBe(3);
    for (const s of [sa, sb, sc]) expect(await resolveSession(s.token)).toBeNull();
    expect((await b.json(sessionRoute.GET, "/api/auth/session")).data.authenticated).toBe(false);
    expect((await bystander.json(sessionRoute.GET, "/api/auth/session")).data).toMatchObject({ authenticated: true });
  });
});

describe("auth levels", () => {
  it("public routes never create an identity or a cookie", async () => {
    const before = count("SELECT COUNT(*) AS n FROM users"); const sess = count("SELECT COUNT(*) AS n FROM sessions");
    const c = new Client();
    const res = await c.call(sessionRoute.GET, "/api/auth/session");
    const body = await res.json();
    expect(body).toMatchObject({ authenticated: false, user: null });
    expect(body).not.toHaveProperty("isGuest");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM users")).toBe(before);
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(sess);
  });

  it("user routes: 401 with no session (creating nothing), OK for an account", async () => {
    const users = count("SELECT COUNT(*) AS n FROM users"), sessions = count("SELECT COUNT(*) AS n FROM sessions");
    const anon = new Client();
    const r1 = await anon.json(logoutAll.POST, "/api/auth/logout-all", { method: "POST" });
    expect(r1.status).toBe(401); expect(r1.data.code).toBe("unauthenticated"); expect(r1.headers.get("set-cookie")).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM users")).toBe(users);
    expect(count("SELECT COUNT(*) AS n FROM sessions")).toBe(sessions);
    expect((await accountClient().json(logoutAll.POST, "/api/auth/logout-all", { method: "POST" })).status).toBe(200);
  });

  it("GET /api/auth/session tells an account who they are and when the session ends", async () => {
    const u = new Client(); const { userId, email } = makeUser("Ada@Example.com"); signIn(u, userId);
    const data = (await u.json(sessionRoute.GET, "/api/auth/session")).data;
    expect(data).toMatchObject({ authenticated: true, user: { email, displayName: "Test User" } });
    expect(data).not.toHaveProperty("isGuest");
    expect(data.expiresAt).toBeGreaterThan(Date.now()); expect(data.idleExpiresAt).toBeLessThanOrEqual(data.expiresAt);
  });
});

describe("request flooding", () => {
  const withProxy = (ip: string) => ({ "x-forwarded-for": ip });

  it("a forged x-forwarded-for cannot dodge the per-IP ceiling", async () => {
    vi.stubEnv("MORPHIE_TRUSTED_PROXY", "1"); vi.stubEnv("MORPHIE_IP_RATE_PER_MIN", "2");
    const real = "198.51.100.20";
    for (let i = 0; i < 2; i++) expect((await new Client(ORIGIN_HTTP, withProxy(real)).call(sessionRoute.GET, "/api/auth/session")).status).toBe(200);
    // the attacker prepends fake hops; the proxy still appends the real one last
    expect((await new Client(ORIGIN_HTTP, withProxy(`1.1.1.1, ${real}`)).call(sessionRoute.GET, "/api/auth/session")).status).toBe(429);
    // another network is unaffected
    expect((await new Client(ORIGIN_HTTP, withProxy("198.51.100.21")).call(sessionRoute.GET, "/api/auth/session")).status).toBe(200);
  });

  it("without a trusted proxy every client shares the 'unknown' bucket (and spoofed headers are ignored)", async () => {
    vi.stubEnv("MORPHIE_IP_RATE_PER_MIN", "2");
    expect((await new Client(ORIGIN_HTTP, withProxy("1.1.1.1")).call(sessionRoute.GET, "/api/auth/session")).status).toBe(200);
    expect((await new Client(ORIGIN_HTTP, withProxy("2.2.2.2")).call(sessionRoute.GET, "/api/auth/session")).status).toBe(200);
    expect((await new Client(ORIGIN_HTTP, withProxy("3.3.3.3")).call(sessionRoute.GET, "/api/auth/session")).status).toBe(429);
  });

  it("per-IP rate limits cannot be escaped by switching accounts or cookies", async () => {
    vi.stubEnv("MORPHIE_TRUSTED_PROXY", "1");
    let limited = 0;
    for (let i = 0; i < 45; i++) {
      const fresh = new Client(ORIGIN_HTTP, withProxy("192.0.2.99")); // a different account every time: the per-user bucket never fills
      signIn(fresh, makeUser().userId);
      const r = await fresh.json(providerTest.POST, "/api/providers/test", { method: "POST", body: {} });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0); // 12/min per user x3 = 36 per IP
  });

  it("a global per-IP request ceiling applies to every route", async () => {
    vi.stubEnv("MORPHIE_TRUSTED_PROXY", "1"); vi.stubEnv("MORPHIE_IP_RATE_PER_MIN", "5");
    const c = new Client(ORIGIN_HTTP, withProxy("192.0.2.50"));
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await c.call(sessionRoute.GET, "/api/auth/session")).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });
});
