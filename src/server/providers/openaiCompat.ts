import type { ProviderOptions } from "@/lib/types";
import type { ChatMessage, ChatRequest, ChatResult, Provider, ProviderModel, ToolCall } from "./types";
import { ProviderError } from "./types";
import { parseToolArgs, providerFetch, readSSE, ThinkFilter } from "./util";

export interface OpenAICompatConfig {
  kind: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  options?: ProviderOptions;
  /** Defaults for hosted vendors (e.g. OpenAI wants max_completion_tokens). */
  defaults?: Partial<ProviderOptions>;
  /** Static model list when the vendor has no /models endpoint. */
  staticModels?: string[];
}

const DEFAULT_TIMEOUT_SEC = 90;

export class OpenAICompatProvider implements Provider {
  readonly kind: string;
  readonly label: string;
  readonly model: string;
  private readonly opts: ProviderOptions;

  constructor(private cfg: OpenAICompatConfig) {
    this.kind = cfg.kind;
    this.label = cfg.label;
    this.model = cfg.model;
    this.opts = { ...cfg.defaults, ...cfg.options };
  }

  get nativeTools(): boolean {
    return this.opts.nativeTools !== false;
  }
  get vision(): boolean { return this.opts.vision === true; }
  get contextWindow(): number | undefined { return this.opts.contextWindow; }
  /** Some gateways reject stream_options; remembered per provider instance after the first refusal. */
  private noStreamUsage = false;

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    const key = this.cfg.apiKey;
    const style = this.opts.authStyle ?? (key ? "bearer" : "none");
    if (key && style !== "none") {
      if (style === "bearer") h.authorization = `Bearer ${key}`;
      else if (style === "x-api-key") h["x-api-key"] = key;
      else if (style === "api-key") h["api-key"] = key;
      else if (style === "header" && this.opts.authHeaderName) h[this.opts.authHeaderName.toLowerCase()] = key;
    }
    for (const [k, v] of Object.entries(this.opts.extraHeaders ?? {})) if (k.trim()) h[k.trim().toLowerCase()] = v;
    return h;
  }

  private url(path: string): string {
    const base = this.cfg.baseUrl.replace(/\/+$/, "");
    const p = path.startsWith("/") ? path : `/${path}`;
    const u = new URL(base + p);
    for (const [k, v] of Object.entries(this.opts.queryParams ?? {})) if (k.trim()) u.searchParams.set(k.trim(), v);
    return u.toString();
  }

  private serialize(messages: ChatMessage[]): unknown[] {
    const out: unknown[] = [];
    for (const m of messages) {
      if (m.role === "assistant" && m.toolCalls?.length) {
        out.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
        });
      } else if (m.role === "tool") {
        out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      } else if (m.role === "user" && m.images?.length && this.vision) {
        out.push({ role: "user", content: [{ type: "text", text: m.content }, ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } }))] });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const stream = this.opts.streaming !== false;
    const messages = [...req.messages];
    if (this.opts.systemPrompt?.trim()) {
      const first = messages[0];
      if (first?.role === "system") messages[0] = { ...first, content: `${this.opts.systemPrompt.trim()}\n\n${first.content}` };
      else messages.unshift({ role: "system", content: this.opts.systemPrompt.trim() });
    }
    const body: Record<string, unknown> = { model: this.model, messages: this.serialize(messages), stream };
    if (stream && !this.noStreamUsage) body.stream_options = { include_usage: true };
    if (req.tools?.length && this.nativeTools) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
    }
    const temperature = req.temperature ?? this.opts.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    if (this.opts.topP !== undefined) body.top_p = this.opts.topP;
    const maxTokens = req.maxTokens ?? this.opts.maxTokens;
    if (maxTokens) body[this.opts.tokenParam ?? "max_tokens"] = maxTokens;

    const timeoutMs = (this.opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    const send = () => providerFetch(this.url(this.opts.chatPath || "/chat/completions"), {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    }, { timeoutMs, signal: req.signal, label: this.label, secrets: [this.cfg.apiKey, ...Object.values(this.opts.extraHeaders ?? {})] });
    let opened;
    try { opened = await send(); }
    catch (e) {
      // Usage-in-stream is an optional extra: a gateway that refuses it gets the plain request instead.
      if (!(e instanceof ProviderError) || !body.stream_options || !(e.status === 400 || e.status === 422) || !/stream_options|include_usage|unrecognized|unknown|extra/i.test(e.message)) throw e;
      this.noStreamUsage = true;
      delete body.stream_options;
      opened = await send();
    }

    const filter = new ThinkFilter(req.onText, req.onReasoning);
    const calls = new Map<number, { id: string; name: string; args: string; obj?: Record<string, unknown> }>();
    let reasoning = "";
    let finish: string | undefined;
    let usage: ChatResult["usage"];

    const ingestChoice = (choice: any, isDelta: boolean) => {
      const part = isDelta ? choice?.delta : choice?.message;
      if (!part) return;
      const r = part.reasoning_content ?? part.reasoning;
      if (typeof r === "string" && r) { reasoning += r; req.onReasoning?.(r); }
      if (typeof part.content === "string" && part.content) filter.push(part.content);
      else if (Array.isArray(part.content)) {
        const text = part.content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("");
        if (text) filter.push(text);
      }
      for (const [i, tc] of ((part.tool_calls as any[]) ?? []).entries()) {
        const idx = typeof tc.index === "number" ? tc.index : isDelta ? i : calls.size;
        const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        const a = tc.function?.arguments;
        if (typeof a === "string") cur.args += a;
        else if (a && typeof a === "object") cur.obj = a;
        calls.set(idx, cur);
        if (typeof a === "string" && a) req.onToolDelta?.({ index: idx, name: cur.name, args: cur.args });
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    };
    const ingestUsage = (u: any) => {
      if (u && (u.prompt_tokens != null || u.completion_tokens != null)) {
        const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0;
        usage = { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cached: Number(cached) || undefined };
      }
    };

    const ctype = opened.res.headers.get("content-type") ?? "";
    if (stream && ctype.includes("text/event-stream")) {
      for await (const ev of readSSE(opened, timeoutMs)) {
        if (ev.data === "[DONE]") break;
        let json: any;
        try { json = JSON.parse(ev.data); } catch { continue; }
        if (json.error) throw new ProviderError(`${this.label}: ${String(json.error.message ?? json.error).slice(0, 300)}`);
        ingestChoice(json.choices?.[0], true);
        ingestUsage(json.usage);
      }
    } else {
      // Non-streaming reply (or a gateway that ignored stream:true).
      let json: any;
      try { json = await opened.res.json(); } catch { throw new ProviderError(`${this.label} sent a reply that isn't JSON. Check the base URL and chat path.`); }
      if (json.error) throw new ProviderError(`${this.label}: ${String(json.error.message ?? json.error).slice(0, 300)}`);
      if (!json.choices) throw new ProviderError(`${this.label} sent an unexpected reply (no "choices"). This may not be an OpenAI-compatible endpoint.`);
      ingestChoice(json.choices[0], false);
      ingestUsage(json.usage);
    }
    filter.end();

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name)
      .map(([idx, c]) => {
        const parsed = c.obj ? { args: c.obj } : parseToolArgs(c.args);
        return { id: c.id || `call_${Date.now().toString(36)}_${idx}`, name: c.name, arguments: parsed.args, error: parsed.error };
      });
    return { content: filter.text, toolCalls, reasoning: (reasoning + filter.reasoning) || undefined, usage, finishReason: finish };
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    if (this.cfg.staticModels) return this.cfg.staticModels.map((id) => ({ id }));
    const opened = await providerFetch(this.url(this.opts.modelsPath || "/models"), { method: "GET", headers: this.authHeaders() }, {
      timeoutMs: 20_000, signal, label: this.label, secrets: [this.cfg.apiKey], retries: 0,
    });
    let json: any;
    try { json = await opened.res.json(); } catch { throw new ProviderError(`${this.label} didn't return a JSON model list.`); }
    const list: any[] = Array.isArray(json) ? json : json.data ?? json.models ?? [];
    const ids = list
      .map((m) => (typeof m === "string" ? { id: m } : { id: String(m.id ?? m.name ?? m.model ?? ""), label: m.display_name ?? undefined }))
      .filter((m) => m.id);
    if (!ids.length) throw new ProviderError(`${this.label} returned an empty model list.`);
    return ids.sort((a, b) => a.id.localeCompare(b.id));
  }
}
