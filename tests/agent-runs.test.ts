import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_SETTINGS, type AgentEvent, type AgentSettings, type Mode } from "@/lib/types";
import { clearOldToolResults, compact, CLEARED } from "@/server/agent/context";
import { runAgent } from "@/server/agent/loop";
import { decide } from "@/server/agent/approvals";
import { recoverInterrupted } from "@/server/agent/recover";
import { followRun, startRun, stopRun, settled } from "@/server/agent/runs";
import { loadSnapshot, repairToolPairs, saveSnapshot } from "@/server/agent/snapshot";
import { fileSlug, isDeliverable, zipProject } from "@/server/code/projects";
import { VERIFY_SCRIPT } from "@/server/code/verifyScript";
import { createConversation, getConversation, getMessages } from "@/server/conversations";
import { insertProject } from "@/server/data/projects";
import { usageSummary } from "@/server/data/usage";
import { AnthropicProvider } from "@/server/providers/anthropic";
import type { ChatMessage, ChatRequest } from "@/server/providers/types";
import { LocalSandbox } from "@/server/sandbox/local";
import { formatReport, verifyProjectTool } from "@/server/tools/projectTools";
import type { ToolContext } from "@/server/tools/types";
import { estimateMessages, metered } from "@/server/usage";
import { unzipSync, strFromU8 } from "fflate";
import { testActor } from "./helpers/actor";
import { json, startMock, sse } from "./helpers/mock";
import { call, Scripted, type Step } from "./helpers/scripted";

let n = 0;
const uid = (tag: string) => `run_${tag}_${++n}_abcdefghijklmnop`;
const ofType = <T extends AgentEvent["type"]>(events: AgentEvent[], t: T) => events.filter((e) => e.type === t) as Extract<AgentEvent, { type: T }>[];

async function run(script: Step[], opts: { mode?: Mode; message?: string; settings?: Partial<AgentSettings>; userId?: string; convId?: string; resume?: boolean; budget?: number; canCreateProject?: boolean; approve?: boolean; /** ask_user: what the user answers (null: skip). */ answers?: Record<string, string> | null } = {}) {
  const userId = opts.userId ?? uid("x");
  const actor = testActor(userId);
  const mode = opts.mode ?? "agent";
  const conv = opts.convId ? (await getConversation(actor, opts.convId))! : await createConversation(actor, mode);
  const provider = new Scripted(script);
  const events: AgentEvent[] = [];
  await runAgent({
    actor, conversationId: conv.id, mode, message: opts.message ?? "build me a thing", provider, signal: new AbortController().signal,
    settings: { ...DEFAULT_AGENT_SETTINGS, memory: false, approval: "never", ...opts.settings }, budget: opts.budget, resume: opts.resume, canCreateProject: opts.canCreateProject,
    emit: (e) => {
      events.push(e);
      if (e.type === "approval") setTimeout(() => void decide(userId, e.id, { approved: opts.approve ?? true }), 2);
      if (e.type === "question") setTimeout(() => void decide(userId, e.id, opts.answers ? { approved: true, answers: opts.answers } : { approved: false }), 2);
    },
  });
  return { userId, actor, conv, provider, events, messages: await getMessages(actor, conv.id) };
}

