import { describe, expect, it } from "vitest";
import { applyEvent, newRun } from "@/lib/runState";
import type { AgentEvent } from "@/lib/types";

const fold = (events: AgentEvent[]) => events.reduce(applyEvent, newRun({ convId: null, mode: "agent", userMessage: "go", now: 0 }));

describe("applyEvent", () => {
  it("builds a timeline: commentary becomes a note, tools update in place, approvals gate status", async () => {
    const run = fold([
      { type: "start", conversationId: "c1", mode: "agent", provider: "P", model: "m" },
      { type: "step", n: 1, max: 5 },
      { type: "text", delta: "Let me " }, { type: "text", delta: "plan." },
      { type: "note", text: "Let me plan." },
      { type: "plan", items: [{ text: "a", status: "active" }] },
      { type: "tool_start", step: { id: "s1_0", name: "workspace_write", args: { path: "a.md" }, status: "waiting", needsApproval: true } },
      { type: "approval", id: "ap1", stepId: "s1_0", tool: "workspace_write", args: { path: "a.md" }, reason: "Write a.md" },
    ]);
    expect(run).toMatchObject({ convId: "c1", status: "waiting", answer: "", step: { n: 1, max: 5 } });
    expect(run.timeline[0]).toEqual({ kind: "note", text: "Let me plan." });
    expect(Object.keys(run.approvals)).toEqual(["ap1"]);

    const after = [
      { type: "tool_start", step: { id: "s1_0", name: "workspace_write", args: {}, status: "running" } },
      { type: "tool_end", stepId: "s1_0", status: "done", output: "ok", ms: 12, summary: "Created a.md" },
      { type: "text", delta: "Done." },
      { type: "done", reason: "complete" },
    ] as AgentEvent[];
    const final = after.reduce(applyEvent, run);
    expect(final.approvals).toEqual({});
    expect(final.status).toBe("done");
    expect(final.answer).toBe("Done.");
    const tool = final.timeline.filter((t) => t.kind === "tool");
    expect(tool).toHaveLength(1);                      // updated in place, not duplicated
    expect(tool[0]).toMatchObject({ step: { status: "done", ms: 12, summary: "Created a.md" } });
  });

  it("keeps errors sticky, caps reasoning, and ignores unknown steps gracefully", async () => {
    const run = fold([{ type: "error", message: "nope" }, { type: "done", reason: "error" }, { type: "thinking", delta: "x".repeat(20_000) }]);
    expect(run.status).toBe("error");
    expect(run.error).toBe("nope");
    expect(run.reasoning.length).toBe(12_000);
    expect(() => fold([{ type: "tool_end", stepId: "ghost", status: "done", ms: 1 }])).not.toThrow();
  });
});
