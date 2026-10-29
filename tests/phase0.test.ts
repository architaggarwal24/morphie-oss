import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { zipSync, strToU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allHeaders } from "../security-headers.mjs";
import { forbiddenEntries } from "../scripts/release-check.mjs";
import { assertProductionConfig, config, productionConfigProblems } from "@/server/config";
import { _resetCryptoCache, encrypt } from "@/server/crypto";
import { _setResolverForTests } from "@/server/dnsResolver";
import { guardedFetch, securityCause } from "@/server/net";
import { clientIp, isPrivateIp, validateBaseUrl } from "@/server/security";
import { fetchPublic } from "@/server/tools/fetchUrl";
import { providerFetch } from "@/server/providers/util";
import { ProviderError } from "@/server/providers/types";
import { ToolError } from "@/server/tools/types";

afterEach(async () => { vi.unstubAllEnvs(); _setResolverForTests(undefined); _resetCryptoCache(); });

const GOOD = {
  NODE_ENV: "production", ENCRYPTION_KEY: "a".repeat(40), SESSION_SECRET: "b".repeat(40),
} as unknown as NodeJS.ProcessEnv;

describe("production configuration", () => {
  it("accepts a safe configuration", async () => {
    expect(productionConfigProblems(GOOD)).toEqual([]);
    expect(() => assertProductionConfig(GOOD)).not.toThrow();
  });

  it("lists every problem at once and refuses to start", async () => {
    const env = { NODE_ENV: "production", MORPHIE_EMAIL_TRANSPORT: "console", GOOGLE_CLIENT_ID: "x", MORPHIE_PUBLIC_URL: "http://example.com" } as unknown as NodeJS.ProcessEnv;
    const problems = productionConfigProblems(env);
    expect(problems.join("\n")).toMatch(/ENCRYPTION_KEY is required/);
    expect(problems.join("\n")).toMatch(/SESSION_SECRET is required/);
    expect(problems.join("\n")).toMatch(/console is not allowed in production/);
    expect(problems.join("\n")).toMatch(/https:\/\//);
    expect(() => assertProductionConfig(env)).toThrow(/refuses to start/);
  });

  it("rejects short and identical secrets", async () => {
    expect(productionConfigProblems({ ...GOOD, ENCRYPTION_KEY: "short" } as never).join()).toMatch(/at least 32/);
    expect(productionConfigProblems({ ...GOOD, SESSION_SECRET: GOOD.ENCRYPTION_KEY } as never).join()).toMatch(/different/);
  });

  it("does nothing outside production, and file-based secrets are impossible in production", async () => {
    expect(() => assertProductionConfig({ NODE_ENV: "development" } as never)).not.toThrow();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENCRYPTION_KEY", "");
    _resetCryptoCache();
    expect(() => encrypt("x")).toThrow(/must be set in production/);
  });

  it("startup exits with status 1 and prints every problem, so a supervisor sees a crash", async () => {
    const { startupChecks } = await import("../src/instrumentation-node");
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("ENCRYPTION_KEY", ""); vi.stubEnv("SESSION_SECRET", "");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => startupChecks()).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(err.mock.calls[0][0])).toMatch(/ENCRYPTION_KEY is required[\s\S]*SESSION_SECRET is required/);
    exit.mockRestore(); err.mockRestore();
  });

  it("defaults private URLs to forbidden in production and allowed in development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(config.allowPrivateUrls).toBe(false);
    vi.stubEnv("MORPHIE_ALLOW_PRIVATE_URLS", "true");
    expect(config.allowPrivateUrls).toBe(true);
    vi.stubEnv("MORPHIE_ALLOW_PRIVATE_URLS", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(config.allowPrivateUrls).toBe(true);
  });
});

