import { resolveAll } from "./dnsResolver";
import net from "node:net";
import { config } from "./config";

export class SecurityError extends Error {}
/** Cross-site request rejected (403). Other SecurityErrors are ordinary input problems (400). */
export class OriginError extends SecurityError {}

// ---------------------------------------------------------------- IP rules

function parseV4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

/** Parse any IPv6 text form (compressed, zone id, embedded dotted quad) into 16 bytes. */
export function parseV6(input: string): number[] | null {
  let s = input.split("%")[0].toLowerCase();
  if (s.includes(".")) {
    const i = s.lastIndexOf(":");
    const v4 = parseV4(s.slice(i + 1));
    if (!v4) return null;
    s = `${s.slice(0, i + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
];

function v4Private(b: number[]): boolean {
  const n = (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
  return V4_BLOCKS.some(([base, bits]) => {
    const bb = parseV4(base)!;
    const bn = (((bb[0] << 24) | (bb[1] << 16) | (bb[2] << 8) | bb[3]) >>> 0);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (bn & mask);
  });
}

/** True for loopback, private, link-local, multicast, documentation and transition-mechanism addresses (v4 and v6). */
export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Private(parseV4(ip)!);
  if (kind === 6) {
    const b = parseV6(ip);
    if (!b) return true; // unparseable: fail closed
    const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
    if (zeros(0, 12)) return true;                                         // ::/96: unspecified, loopback, IPv4-compatible
    if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Private(b.slice(12)); // ::ffff:a.b.c.d (any text form)
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {  // 64:ff9b::/96 NAT64, 64:ff9b:1::/48 local use
      return b[4] === 0 && b[5] === 0 && zeros(4, 12) ? v4Private(b.slice(12)) : true;
    }
    if (b[0] === 0x20 && b[1] === 0x02) return v4Private(b.slice(2, 6));    // 2002::/16 6to4
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // 2001::/32 Teredo
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
    if (b[0] === 0x01 && b[1] === 0 && zeros(2, 8)) return true;            // 100::/64 discard
    if ((b[0] & 0xfe) === 0xfc) return true;                                // fc00::/7 unique local
    if (b[0] === 0xfe && (b[1] & 0x80) === 0x80) return true;               // fe80::/10 link-local and fec0::/10 site-local
    if (b[0] === 0xff) return true;                                         // ff00::/8 multicast
    return false;
  }
  return false;
}

function isPrivateName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") && !net.isIP(h.replace(/^\[|\]$/g, ""));
}

// ------------------------------------------------------------- URL checking

export interface UrlRules {
  /** Permit localhost / private networks (Ollama, LM Studio, LAN gateways). */
  allowPrivate: boolean;
}

/** Validate and normalise a user-supplied base URL. Throws SecurityError with a human message. */
export function validateBaseUrl(raw: string, rules: UrlRules = { allowPrivate: config.allowPrivateUrls }): string {
  const text = (raw ?? "").trim();
  if (!text) throw new SecurityError("Enter a base URL.");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SecurityError("That doesn't look like a URL. Include https:// at the start.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SecurityError("The URL must start with https:// or http://.");
  if (url.username || url.password) throw new SecurityError("Don't put credentials in the URL; use the API key field.");
  if (url.hash) throw new SecurityError("Remove the #fragment from the URL.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = net.isIP(host) ? isPrivateIp(host) : isPrivateName(host);
  if (literal && !rules.allowPrivate) {
    throw new SecurityError("Private and local addresses aren't allowed on this server.");
  }
  if (url.protocol === "http:" && !literal && !rules.allowPrivate) {
    throw new SecurityError("Use https:// for remote providers so your key isn't sent in clear text.");
  }
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

/** Resolve DNS and make sure a hostname doesn't point somewhere private. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new SecurityError("That address is private.");
    return;
  }
  if (isPrivateName(host)) throw new SecurityError("That host is private.");
  let addrs: { address: string }[];
  try {
    addrs = await resolveAll(host, { all: true });
  } catch {
    throw new SecurityError(`Couldn't resolve ${host}.`);
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new SecurityError("That host resolves to a private address.");
}

// ---------------------------------------------------------------- client IP

/** Stable key for rate limiting: IPv4 as-is, IPv6 grouped by /64 (one host can mint billions of addresses). */
export function normalizeIp(raw: string): string {
  let t = raw.trim().replace(/^\[|\]$/g, "");
  const portMatch = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(t);
  if (portMatch) t = portMatch[1];
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw.trim());
  if (bracketed) t = bracketed[1];
  const kind = net.isIP(t);
  if (kind === 4) return t;
  if (kind === 6) {
    const b = parseV6(t);
    if (!b) return "unknown";
    if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return b.slice(12).join(".");
    return "v6:" + [0, 2, 4, 6].map((i) => ((b[i] << 8) | b[i + 1]).toString(16)).join(":");
  }
  return "unknown";
}

