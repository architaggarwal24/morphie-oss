import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import * as emailRequest from "@/app/api/auth/email/request/route";
import * as emailVerify from "@/app/api/auth/email/verify/route";
import { _resetTransportForTests, transport, type MemoryTransport } from "@/server/email";
import { _resetRateLimits } from "@/server/security";
import { Client } from "./helpers/client";
import { CASES, EXEMPT, actorOf, seedResources, snapshot, type Case, type Resources } from "./helpers/ownership";
import { discoverRouteFiles as discover, routePattern, VERBS } from "./helpers/routes";
import { accountClient } from "./helpers/users";

const files = discover();
const modules = new Map<string, Record<string, any>>();
beforeAll(async () => { for (const f of files) modules.set(routePattern(f), await import(/* @vite-ignore */ f)); });
beforeEach(async () => _resetRateLimits());

describe("every route declares who may call it", () => {
  it("discovers the route files", async () => {
    expect(files.length).toBeGreaterThanOrEqual(25);
  });

  it("every exported HTTP handler is built by route() with an auth level of public or user", async () => {
    const problems: string[] = [];
    for (const [pattern, mod] of modules) {
      const exported = VERBS.filter((v) => v in mod);
      if (!exported.length) problems.push(`${pattern}: exports no HTTP handler`);
      for (const v of exported) {
        const auth = mod[v]?.auth;
        if (!["public", "user"].includes(auth)) problems.push(`${pattern} ${v}: no auth declaration (wrap it in route({ auth: ... }, ...))`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("no route or page code touches the database directly", async () => {
    const offenders: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(ts|tsx)$/.test(e.name)) { const src = fs.readFileSync(f, "utf8"); if (/\bdb\(\)|from "@\/server\/db"|from "\.\.?\/.*\/server\/db"/.test(src)) offenders.push(f); } } };
    walk("src/app");
    expect(offenders).toEqual([]);
  });
});

describe("every route that takes an id or a path is covered by a cross-user case", () => {
  const needsCase = (file: string) => {
    const src = fs.readFileSync(file, "utf8");
    return routePattern(file).includes("[") || /\b(conversationId|designId|profileId)\b|searchParams\.get\("path"\)|\bid: z\.string/.test(src);
  };

  it("has a case or a documented exemption for each, and no stale entries", async () => {
    const patterns = files.map(routePattern);
    const missing = files.filter(needsCase).map(routePattern).filter((p) => !CASES.some((c) => c.route === p) && !(p in EXEMPT));
    expect(missing, "routes taking ids/paths need a case in tests/helpers/ownership.ts (or an EXEMPT reason)").toEqual([]);
    expect(CASES.filter((c) => !patterns.includes(c.route)).map((c) => c.route)).toEqual([]);
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(20);
  });

  it("covers every exported verb of those routes", async () => {
    const gaps: string[] = [];
    for (const f of files.filter(needsCase)) {
      const p = routePattern(f);
      if (p in EXEMPT) continue;
      for (const v of VERBS.filter((v) => v in modules.get(p)!)) if (!CASES.some((c) => c.route === p && c.verb === v)) gaps.push(`${p} ${v}`);
    }
    expect(gaps).toEqual([]);
  });
});

/** An account made the way a real person makes one: ask for an emailed code, type it in. */
async function signedUpAccount(): Promise<Client> {
  _resetTransportForTests();
  const c = new Client();
  const address = `attacker-${Math.random().toString(36).slice(2, 8)}@example.com`;
  expect((await c.json(emailRequest.POST, "/api/auth/email/request", { method: "POST", body: { email: address } })).status).toBe(200);
  const mail = [...(transport() as MemoryTransport).outbox].reverse().find((m) => m.to === address)!;
  const code = /\b(\d{6})\b/.exec(mail.text)![1];
  expect((await c.json(emailVerify.POST, "/api/auth/email/verify", { method: "POST", body: { email: address, code } })).status).toBe(200);
  return c;
}
const send = (c: Client, k: Case, r: Resources) =>
  c.json(modules.get(k.route)![k.verb], k.url(r), { method: k.verb, body: k.body?.(r), params: k.params?.(r) });

describe("user B can never reach user A's resources", () => {
  let victim: Client; let r: Resources; let before: string;
  beforeAll(async () => { victim = accountClient(); r = await seedResources(victim); before = await snapshot(await actorOf(victim)); });

  const attackers: Array<{ who: string; make: () => Promise<Client>; anonymous?: true }> = [
    { who: "another account", make: async () => accountClient() },
    { who: "an account that just signed up with an emailed code", make: signedUpAccount },
    { who: "a visitor with no cookie at all", make: async () => new Client(), anonymous: true },
  ];

  for (const { who, make, anonymous } of attackers) {
    describe(`as ${who}`, () => {
      for (const k of CASES) {
        const expected = anonymous ? "401" : k.listing ? "200, nothing of A's" : "404/403";
        it(`${k.verb} ${k.route}: ${k.label} → ${expected}`, async () => {
          const attacker = await make();
          const res = await send(attacker, k, r);
          if (anonymous) expect(res.status, `${k.verb} ${k.url(r)} answered ${res.status} ${JSON.stringify(res.data)}`).toBe(401);
          else if (k.listing) expect(res.status).toBe(200);
          else expect([403, 404], `${k.verb} ${k.url(r)} answered ${res.status} ${JSON.stringify(res.data)}`).toContain(res.status);
          expect(JSON.stringify(res.data ?? "")).not.toMatch(/Victim|victim|confidential roadmap|sk-victim|private (question|answer)/);
        });
      }
      it("leaves every one of A's resources exactly as they were", async () => {
        expect(await snapshot(await actorOf(victim))).toBe(before);
      });
    });
  }
});

describe("positive controls: the same requests work (or reach the handler) for the real owner", () => {
  for (const k of CASES) {
    it(`${k.verb} ${k.route}: ${k.label}`, async () => {
      const owner = accountClient();
      const r = await seedResources(owner);
      const res = await send(owner, k, r);
      if (k.owner === "reaches-handler") expect([403, 404], `${k.label}: ${JSON.stringify(res.data)}`).not.toContain(res.status);
      else expect(k.owner ?? [200], `${k.label}: ${JSON.stringify(res.data)}`).toContain(res.status);
    });
  }
});
