import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardedFetch, onWorkers, securityCause } from "@/server/net";

/**
 * On Cloudflare Workers there are no raw sockets with a custom DNS lookup, so guardedFetch takes a different road:
 * literal private IPs and private names are refused up front, hostnames are pre-resolved over DNS-over-HTTPS, and
 * redirects are never followed. These run that road by pretending to be workerd.
 */
const doh = (answers: Record<string, string[]>) => (url: string) => {
  const u = new URL(url);
  const name = u.searchParams.get("name")!, type = u.searchParams.get("type");
  const data = (answers[name] ?? []).filter((a) => (type === "AAAA" ? a.includes(":") : !a.includes(":")));
  return new Response(JSON.stringify({ Answer: data.map((d) => ({ type: type === "AAAA" ? 28 : 1, data: d })) }), { headers: { "content-type": "application/dns-json" } });
};

let calls: string[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
});
afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(answers: Record<string, string[]>, upstream: (url: string, init?: RequestInit) => Response = () => new Response("ok")) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://cloudflare-dns.com/")) return doh(answers)(url);
    calls.push(url);
    return upstream(url, init);
  }));
}

describe("guardedFetch on Cloudflare Workers", () => {
  it("detects the Workers runtime", () => { expect(onWorkers()).toBe(true); });

  it("fetches a public host after checking its DNS answers", async () => {
    stubFetch({ "api.example.com": ["93.184.216.34"] });
    const r = await guardedFetch("https://api.example.com/v1/models", {}, { allowPrivate: false });
    expect(await r.text()).toBe("ok");
    expect(calls).toEqual(["https://api.example.com/v1/models"]);
  });

  it("refuses literal private addresses, private names and hosts that resolve privately, before any request", async () => {
    stubFetch({ "rebind.example": ["10.0.0.7"], "six.example": ["fd00::1"] });
    for (const url of ["http://127.0.0.1:11434/", "http://[::1]/", "http://169.254.169.254/latest", "http://printer.local/", "http://db.internal/", "http://rebind.example/", "http://six.example/"]) {
      const err = await guardedFetch(url, {}, { allowPrivate: false }).catch((e) => e);
      expect(securityCause(err), url).toBeTruthy();
    }
    expect(calls).toEqual([]);
  });

  it("allows private targets only when the profile says so (local Ollama during development)", async () => {
    stubFetch({});
    await guardedFetch("http://127.0.0.1:11434/api/tags", {}, { allowPrivate: true });
    expect(calls).toEqual(["http://127.0.0.1:11434/api/tags"]);
  });

  it("never follows redirects: the caller sees the 3xx", async () => {
    stubFetch({ "a.example": ["93.184.216.34"] }, (_u, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    });
    const r = await guardedFetch("http://a.example/", {}, { allowPrivate: false });
    expect(r.status).toBe(302);
  });

  it("still only speaks http and https", async () => {
    stubFetch({});
    const err = await guardedFetch("file:///etc/passwd", {}, { allowPrivate: true }).catch((e) => e);
    expect(securityCause(err)).toBeTruthy();
  });
});
