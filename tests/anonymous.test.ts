import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as bootstrap from "@/app/api/bootstrap/route";
import type { Actor } from "@/server/auth/actor";
import { sqliteConn as db } from "@/server/db";
import { route } from "@/server/http";
import { _resetRateLimits } from "@/server/security";
import { Client } from "./helpers/client";
import { discoverRouteFiles, routePattern, VERBS } from "./helpers/routes";
import { accountClient } from "./helpers/users";

const files = discoverRouteFiles();
const modules = new Map<string, Record<string, any>>();
beforeAll(async () => { for (const f of files) modules.set(routePattern(f), await import(/* @vite-ignore */ f)); });
beforeEach(async () => _resetRateLimits());

const count = (table: string) => db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n as number;

/** The only routes a visitor without a session may call. Adding to this list is a deliberate decision. */
const PUBLIC_ROUTES = [
  "GET /api/bootstrap",
  "GET /api/auth/oauth/[provider]/callback",
  "GET /api/auth/oauth/[provider]/start",
  "GET /api/auth/session",
  "GET /api/health",
  "POST /api/auth/email/request",
  "POST /api/auth/email/verify",
  "POST /api/auth/password/login",
  "POST /api/auth/password/signup",
  "POST /api/auth/logout",
  // The project preview: a sandboxed frame gets no session cookie, so the signed, expiring token in the URL is the key.
  "GET /api/preview/[token]/[[...path]]",
  // Bank alert emails from the Worker's email handler: a shared secret (MORPHIE_INBOUND_SECRET) plus DKIM, no session.
  "POST /api/billing/inbound",
  // The Morphie Runner on someone's own computer: its runner token (Authorization: Bearer), not a session.
  "GET /api/runner/jobs",
  "POST /api/runner/jobs",
].sort();

const handlers = (): Array<{ pattern: string; verb: string; auth: string }> =>
  [...modules].flatMap(([pattern, mod]) => VERBS.filter((v) => v in mod).map((verb) => ({ pattern, verb, auth: mod[verb].auth as string })));

describe("auth levels are exactly public and user", () => {
  it("the set of public routes is the sign-in flow, bootstrap, session and health, and nothing else", async () => {
    const pub = handlers().filter((h) => h.auth === "public").map((h) => `${h.verb} ${h.pattern}`).sort();
    expect(pub).toEqual(PUBLIC_ROUTES);
  });

  it("every other route is declared 'user'", async () => {
    const others = handlers().filter((h) => h.auth !== "public");
    expect(others.length).toBeGreaterThanOrEqual(30);
    expect(others.filter((h) => h.auth !== "user").map((h) => `${h.verb} ${h.pattern} → ${h.auth}`)).toEqual([]);
  });

  it("'guest' cannot compile as an auth level, and an Actor has no isGuest", async () => {
    // These lines are checked by `npm run typecheck`: if the guest level or the field came back, the directives
    // would be unused and tsc would fail. They are never executed.
    const neverRun = () => {
      // @ts-expect-error "guest" is not an auth level
      route({ auth: "guest" }, async () => ({}));
      // @ts-expect-error an Actor is just { userId, sessionId }
      const actor: Actor = { userId: "u", sessionId: "s", isGuest: false };
      return actor;
    };
    expect(typeof neverRun).toBe("function");
  });

  it("no source file still carries guest-mode identifiers (only the migration that removes them may)", async () => {
    const banned = /\bis_guest\b|\bisGuest\b|createGuestUser|auth:\s*"guest"|legacy_anonymous|linked_guest|linkedGuest|guestLinked|morphie_uid|acceptLegacyCookie|REMOVE-LEGACY-SHIM|MAX_NEW_IDENTITIES|GUEST_IDLE|GUEST_MAX/;
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(ts|tsx)$/.test(e.name) && banned.test(fs.readFileSync(f, "utf8"))) hits.push(f.split(path.sep).join("/"));
      }
    };
    walk("src");
    expect(hits).toEqual(["src/server/migrations.ts"]);
    expect(fs.existsSync("src/server/auth/legacyCookie.ts")).toBe(false);
  });
});