describe("token budget and Continue", () => {
  it("pauses when the budget is spent, saves where it got to, and Continue picks it up with the same working context", async () => {
    const big = { input: 30_000, output: 500 };
    const r = await run([
      { toolCalls: [call("calculator", { expression: "1+1" })], usage: big },
      { toolCalls: [call("calculator", { expression: "2+2" })], usage: big },
      { content: "Done so far: two sums. Next: the third.", usage: { input: 100, output: 20 } },
    ], { budget: 50_000 });
    const done = ofType(r.events, "done").at(-1)!;
    expect(done).toMatchObject({ reason: "budget", continuable: true });
    // The last call is offered no tools and told why.
    const last = r.provider.requests.at(-1)!;
    expect(last.tools).toBeUndefined();
    expect(String(last.messages.at(-1)!.content)).toMatch(/budget is used up/);
    expect(ofType(r.events, "budget").at(-1)!.used).toBeGreaterThan(50_000);
    const reply = r.messages.at(-1)!;
    expect(reply.meta).toMatchObject({ reason: "budget", continuable: true, budget: { limit: 50_000 } });
    const snap = (await loadSnapshot(r.actor, r.conv.id))!;
    expect(snap.status).toBe("paused");
    expect(snap.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["2", "4"]);

    // Continue: same conversation, the saved messages come back, a fresh budget, and the old reply loses its button.
    const c = await run([{ content: "All three sums are done." }], { userId: r.userId, convId: r.conv.id, resume: true, budget: 50_000 });
    const sent = c.provider.requests[0].messages;
    expect(sent.some((m) => m.role === "tool" && m.content === "4")).toBe(true);
    expect(String(sent.at(-1)!.content)).toMatch(/Continue the task from where you stopped \(it used its token budget\)/);
    const msgs = c.messages;
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1); // Continue adds no user message
    expect(msgs.at(-2)!.meta?.continuable).toBeFalsy();
    expect(msgs.at(-1)).toMatchObject({ content: "All three sums are done.", meta: { continued: true, reason: "complete" } });
    expect(await loadSnapshot(r.actor, r.conv.id)).toBeNull(); // finished: nothing left to continue
  });

  it("warns the model once when 80% of the budget is gone", async () => {
    const r = await run([
      { toolCalls: [call("calculator", { expression: "3+3" })], usage: { input: 85_000, output: 0 } },
      { content: "Wrapped up." },
    ], { budget: 100_000 });
    expect(String(r.provider.requests[1].messages.at(-1)!.content)).toMatch(/budget are left/);
    expect(r.messages.at(-1)!.meta?.reason).toBe("complete");
  });

  it("an error mid-run leaves a continuable reply", async () => {
    const r = await run([{ toolCalls: [call("calculator", { expression: "5+5" })] }]); // the script runs out → the provider throws
    expect(r.messages.at(-1)!.meta).toMatchObject({ reason: "error", continuable: true });
  });

  it("counts every model call of the run, and records each in the usage ledger by feature", async () => {
    const userId = uid("ledger");
    const r = await run([{ content: "hi", usage: { input: 1200, output: 30, cached: 1000 } }], { userId, mode: "chat" });
    expect(r.messages.at(-1)!.meta?.usage).toEqual({ input: 1200, output: 30, cached: 1000 });
    const s = await usageSummary(r.actor, 7);
    expect(s.total).toMatchObject({ input: 1200, output: 30, cached: 1000, calls: 1, estimated: 0 });
    expect(s.byFeature[0].key).toBe("chat");
    expect(s.conversations[0]).toMatchObject({ id: r.conv.id, input: 1200 });
    expect(s.byDay.at(-1)!.input).toBe(1200);
  });

  it("estimates usage when the provider reports none", async () => {
    const actor = testActor(uid("est"));
    const p = metered(new Scripted([{ content: "x".repeat(360) }]), { actor, feature: "other" });
    const out = await p.chat({ messages: [{ role: "user", content: "y".repeat(720) }] });
    expect(out.usage!.output).toBe(100);
    expect(out.usage!.input).toBeGreaterThanOrEqual(200);
    expect((await usageSummary(actor, 1)).total.estimated).toBe(1);
  });

  it("still counts a call that was stopped part-way (estimated from what streamed)", async () => {
    const actor = testActor(uid("stop"));
    const ac = new AbortController();
    const streaming = { kind: "s", label: "S", model: "m", nativeTools: true, listModels: async () => [],
      async chat(req: ChatRequest) { req.onText?.("y".repeat(400)); ac.abort(); throw new Error("Stopped."); } };
    const seen: number[] = [];
    const p = metered(streaming as never, { actor, feature: "chat", onUsage: (u) => seen.push(u.output) });
    await expect(p.chat({ messages: [{ role: "user", content: "hi" }], signal: ac.signal, onText: () => {} })).rejects.toThrow("Stopped.");
    expect(seen).toEqual([100]);
    expect((await usageSummary(actor, 1)).total).toMatchObject({ calls: 1, output: 100, estimated: 1 });
    // A failure that wasn't a stop is not billed here (the provider didn't finish the call).
    const failing = metered({ ...streaming, async chat() { throw new Error("boom"); } } as never, { actor, feature: "chat" });
    await expect(failing.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("boom");
    expect((await usageSummary(actor, 1)).total.calls).toBe(1);
  });
});

