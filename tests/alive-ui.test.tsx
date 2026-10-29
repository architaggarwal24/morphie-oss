// @vitest-environment jsdom
/** The live parts of a run: the activity line, the agent's question card, and away-from-tab notifications. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveMessage } from "@/components/chat/Message";
import { answerText } from "@/components/chat/QuestionCard";
import { getNotifyPrefs, notifyRun, notifyText, setNotifyPrefs } from "@/lib/notify";
import { applyEvent, newRun, type RunState } from "@/lib/runState";
import { useStore } from "@/lib/store";
import type { AgentEvent } from "@/lib/types";

const initialStore = useStore.getInitialState();
const fold = (events: AgentEvent[]) => events.reduce(applyEvent, newRun({ convId: "c1", mode: "agent", userMessage: "go", now: 0 }));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
let calls: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  calls = [];
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    return json({ ok: true });
  }));
  useStore.setState(initialStore, true);
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const asking: AgentEvent[] = [
  { type: "start", conversationId: "c1", mode: "agent", provider: "P", model: "m" },
  { type: "activity", text: "Writing questions for you" },
  { type: "tool_start", step: { id: "s1_0", name: "ask_user", args: {}, status: "running" } },
  { type: "question", id: "q1", stepId: "s1_0", questions: [
    { question: "Who is it for?", header: "Audience", options: [{ label: "Developers" }, { label: "Designers" }] },
    { question: "Which pages?", multiSelect: true, options: [{ label: "Home" }, { label: "Pricing" }, { label: "Blog" }] },
  ] },
];

describe("run state", () => {
  it("a question makes the run wait until its step ends; the activity line clears when a step starts", () => {
    const run = fold(asking);
    expect(run.status).toBe("waiting");
    expect(run.activity).toBeUndefined();
    expect(Object.keys(run.questions)).toEqual(["q1"]);
    expect(run.timeline[0]).toMatchObject({ kind: "tool", step: { status: "waiting" } });
    const after = fold([...asking, { type: "tool_end", stepId: "s1_0", status: "done", ms: 5, summary: "2 answered" }, { type: "activity", text: "Reading the results", chars: 0 }]);
    expect(after.status).toBe("running");
    expect(after.questions).toEqual({});
    expect(after.activity).toEqual({ text: "Reading the results", chars: 0 });
    expect(fold([...asking.slice(0, 2), { type: "text", delta: "Hi" }]).activity).toBeUndefined();
    expect(fold([...asking, { type: "done", reason: "approval_timeout", continuable: true }]).questions).toEqual({});
  });
});

describe("live message", () => {
  const show = (run: RunState) => { useStore.setState({ run }); return render(<LiveMessage run={run} />); };

  it("shows what the agent is doing between steps", () => {
    show(fold([{ type: "start", conversationId: "c1", mode: "agent", provider: "P", model: "m" }, { type: "activity", text: "Writing src/app/page.tsx", chars: 2400 }]));
    const line = screen.getByTestId("activity-line");
    expect(line.textContent).toContain("Writing src/app/page.tsx…");
    expect(line.textContent).toContain("2.4k chars");
  });

  it("hides the activity line while a step shows its own spinner", () => {
    show(fold([
      { type: "start", conversationId: "c1", mode: "agent", provider: "P", model: "m" },
      { type: "tool_start", step: { id: "s1_0", name: "bash", args: { command: "npm test" }, status: "running" } },
      { type: "activity", text: "Preparing: ls" },
    ]));
    expect(screen.queryByTestId("activity-line")).toBeNull();
  });

  it("asks multiple-choice questions and sends the answers (picked options and typed ones)", async () => {
    show(fold(asking));
    expect(screen.getByText("Waiting for your answers")).toBeTruthy();
    expect(screen.getByText("2 quick questions before I start")).toBeTruthy();
    const send = screen.getByRole("button", { name: "Send answers" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Developers" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Home" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Blog" }));
    fireEvent.change(screen.getByLabelText("Other answer: Which pages?"), { target: { value: "Docs" } });
    expect(screen.getByRole("radio", { name: "Developers" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("2/2 answered")).toBeTruthy();
    await act(async () => { fireEvent.click(send); });
    await waitFor(() => expect(calls.find((c) => c.url === "/api/agent/approve")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/agent/approve")!.body).toEqual({ id: "q1", approved: true, answers: { "Who is it for?": "Developers", "Which pages?": "Home, Blog, Docs" } });
    expect(useStore.getState().run!.questions).toEqual({});
    expect(useStore.getState().run!.status).toBe("running");
  });

  it("Skip lets the agent use its judgment", async () => {
    show(fold(asking));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Skip, use your judgment" })); });
    expect(calls.find((c) => c.url === "/api/agent/approve")!.body).toEqual({ id: "q1", approved: false });
  });

  it("joins picked and typed answers", () => {
    expect(answerText(["A", "B"], "  c ")).toBe("A, B, c");
    expect(answerText([], "")).toBe("");
  });
});

describe("notifications", () => {
  it("only fires while the tab is hidden, and marks the tab title until you come back", () => {
    const shown: Array<{ title: string; body?: string }> = [];
    class FakeNotification { static permission = "granted"; onclick: (() => void) | null = null; constructor(title: string, o?: { body?: string }) { shown.push({ title, body: o?.body }); } close() {} }
    vi.stubGlobal("Notification", FakeNotification);
    document.title = "Morphie";
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    expect(notifyRun("done", "Landing page")).toBe(false);
    expect(shown).toEqual([]);
    hidden = true;
    expect(notifyRun("question", "Landing page")).toBe(true);
    expect(shown).toEqual([{ title: "Morphie has a question", body: "“Landing page” is waiting for your answers." }]);
    expect(document.title).toBe("● Morphie");
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.title).toBe("Morphie");
    // Desktop notifications off: nothing shown (the chime and title still work).
    setNotifyPrefs({ desktop: false });
    hidden = true;
    notifyRun("done");
    expect(shown).toHaveLength(1);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });

  it("remembers the settings and words each kind", () => {
    expect(getNotifyPrefs()).toEqual({ sound: true, desktop: true });
    setNotifyPrefs({ sound: false });
    expect(getNotifyPrefs()).toEqual({ sound: false, desktop: true });
    expect(notifyText("done").body).toBe("Your task is done.");
    expect(notifyText("approval", "Fix login").title).toBe("Morphie needs your OK");
  });
});

describe("preview tab", () => {
  const project = { id: "p_abcdef", name: "demo" } as never;
  const status = (over: Record<string, unknown> = {}) => ({ sandbox: "local", staticUrl: "/api/preview/T/index.html", staticRoot: ".", dev: { available: true, command: "npm run dev" }, server: null, shots: [], ...over });

  it("shows the static site in a sandboxed frame without same-origin rights", async () => {
    const { PreviewTab } = await import("@/components/code/PreviewTab");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return json(status({ dev: { available: false, command: null } }));
    }));
    render(<PreviewTab project={project} />);
    const frame = (await screen.findByTitle("App preview")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/api/preview/T/index.html");
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("starts the dev server from the Live view", async () => {
    const { PreviewTab, devServerUrl } = await import("@/components/code/PreviewTab");
    let started = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (init.method === "POST") started = true;
      return json(status({ staticUrl: null, staticRoot: null, server: started ? { status: "starting", port: 4123, command: "npm run dev", log: "> dev", startedAt: 1 } : null }));
    }));
    render(<PreviewTab project={project} />);
    await screen.findByText("Run the app");
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Start dev server/ })); });
    expect(calls.find((c) => c.body?.action === "start")?.url).toBe("/api/projects/p_abcdef/preview");
    await screen.findByText("> dev");
    expect(devServerUrl(4123, "localhost")).toBe("http://127.0.0.1:4123/");
    expect(devServerUrl(4123, "morphie.example.com")).toBeNull();
  });
});

describe("rewind", () => {
  it("rewinds code and conversation, puts the message back in the box, and offers to undo the files", async () => {
    const { RewindDialog } = await import("@/components/chat/RewindDialog");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/rewind")) return json({ ok: true, code: true, conversation: true, prompt: "build the thing", undo: "a".repeat(40) });
      return json({ messages: [], running: false });
    }));
    useStore.setState({ session: { user: { email: "a@b.c" } } as never });
    const onClose = vi.fn();
    render(<RewindDialog target={{ id: 7, content: "build the thing" }} onClose={onClose} convId="c1" mode="agent" hasCheckpoint />);
    expect(screen.getByRole("radio", { name: /Code and conversation/ }).getAttribute("aria-checked")).toBe("true");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Rewind" })); });
    expect(calls.find((c) => c.url === "/api/conversations/c1/rewind")!.body).toEqual({ messageId: 7, code: true, conversation: true });
    expect(onClose).toHaveBeenCalled();
    expect(useStore.getState().drafts.agent).toBe("build the thing");
    const toast = useStore.getState().toasts.at(-1)!;
    expect(toast.text).toBe("Rewound the files and the conversation.");
    await act(async () => { toast.action!.run(); });
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/conversations/c1/rewind").at(-1)!.body).toEqual({ undo: "a".repeat(40) }));
  });

  it("without a checkpoint only the conversation can be rewound", async () => {
    const { RewindDialog } = await import("@/components/chat/RewindDialog");
    render(<RewindDialog target={{ id: 7, content: "x" }} onClose={() => {}} convId="c1" mode="agent" hasCheckpoint={false} />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Conversation only/ }).getAttribute("aria-checked")).toBe("true"));
    expect((screen.getByRole("radio", { name: /Code only/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