describe("a visitor with no identity", () => {
  /** Fill a route pattern such as /api/design/[id]/[action] with throwaway values. */
  const urlFor = (pattern: string) => pattern.replace(/\[(\w+)\]/g, (_, name) => (name === "action" ? "export" : "nothing-here"));
  const paramsFor = (pattern: string) => Object.fromEntries([...pattern.matchAll(/\[(\w+)\]/g)].map(([, name]) => [name, name === "action" ? "export" : "nothing-here"]));

  const nonPublic = () => handlers().filter((h) => h.auth !== "public");

  for (const [label, prepare] of [
    ["no cookie", (_c: Client) => {}],
    ["a forged session cookie", (c: Client) => c.jar.set("morphie_session", "A".repeat(43))],
    ["a malformed session cookie", (c: Client) => c.jar.set("morphie_session", "../../etc/passwd")],
  ] as const) {
    it(`gets 401 from every non-public route with ${label}, and nothing is created`, async () => {
      const usersBefore = count("users"), sessionsBefore = count("sessions");
      const calls = nonPublic();
      expect(calls.length).toBeGreaterThanOrEqual(30);
      const problems: string[] = [];
      for (const { pattern, verb } of calls) {
        const c = new Client(); prepare(c);
        const body = verb === "GET" || verb === "HEAD" || verb === "DELETE" ? undefined : {};
        const res = await c.call(modules.get(pattern)![verb], urlFor(pattern), { method: verb, body, params: paramsFor(pattern) });
        const json = await res.json().catch(() => null);
        if (res.status !== 401) problems.push(`${verb} ${pattern} answered ${res.status}`);
        else if (json?.code !== "unauthenticated") problems.push(`${verb} ${pattern} answered 401 with code ${json?.code}`);
        if (res.headers.get("set-cookie")) problems.push(`${verb} ${pattern} set a cookie for a visitor`);
      }
      expect(problems).toEqual([]);
      expect(count("users")).toBe(usersBefore);
      expect(count("sessions")).toBe(sessionsBefore);
    });
  }

  it("is refused on identity before anything else: a malformed write is a 401 and its body is never read", async () => {
    const c = new Client();
    const providers = modules.get("/api/providers")!;
    const res = await c.json(providers.POST, "/api/providers", { method: "POST", body: { kind: "nope" } });
    expect(res.status).toBe(401);
    expect(res.data).toEqual({ error: "Sign in to use this.", code: "unauthenticated" });
  });
});

describe("anonymous /api/bootstrap", () => {
  it("is public, minimal, and creates nothing: no user, no session, no cookie", async () => {
    const usersBefore = count("users"), sessionsBefore = count("sessions");
    const res = await new Client().call(bootstrap.GET, "/api/bootstrap");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = await res.json();
    expect(Object.keys(data).sort()).toEqual(["methods", "session", "version"]);
    expect(data.session).toBeNull();
    expect(data.version).toBe("2.0.0");
    expect(data.methods).toEqual({ email: expect.any(Boolean), google: expect.any(Boolean), github: expect.any(Boolean), password: expect.any(Boolean) });
    expect(count("users")).toBe(usersBefore);
    expect(count("sessions")).toBe(sessionsBefore);
  });

  it("leaks none of the signed-in payload (catalog, profiles, settings, conversations, server limits)", async () => {
    const text = JSON.stringify(await (await new Client().call(bootstrap.GET, "/api/bootstrap")).json());
    for (const key of ["catalog", "customPresets", "profiles", "activeId", "settings", "tools", "search", "conversations", "server"]) expect(text).not.toContain(`"${key}"`);
  });

  it("a stale or forged cookie is treated as no session: still minimal, and no cookie is issued", async () => {
    const c = new Client(); c.jar.set("morphie_session", "A".repeat(43));
    const res = await c.call(bootstrap.GET, "/api/bootstrap");
    expect((await res.json()).session).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("a signed-in user still gets today's full payload, plus their session", async () => {
    const c = accountClient();
    const { status, data } = await c.json(bootstrap.GET, "/api/bootstrap");
    expect(status).toBe(200);
    expect(Object.keys(data).sort()).toEqual(
      ["activeId", "admin", "catalog", "code", "conversations", "customPresets", "methods", "plan", "profiles", "projects", "running", "search", "server", "session", "settings", "tools", "version"],
    );
    // Plans are off unless the server turns them on: no plan, no admin.
    expect(data.plan).toBeNull();
    expect(data.admin).toBe(false);
    expect(data.session).toMatchObject({ user: { email: expect.stringContaining("@"), displayName: "Test User" } });
    expect(data.session.expiresAt).toBeGreaterThan(Date.now());
    expect(data.profiles).toEqual([]);
  });
});
