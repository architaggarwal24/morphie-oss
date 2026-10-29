import type { ChatMessage, ChatRequest, ChatResult, Provider, ProviderModel, ToolCall } from "./types";
import { ProviderError } from "./types";
import { parseToolArgs, providerFetch, readSSE } from "./util";

const VERSION = "2023-06-01";
const TIMEOUT = 90_000;

export class AnthropicProvider implements Provider {
  readonly kind = "anthropic";
  readonly label = "Anthropic";
  readonly nativeTools = true;
  readonly vision: boolean;
  readonly contextWindow: number;
  constructor(private cfg: { apiKey: string; model: string; baseUrl?: string; maxTokens?: number; vision?: boolean; contextWindow?: number }) {
    this.vision = cfg.vision ?? true;
    this.contextWindow = cfg.contextWindow ?? 200_000;
  }

  get model(): string { return this.cfg.model; }
  private get base(): string { return (this.cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, ""); }
  private headers() {
    return { "content-type": "application/json", "x-api-key": this.cfg.apiKey, "anthropic-version": VERSION };
  }

  /** System as blocks, with a cache breakpoint after the part that never changes (instructions), when there is one. */
  private systemBlocks(messages: ChatMessage[]): unknown[] {
    const blocks: any[] = [];
    for (const m of messages.filter((x) => x.role === "system")) {
      const split = m.cacheSplit && m.cacheSplit > 0 && m.cacheSplit < m.content.length ? m.cacheSplit : m.content.length;
      blocks.push({ type: "text", text: m.content.slice(0, split), cache_control: { type: "ephemeral" } });
      if (split < m.content.length && m.content.slice(split).trim()) blocks.push({ type: "text", text: m.content.slice(split) });
    }
    // At most 4 breakpoints are allowed: keep the first two system ones.
    let n = 0;
    for (const b of blocks) if (b.cache_control && ++n > 2) delete b.cache_control;
    return blocks;
  }

  private convert(messages: ChatMessage[]): { system: string; messages: unknown[] } {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const out: any[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content || "(no output)" };
        const last = out[out.length - 1];
        if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b: any) => b.type === "tool_result")) last.content.push(block);
        else out.push({ role: "user", content: [block] });
      } else if (m.role === "assistant") {
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
        if (blocks.length) out.push({ role: "assistant", content: blocks });
      } else if (m.images?.length && this.vision) {
        out.push({ role: "user", content: [...m.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })), { type: "text", text: m.content || " " }] });
      } else {
        out.push({ role: "user", content: m.content || " " });
      }
    }
    // Neighbouring turns from the same side become one (the API wants user/assistant to alternate): tool results
    // followed by a note or screenshots, or a reply continued after a pause.
    for (let i = out.length - 1; i > 0; i--) {
      if (out[i].role !== out[i - 1].role) continue;
      const blocks = (c: any) => (typeof c === "string" ? [{ type: "text", text: c }] : c);
      out[i - 1].content = [...blocks(out[i - 1].content), ...blocks(out[i].content)];
      out.splice(i, 1);
    }
    // A rolling breakpoint on the newest message: the next step reuses everything up to here from the cache.
    const last = out[out.length - 1];
    if (last) {
      if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
      const block = last.content[last.content.length - 1];
      if (block) block.cache_control = { type: "ephemeral" };
    }
    return { system, messages: out };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { system, messages } = this.convert(req.messages);
    const body: Record<string, unknown> = { model: this.model, max_tokens: req.maxTokens ?? this.cfg.maxTokens ?? defaultMaxTokens(this.model), messages, stream: true };
    if (system) body.system = this.systemBlocks(req.messages);
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      const tools: any[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      tools[tools.length - 1].cache_control = { type: "ephemeral" }; // tool definitions are part of the cached prefix
      body.tools = tools;
    }

    const opened = await providerFetch(`${this.base}/v1/messages`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, {
      timeoutMs: TIMEOUT, signal: req.signal, label: "Anthropic", secrets: [this.cfg.apiKey],
    });

    let text = "";
    let reasoning = "";
    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
    let finish: string | undefined;
    let input = 0;
    let output = 0;
    let cached = 0;

    for await (const ev of readSSE(opened, TIMEOUT)) {
      let j: any;
      try { j = JSON.parse(ev.data); } catch { continue; }
      switch (j.type) {
        case "message_start": {
          const u = j.message?.usage ?? {};
          cached = u.cache_read_input_tokens ?? 0;
          input = (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
          output = u.output_tokens ?? 0;
          break;
        }
        case "content_block_start": blocks.set(j.index, { type: j.content_block?.type, id: j.content_block?.id, name: j.content_block?.name, json: "" }); break;
        case "content_block_delta": {
          const d = j.delta;
          if (d?.type === "text_delta") { text += d.text; req.onText?.(d.text); }
          else if (d?.type === "thinking_delta") { reasoning += d.thinking; req.onReasoning?.(d.thinking); }
          else if (d?.type === "input_json_delta") { const b = blocks.get(j.index); if (b) { b.json += d.partial_json; req.onToolDelta?.({ index: j.index, name: b.name ?? "", args: b.json }); } }
          break;
        }
        case "message_delta": finish = j.delta?.stop_reason ?? finish; output = j.usage?.output_tokens ?? output; break;
        case "error": throw new ProviderError(`Anthropic: ${String(j.error?.message ?? "stream error").slice(0, 300)}`, undefined, j.error?.type === "overloaded_error");
      }
    }
    const toolCalls: ToolCall[] = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, b]) => b.type === "tool_use" && b.name)
      .map(([, b]) => {
        const p = parseToolArgs(b.json || "{}");
        return { id: b.id ?? `toolu_${Math.random().toString(36).slice(2)}`, name: b.name!, arguments: p.args, error: p.error };
      });
    return { content: text, toolCalls, reasoning: reasoning || undefined, usage: { input, output, cached: cached || undefined }, finishReason: finish };
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const opened = await providerFetch(`${this.base}/v1/models?limit=100`, { headers: this.headers() }, {
      timeoutMs: 20_000, signal, label: "Anthropic", secrets: [this.cfg.apiKey], retries: 0,
    });
    const json: any = await opened.res.json();
    return (json.data ?? []).map((m: any) => ({ id: m.id, label: m.display_name }));
  }
}

/** Room for a whole file in one tool call, within what each model family accepts. */
export function defaultMaxTokens(model: string): number {
  if (/claude-3-(haiku|opus|sonnet)-20/.test(model)) return 4096;
  if (/claude-3-5/.test(model)) return 8192;
  return 16_000;
}
