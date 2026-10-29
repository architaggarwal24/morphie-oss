import type { ChatMessage, ChatRequest, ChatResult, Provider, ProviderModel, ToolCall } from "./types";
import { ProviderError } from "./types";
import { providerFetch, readSSE, stripSchema } from "./util";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT = 90_000;
const BANNED = ["additionalProperties", "$schema", "default", "examples", "$id", "$ref", "title"];

export class GeminiProvider implements Provider {
  readonly kind = "gemini";
  readonly label = "Google Gemini";
  readonly nativeTools = true;
  readonly vision = true;
  constructor(private cfg: { apiKey: string; model: string; contextWindow?: number }) {}
  get contextWindow(): number { return this.cfg.contextWindow ?? 1_000_000; }
  get model(): string { return this.cfg.model; }
  private headers() { return { "content-type": "application/json", "x-goog-api-key": this.cfg.apiKey }; }

  private convert(messages: ChatMessage[]) {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const contents: any[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        const part = { functionResponse: { name: m.name ?? "tool", response: { result: m.content } } };
        const last = contents[contents.length - 1];
        if (last?.role === "user" && last.parts.every((p: any) => p.functionResponse)) last.parts.push(part);
        else contents.push({ role: "user", parts: [part] });
      } else if (m.role === "assistant") {
        const parts: any[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.arguments } });
        if (parts.length) contents.push({ role: "model", parts });
      } else {
        contents.push({ role: "user", parts: [...(m.images ?? []).map((i) => ({ inlineData: { mimeType: i.mime, data: i.data } })), { text: m.content || " " }] });
      }
    }
    // Gemini wants user/model turns to alternate: merge neighbours from the same side.
    for (let i = contents.length - 1; i > 0; i--) {
      if (contents[i].role === contents[i - 1].role) { contents[i - 1].parts.push(...contents[i].parts); contents.splice(i, 1); }
    }
    return { system, contents };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { system, contents } = this.convert(req.messages);
    const body: Record<string, unknown> = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: stripSchema(t.parameters, BANNED) })) }];
    const gen: Record<string, unknown> = {};
    if (req.temperature !== undefined) gen.temperature = req.temperature;
    if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
    if (Object.keys(gen).length) body.generationConfig = gen;

    const url = `${BASE}/models/${encodeURIComponent(this.model.replace(/^models\//, ""))}:streamGenerateContent?alt=sse`;
    const opened = await providerFetch(url, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, {
      timeoutMs: TIMEOUT, signal: req.signal, label: "Google Gemini", secrets: [this.cfg.apiKey],
    });

    let text = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    let finish: string | undefined;
    let usage: ChatResult["usage"];
    for await (const ev of readSSE(opened, TIMEOUT)) {
      let j: any;
      try { j = JSON.parse(ev.data); } catch { continue; }
      if (j.error) throw new ProviderError(`Google Gemini: ${String(j.error.message ?? "stream error").slice(0, 300)}`);
      const cand = j.candidates?.[0];
      for (const p of cand?.content?.parts ?? []) {
        if (typeof p.text === "string") {
          if (p.thought) { reasoning += p.text; req.onReasoning?.(p.text); }
          else { text += p.text; req.onText?.(p.text); }
        } else if (p.functionCall?.name) {
          toolCalls.push({ id: `call_${Date.now().toString(36)}_${toolCalls.length}`, name: p.functionCall.name, arguments: p.functionCall.args ?? {} });
        }
      }
      if (cand?.finishReason) finish = cand.finishReason;
      if (j.usageMetadata) usage = { input: j.usageMetadata.promptTokenCount ?? 0, output: (j.usageMetadata.candidatesTokenCount ?? 0) + (j.usageMetadata.thoughtsTokenCount ?? 0), cached: j.usageMetadata.cachedContentTokenCount || undefined };
    }
    if (!text && !toolCalls.length && finish && finish !== "STOP") {
      throw new ProviderError(`Gemini stopped without an answer (${finish}). It may have been blocked by a safety filter.`);
    }
    return { content: text, toolCalls, reasoning: reasoning || undefined, usage, finishReason: finish };
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    const opened = await providerFetch(`${BASE}/models?pageSize=200`, { headers: this.headers() }, {
      timeoutMs: 20_000, signal, label: "Google Gemini", secrets: [this.cfg.apiKey], retries: 0,
    });
    const json: any = await opened.res.json();
    return (json.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => ({ id: String(m.name).replace(/^models\//, ""), label: m.displayName }));
  }
}