describe("keeping the context small", () => {
  const tool = (i: number, size: number): ChatMessage => ({ role: "tool", toolCallId: `t${i}`, name: "read_file", content: `line one ${i}\n` + "z".repeat(size) });

  it("clears old tool output in one go once there's a lot of it, keeping the newest results", () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "task" }];
    for (let i = 0; i < 10; i++) msgs.push({ role: "assistant", content: "", toolCalls: [{ id: `t${i}`, name: "read_file", arguments: {} }] }, tool(i, 6000));
    expect(clearOldToolResults(msgs)).toBe(4);
    const results = msgs.filter((m) => m.role === "tool");
    expect(results.slice(0, 4).every((m) => m.content.startsWith(CLEARED))).toBe(true);
    expect(results[0].content).toContain("line one 0");
    expect(results.slice(4).every((m) => !m.content.startsWith(CLEARED))).toBe(true);
    expect(clearOldToolResults(msgs)).toBe(0); // under the trigger now: nothing changes (the cached prefix stays valid)
  });

  it("compacts the middle of a run into a progress note on the task, keeping the latest rounds verbatim", async () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "build the app" }];
    for (let i = 0; i < 8; i++) msgs.push({ role: "assistant", content: `step ${i}`, toolCalls: [{ id: `t${i}`, name: "bash", arguments: { command: `cmd ${i}` } }] }, { role: "tool", toolCallId: `t${i}`, name: "bash", content: `out ${i}` });
    const helper = new Scripted([{ content: "Built the header and footer. Next: the pricing section." }]);
    expect(await compact(msgs, 1, helper, new AbortController().signal)).toBe(true);
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toMatch(/^build the app\n\n---\n\[Progress so far[\s\S]*pricing section/);
    expect(msgs[2]).toMatchObject({ role: "assistant", content: "step 4" }); // the newest four rounds are intact
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(4);
    expect(String(helper.requests[0].messages[1].content)).toContain("CALL bash");
  });

  it("gives every tool call an answer (a run stopped mid-step)", () => {
    const fixed = repairToolPairs([{ role: "assistant", content: "", toolCalls: [{ id: "a", name: "x", arguments: {} }, { id: "b", name: "y", arguments: {} }] }, { role: "tool", toolCallId: "a", name: "x", content: "ok" }]);
    expect(fixed.map((m) => m.toolCallId).filter(Boolean)).toEqual(["a", "b"]);
    expect(fixed[2].content).toMatch(/stopped before this finished/);
  });

  it("estimates the size of a request", () => {
    expect(estimateMessages([{ role: "user", content: "a".repeat(3600) }])).toBeGreaterThan(1000);
  });
});

describe("runs outlive the connection", () => {
  const read = async (res: Response) => {
    const text = await res.text();
    return text.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
  };

  it("buffers events with a seq, replays from any point, and keeps going when nobody is listening", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    startRun("u1", "conv_follow_1", async (emit) => {
      emit({ type: "text", delta: "a" });
      emit({ type: "text", delta: "b" });
      await gate;
      emit({ type: "done", reason: "complete" });
    });
    // A follower that leaves early doesn't stop anything.
    const ac = new AbortController();
    const early = followRun(new Request("http://x/", { signal: ac.signal }), "conv_follow_1", 0)!;
    ac.abort();
    await early.body?.cancel().catch(() => {});
    const later = followRun(new Request("http://x/"), "conv_follow_1", 1)!;
    release();
    const events = await read(later);
    expect(events.map((e) => [e.seq, e.type, e.delta])).toEqual([[2, "text", "b"], [3, "done", undefined]]);
    await settled("conv_follow_1");
    expect(followRun(new Request("http://x/"), "conv_follow_1", 3)).toBeTruthy(); // finished runs stay replayable for a while
  });

  it("only stop() stops a run", async () => {
    let aborted = false;
    startRun("u1", "conv_stop_1", async (emit, signal) => {
      await new Promise<void>((r) => signal.addEventListener("abort", () => { aborted = true; r(); }, { once: true }));
      emit({ type: "done", stopped: true, reason: "aborted" });
    });
    expect(() => startRun("u1", "conv_stop_1", async () => {})).toThrow(/busy/);
    expect(stopRun("conv_stop_1")).toBe(true);
    await settled("conv_stop_1");
    expect(aborted).toBe(true);
    expect(stopRun("conv_stop_1")).toBe(false);
  });

  it("turns a run the server lost into a paused reply that offers Continue", async () => {
    const actor = testActor(uid("lost"));
    const conv = await createConversation(actor, "agent");
    await saveSnapshot(actor, conv.id, {
      v: 1, status: "running", mode: "agent", startedAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000, message: "build it", messages: [{ role: "system", content: "s" }, { role: "user", content: "build it" }],
      timeline: [{ kind: "tool", step: { id: "s1_0", name: "bash", args: { command: "npm i" }, status: "running" } }], sources: [], files: [], changed: ["index.html"], used: 1000,
    });
    expect(await recoverInterrupted(actor, conv.id)).toBe(true);
    const msgs = await getMessages(actor, conv.id);
    expect(msgs.at(-1)!.meta).toMatchObject({ reason: "interrupted", continuable: true, changed: ["index.html"] });
    expect(msgs.at(-1)!.meta!.timeline![0]).toMatchObject({ kind: "tool", step: { status: "error" } });
    expect((await loadSnapshot(actor, conv.id))!.status).toBe("paused");
    expect(await recoverInterrupted(actor, conv.id)).toBe(false); // only once
  });
});

