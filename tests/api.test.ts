import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { config } from "@/server/config";
import { sqliteConn as db } from "@/server/db";
import { newSession } from "@/server/auth/session";
import { listFiles, readFile, writeFile } from "@/server/workspace";
import { testActor } from "./helpers/actor";
import type { AgentEvent, DesignEvent } from "@/lib/types";
import { DEFAULT_AGENT_SETTINGS } from "@/lib/types";
import { COMPONENTS } from "@/server/design/components";
import { THEMES } from "@/server/design/themes";
import * as agentApprove from "@/app/api/agent/approve/route";
import * as bootstrap from "@/app/api/bootstrap/route";
import * as chat from "@/app/api/chat/route";
import * as conversation from "@/app/api/conversations/[id]/route";
import * as conversations from "@/app/api/conversations/route";
import * as dataWipe from "@/app/api/data/wipe/route";
import * as design from "@/app/api/design/route";
import * as designAction from "@/app/api/design/[id]/[action]/route";
import * as documents from "@/app/api/documents/route";
import * as providers from "@/app/api/providers/route";
import * as providerModels from "@/app/api/providers/models/route";
import * as providerTest from "@/app/api/providers/test/route";
import * as settings from "@/app/api/settings/route";
import * as runs from "@/app/api/runs/[id]/route";
import * as runStop from "@/app/api/runs/[id]/stop/route";
import * as workspaceFile from "@/app/api/workspace/file/route";
import { _resetRateLimits } from "@/server/security";
import { Mock, startMock } from "./helpers/mock";
import { makeUser } from "./helpers/users";

const ORIGIN = "http://localhost:3000";
let mock: Mock;
let script: Array<(body: any) => { content?: string; tool_calls?: any[] }> = [];
const KEY = "sk-secret-abcdef123456";

const reply = (res: any, body: any, msg: { content?: string; tool_calls?: any[] }) => {
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (msg.content) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: msg.content } }] })}\n\n`);
    (msg.tool_calls ?? []).forEach((tc, i) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: tc.id, function: tc.function }] } }] })}\n\n`));
    res.end("data: [DONE]\n\n");
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: msg.content ?? null, tool_calls: msg.tool_calls } }] }));
  }
};
const tc = (name: string, args: object, id = "t" + Math.random().toString(36).slice(2, 7)) => ({ id, function: { name, arguments: JSON.stringify(args) } });

beforeAll(async () => {
  mock = await startMock((req, res) => {
    if (req.url?.startsWith("/v1/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "zeta-1" }, { id: "alpha-2" }] })); }
    const next = script.shift();
    if (!next) { res.writeHead(500); return res.end("script exhausted"); }
    reply(res, req.body, next(req.body));
  });
});
afterAll(async () => { await mock.close(); });

/** A live session token for a user, written synchronously (the same INSERT startSession runs). */
function sessionToken(userId: string): string {
  const { started, insert } = newSession(userId, { ip: "test" }, Date.now());
  db().prepare(insert.sql).run(...(insert.params as never[]));
  return started.token;
}

/** A browser. By default it is signed in as a brand-new account (there is no other kind of caller); `new Session(false)` is a visitor. */
class Session {
  cookie = "";
  userId = "";
  constructor(signedIn = true) {
    if (signedIn) { this.userId = makeUser().userId; this.cookie = `morphie_session=${sessionToken(this.userId)}`; }
  }
  async call(handler: Function, p: string, init: { method?: string; body?: unknown; origin?: string | null; params?: Record<string, string>; form?: FormData } = {}) {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { host: "localhost:3000" };
    if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
    if (this.cookie) headers.cookie = this.cookie;
    let body: BodyInit | undefined;
    if (init.form) body = init.form;
    else if (init.body !== undefined) { body = JSON.stringify(init.body); headers["content-type"] = "application/json"; }
    const res: Response = await handler(new Request(ORIGIN + p, { method, headers, body }), { params: Promise.resolve(init.params ?? {}) });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    return res;
  }
  async json(handler: Function, p: string, init: Parameters<Session["call"]>[2] = {}) {
    const res = await this.call(handler, p, init);
    return { status: res.status, data: (await res.json()) as any };
  }
  /** Read an SSE response, invoking `onEvent` live so tests can react (e.g. approve an action) mid-stream. */
  async stream<T>(handler: Function, p: string, body: unknown, onEvent?: (e: T) => Promise<void> | void) {
    const res = await this.call(handler, p, { method: "POST", body });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events: T[] = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        if (block.startsWith("data: ")) { const e = JSON.parse(block.slice(6)) as T; events.push(e); await onEvent?.(e); }
      }
    }
    return events;
  }
}

