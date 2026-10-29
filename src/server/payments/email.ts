/**
 * Bank credit alerts by email: confirm UPI payments without anyone checking the bank app.
 *
 * Cloudflare Email Routing hands the bank's alert to the Worker (worker/index.ts → POST /api/billing/inbound). Before
 * anything in it is believed, its DKIM signature must verify (RSA-SHA256, the bank's public key from DNS) for a domain
 * the admin listed, and the From address must belong to that domain. Only then is the text read for an amount and a
 * UPI reference (UTR), which are matched to an open order.
 *
 * Only DKIM is trusted: headers such as Authentication-Results can be written by anyone who sends mail.
 */

// ------------------------------------------------------------------ MIME (just enough for alert emails)

export interface Header { name: string; /** The full header as received, folded lines included, without the final CRLF. */ raw: string; value: string }

export interface ParsedEmail { headers: Header[]; /** Header block and body exactly as received (CRLF line ends). */ headerBlock: string; body: string; text: string; from: string; subject: string }

const toCrlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

export function splitHeaders(block: string): Header[] {
  const out: Header[] = [];
  for (const line of block.split("\r\n")) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1].raw += `\r\n${line}`;
    else if (line.includes(":")) out.push({ name: line.slice(0, line.indexOf(":")).trim(), raw: line, value: "" });
  }
  for (const h of out) h.value = h.raw.slice(h.raw.indexOf(":") + 1).replace(/\r\n/g, "").trim();
  return out;
}

const header = (hs: Header[], name: string) => hs.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function decodeQP(s: string): Uint8Array {
  const clean = s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(clean.slice(i + 1, i + 3))) { bytes.push(parseInt(clean.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(...new TextEncoder().encode(clean[i]));
  }
  return new Uint8Array(bytes);
}

const decodeB64 = (s: string) => Uint8Array.from(atob(s.replace(/[^A-Za-z0-9+/=]/g, "")), (c) => c.charCodeAt(0));

function decodePart(body: string, encoding: string, charset: string): string {
  const enc = encoding.toLowerCase();
  const bytes = enc === "base64" ? decodeB64(body) : enc === "quoted-printable" ? decodeQP(body) : new TextEncoder().encode(body);
  try { return new TextDecoder(charset || "utf-8").decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

/** HTML to readable text (alerts are often HTML only). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#8377;|&#x20b9;/gi, "₹").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** The readable text of a MIME entity: text/plain preferred, else text/html converted. */
function textOf(headers: Header[], body: string, depth = 0): { plain: string; html: string } {
  const ctype = header(headers, "content-type") || "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(ctype)?.[1];
  if (/^multipart\//i.test(ctype) && boundary && depth < 5) {
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith("--"));
    const acc = { plain: "", html: "" };
    for (const p of parts) {
      const i = p.indexOf("\r\n\r\n");
      if (i < 0) continue;
      const sub = textOf(splitHeaders(p.slice(0, i).replace(/^\r\n/, "")), p.slice(i + 4), depth + 1);
      acc.plain ||= sub.plain; acc.html ||= sub.html;
    }
    return acc;
  }
  const charset = /charset="?([^";]+)"?/i.exec(ctype)?.[1] ?? "utf-8";
  const decoded = decodePart(body, header(headers, "content-transfer-encoding"), charset);
  return /^text\/html/i.test(ctype) ? { plain: "", html: decoded } : /^text\//i.test(ctype) ? { plain: decoded, html: "" } : { plain: "", html: "" };
}

export function parseEmail(raw: string): ParsedEmail {
  const crlf = toCrlf(raw);
  const i = crlf.indexOf("\r\n\r\n");
  const headerBlock = i < 0 ? crlf : crlf.slice(0, i);
  const body = i < 0 ? "" : crlf.slice(i + 4);
  const headers = splitHeaders(headerBlock);
  const t = textOf(headers, body);
  return { headers, headerBlock, body, text: (t.plain || htmlToText(t.html)).replace(/\r\n/g, "\n"), from: header(headers, "from"), subject: header(headers, "subject") };
}

/** The address in a From header: `Bank <alerts@bank.com>` → alerts@bank.com. */
export const addressOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

// ------------------------------------------------------------------ DKIM (RFC 6376), rsa-sha256

export type TxtLookup = (name: string) => Promise<string[]>;

/** TXT records over DNS-over-HTTPS (works the same on Workers and Node). */
export const dohTxt: TxtLookup = async (name) => {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: "application/dns-json" } });
  if (!r.ok) return [];
  const j = (await r.json()) as { Answer?: Array<{ type: number; data: string }> };
  // Each answer is one or more quoted strings that make up one record.
  return (j.Answer ?? []).filter((a) => a.type === 16).map((a) => (a.data.match(/"((?:[^"\\]|\\.)*)"/g) ?? [a.data]).map((q) => q.replace(/^"|"$/g, "").replace(/\\"/g, '"')).join(""));
};

const tags = (v: string): Record<string, string> => Object.fromEntries(v.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
  const i = p.indexOf("=");
  return [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).replace(/\s+/g, "")];
}));

