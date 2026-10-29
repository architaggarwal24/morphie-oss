/** Workers Free: agent runs hand over to a fresh invocation every few steps, and stay one run with one reply. */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { DEFAULT_AGENT_SETTINGS, type AgentEvent } from "@/lib/types";
import { runAgent } from "@/server/agent/loop";
import { endSlices, resumeSlices, sliceHook, waitingSlices } from "@/server/agent/slices";
import { createConversation, getMessages } from "@/server/conversations";
import { testActor } from "./helpers/actor";
import { call, Scripted } from "./helpers/scripted";

const g = globalThis as { __morphieRunnerWake?: () => unknown; __morphieFetches?: number };
afterEach(() => { delete g.__morphieRunnerWake; g.__morphieFetches = 0; });

describe("run slices", () => {
  it("is off unless configured and inside the AgentRunner", () => {
    expect(sliceHook("c1", 0)).toBeUndefined();
    expect(sliceHook("c1", 3)).toBeUndefined(); // no runner to wake
    g.__morphieRunnerWake = () => {};
    expect(sliceHook("c1", 3)).toBeTypeOf("function");
  });

  it("an agent run hands over every N steps and still ends as one run, one reply", async () => {
    let wakes = 0;
    // The runner's alarm: a fresh invocation picks the run up.
    g.__morphieRunnerWake = () => { wakes++; setTimeout(() => void resumeSlices(), 5); };
    const actor = testActor(`slices_${Date.now()}_abcdefgh`);
    const conv = await createConversation(actor, "agent");
    const steps = Array.from({ length: 6 }, (_, i) => ({ toolCalls: [call("calculator", { expression: `${i} + 1` })] }));
    const provider = new Scripted([...steps, { content: "All done: 21." }]);
    const events: AgentEvent[] = [];
    await runAgent({
      actor, conversationId: conv.id, mode: "agent", message: "add things up", provider, signal: new AbortController().signal,
      settings: { ...DEFAULT_AGENT_SETTINGS, memory: false, approval: "never" }, emit: (e) => events.push(e), slice: sliceHook(conv.id, 2),
    });
    endSlices(conv.id);
    expect(wakes).toBe(3); // 7 steps, a hand-over before steps 3, 5 and 7
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "complete" });
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    const msgs = await getMessages(actor, conv.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toBe("All done: 21.");
    expect(msgs[1].meta?.timeline?.filter((t) => t.kind === "tool")).toHaveLength(6);
  });

  it("hands over early when the outbound requests add up, and Stop works while waiting", async () => {
    g.__morphieRunnerWake = () => {};
    const hook = sliceHook("c-fetch", 100)!;
    const ac = new AbortController();
    g.__morphieFetches = 0;
    await hook(ac.signal); // step 2: nothing used yet
    g.__morphieFetches = 31;
    const waiting = hook(ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(waitingSlices()).toBe(1);
    ac.abort();
    await waiting; // released by Stop
    endSlices("c-fetch");
    expect(waitingSlices()).toBe(0);
  });
});

describe("the Workers Free config", () => {
  const jsonc = (f: string) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
  it("is wrangler.jsonc without containers, with code projects off and runs in slices", () => {
    const paid = jsonc("wrangler.jsonc");
    const free = jsonc("wrangler.free.jsonc");
    expect(free.containers).toBeUndefined();
    expect(free.vars).toEqual({ ...paid.vars, MORPHIE_SANDBOX: "none", MORPHIE_RUN_SLICE_STEPS: "6" });
    const { containers: _c, vars: _v, ...paidRest } = paid;
    const { vars: _fv, ...freeRest } = free;
    // Same bindings, D1, R2, Durable Objects (MorphieSandbox stays declared so an existing deployment keeps its class).
    expect(freeRest).toEqual(paidRest);
  });

  it("builds the Worker with webpack (Turbopack's duplicated chunks don't fit the free plan's 3 MB)", () => {
    expect(fs.readFileSync("open-next.config.ts", "utf8")).toContain('buildCommand: "npx next build --webpack"');
  });
});
