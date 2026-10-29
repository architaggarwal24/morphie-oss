import type { ChatMessage, ChatRequest, ChatResult, Provider, ProviderModel, ToolSpec } from "./types";

/**
 * Wraps a provider that has no native function calling. Tools are described in the
 * system prompt and the model is asked to reply with a ```tool_call fenced JSON block.
 * The block is parsed back into a normal ToolCall so the agent loop never notices.
 */
export class PromptedToolsProvider implements Provider {
  readonly nativeTools = true; // from the caller's point of view
  constructor(private inner: Provider) {}
  get kind() { return this.inner.kind; }
  get label() { return this.inner.label; }
  get model() { return this.inner.model; }
  get vision() { return this.inner.vision; }
  get contextWindow() { return this.inner.contextWindow; }
  listModels(signal?: AbortSignal): Promise<ProviderModel[]> { return this.inner.listModels(signal); }

  private describe(tools: ToolSpec[]): string {
    const lines = tools.map((t) => `- ${t.name}: ${t.description}\n  parameters (JSON Schema): ${JSON.stringify(t.parameters)}`);
    return [
      "You can use tools. To call ONE tool, reply with ONLY a fenced block and nothing else:",
      "```tool_call",
      '{"name": "<tool name>", "arguments": { ... }}',
      "```",
      "After the tool result arrives you may call another tool or give your final answer in plain text.",
      "If no tool is needed, answer normally without any tool_call block.",
      "",
      "Available tools:",
      ...lines,
    ].join("\n");
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (!req.tools?.length) return this.inner.chat(req);
    const messages: ChatMessage[] = [];
    for (const m of req.messages) {
      if (m.role === "tool") {
        messages.push({ role: "user", content: `Tool result for ${m.name ?? "tool"}:\n${m.content}\n\nContinue: call another tool or answer the user.` });
      } else if (m.role === "assistant" && m.toolCalls?.length) {
        const blocks = m.toolCalls.map((c) => "```tool_call\n" + JSON.stringify({ name: c.name, arguments: c.arguments }) + "\n```").join("\n");
        messages.push({ role: "assistant", content: [m.content, blocks].filter(Boolean).join("\n") });
      } else {
        messages.push({ ...m });
      }
    }
    const desc = this.describe(req.tools);
    const first = messages[0];
    if (first?.role === "system") messages[0] = { ...first, content: `${first.content}\n\n${desc}` };
    else messages.unshift({ role: "system", content: desc });

    // Buffer text so a tool_call block is never streamed to the user as if it were an answer.
    let held = "";
    let streaming = false;
    const result = await this.inner.chat({
      ...req, messages, tools: undefined,
      onText: (d) => {
        held += d;
        if (streaming) { req.onText?.(d); return; }
        const trimmed = held.trimStart();
        if (trimmed.length >= 3 && !"```".startsWith(trimmed.slice(0, 3))) { streaming = true; req.onText?.(held); }
        else if (req.onToolDelta && held.length > 20) req.onToolDelta({ index: 0, name: /"name"\s*:\s*"([^"]+)"/.exec(held)?.[1] ?? "", args: held });
      },
    });
    const call = parseBlock(result.content);
    if (call) {
      const text = result.content.replace(/```tool_call[\s\S]*?```/, "").trim();
      return { ...result, content: text, toolCalls: [{ id: `call_${Date.now().toString(36)}`, name: call.name, arguments: call.arguments }] };
    }
    if (!streaming && held) req.onText?.(held);
    return result;
  }
}

function parseBlock(text: string): { name: string; arguments: Record<string, unknown> } | null {
  const m = text.match(/```tool_call\s*([\s\S]*?)```/) ?? text.match(/^\s*(\{[\s\S]*"name"[\s\S]*\})\s*$/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    if (typeof j?.name !== "string") return null;
    const args = j.arguments ?? j.parameters ?? {};
    return { name: j.name, arguments: typeof args === "object" && args ? args : {} };
  } catch {
    return null;
  }
}