describe("projects the agent creates, verifies and delivers", () => {
  it("creates a project when the task needs to run code (asking first under 'ask'), moves the task into it and switches tools", async () => {
    const r = await run([
      { toolCalls: [call("create_project", { name: "friday-landing" })] },
      (req: ChatRequest) => {
        // Now inside the project: code tools, and the code system prompt.
        expect(req.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(["write_file", "bash", "edit_file"]));
        expect(req.tools!.map((t) => t.name)).not.toContain("create_project");
        expect(String(req.messages[0].content)).toContain('Project: "friday-landing"');
        return { toolCalls: [call("write_file", { path: "index.html", content: "<h1>Friday</h1>" })] };
      },
      { content: "Built it." },
    ], { canCreateProject: true, settings: { approval: "ask", permissions: { allow: ["Edit"], deny: [] }, disabledTools: ["verify_project"] } });
    expect(ofType(r.events, "approval").map((e) => e.tool)).toEqual(["create_project"]);
    const made = ofType(r.events, "project")[0].project;
    expect(made.name).toBe("friday-landing");
    expect((await getConversation(r.actor, r.conv.id))!.projectId).toBe(made.id);
    expect(fs.readFileSync(path.join(new LocalSandbox(r.userId, made.id).root, "index.html"), "utf8")).toBe("<h1>Friday</h1>");
    // With verify_project turned off nothing holds the answer back.
    expect(r.provider.requests.length).toBe(3);
    expect(r.messages.at(-1)!.meta!.projectId).toBe(made.id);
    const d = r.messages.at(-1)!.meta!.deliverables!;
    expect(d).toMatchObject({ kind: "project", name: "friday-landing", slug: "friday-landing", projectId: made.id, total: 1 });
    // A project made during the run: rewinding its code goes back to the empty project.
    const { restoreCheckpoint } = await import("@/server/code/checkpoints");
    const sb = new LocalSandbox(r.userId, made.id);
    expect((await restoreCheckpoint(sb, r.messages.at(-1)!.meta!.checkpoint!)).restored).toBe(true);
    expect(fs.existsSync(path.join(sb.root, "index.html"))).toBe(false);
  });

  it("won't finish a fresh build without verifying: it's asked to run verify_project first", async () => {
    const r = await run([
      { toolCalls: [call("create_project", { name: "demo-site" })] },
      { toolCalls: [call("write_file", { path: "index.html", content: "<title>Demo</title><h1>Hi</h1>" })] },
      { content: "All done!" },
      (req: ChatRequest) => {
        expect(String(req.messages.at(-1)!.content)).toMatch(/Call verify_project now/);
        return { toolCalls: [call("verify_project", { skip: ["screenshot"] })] };
      },
      (req: ChatRequest) => {
        const result = req.messages.filter((m) => m.role === "tool").at(-1)!.content;
        expect(result).toMatch(/verify_project: PASSED/);
        expect(result).toMatch(/GET \/ → 200 “Demo”/);
        return { content: "Built and verified." };
      },
    ], { canCreateProject: true });
    expect(r.messages.at(-1)!.content).toBe("Built and verified.");
    expect(r.messages.at(-1)!.meta!.deliverables).toMatchObject({ verified: true });
    // The first "All done!" became commentary.
    expect(r.messages.at(-1)!.meta!.timeline!.some((t) => t.kind === "note" && t.text === "All done!")).toBe(true);
  }, 60_000);

  it("runs as a normal agent task when the server has no sandbox (no create_project tool)", async () => {
    const r = await run([{ content: "Here's an answer." }], { canCreateProject: false });
    expect(r.provider.requests[0].tools!.map((t) => t.name)).not.toContain("create_project");
  });
});