export function canonBody(body: string, mode: "simple" | "relaxed"): string {
  let b = body;
  if (mode === "relaxed") b = b.split("\r\n").map((l) => l.replace(/[ \t]+/g, " ").replace(/ +$/, "")).join("\r\n");
  b = b.replace(/(\r\n)*$/, "");
  return b || mode === "simple" ? `${b}\r\n` : "";
}

export function canonHeader(h: Header, mode: "simple" | "relaxed"): string {
  if (mode === "simple") return h.raw;
  const value = h.raw.slice(h.raw.indexOf(":") + 1).replace(/\r\n/g, "").replace(/[ \t]+/g, " ").trim();
  return `${h.name.toLowerCase().trim()}:${value}`;
}

const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

export interface DkimResult { domain: string; ok: boolean; reason?: string }

/** Verify every DKIM-Signature (up to 3). A domain counts only when its signature checks out against its DNS key. */
export async function verifyDkim(email: ParsedEmail, lookup: TxtLookup = dohTxt, now = Date.now()): Promise<DkimResult[]> {
  const sigs = email.headers.filter((h) => h.name.toLowerCase() === "dkim-signature").slice(0, 3);
  const out: DkimResult[] = [];
  for (const sig of sigs) {
    const t = tags(sig.value);
    const domain = (t.d ?? "").toLowerCase();
    const fail = (reason: string) => out.push({ domain, ok: false, reason });
    if (t.v !== "1" || !t.d || !t.s || !t.h || !t.b || !t.bh) { fail("incomplete signature"); continue; }
    if ((t.a ?? "").toLowerCase() !== "rsa-sha256") { fail(`unsupported algorithm ${t.a}`); continue; }
    if (t.x && Number(t.x) * 1000 < now) { fail("signature expired"); continue; }
    const [hc, bc] = (t.c ?? "simple/simple").toLowerCase().split("/") as Array<"simple" | "relaxed">;
    const headerMode = hc === "relaxed" ? "relaxed" : "simple";
    const bodyMode = bc === "relaxed" ? "relaxed" : "simple";
    // Body hash.
    let body = canonBody(email.body, bodyMode);
    if (t.l) body = body.slice(0, Number(t.l));
    const bh = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
    if (bh !== t.bh) { fail("body hash mismatch"); continue; }
    // Signed headers, each name taken from the bottom up.
    const used = new Map<string, number>();
    const lines: string[] = [];
    for (const name of t.h.split(":").map((n) => n.trim().toLowerCase()).filter(Boolean)) {
      const all = email.headers.filter((h) => h.name.toLowerCase() === name && h !== sig);
      const n = used.get(name) ?? 0;
      const h = all[all.length - 1 - n];
      used.set(name, n + 1);
      if (h) lines.push(`${canonHeader(h, headerMode)}\r\n`);
    }
    const sigRaw = { ...sig, raw: sig.raw.replace(/(\bb\s*=)[^;]*/i, "$1") };
    lines.push(canonHeader(sigRaw, headerMode));
    // The domain's key.
    let key: Record<string, string> | undefined;
    try { key = (await lookup(`${t.s}._domainkey.${domain}`)).map(tags).find((k) => k.p !== undefined); } catch { /* no key */ }
    if (!key?.p) { fail("no public key in DNS"); continue; }
    if (key.k && key.k.toLowerCase() !== "rsa") { fail("unsupported key type"); continue; }
    try {
      const pub = await crypto.subtle.importKey("spki", decodeB64(key.p), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, decodeB64(t.b), new TextEncoder().encode(lines.join("")));
      out.push(ok ? { domain, ok: true } : { domain, ok: false, reason: "signature mismatch" });
    } catch { fail("bad public key"); }
  }
  return out;
}

/** The From address's domain is the signing domain or a subdomain of it (DMARC-style relaxed alignment). */
export function aligned(fromAddress: string, domain: string): boolean {
  const host = fromAddress.split("@")[1] ?? "";
  return host === domain || host.endsWith(`.${domain}`);
}

// ------------------------------------------------------------------ reading a credit alert

export interface CreditAlert { amounts: number[]; utrs: string[]; credit: boolean }

/** Amounts (in paise) and 12-digit UPI references in an alert's text, and whether it reads as money coming in. */
export function readAlert(text: string): CreditAlert {
  const t = text.replace(/\s+/g, " ");
  const amounts = [...t.matchAll(/(?:₹|\bRs\.?|\bINR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi)]
    .map((m) => Math.round(Number(m[1].replace(/,/g, "")) * 100)).filter((n) => Number.isFinite(n) && n > 0);
  const utrs = [...new Set([...t.matchAll(/(?<![0-9])([0-9]{12})(?![0-9])/g)].map((m) => m[1]))];
  const credit = /\bcredit(ed)?\b|\breceived\b|\bdeposited\b/i.test(t) && !/\bdebit(ed)?\b.*\bfrom your\b/i.test(t);
  return { amounts: [...new Set(amounts)], utrs, credit };
}
