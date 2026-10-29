import { guardedFetch, securityCause } from "../net";
import { assertPublicHost, SecurityError } from "../security";
import { ToolError, str, type ToolDef } from "./types";

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };

export function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  let t = html
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  t = t.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return { title, text: t.replace(/[ \t\f\v]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/** Fetch a public web page. Private networks are blocked regardless of server config, and every redirect is re-checked. */
export async function fetchPublic(rawUrl: string, signal?: AbortSignal, io: { fetch: typeof guardedFetch } = { fetch: guardedFetch }): Promise<{ url: string; status: number; contentType: string; body: string; truncated: boolean }> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new ToolError("That isn't a valid URL."); }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new ToolError("Only http and https URLs can be fetched.");
    if (url.username || url.password) throw new ToolError("URLs with credentials aren't allowed.");
    try { await assertPublicHost(url.hostname); } catch (e) {
      throw new ToolError(e instanceof SecurityError ? `Blocked: ${e.message}` : "Couldn't check that host.");
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await io.fetch(url, {
        signal: ctl.signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; MorphieBot/2.0)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
      }, { allowPrivate: false });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location")!, url);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!/^(text\/|application\/(json|xml|xhtml|rss|atom|ld\+json))/i.test(contentType) && contentType) {
        throw new ToolError(`That URL returned ${contentType.split(";")[0]}, which can't be read as text.`);
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        chunks.push(value);
        if (size > MAX_BYTES) { truncated = true; reader.cancel().catch(() => {}); break; }
      }
      return { url: url.toString(), status: res.status, contentType, body: Buffer.concat(chunks).toString("utf8"), truncated };
    } catch (e) {
      if (e instanceof ToolError) throw e;
      if (signal?.aborted) throw new ToolError("Stopped.");
      const blocked = securityCause(e);
      if (blocked) throw new ToolError(`Blocked: ${blocked.message}`);
      throw new ToolError(`Couldn't fetch that page (${ctl.signal.aborted ? "timed out" : "network error"}).`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new ToolError("Too many redirects.");
}

export const fetchUrl: ToolDef = {
  name: "fetch_url",
  label: "Read web page",
  description: "Download a public web page and return its readable text. Use after web_search to read a result, or when the user gives you a URL. Cannot access private/local addresses or pages behind a login.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full http(s) URL." },
      max_chars: { type: "integer", description: "Maximum characters to return (500-12000). Default 6000." },
    },
    required: ["url"],
  },
  risk: "safe",
  modes: ["agent"],
  readOnly: true,
  parallel: true,
  permission: (a) => ({ tool: "WebFetch", value: String(a.url ?? "") }),
  untrusted: true,
  describeCall: (a) => `Read ${String(a.url ?? "").slice(0, 100)}`,
  async run(args, ctx) {
    const url = str(args, "url", 2000);
    const max = Math.min(12_000, Math.max(500, Math.round(Number(args.max_chars) || 6000)));
    const page = await fetchPublic(url, ctx.signal);
    const isHtml = /html/i.test(page.contentType) || /^\s*<(!doctype|html)/i.test(page.body);
    const { title, text } = isHtml ? htmlToText(page.body) : { title: "", text: page.body.trim() };
    if (!text) return { text: "The page had no readable text (it may need JavaScript to load).", summary: "Empty page" };
    const clipped = text.length > max ? text.slice(0, max) + `\n…[truncated, ${text.length - max} more characters]` : text;
    return {
      text: `${title ? `Title: ${title}\n` : ""}URL: ${page.url}\n\n${clipped}`,
      sources: [{ title: title || page.url, url: page.url }],
      summary: `${title || new URL(page.url).hostname} · ${text.length.toLocaleString()} chars`,
    };
  },
};