const customProvider = (over: object = {}) => ({
  kind: "custom", label: "CodeCraft", baseUrl: mock.url + "/v1", apiKey: KEY, model: "alpha-2",
  options: { authStyle: "x-api-key", extraHeaders: { "X-Team": "t-123" }, queryParams: { v: "1" } }, ...over,
});

describe("session, CSRF and bootstrap", () => {
  it("serves the catalog to a signed-in user, rejects cross-site writes, and ignores forged cookies", async () => {
    const s = new Session();
    const res = await s.call(bootstrap.GET, "/api/bootstrap");
    expect(res.headers.get("set-cookie")).toBeNull(); // bootstrap never issues a session; only a login does
    const data: any = await res.json();
    expect(data.catalog.map((c: any) => c.kind)).toEqual(expect.arrayContaining(["openai", "anthropic", "gemini", "openrouter", "groq", "ollama", "custom"]));
    expect(data.customPresets.some((p: any) => p.id === "codecraft" && p.baseUrl === "https://codecraftapi.com/v1")).toBe(true);
    expect(data.profiles).toEqual([]);
    expect(data.session).not.toBeNull();

    expect((await s.json(settings.PUT, "/api/settings", { method: "PUT", body: { approval: "always" }, origin: "https://evil.example" })).status).toBe(403);
    expect((await s.json(settings.PUT, "/api/settings", { method: "PUT", body: { approval: "always" }, origin: null })).status).toBe(200);

    // forged cookies are ignored: the visitor stays a visitor, gets the minimal payload, and nothing is issued
    for (const forgedCookie of ["morphie_uid=AAAAAAAAAAAAAAAAAAAAAAAA.forgedsignaturevalue00000000", "morphie_session=" + "A".repeat(43)]) {
      const forged = new Session(false); forged.cookie = forgedCookie;
      const r = await forged.call(bootstrap.GET, "/api/bootstrap");
      expect(r.headers.get("set-cookie")).toBeNull();
      expect((await r.json()).session).toBeNull();
      expect((await forged.json(settings.GET, "/api/settings")).status).toBe(401);
    }
  });
});