/**
 * The client IP, or "unknown". x-forwarded-for is only believed when MORPHIE_TRUSTED_PROXY says how many proxies
 * sit in front of us; we then take the Nth entry from the right, which a client cannot forge by sending its own header.
 * Without a trusted proxy a route handler has no socket address, so everything shares the "unknown" bucket.
 */
export function clientIp(req: Request, cloudflare = onCloudflareWorkers()): string {
  // On Cloudflare, the edge sets CF-Connecting-IP to the visitor's address and overwrites any value a client sends,
  // so it can be believed without MORPHIE_TRUSTED_PROXY. (Without this, every visitor shared the "unknown" bucket.)
  if (cloudflare) {
    const cf = req.headers.get("cf-connecting-ip")?.trim();
    if (cf) return normalizeIp(cf);
  }
  const hops = config.trustedProxyHops;
  if (!hops) return "unknown";
  const parts = (req.headers.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const entry = parts[parts.length - hops];
  return entry ? normalizeIp(entry) : "unknown";
}

/** Inside the Workers runtime (workerd). Same test as net.ts's onWorkers, kept here to avoid an import cycle. */
const onCloudflareWorkers = () => typeof navigator !== "undefined" && (navigator as { userAgent?: string }).userAgent === "Cloudflare-Workers";

/** Was this request made over https (directly, or via a trusted proxy that says so)? */
export function isSecureRequest(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  return config.trustedProxyHops > 0 && req.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
}

// --------------------------------------------------------------- rate limits

interface Bucket { hits: number[] }
const buckets = new Map<string, Bucket>();

/** Sliding-window limiter. Returns seconds to wait, or 0 if the call may proceed. */
export function rateLimit(key: string, limit: number, windowMs: number): number {
  const t = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((h) => t - h < windowMs);
  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    return Math.max(1, Math.ceil((windowMs - (t - bucket.hits[0])) / 1000));
  }
  bucket.hits.push(t);
  buckets.set(key, bucket);
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (!b.hits.length || t - b.hits[b.hits.length - 1] > windowMs) buckets.delete(k);
  }
  return 0;
}

let epoch = 0;
/** Durable (database) limits are keyed by this, so a test's reset clears them too. Always 0 in a running server. */
export const rateLimitEpoch = (): number => epoch;

/** Tests: forget every limit. `keepDurable` forgets only this instance's memory, like a request landing on another isolate. */
export function _resetRateLimits(opts: { keepDurable?: boolean } = {}): void {
  buckets.clear();
  if (!opts.keepDurable) epoch++;
}

// ------------------------------------------------------------------ CSRF

/** Reject cross-site state-changing requests. */
export function checkOrigin(req: Request): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new OriginError("Bad Origin header.");
    }
    const forwarded = config.trustedProxyHops > 0 ? req.headers.get("x-forwarded-host") : null;
    const host = forwarded ?? req.headers.get("host") ?? new URL(req.url).host;
    if (originHost === host || config.allowedOrigins.includes(origin)) return;
    throw new OriginError("Cross-site request blocked.");
  }
  if (req.headers.get("sec-fetch-site") === "cross-site") throw new OriginError("Cross-site request blocked.");
}

// -------------------------------------------------------------- redaction

/** Strip anything that looks like a credential out of text destined for logs or the UI. */
export function redact(text: string, secrets: Array<string | undefined | null> = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(sk|pk|key|tok|gsk|xai|AIza|tvly)[-_][A-Za-z0-9_-]{12,}/g, "[redacted]");
}