describe("verify_project", () => {
  async function sandboxWith(files: Record<string, string>) {
    const userId = uid("verify");
    const actor = testActor(userId);
    const p = await insertProject(actor, { name: "verify me", repoUrl: null, branch: null });
    const sb = new LocalSandbox(userId, p.id);
    for (const [f, c] of Object.entries(files)) await sb.writeFile(f, c);
    const events: AgentEvent[] = [];
    const ctx = { actor, conversationId: "c", mode: "agent", signal: new AbortController().signal, settings: DEFAULT_AGENT_SETTINGS, provider: new Scripted([]), emit: (e: AgentEvent) => events.push(e), flags: { planMode: false }, stepId: "s1_0", code: { project: p, sandbox: sb, read: new Set(), projectDeny: [], changed: [] } } as unknown as ToolContext;
    return { sb, ctx, events };
  }

  it("builds, tests, starts a Node app and loads its pages; reports failures with the end of their log", async () => {
    const { ctx, sb } = await sandboxWith({
      "package.json": JSON.stringify({ name: "x", scripts: { build: "node build.js", test: "node test.js", start: "node server.js" } }),
      "build.js": "require('fs').mkdirSync('out',{recursive:true}); console.log('built');",
      "test.js": "console.log('1 passing');",
      "server.js": "require('http').createServer((q,s)=>{ if(q.url==='/'){s.writeHead(200,{'content-type':'text/html'});s.end('<title>Home</title><p>Hello</p>')} else {s.writeHead(500);s.end('boom')} }).listen(process.env.PORT,'127.0.0.1')",
    });
    const ok = await verifyProjectTool.run({ skip: ["screenshot", "install"] }, ctx) as { text: string; verify: { passed: boolean } };
    expect(ok.text).toMatch(/PASSED/);
    expect(ok.text).toMatch(/✓ build/);
    expect(ok.text).toMatch(/✓ test/);
    expect(ok.text).toMatch(/GET \/ → 200 “Home”/);
    expect(ok.verify.passed).toBe(true);
    expect(fs.existsSync(path.join(sb.root, ".morphie/logs/verify-build.log"))).toBe(true);
    expect(fs.readFileSync(path.join(sb.root, ".morphie/.gitignore"), "utf8")).toContain("logs/");

    await sb.writeFile("build.js", "console.error('SyntaxError: Unexpected token in src/app.ts:12'); process.exit(2)");
    const bad = await verifyProjectTool.run({ skip: ["screenshot", "install"], paths: ["/", "/broken"] }, ctx) as { text: string; verify: { passed: boolean } };
    expect(bad.verify.passed).toBe(false);
    expect(bad.text).toMatch(/FAILED/);
    expect(bad.text).toMatch(/✗ build: exit code 2[\s\S]*Unexpected token in src\/app.ts:12/);
    expect(bad.text).toMatch(/✗ GET \/broken → 500/);
  }, 60_000);

  const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
  it.skipIf(!fs.existsSync(CHROME))("renders the pages in a headless browser and hands the screenshots to the model", async () => {
    const before = process.env.CHROME_PATH;
    process.env.CHROME_PATH = CHROME;
    try {
      const { ctx, sb } = await sandboxWith({ "index.html": "<title>Shop</title><main><h1>Fresh bread daily</h1><p>Order by 9pm for next-day delivery.</p></main>" });
      const out = await verifyProjectTool.run({}, ctx) as { text: string; images: Array<{ mime: string; data: string }>; verify: { passed: boolean } };
      expect(out.verify.passed).toBe(true);
      expect(out.text).toMatch(/renders \d+ characters of text/);
      expect(out.text).toMatch(/Screenshots: \.morphie\/shots\/home\.png/);
      expect(out.images[0].mime).toBe("image/png");
      expect(Buffer.from(out.images[0].data, "base64").subarray(1, 4).toString()).toBe("PNG");
      expect(fs.existsSync(path.join(sb.root, ".morphie/shots/home.png"))).toBe(true);
    } finally { if (before === undefined) delete process.env.CHROME_PATH; else process.env.CHROME_PATH = before; }
  }, 120_000);

  it("asks once for tests when a project has none", () => {
    const report = { kind: "node", steps: [{ name: "build", command: "npm run build", ok: true, exitCode: 0, ms: 1200, timedOut: false, log: "", tail: "" }], pages: [], screenshots: [], notes: [], noTests: true };
    expect(formatReport(report, { testsNagged: false })).toMatchObject({ passed: false, problems: ["no tests"] });
    expect(formatReport(report, { testsNagged: true }).passed).toBe(true);
  });

  it("the script has no template-literal syntax that would break when written out", () => {
    expect(VERIFY_SCRIPT).not.toMatch(/\$\{/);
    expect(VERIFY_SCRIPT).toContain("@@MORPHIE_VERIFY@@");
  });
});

describe("deliverables", () => {
  it("zips a project under a folder named after it, leaving out dependencies, build output and Morphie's scratch files", async () => {
    const userId = uid("zip");
    const actor = testActor(userId);
    const p = await insertProject(actor, { name: "Friday Landing", repoUrl: null, branch: null });
    const sb = new LocalSandbox(userId, p.id);
    for (const f of ["index.html", "src/app.js", "node_modules/x/index.js", ".git/HEAD", ".morphie/logs/verify-build.log", "dist/app.js"]) await sb.writeFile(f, `// ${f}`);
    const z = await zipProject(sb, p.name);
    expect(z.filename).toBe("friday-landing.zip");
    expect(Object.keys(unzipSync(z.bytes)).sort()).toEqual(["friday-landing/index.html", "friday-landing/src/app.js"]);
    expect(strFromU8(unzipSync(z.bytes)["friday-landing/index.html"])).toBe("// index.html");
  });

  it("names things the way people expect", () => {
    expect(fileSlug("Friday Landing!")).toBe("friday-landing");
    expect(fileSlug("2048 game")).toBe("2048-game");
    expect(isDeliverable(".morphie/verify.mjs")).toBe(false);
    expect(isDeliverable(".morphie/settings.json")).toBe(true);
  });
});

describe("providers", () => {
  it("Anthropic merges neighbouring turns from the same side (tool results + a note, a continued reply)", async () => {
    const mock = await startMock((_r, res) => sse(res, [
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ]));
    try {
      const p = new AnthropicProvider({ apiKey: "ak-1234567", model: "claude-x" });
      (p as any).cfg.baseUrl = mock.url;
      await p.chat({ messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", arguments: {} }] },
        { role: "tool", toolCallId: "t1", name: "x", content: "result" },
        { role: "user", content: "budget note" },
        { role: "assistant", content: "part one" },
        { role: "assistant", content: "part two" },
        { role: "user", content: "next" },
      ] });
      const roles = mock.calls[0].body.messages.map((m: any) => m.role);
      expect(roles).toEqual(["user", "assistant", "user", "assistant", "user"]);
      expect(mock.calls[0].body.messages[2].content.map((b: any) => b.type)).toEqual(["tool_result", "text"]);
      expect(mock.calls[0].body.max_tokens).toBe(16_000);
    } finally { await mock.close(); }
  });

  it("an OpenAI-compatible gateway's usage arrives through the meter", async () => {
    const mock = await startMock((_r, res) => json(res, { choices: [{ message: { content: "hey" } }], usage: { prompt_tokens: 40, completion_tokens: 2, prompt_cache_hit_tokens: 32 } }));
    try {
      const { OpenAICompatProvider } = await import("@/server/providers/openaiCompat");
      const seen: number[] = [];
      const actor = testActor(uid("oa"));
      const p = metered(new OpenAICompatProvider({ kind: "custom", label: "X", baseUrl: mock.url, model: "m" }), { actor, feature: "chat", onUsage: (u) => seen.push(u.input, u.output, u.cached) });
      await p.chat({ messages: [{ role: "user", content: "x" }] });
      expect(seen).toEqual([40, 2, 32]);
    } finally { await mock.close(); }
  });
});