describe("security headers", () => {
  const find = (rules: ReturnType<typeof allHeaders>, source: string, key: string) =>
    rules.find((r) => r.source === source)!.headers.find((h) => h.key === key)?.value;

  it("sends HSTS only in production and the full hardening set always", async () => {
    const prod = allHeaders({ production: true });
    const dev = allHeaders({ production: false });
    expect(find(prod, "/:path*", "Strict-Transport-Security")).toMatch(/max-age=31536000/);
    expect(find(dev, "/:path*", "Strict-Transport-Security")).toBeUndefined();
    for (const rules of [prod, dev]) {
      expect(find(rules, "/:path*", "X-Content-Type-Options")).toBe("nosniff");
      expect(find(rules, "/:path*", "X-Frame-Options")).toBe("DENY");
      expect(find(rules, "/:path*", "Cross-Origin-Opener-Policy")).toBe("same-origin");
      expect(find(rules, "/:path*", "Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(find(rules, "/:path*", "Permissions-Policy")).toContain("usb=()");
      expect(find(rules, "/api/:path*", "Content-Security-Policy")).toContain("default-src 'none'");
      // The project preview renders, but only framed by Morphie and always sandboxed (listed last, so it wins).
      expect(find(rules, "/api/preview/:path*", "Content-Security-Policy")).toMatch(/^sandbox allow-scripts .*frame-ancestors 'self'$/);
      expect(find(rules, "/api/preview/:path*", "X-Frame-Options")).toBe("SAMEORIGIN");
      expect(rules.at(-1)!.source).toBe("/api/preview/:path*");
    }
  });
});

describe("private address detection", () => {
  const priv = ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.9", "172.20.0.1", "192.0.2.5", "::1", "::", "::ffff:7f00:1", "::ffff:127.0.0.1", "::7f00:1",
    "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "fe80::1", "fec0::1", "fd12::1", "ff02::1", "::ffff:a00:1"];
  const pub = ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::"];
  it.each(priv)("blocks %s", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(pub)("allows %s", (ip) => expect(isPrivateIp(ip)).toBe(false));

  it("blocks IPv4-mapped IPv6 literals in base URLs after URL normalisation", async () => {
    for (const u of ["http://[::ffff:127.0.0.1]/v1", "http://[::ffff:7f00:1]/v1", "http://[::127.0.0.1]/", "http://[64:ff9b::7f00:1]/"]) {
      expect(() => validateBaseUrl(u, { allowPrivate: false }), u).toThrow(/Private and local/);
    }
  });
});

describe("client IP", () => {
  const req = (xff?: string) => new Request("http://x.test/", { headers: xff ? { "x-forwarded-for": xff } : {} });
  it("ignores x-forwarded-for unless a proxy is trusted", async () => {
    expect(clientIp(req("1.2.3.4"))).toBe("unknown");
  });
  it("takes the Nth entry from the right, so a forged leftmost entry is useless", async () => {
    vi.stubEnv("MORPHIE_TRUSTED_PROXY", "1");
    expect(clientIp(req("6.6.6.6, 203.0.113.9"))).toBe("203.0.113.9");
    vi.stubEnv("MORPHIE_TRUSTED_PROXY", "2");
    expect(clientIp(req("6.6.6.6, 198.51.100.7, 10.0.0.1"))).toBe("198.51.100.7");
    expect(clientIp(req("10.0.0.1"))).toBe("unknown");
  });
  it("groups IPv6 by /64, unwraps mapped IPv4 and strips ports", async () => {
    vi.stubEnv("MORPHIE_TRUSTED_PROXY", "true");
    expect(clientIp(req("2001:db8:1:2:aaaa:bbbb:cccc:dddd"))).toBe(clientIp(req("2001:db8:1:2:1::9")));
    expect(clientIp(req("2001:db8:1:2::1"))).not.toBe(clientIp(req("2001:db8:1:3::1")));
    expect(clientIp(req("::ffff:1.2.3.4"))).toBe("1.2.3.4");
    expect(clientIp(req("1.2.3.4:5555"))).toBe("1.2.3.4");
    expect(clientIp(req("not-an-ip"))).toBe("unknown");
  });
  it("believes CF-Connecting-IP on Cloudflare Workers only", async () => {
    // On Cloudflare Workers, CF-Connecting-IP (set by the edge) is the address, with or without MORPHIE_TRUSTED_PROXY.
    const cf = (ip: string, xff?: string) => new Request("http://x/", { headers: { "cf-connecting-ip": ip, ...(xff ? { "x-forwarded-for": xff } : {}) } });
    expect(clientIp(cf("203.0.113.50", "6.6.6.6"), true)).toBe("203.0.113.50");
    expect(clientIp(cf("2001:db8:1:2::5"), true)).toBe(clientIp(cf("2001:db8:1:2::9"), true));
    // Elsewhere the header is just something a client sent, and is ignored.
    expect(clientIp(cf("203.0.113.50"), false)).not.toBe("203.0.113.50");
  });
});

describe("guardedFetch: addresses are validated at connect time", () => {
  async function server(handler: http.RequestListener) {
    let hits = 0;
    const srv = http.createServer((q, s) => { hits++; handler(q, s); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    return { port, hits: () => hits, close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
  }
  const answer = (...addrs: string[]) => async () => addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("connects to a private address only when allowed", async () => {
    const s = await server((_q, r) => r.end("hello"));
    try {
      const ok = await guardedFetch(`http://127.0.0.1:${s.port}/`, {}, { allowPrivate: true });
      expect(await ok.text()).toBe("hello");
      await expect(guardedFetch(`http://127.0.0.1:${s.port}/`, {}, { allowPrivate: false })).rejects.toSatisfy((e) => !!securityCause(e));
      await expect(guardedFetch(`http://[::ffff:7f00:1]:${s.port}/`, {}, { allowPrivate: false })).rejects.toSatisfy((e) => !!securityCause(e));
      expect(s.hits()).toBe(1);
    } finally { await s.close(); }
  });

  it("blocks a public-looking name that resolves inward, and a mixed answer, without ever connecting", async () => {
    const s = await server((_q, r) => r.end("secret"));
    try {
      _setResolverForTests(answer("127.0.0.1"));
      await expect(guardedFetch(`http://innocent.test:${s.port}/`, {}, { allowPrivate: false })).rejects.toSatisfy((e) => !!securityCause(e));
      _setResolverForTests(answer("93.184.216.34", "127.0.0.1"));
      await expect(guardedFetch(`http://mixed.test:${s.port}/`, {}, { allowPrivate: false })).rejects.toSatisfy((e) => !!securityCause(e));
      expect(s.hits()).toBe(0);
      _setResolverForTests(answer("127.0.0.1"));
      const ok = await guardedFetch(`http://local.test:${s.port}/`, {}, { allowPrivate: true });
      expect(await ok.text()).toBe("secret");
    } finally { await s.close(); }
  });

  it("does not follow redirects, decodes gzip and honours abort", async () => {
    const zlib = await import("node:zlib");
    const s = await server((q, r) => {
      if (q.url === "/redir") { r.writeHead(302, { location: "http://169.254.169.254/" }); return r.end(); }
      if (q.url === "/gz") { r.writeHead(200, { "content-encoding": "gzip" }); return r.end(zlib.gzipSync("zipped")); }
      /* /hang */ r.writeHead(200); r.write("x");
    });
    try {
      const red = await guardedFetch(`http://127.0.0.1:${s.port}/redir`, {}, { allowPrivate: true });
      expect(red.status).toBe(302);
      expect(red.headers.get("location")).toBe("http://169.254.169.254/");
      expect(await (await guardedFetch(`http://127.0.0.1:${s.port}/gz`, {}, { allowPrivate: true })).text()).toBe("zipped");
      const ctl = new AbortController();
      const res = await guardedFetch(`http://127.0.0.1:${s.port}/hang`, { signal: ctl.signal }, { allowPrivate: true });
      const reader = res.body!.getReader();
      await reader.read();
      ctl.abort();
      await expect(reader.read()).rejects.toBeTruthy();
    } finally { await s.close(); }
  });

  it("closes the DNS-rebinding window for fetch_url: public at the pre-check, private at connect time", async () => {
    const s = await server((_q, r) => r.end("internal"));
    try {
      let calls = 0;
      _setResolverForTests(async () => (++calls === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]));
      await expect(fetchPublic(`http://rebind.test:${s.port}/`)).rejects.toThrow(/Blocked/);
      expect(s.hits()).toBe(0);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally { await s.close(); }
  });

  it("re-checks every redirect hop in fetch_url", async () => {
    _setResolverForTests(async (h) => [{ address: h === "inner.test" ? "10.0.0.5" : "93.184.216.34", family: 4 }]);
    const hop = (location: string) => vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    for (const target of ["http://[::ffff:7f00:1]/", "http://169.254.169.254/latest/meta-data", "http://inner.test/admin", "http://localhost:3000/"]) {
      const fake = hop(target);
      await expect(fetchPublic("http://start.test/", undefined, { fetch: fake as never }), target).rejects.toBeInstanceOf(ToolError);
      expect(fake).toHaveBeenCalledTimes(1); // the second hop was refused before any request was made
    }
  });

  it("applies to every provider call, not just fetch_url", async () => {
    const s = await server((_q, r) => r.end("{}"));
    try {
      vi.stubEnv("MORPHIE_ALLOW_PRIVATE_URLS", "false");
      _setResolverForTests(answer("127.0.0.1"));
      const p = providerFetch(`http://models.example.test:${s.port}/v1/models`, {}, { timeoutMs: 2000, label: "Test", retries: 0 });
      await expect(p).rejects.toBeInstanceOf(ProviderError);
      await expect(p).rejects.toThrow(/Blocked/);
      expect(s.hits()).toBe(0);
    } finally { await s.close(); }
  });
});

describe("release check", () => {
  it("flags data, env, database and key files at any depth, and allows .env.example", async () => {
    const bad = forbiddenEntries([
      "morphie/data/morphie.db", "morphie/data/.session_secret", "app/.env", "app/.env.local", "x/morphie.db-wal", "k/server.pem",
      "node_modules/a/b.js", ".next/cache/x", ".git/config", "deep/er/data/workspace/u/notes.md", "data/workspace/u/a.md",
      "app/.dev.vars", "app/.dev.vars.production", ".open-next/worker.js", "x/.wrangler/state/v3/d1/db.sqlite",
    ]);
    expect(bad).toHaveLength(15);
    expect(forbiddenEntries([".env.example", "src/server/db.ts", "README.md", "src/app/api/data/export/route.ts", "src/data/x.ts", ".dev.vars.example", "wrangler.jsonc", "worker/index.ts", "scripts/release-check.mjs"])).toEqual([]);
  });

  it("the CLI fails on a zip containing data/ and passes a clean one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relcheck-"));
    const dirty = path.join(dir, "dirty.zip"); const clean = path.join(dir, "clean.zip");
    fs.writeFileSync(dirty, zipSync({ "morphie/src/a.ts": strToU8("x"), "morphie/data/.session_secret": strToU8("s") }));
    fs.writeFileSync(clean, zipSync({ "morphie/src/a.ts": strToU8("x"), "morphie/.env.example": strToU8("# ok") }));
    const run = (f: string) => spawnSync(process.execPath, [path.resolve("scripts/release-check.mjs"), f], { encoding: "utf8" });
    const bad = run(dirty);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("morphie/data/.session_secret");
    expect(run(clean).status).toBe(0);
  });
});
