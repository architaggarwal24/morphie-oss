import type { Actor } from "../auth/actor";
import { config } from "../config";
import { getSecret } from "../settings";
import { providerFetch } from "../providers/util";
import { ToolError, str, type ToolDef } from "./types";

export async function tavilyKey(actor: Actor): Promise<string | undefined> {
  return (await getSecret(actor, "tavily")) ?? config.tavilyKey;
}

export const webSearch: ToolDef = {
  name: "web_search",
  label: "Web search",
  description: "Search the web for current information (news, prices, recent events, facts you're unsure about). Returns titles, snippets and URLs. Use fetch_url afterwards to read a promising page in full.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A focused search query." },
      max_results: { type: "integer", description: "How many results (1-8). Default 5." },
    },
    required: ["query"],
  },
  risk: "safe",
  modes: ["chat", "agent"],
  readOnly: true,
  parallel: true,
  permission: () => ({ tool: "WebSearch" }),
  untrusted: true,
  needsKey: "tavily",
  describeCall: (a) => `Search the web for “${String(a.query ?? "").slice(0, 80)}”`,
  async run(args, ctx) {
    const query = str(args, "query", 400);
    const key = await tavilyKey(ctx.actor);
    if (!key) {
      throw new ToolError("Web search isn't set up. Add a Tavily API key in Settings → Tools to enable it (tell the user this).");
    }
    const n = Math.min(8, Math.max(1, Math.round(Number(args.max_results) || 5)));
    const opened = await providerFetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: n, search_depth: "basic" }),
    }, { timeoutMs: 15_000, signal: ctx.signal, label: "Tavily search", secrets: [key], retries: 0 }).catch((e) => {
      throw new ToolError(`Web search failed: ${(e as Error).message}`);
    });
    const data: any = await opened.res.json().catch(() => ({}));
    const results: any[] = Array.isArray(data.results) ? data.results.slice(0, n) : [];
    if (!results.length) return { text: `No web results found for "${query}".`, summary: "No results" };
    const sources = results.map((r) => ({ title: String(r.title ?? "Untitled").slice(0, 140), url: String(r.url ?? ""), snippet: String(r.content ?? "").slice(0, 240) }));
    const text = sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\n${s.url}`).join("\n\n");
    return { text, sources, summary: `${sources.length} results` };
  },
};