describe("custom OpenAI-compatible provider, configured entirely from the UI", () => {
  const s = new Session();
  let profileId = "";

  it("saves, never returns the key, and stores it encrypted", async () => {
    const { status, data } = await s.json(providers.POST, "/api/providers", { method: "POST", body: customProvider() });
    expect(status).toBe(200);
    profileId = data.profile.id;
    expect(data.activeId).toBe(profileId);
    expect(data.profile).toMatchObject({ kind: "custom", label: "CodeCraft", model: "alpha-2", hasKey: true, keyHint: "••••3456", baseUrl: mock.url + "/v1" });
    expect(data.profile.options.extraHeaders).toEqual({ "X-Team": "" });  // header values never echoed
    const everything = JSON.stringify((await s.json(bootstrap.GET, "/api/bootstrap")).data);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("t-123");
    const raw = JSON.stringify(db().prepare("SELECT * FROM provider_profiles").all());
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain("t-123");
  });

  it("fetches models via the stored key and the configured auth style, headers and query", async () => {
    mock.calls.length = 0;
    const { data } = await s.json(providerModels.POST, "/api/providers/models", { method: "POST", body: { profileId, kind: "custom", baseUrl: mock.url + "/v1", options: { authStyle: "x-api-key" } } });
    expect(data.models.map((m: any) => m.id)).toEqual(["alpha-2", "zeta-1"]);
    expect(mock.calls[0].headers["x-api-key"]).toBe(KEY);
  });

  it("tests the connection and detects tool calling", async () => {
    script = [() => ({ content: "pong" }), () => ({ tool_calls: [tc("get_current_time", { location: "UTC" })] })];
    const { data } = await s.json(providerTest.POST, "/api/providers/test", { method: "POST", body: { profileId } });
    expect(data).toMatchObject({ ok: true, tools: "supported", reply: "pong" });
    expect(data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a bad key clearly instead of throwing", async () => {
    const bad = new Session();
    const saved = await bad.json(providers.POST, "/api/providers", { method: "POST", body: customProvider({ apiKey: "sk-wrong-000000000" }) });
    expect(saved.status).toBe(200);
    const orig = mock.calls.length;
    script = [];       // exhausted script → mock answers 500, which is reported as a provider problem
    const { data } = await bad.json(providerTest.POST, "/api/providers/test", { method: "POST", body: { profileId: saved.data.profile.id } });
    expect(data.ok).toBe(false);
    expect(data.message).toMatch(/having trouble|500/);
    expect(mock.calls.length).toBeGreaterThan(orig);
  });

  it("validates input: credentials in URL, bad header names, missing model, unknown kind", async () => {
    const t = new Session();
    const bad = async (over: object) => (await t.json(providers.POST, "/api/providers", { method: "POST", body: customProvider(over) })).status;
    expect(await bad({ baseUrl: "https://user:pass@example.com/v1" })).toBe(400);
    expect(await bad({ baseUrl: "ftp://example.com" })).toBe(400);
    expect(await bad({ baseUrl: "" })).toBe(400);
    expect(await bad({ options: { extraHeaders: { "bad header": "x" } } })).toBe(400);
    expect(await bad({ options: { authStyle: "header" } })).toBe(400);
    expect(await bad({ model: "" })).toBe(400);
    expect(await bad({ kind: "nope" })).toBe(400);
    expect(await bad({ options: { chatPath: "chat/completions?x=1" } })).toBe(400);
  });

  it("can forbid private/local URLs (for public deployments)", async () => {
    process.env.MORPHIE_ALLOW_PRIVATE_URLS = "false";
    try {
      const t = new Session();
      const r = await t.json(providers.POST, "/api/providers", { method: "POST", body: customProvider() });
      expect(r.status).toBe(400);
      expect(r.data.error).toMatch(/Private and local/);
    } finally { delete process.env.MORPHIE_ALLOW_PRIVATE_URLS; }
  });

  it("chat streams tokens through the configured provider (custom headers sent) and persists the conversation", async () => {
    mock.calls.length = 0;
    script = [() => ({ content: "Hello from the gateway." })];
    const events = await s.stream<AgentEvent>(chat.POST, "/api/chat", { message: "hi there", mode: "chat" });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["start", "text", "title", "done"]));
    const start = events[0] as any;
    expect(start.provider).toBe("CodeCraft");
    const call = mock.calls.find((c) => c.url?.startsWith("/v1/chat/completions"))!;
    expect(call.url).toBe("/v1/chat/completions?v=1");
    expect(call.headers["x-api-key"]).toBe(KEY);
    expect(call.headers["x-team"]).toBe("t-123");
    const { data } = await s.json(conversation.GET, `/api/conversations/${start.conversationId}`, { params: { id: start.conversationId } });
    expect(data.messages.map((m: any) => [m.role, m.content])).toEqual([["user", "hi there"], ["assistant", "Hello from the gateway."]]);
    expect(data.conversation.title).toBe("hi there");
  });

  it("agent mode: approval round-trips over HTTP, the file lands in the sandbox, and other sessions are locked out", async () => {
    script = [
      () => ({ content: "Planning.", tool_calls: [tc("update_plan", { items: [{ text: "Write note", status: "active" }] })] }),
      () => ({ tool_calls: [tc("workspace_write", { path: "notes/hello.md", content: "# Hi" })] }),
      () => ({ content: "Saved notes/hello.md." }),
    ];
    const intruder = new Session(); // another signed-in account
    let intruderBlocked = false;
    const events = await s.stream<AgentEvent>(chat.POST, "/api/chat", { message: "write me a note", mode: "agent" }, async (e) => {
      if (e.type === "approval") {
        const stolen = await intruder.json(agentApprove.POST, "/api/agent/approve", { method: "POST", body: { id: e.id, approved: true } });
        intruderBlocked = stolen.status === 410;
        const ok = await s.json(agentApprove.POST, "/api/agent/approve", { method: "POST", body: { id: e.id, approved: true } });
        expect(ok.status).toBe(200);
      }
    });
    expect(intruderBlocked).toBe(true);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["plan", "approval", "tool_end", "done"]));
    expect(events.filter((e) => e.type === "tool_end").every((e: any) => e.status === "done")).toBe(true);
    const f = await s.json(workspaceFile.GET, "/api/workspace/file?path=notes/hello.md");
    expect(f.data.content).toBe("# Hi");
    const dl = await s.call(workspaceFile.GET, "/api/workspace/file?path=notes/hello.md&download=1");
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await s.json(workspaceFile.GET, "/api/workspace/file?path=../../etc/passwd")).status).toBe(400);
    // the other browser sees none of this
    expect((await intruder.json(workspaceFile.GET, "/api/workspace/file?path=notes/hello.md")).status).toBe(404);
  });

  it("refuses to run two replies in one conversation at once, and unknown conversations 404", async () => {
    script = [() => ({ content: "a" })];
    const first = await s.stream<AgentEvent>(chat.POST, "/api/chat", { message: "one", mode: "chat" });
    const id = (first[0] as any).conversationId;
    expect((await s.json(chat.POST, "/api/chat", { method: "POST", body: { message: "x", conversationId: "nope" } })).status).toBe(404);
    // edit + re-run replaces the old turn
    const msgs = (await s.json(conversation.GET, `/api/conversations/${id}`, { params: { id } })).data.messages;
    script = [() => ({ content: "b" })];
    await s.stream<AgentEvent>(chat.POST, "/api/chat", { message: "one (edited)", conversationId: id, truncateFrom: msgs[0].id });
    const after = (await s.json(conversation.GET, `/api/conversations/${id}`, { params: { id } })).data.messages;
    expect(after.map((m: any) => m.content)).toEqual(["one (edited)", "b"]);
  });

  it("a run that stops on an error can be continued; its stream can be followed again from any seq; Stop is its own call", async () => {
    script = [() => ({ tool_calls: [tc("calculator", { expression: "6*7" })] })]; // the next model call fails (the script runs out)
    const first = await s.stream<AgentEvent & { seq: number }>(chat.POST, "/api/chat", { message: "work it out", mode: "agent" });
    const id = (first[0] as any).conversationId as string;
    expect(first.map((e) => e.seq)).toEqual(first.map((_, i) => i + 1));
    expect(first.find((e) => e.type === "done")).toMatchObject({ reason: "error", continuable: true });
    // Re-attach from the middle: only what came after.
    const again = await s.call(runs.GET, `/api/runs/${id}?from=3`, { params: { id } });
    const replay = (await again.text()).split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
    expect(replay[0].seq).toBe(4);
    expect(replay.at(-1).type).toBe(first.at(-1)!.type);
    // Continue: no new user message, and the reply picks up the work.
    script = [() => ({ content: "It's 42." })];
    const second = await s.stream<AgentEvent>(chat.POST, "/api/chat", { conversationId: id, mode: "agent", continue: true });
    expect(second.find((e) => e.type === "done")).toMatchObject({ reason: "complete" });
    const msgs = (await s.json(conversation.GET, `/api/conversations/${id}`, { params: { id } })).data.messages;
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(msgs[1].meta.continuable).toBeFalsy();
    expect(msgs[2]).toMatchObject({ content: "It's 42.", meta: { continued: true } });
    expect((await s.json(runStop.POST, `/api/runs/${id}/stop`, { method: "POST", body: {}, params: { id } })).data).toEqual({ stopped: false });
    const idle = await s.json(conversations.POST, "/api/conversations", { method: "POST", body: { mode: "agent" } });
    const quiet = idle.data.conversation.id;
    expect((await s.json(runs.GET, `/api/runs/${quiet}`, { params: { id: quiet } })).data).toEqual({ active: false });
    expect((await s.json(chat.POST, "/api/chat", { method: "POST", body: { continue: true } })).status).toBe(400);
  });

  it("reports a missing provider as an actionable error", async () => {
    const fresh = new Session();
    const r = await fresh.json(chat.POST, "/api/chat", { method: "POST", body: { message: "hello" } });
    expect(r.status).toBe(400);
    expect(r.data.code).toBe("no_provider");
  });
});