describe("the agent decides how many steps a task takes", () => {
  it("ignores a step limit saved by an older version", async () => {
    const { writeSettingsJson } = await import("@/server/data/settings");
    const { getSettings } = await import("@/server/settings");
    const actor = testActor(uid("oldsteps"));
    await writeSettingsJson(actor, JSON.stringify({ maxSteps: 5, approval: "never" }));
    const s = await getSettings(actor);
    expect(s.maxSteps).toBeUndefined();
    expect(s.approval).toBe("never");
    // Twelve rounds go by without anything forcing an answer.
    const looping: Step[] = Array.from({ length: 12 }, (_, i) => ({ toolCalls: [call("calculator", { expression: `${i} + 1` })] }));
    const r = await run([...looping, { content: "Done after twelve rounds." }], { settings: s });
    expect(r.messages.at(-1)).toMatchObject({ content: "Done after twelve rounds.", meta: { reason: "complete" } });
    expect(r.provider.requests.every((q) => !String(q.messages.at(-1)!.content).includes("step limit"))).toBe(true);
  });

  it("shows the model its own plan again when it stops ticking it off", async () => {
    const plan = { items: [{ text: "Scaffold", status: "active" }, { text: "Build sections", status: "pending" }] };
    const sum = (i: number) => ({ toolCalls: [call("calculator", { expression: `${i} * 2` })] });
    const r = await run([{ toolCalls: [call("update_plan", plan)] }, sum(1), sum(2), sum(3), sum(4), { content: "ok" }]);
    const reminder = r.provider.requests[5].messages.find((m) => m.role === "user" && m.content.startsWith("Reminder (from Morphie"));
    expect(reminder?.content).toContain("1. [active] Scaffold");
    expect(r.provider.requests[4].messages.some((m) => m.content.startsWith("Reminder (from Morphie"))).toBe(false);
  });
});

