import { _rewriteUrlForTests } from "@/server/net";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "@/server/providers/anthropic";
import { createProvider } from "@/server/providers/factory";
import { GeminiProvider } from "@/server/providers/gemini";
import { OllamaProvider } from "@/server/providers/ollama";
import { OpenAICompatProvider } from "@/server/providers/openaiCompat";
import { ProviderError } from "@/server/providers/types";
import { ThinkFilter } from "@/server/providers/util";
import { json, Mock, sse, startMock } from "./helpers/mock";

let mock: Mock | undefined;
afterEach(async () => { await mock?.close(); mock = undefined; });

const chunk = (delta: object, finish: string | null = null) => ({ choices: [{ delta, finish_reason: finish }] });

describe("ThinkFilter", () => {
  it("splits reasoning from text even when tags straddle chunks", async () => {
    const t: string[] = [], r: string[] = [];
    const f = new ThinkFilter((s) => t.push(s), (s) => r.push(s));
    for (const c of ["Hi <thi", "nk>plan", " it</th", "ink>answer"]) f.push(c);
    f.end();
    expect(f.text).toBe("Hi answer");
    expect(f.reasoning).toBe("plan it");
  });
});

describe("OpenAICompatProvider", () => {
  it("streams text, and sends bearer auth, custom headers and query params", async () => {
    mock = await startMock((req, res) => sse(res, [chunk({ content: "Hel" }), chunk({ content: "lo" }, "stop"), "[DONE]"]));
    const p = new OpenAICompatProvider({
      kind: "custom", label: "X", baseUrl: mock.url + "/v1", apiKey: "sk-test-123456", model: "m1",
      options: { extraHeaders: { "X-Team": "abc" }, queryParams: { "api-version": "2024" }, temperature: 0.3, maxTokens: 50 },
    });
    const deltas: string[] = [];
    const out = await p.chat({ messages: [{ role: "user", content: "hi" }], onText: (d) => deltas.push(d) });
    expect(out.content).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    const c = mock.calls[0];
    expect(c.url).toBe("/v1/chat/completions?api-version=2024");
    expect(c.headers.authorization).toBe("Bearer sk-test-123456");
    expect(c.headers["x-team"]).toBe("abc");
    expect(c.body).toMatchObject({ model: "m1", stream: true, temperature: 0.3, max_tokens: 50 });
  });

  it("supports x-api-key, custom header and no auth", async () => {
    mock = await startMock((_r, res) => json(res, { choices: [{ message: { content: "ok" } }] }));
    for (const [opts, header, expected] of [
      [{ authStyle: "x-api-key" as const }, "x-api-key", "K123456"],
      [{ authStyle: "header" as const, authHeaderName: "X-Gateway-Key" }, "x-gateway-key", "K123456"],
      [{ authStyle: "none" as const }, "authorization", undefined],
    ] as const) {
      mock.calls.length = 0;
      const p = new OpenAICompatProvider({ kind: "custom", label: "X", baseUrl: mock.url, apiKey: "K123456", model: "m", options: { ...opts, streaming: false } });
      expect((await p.chat({ messages: [{ role: "user", content: "x" }] })).content).toBe("ok");
      expect(mock.calls[0].headers[header]).toBe(expected);
    }
  });

  it("assembles streamed tool calls and parses arguments", async () => {
    mock = await startMock((_r, res) => sse(res, [
      chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "calculator", arguments: '{"expr' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ession":"2+2"}' } }] }, "tool_calls"),
      "[DONE]",
    ]));
    const p = new OpenAICompatProvider({ kind: "custom", label: "X", baseUrl: mock.url, model: "m" });
    const out = await p.chat({ messages: [{ role: "user", content: "x" }], tools: [{ name: "calculator", description: "d", parameters: { type: "object" } }] });
    expect(out.toolCalls).toEqual([{ id: "c1", name: "calculator", arguments: { expression: "2+2" }, error: undefined }]);
    expect(mock.calls[0].body.tools[0].function.name).toBe("calculator");
  });

  it("falls back to a JSON reply when a gateway ignores stream:true, and extracts reasoning", async () => {
    mock = await startMock((_r, res) => json(res, { choices: [{ message: { content: "<think>hmm</think>done", reasoning_content: "r1" } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    const p = new OpenAICompatProvider({ kind: "custom", label: "X", baseUrl: mock.url, model: "m" });
    const out = await p.chat({ messages: [{ role: "user", content: "x" }] });
    expect(out.content).toBe("done");
    expect(out.reasoning).toBe("r1hmm");
    expect(out.usage).toEqual({ input: 3, output: 4 });
  });

  it("asks for streamed usage, reads cached tokens and sends images as data URLs", async () => {
    mock = await startMock((_r, res) => sse(res, [
      chunk({ content: "hi" }, "stop"),
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 40 } } },
      "[DONE]",
    ]));
    const p = new OpenAICompatProvider({ kind: "custom", label: "X", baseUrl: mock.url, model: "m", options: { vision: true, contextWindow: 32000 } } as any);
    expect(p.vision).toBe(true);
    expect(p.contextWindow).toBe(32000);
    const out = await p.chat({ messages: [{ role: "user", content: "see", images: [{ mime: "image/jpeg", data: "/9j/4AAQ" }] }] });
    expect(out.usage).toEqual({ input: 50, output: 3, cached: 40 });
    const b = mock.calls[0].body;
    expect(b.stream_options).toEqual({ include_usage: true });
    expect(b.messages[0].content).toEqual([{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } }]);
  });

  it("retries without stream_options when a gateway rejects it", async () => {
    mock = await startMock((req, res) => {
      if ((req as any).body?.stream_options) return json(res, { error: { message: "Unrecognized request argument: stream_options" } }, 400);
      return sse(res, [chunk({ content: "fine" }, "stop"), "[DONE]"]);
    });
    const p = new OpenAICompatProvider({ kind: "custom", label: "X", baseUrl: mock.url, model: "m" });
    const out = await p.chat({ messages: [{ role: "user", content: "x" }] });
    expect(out.content).toBe("fine");
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[1].body.stream_options).toBeUndefined();
    await p.chat({ messages: [{ role: "user", content: "y" }] });
    expect(mock.calls[2].body.stream_options).toBeUndefined(); // remembered
  });

  it("maps HTTP errors to friendly messages without leaking the key", async () => {
    mock = await startMock((_r, res) => json(res, { error: { message: "bad key sk-test-123456 rejected" } }, 401));
    const p = new OpenAICompatProvider({ kind: "custom", label: "Acme", baseUrl: mock.url, apiKey: "sk-test-123456", model: "m" });
    const err = await p.chat({ messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("Acme rejected the API key");
    expect(err.message).not.toContain("sk-test-123456");
  });

  it("retries a transient 503 once", async () => {
    let n = 0;
    mock = await startMock((_r, res) => (++n === 1 ? json(res, { error: "busy" }, 503) : json(res, { choices: [{ message: { content: "ok" } }] })));
    const p = new OpenAICompatProvider({ kind: "custom", label: "X", baseUrl: mock.url, model: "m", options: { streaming: false } });
    expect((await p.chat({ messages: [{ role: "user", content: "x" }] })).content).toBe("ok");
    expect(n).toBe(2);
  });

  it("lists models from /models (and honours modelsPath)", async () => {
    mock = await startMock((req, res) => json(res, req.url === "/v1/catalog" ? { data: [{ id: "b" }, { id: "a" }] } : {}, req.url === "/v1/catalog" ? 200 : 404));
    const p = new OpenAICompatProvider({ kind: "custom", label: "X", baseUrl: mock.url + "/v1", model: "m", options: { modelsPath: "/catalog" } });
    expect((await p.listModels()).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("can be stopped", async () => {
    mock = await startMock((_r, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify(chunk({ content: "a" }))}\n\n`); });
    const ac = new AbortController();
    const p = new OpenAICompatProvider({ kind: "custom", label: "X", baseUrl: mock.url, model: "m" });
    const run = p.chat({ messages: [{ role: "user", content: "x" }], signal: ac.signal, onText: () => ac.abort() });
    await expect(run).rejects.toThrow(/Stopped/);
  });
});

describe("prompted tools fallback", () => {
  it("uses a fenced tool_call block when nativeTools is off", async () => {
    mock = await startMock((_r, res) => json(res, { choices: [{ message: { content: 'Sure.\n```tool_call\n{"name":"datetime","arguments":{"timezone":"UTC"}}\n```' } }] }));
    const p = createProvider({ id: "1", kind: "custom", label: "Z", model: "m", baseUrl: mock.url, options: { nativeTools: false, streaming: false } });
    const out = await p.chat({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "time?" }], tools: [{ name: "datetime", description: "now", parameters: { type: "object" } }] });
    expect(out.toolCalls[0]).toMatchObject({ name: "datetime", arguments: { timezone: "UTC" } });
    expect(mock.calls[0].body.tools).toBeUndefined();
    expect(mock.calls[0].body.messages[0].content).toContain("tool_call");
  });
});

describe("Anthropic", () => {
  it("streams text + tool_use and converts tool results", async () => {
    mock = await startMock((_r, res) => sse(res, [
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "datetime" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"timezone":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"UTC"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    ]));
    const p = new AnthropicProvider({ apiKey: "ak-1234567", model: "claude-x" });
    (p as any).cfg.baseUrl = mock.url;
    const out = await p.chat({
      messages: [
        { role: "system", content: "sys" }, { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "t0", name: "datetime", arguments: {} }] },
        { role: "tool", toolCallId: "t0", name: "datetime", content: "noon" },
      ],
      tools: [{ name: "datetime", description: "d", parameters: { type: "object" } }],
    });
    expect(out.content).toBe("Let me check.");
    expect(out.toolCalls[0]).toMatchObject({ id: "tu1", name: "datetime", arguments: { timezone: "UTC" } });
    expect(out.usage).toEqual({ input: 5, output: 9 });
    const b = mock.calls[0].body;
    expect(mock.calls[0].headers["x-api-key"]).toBe("ak-1234567");
    // The system prompt is sent as a cacheable block, and the tool list ends with a cache breakpoint.
    expect(b.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
    expect(b.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t0" });
    expect(b.tools[0].input_schema).toEqual({ type: "object" });
    expect(b.tools[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("splits the system prompt at cacheSplit, reports cache reads, and sends images", async () => {
    mock = await startMock((_r, res) => sse(res, [
      { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    ]));
    const p = new AnthropicProvider({ apiKey: "ak-1234567", model: "claude-x" });
    (p as any).cfg.baseUrl = mock.url;
    expect(p.vision).toBe(true);
    const out = await p.chat({ messages: [
      { role: "system", content: "STATIC PART\nDATE: today", cacheSplit: "STATIC PART\n".length },
      { role: "user", content: "look", images: [{ mime: "image/png", data: "iVBORw0KGgo=" }] },
    ] });
    expect(out.usage).toEqual({ input: 1000, output: 2, cached: 900 });
    const b = mock.calls[0].body;
    expect(b.system[0]).toEqual({ type: "text", text: "STATIC PART\n", cache_control: { type: "ephemeral" } });
    expect(b.system[1].text).toBe("DATE: today");
    const blocks = b.messages[0].content;
    expect(blocks.some((x: any) => x.type === "image" && x.source.media_type === "image/png" && x.source.data === "iVBORw0KGgo=")).toBe(true);
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("Gemini", () => {
  it("streams text and function calls; strips unsupported schema keys", async () => {
    mock = await startMock((_r, res) => sse(res, [
      { candidates: [{ content: { parts: [{ text: "Hi " }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { name: "calculator", args: { expression: "1+1" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } },
    ]));
    // The transport no longer uses the global fetch, so the fixed Gemini host is redirected at the transport seam instead.
    _rewriteUrlForTests((u) => new URL(u.toString().replace("https://generativelanguage.googleapis.com", mock!.url)));
    try {
      const p = new GeminiProvider({ apiKey: "gk-1234567", model: "gemini-x" });
      const out = await p.chat({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "calculator", description: "d", parameters: { type: "object", additionalProperties: false, properties: { expression: { type: "string" } } } }],
      });
      expect(out.content).toBe("Hi ");
      expect(out.toolCalls[0]).toMatchObject({ name: "calculator", arguments: { expression: "1+1" } });
      expect(mock.calls[0].url).toContain("gemini-x:streamGenerateContent?alt=sse");
      expect(mock.calls[0].headers["x-goog-api-key"]).toBe("gk-1234567");
      expect(JSON.stringify(mock.calls[0].body.tools)).not.toContain("additionalProperties");
    } finally { _rewriteUrlForTests(undefined); }
  });
});

describe("Ollama", () => {
  it("reads NDJSON streams including tool calls", async () => {
    mock = await startMock((_r, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { content: "Hey" } }) + "\n");
      res.write(JSON.stringify({ message: { tool_calls: [{ function: { name: "datetime", arguments: { timezone: "UTC" } } }] } }) + "\n");
      res.end(JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 2 }) + "\n");
    });
    const p = new OllamaProvider({ baseUrl: mock.url, model: "llama3.1" });
    const out = await p.chat({ messages: [{ role: "user", content: "x" }] });
    expect(out.content).toBe("Hey");
    expect(out.toolCalls[0]).toMatchObject({ name: "datetime", arguments: { timezone: "UTC" } });
    expect(out.usage).toEqual({ input: 1, output: 2 });
  });

  it("gives a helpful message when Ollama isn't running", async () => {
    const p = new OllamaProvider({ baseUrl: "http://127.0.0.1:1", model: "m" });
    await expect(p.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/Is it running/);
  });
});