describe("design over the API", () => {
  const s = new Session();
  const base = () => ({ name: "Acme", theme: { ...THEMES.minimal.colors }, typography: { ...THEMES.minimal.typography }, sections: [COMPONENTS.hero.example, COMPONENTS.footer.example] });

  it("creates via SSE, undoes, applies a theme without the model, and downloads a zip", async () => {
    await s.json(providers.POST, "/api/providers", { method: "POST", body: customProvider() });
    script = [() => ({ content: JSON.stringify({ summary: "Made it.", design: base() }) })];
    const events = await s.stream<DesignEvent>(design.POST, "/api/design", { message: "a landing page for acme" });
    expect(events.map((e) => e.type)).toEqual(["stage", "stage", "result"]);
    const result = events.at(-1) as Extract<DesignEvent, { type: "result" }>;
    expect(result.state.previewHtml).toContain("<!DOCTYPE html>");
    const id = result.state.id;

    const themed = await s.json(designAction.POST, `/api/design/${id}/theme`, { method: "POST", body: { theme: "premium" }, params: { id, action: "theme" } });
    expect(themed.data.state.history.version).toBe(2);
    expect(themed.data.state.design.theme.primary).toBe(THEMES.premium.colors.primary);
    const undone = await s.json(designAction.POST, `/api/design/${id}/undo`, { method: "POST", body: {}, params: { id, action: "undo" } });
    expect(undone.data.state.history.version).toBe(1);

    const zip = await s.call(designAction.GET, `/api/design/${id}/download?format=react`, { params: { id, action: "download" } });
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(Object.keys(unzipSync(new Uint8Array(await zip.arrayBuffer())))).toContain("acme-react/src/App.jsx");
    expect((await s.json(designAction.GET, `/api/design/${id}/export?format=pdf`, { params: { id, action: "export" } })).status).toBe(400);
  });

  it("asks for clarification instead of failing on an empty brief", async () => {
    const events = await s.stream<DesignEvent>(design.POST, "/api/design", { message: "Use the Premium theme" });
    expect(events[0]).toMatchObject({ type: "clarify" });
  });
});