describe("runs that crash or get lost", () => {
  it("a crash keeps the work as a reply that can be continued", async () => {
    const { failRun } = await import("@/server/agent/recover");
    const actor = testActor(uid("crash"));
    const conv = await createConversation(actor, "agent");
    await saveSnapshot(actor, conv.id, { v: 1, status: "running", mode: "agent", startedAt: Date.now() - 5000, updatedAt: Date.now(), message: "x", messages: [], timeline: [], sources: [], files: [], changed: [], used: 0 });
    await failRun(actor, conv.id, new Error("disk full"));
    const last = (await getMessages(actor, conv.id)).at(-1)!;
    expect(last.meta).toMatchObject({ reason: "error", continuable: true });
    expect(last.content).toContain("disk full");
    expect((await loadSnapshot(actor, conv.id))!.status).toBe("paused");
  });

  it("a run lost moments ago is marked for the page to resume by itself", async () => {
    const actor = testActor(uid("fresh"));
    const conv = await createConversation(actor, "agent");
    await saveSnapshot(actor, conv.id, { v: 1, status: "running", mode: "agent", startedAt: Date.now() - 60_000, updatedAt: Date.now() - 5000, message: "x", messages: [], timeline: [], sources: [], files: [], changed: [], used: 0 });
    await recoverInterrupted(actor, conv.id);
    expect((await getMessages(actor, conv.id)).at(-1)!.meta?.autoResume).toBe(true);
  });
});

describe("Ollama context", () => {
  it("sizes num_ctx to the request for local models and leaves cloud models alone", async () => {
    const { contextFor } = await import("@/server/providers/ollama");
    const req = (chars: number) => ({ messages: [{ role: "user" as const, content: "x".repeat(chars) }] });
    expect(contextFor("qwen3:14b", req(1000))).toBe(8192);
    expect(contextFor("qwen3:14b", req(100_000))).toBe(65_536);
    expect(contextFor("qwen3:14b", req(100_000), 32_768)).toBe(32_768);
    expect(contextFor("nemotron-3-ultra:cloud", req(100_000))).toBeUndefined();
  });
});

