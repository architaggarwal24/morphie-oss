import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { resolveAll } from "./dnsResolver";
import { isPrivateIp, SecurityError } from "./security";

/**
 * An outbound HTTP client that cannot be tricked by DNS.
 *
 * `fetch` resolves a hostname itself, so checking DNS first and then calling fetch leaves a window in which the
 * answer can change (DNS rebinding). Here the check IS the connection: the socket's `lookup` resolves the name,
 * rejects the request if any returned address is private (unless allowed), and connects to exactly the addresses
 * it validated. TLS still verifies the certificate against the hostname. Redirects are never followed: the caller
 * sees the 3xx and decides (and every follow-up request is validated again).
 */

let rewriteForTests: ((u: URL) => URL) | undefined;
/** Test hook (only honoured when NODE_ENV=test): point a fixed-host provider at a local mock server. */
export function _rewriteUrlForTests(fn?: (u: URL) => URL): void {
  rewriteForTests = fn;
}

export interface GuardOptions {
  /** Permit loopback / private networks (Ollama, LM Studio). Public servers should pass false. */
  allowPrivate: boolean;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions | LookupCallback, callback?: LookupCallback) => {
    const cb = (typeof options === "function" ? options : callback)!;
    const opts = (typeof options === "function" ? {} : options) as dns.LookupOptions;
    resolveAll(hostname, { all: true, family: opts.family, hints: opts.hints, verbatim: true } as dns.LookupAllOptions).then(
      (addrs) => {
        if (!addrs.length) return cb(new SecurityError(`Couldn't resolve ${hostname}.`) as NodeJS.ErrnoException, "");
        if (!allowPrivate && addrs.some((a) => isPrivateIp(a.address))) {
          return cb(new SecurityError("That host resolves to a private address.") as NodeJS.ErrnoException, "");
        }
        if (opts.all) cb(null, addrs);
        else cb(null, addrs[0].address, addrs[0].family);
      },
      (err) => cb(err, ""),
    );
  };
}

function toHeaderObject(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => { out[k] = v; });
  return out;
}

function fetchError(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}

export async function guardedFetch(input: string | URL, init: RequestInit = {}, opts: GuardOptions): Promise<Response> {
  let url = typeof input === "string" ? new URL(input) : input;
  if (rewriteForTests && process.env.NODE_ENV === "test") url = rewriteForTests(url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fetchError(new SecurityError("Only http and https are allowed."));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !opts.allowPrivate && isPrivateIp(host)) throw fetchError(new SecurityError("That address is private."));

  if (onWorkers()) return workersFetch(url, host, init, opts);

  const method = (init.method ?? "GET").toUpperCase();
  const headers = toHeaderObject(init.headers);
  if (!headers["accept-encoding"]) headers["accept-encoding"] = "identity";
  let body: Buffer | undefined;
  if (init.body != null) {
    if (typeof init.body === "string") body = Buffer.from(init.body, "utf8");
    else if (init.body instanceof Uint8Array) body = Buffer.from(init.body);
    else throw fetchError(new Error("Unsupported request body type."));
    headers["content-length"] = String(body.length);
  }

  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");

  const lib = url.protocol === "https:" ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const req = lib.request(
      {
        host, port: url.port || (url.protocol === "https:" ? 443 : 80), path: `${url.pathname}${url.search}`, method, headers,
        agent: false, // a fresh, validated connection per request; never reuse a socket opened under another policy
        lookup: guardedLookup(opts.allowPrivate) as never,
        ...(net.isIP(host) ? {} : { servername: host }),
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const respHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const item of Array.isArray(v) ? v : [v]) { try { respHeaders.append(k, item); } catch { /* skip invalid */ } }
        }
        let stream: Readable = res;
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        if (stream !== res) { respHeaders.delete("content-encoding"); respHeaders.delete("content-length"); res.on("error", (e) => stream.destroy(e)); }
        const noBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
        if (noBody) res.resume();
        const webBody = noBody ? null : (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>);
        resolve(new Response(webBody, { status, statusText: res.statusMessage ?? "", headers: respHeaders }));
      },
    );
    const onAbort = () => req.destroy(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (err) => reject(signal?.aborted ? err : fetchError(err)));
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    if (body) req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------------ Cloudflare Workers

/** True inside the Workers runtime (workerd), where raw sockets with a custom DNS lookup aren't available. */
export function onWorkers(): boolean {
  return typeof navigator !== "undefined" && (navigator as { userAgent?: string }).userAgent === "Cloudflare-Workers";
}

const PRIVATE_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;
const dohCache = new Map<string, { at: number; addrs: string[] }>();

/** Resolve A and AAAA records over DNS-over-HTTPS (Cloudflare's resolver), cached for a minute. */
async function dohResolve(host: string): Promise<string[]> {
  const hit = dohCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.addrs;
  const ask = async (type: "A" | "AAAA") => {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" } });
    if (!r.ok) return [];
    const j = (await r.json()) as { Answer?: Array<{ type: number; data: string }> };
    return (j.Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
  };
  const addrs = [...(await ask("A")), ...(await ask("AAAA"))];
  dohCache.set(host, { at: Date.now(), addrs });
  return addrs;
}

/**
 * The same policy on Workers, where the socket-level check above can't run. Literal private IPs and private-looking
 * names are refused up front, and a hostname is resolved first (DoH) and refused if any answer is private. The
 * remaining rebinding window is closed by the platform itself: Workers' outbound fetch can't reach loopback or
 * private networks. Redirects are still never followed (redirect: "manual"), so callers re-check every hop.
 */
async function workersFetch(url: URL, host: string, init: RequestInit, opts: GuardOptions): Promise<Response> {
  if (!opts.allowPrivate && !net.isIP(host)) {
    if (PRIVATE_NAME.test(host)) throw fetchError(new SecurityError("That host is on a private network."));
    const addrs = await dohResolve(host).catch(() => [] as string[]);
    if (addrs.some((a) => isPrivateIp(a))) throw fetchError(new SecurityError("That host resolves to a private address."));
  }
  try {
    return await fetch(url.toString(), { method: init.method ?? "GET", headers: init.headers, body: init.body, signal: init.signal, redirect: "manual" });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw fetchError(e);
  }
}

/** Find a SecurityError anywhere in an error's cause chain (guardedFetch wraps it like fetch does). */
export function securityCause(e: unknown): SecurityError | undefined {
  for (let cur: unknown = e, i = 0; cur && i < 5; i++, cur = (cur as { cause?: unknown }).cause) if (cur instanceof SecurityError) return cur;
  return undefined;
}