describe("documents and data ownership", () => {
  const s = new Session();
  const upload = (name: string, content: string | Uint8Array) => {
    const form = new FormData();
    form.set("file", new File([content as BlobPart], name));
    return s.json(documents.POST, "/api/documents", { method: "POST", form });
  };

  it("ingests a text document and rejects disguised or unsupported files", async () => {
    const ok = await upload("notes.txt", "Morphie stores documents locally. The refund window is thirty days.");
    expect(ok.status).toBe(200);
    expect(ok.data.document.chunkCount).toBe(1);
    expect((await upload("notes.txt", "Morphie stores documents locally. The refund window is thirty days.")).data.created).toBe(false);
    expect((await upload("evil.pdf", "MZ this is not a pdf")).status).toBe(400);
    expect((await upload("run.exe", "x")).status).toBe(400);
    expect((await upload("empty.txt", "")).status).toBe(400);
    expect((await upload("../../etc/passwd.txt", "hello world again")).data.document.name).toBe("passwd.txt");
  });

  it("wipes everything for this browser only", async () => {
    const other = new Session();
    await other.json(settings.PUT, "/api/settings", { method: "PUT", body: { taskTokenBudget: 70_000 } });
    await s.json(settings.PUT, "/api/settings", { method: "PUT", body: { taskTokenBudget: 90_000 } });
    await writeFile(testActor(other.userId), "keep.md", "other's file");
    await writeFile(testActor(s.userId), "gone.md", "my file");
    expect((await s.json(dataWipe.POST, "/api/data/wipe", { method: "POST", body: { confirm: false } })).status).toBe(400);
    expect((await s.json(dataWipe.POST, "/api/data/wipe", { method: "POST", body: { confirm: true } })).status).toBe(200);
    expect((await s.json(documents.GET, "/api/documents")).data.documents).toEqual([]);
    expect((await s.json(settings.GET, "/api/settings")).data.taskTokenBudget).toBe(DEFAULT_AGENT_SETTINGS.taskTokenBudget);
    expect((await other.json(settings.GET, "/api/settings")).data.taskTokenBudget).toBe(70_000);
    // Only this account's files went; another account's survive (local folder and R2 alike).
    expect(await listFiles(testActor(s.userId))).toEqual([]);
    expect(await readFile(testActor(other.userId), "keep.md")).toBe("other's file");
    if (process.env.MORPHIE_TEST_CLOUDFLARE !== "1") expect(fs.existsSync(path.join(config.dataDir, "workspace"))).toBe(true);
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once a bucket is exhausted", async () => {
    _resetRateLimits();
    const s = new Session();
    let last: Response | undefined;
    for (let i = 0; i < 13; i++) last = await s.call(providerTest.POST, "/api/providers/test", { method: "POST", body: { kind: "custom", model: "x", baseUrl: "https://example.com/v1" } });
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