describe("ask_user and the activity line", () => {
  const questions = [
    { question: "Who is it for?", header: "Audience", options: [{ label: "Developers" }, { label: "Designers", description: "Visual first" }] },
    { question: "Which stack?", multiSelect: true, options: [{ label: "Next.js" }, { label: "Vite" }, { label: "Plain HTML" }] },
  ];

  it("shows the questions, waits, and hands the answers to the model", async () => {
    const r = await run([{ toolCalls: [call("ask_user", { questions })] }, { content: "Building it for developers with Vite." }], {
      answers: { "Who is it for?": "Developers", "Which stack?": "Vite, Plain HTML" },
      settings: { approval: "always" }, // asking is never an action that needs approval
    });
    expect(ofType(r.events, "approval")).toHaveLength(0);
    const q = ofType(r.events, "question")[0];
    expect(q.questions).toEqual([
      { question: "Who is it for?", header: "Audience", options: [{ label: "Developers" }, { label: "Designers", description: "Visual first" }] },
      { question: "Which stack?", multiSelect: true, options: [{ label: "Next.js" }, { label: "Vite" }, { label: "Plain HTML" }] },
    ]);
    const reply = r.provider.requests[1].messages.find((m) => m.role === "tool")!;
    expect(reply.content).toContain("The user answered:");
    expect(reply.content).toContain("- Which stack?\n  → Vite, Plain HTML");
    expect(ofType(r.events, "tool_end")[0]).toMatchObject({ status: "done", summary: "2 answered" });
    expect(r.messages.at(-1)!.content).toBe("Building it for developers with Vite.");
  });

  it("skipping tells the model to use defaults", async () => {
    const r = await run([{ toolCalls: [call("ask_user", { questions: questions.slice(0, 1) })] }, { content: "ok" }], { answers: null });
    expect(r.provider.requests[1].messages.find((m) => m.role === "tool")!.content).toMatch(/skipped these questions\. Use sensible defaults/);
    expect(ofType(r.events, "tool_end")[0].summary).toBe("Skipped");
  });

  it("rejects malformed questions without bothering the user", async () => {
    const r = await run([{ toolCalls: [call("ask_user", { questions: [{ question: "Pick?", options: [{ label: "only one" }] }] })] }, { content: "ok" }]);
    expect(ofType(r.events, "question")).toHaveLength(0);
    expect(ofType(r.events, "tool_end")[0]).toMatchObject({ status: "error" });
    expect(ofType(r.events, "tool_end")[0].error).toMatch(/needs 2–4 options/);
  });

  it("is offered in agent mode only, and never to sub-agents", async () => {
    const { toolsFor } = await import("@/server/tools");
    expect(toolsFor("agent", DEFAULT_AGENT_SETTINGS, { hasDocuments: false }).some((t) => t.name === "ask_user")).toBe(true);
    expect(toolsFor("chat", DEFAULT_AGENT_SETTINGS, { hasDocuments: false }).some((t) => t.name === "ask_user")).toBe(false);
    const src = fs.readFileSync(path.join(process.cwd(), "src/server/tools/task.ts"), "utf8");
    expect(src).toContain('t.name !== "ask_user"');
  });

  it("says what it's doing before each model call", async () => {
    const r = await run([{ toolCalls: [call("calculator", { expression: "1+1" })] }, { content: "2" }]);
    expect(ofType(r.events, "activity").map((e) => e.text)).toEqual(["Thinking", "Reading the results"]);
  });

  it("describes a tool call from its half-streamed arguments, at most a few times a second", async () => {
    const { describeActivity, partialField, throttledActivity } = await import("@/server/agent/activity");
    expect(partialField('{"path":"src/app/pa', "path")).toBe("src/app/pa");
    expect(partialField('{"command":"echo \\"hi', "command")).toBe('echo "hi');
    expect(describeActivity("write_file", '{"path":"src/app/page.tsx","content":"exp')).toBe("Writing src/app/page.tsx");
    expect(describeActivity("bash", '{"command":"npm install\\nnpm test"}')).toBe("Preparing: npm install");
    expect(describeActivity("edit_file", "{")).toBe("Editing a file");
    expect(describeActivity("some_tool", "{}")).toBe("Preparing some tool");
    let t = 0;
    const seen: Array<[string, number]> = [];
    const on = throttledActivity((text, chars) => seen.push([text, chars]), 250, () => t);
    on({ index: 0, name: "write_file", args: '{"path":"a.ts"' });
    t = 100; on({ index: 0, name: "write_file", args: '{"path":"a.ts","content":"xx' });
    t = 300; on({ index: 0, name: "write_file", args: '{"path":"a.ts","content":"xxxx' });
    t = 310; on({ index: 1, name: "bash", args: '{"command":"ls' });
    expect(seen).toEqual([["Writing a.ts", 14], ["Writing a.ts", 30], ["Preparing: ls", 14]]);
  });

  it("keeps only the latest activity for replay", async () => {
    const convId = uid("act");
    startRun("u_act", convId, async (emit) => {
      emit({ type: "activity", text: "Thinking" });
      emit({ type: "activity", text: "Writing a.ts", chars: 10 });
      emit({ type: "note", text: "hi" });
      emit({ type: "activity", text: "Reading the results" });
      emit({ type: "done" });
    });
    await settled(convId);
    const text = await followRun(new Request("http://x/"), convId, 0)!.text();
    const replay = text.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)) as AgentEvent & { seq: number });
    expect(replay.filter((e) => e.type === "activity").map((e) => (e as { text: string }).text)).toEqual(["Writing a.ts", "Reading the results"]);
    expect(replay.map((e) => e.seq)).toEqual([...replay.map((e) => e.seq)].sort((a, b) => a - b));
  });
});
