// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/components/App";
import { useStore } from "@/lib/store";
import { parseDiff } from "@/lib/diff";

const enc = new TextEncoder();
const initialStore = useStore.getInitialState();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function sseResponse() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { ctl = c; } }), { headers: { "content-type": "text/event-stream" } });
  return { response, push: (e: object) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)), close: () => ctl.close() };
}

const project = { id: "proj_abcdef", name: "shop-api", repoUrl: "https://github.com/acme/shop-api", branch: null, createdAt: 1, updatedAt: 1 };
const boot = {
  version: "2.0.0", methods: { email: true, google: false, github: false },
  session: { user: { email: "ada@example.com", displayName: "Ada" }, expiresAt: Date.now() + 86_400_000, idleExpiresAt: Date.now() + 86_400_000 },
  catalog: [], customPresets: [], profiles: [{ id: "p1", kind: "custom", label: "Gateway", model: "gw-1", hasKey: true, options: {}, updatedAt: 1 }], activeId: "p1",
  settings: { maxSteps: 15, approval: "ask", alwaysAllow: [], disabledTools: [], memory: true, permissions: { allow: [], deny: [] } },
  tools: [], search: { user: false, server: false }, conversations: [], server: { allowPrivateUrls: true, maxUploadMb: 10, maxAgentSteps: 30 },
  projects: [project], code: { sandbox: "local", github: true },
};
const DIFF = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n const b = 3;\n";
const changes = { git: true, branch: "main", ahead: 0, files: [{ path: "src/app.ts", status: "M", staged: false, added: 1, removed: 1 }], diff: DIFF, truncated: false };

let calls: Array<{ url: string; method: string; body: any }> = [];
let sse: ReturnType<typeof sseResponse>;

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
});
beforeEach(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", RO);
  calls = [];
  sse = sseResponse();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    let body: any = init.body;
    try { if (typeof body === "string") body = JSON.parse(body); } catch { /* keep */ }
    calls.push({ url, method: init.method ?? "GET", body });
    if (url === "/api/bootstrap") return json(boot);
    if (url === `/api/projects/${project.id}`) return json({ project, commands: [
      { name: "plan", description: "Toggle plan mode", source: "builtin", clientOnly: true },
      { name: "review", description: "Review the uncommitted changes", source: "builtin", argHint: "[focus]" },
      { name: "ship", description: "Ship a release", source: "project" },
    ], memory: null, git: "" });
    if (url === `/api/projects/${project.id}/changes` && init.method !== "POST") return json(changes);
    if (url === `/api/projects/${project.id}/changes`) return json({ changes: { ...changes, files: [{ ...changes.files[0], staged: true }] } });
    if (url.startsWith(`/api/projects/${project.id}/tree`)) return json({ entries: [{ path: "src", type: "dir" }, { path: "package.json", type: "file", size: 20 }] });
    if (url === "/api/chat") return sse.response;
    if (url.startsWith("/api/conversations")) return json({ conversations: [], messages: [] });
    if (url.startsWith("/api/workspace")) return json({ files: [] });
    return json({ error: `unmocked ${url}` }, 404);
  }));
  useStore.setState(initialStore, true);
  localStorage.clear();
  localStorage.setItem("morphie.project", project.id);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openAgent() {
  render(<App />);
  const user = userEvent.setup();
  await act(async () => { await useStore.getState().boot(); });
  act(() => useStore.getState().setTab("agent"));
  await screen.findByText(/build in shop-api/);
  return user;
}

describe("diff parsing", () => {
  it("splits a git diff into files with numbered lines", () => {
    const [f] = parseDiff(DIFF);
    expect(f).toMatchObject({ path: "src/app.ts", added: 1, removed: 1 });
    expect(f.hunks[0].lines.map((l) => [l.kind, l.oldNo ?? null, l.newNo ?? null])).toEqual([["del", 1, null], ["add", null, 1], ["ctx", 2, 2]]);
  });
});

describe("the coding agent UI", () => {
  it("shows the project, its changes as a diff, and accepts a file", async () => {
    const user = await openAgent();
    expect(screen.getAllByText("shop-api").length).toBeGreaterThan(0);
    const panel = await screen.findByRole("complementary", { name: "Project panel" });
    await waitFor(() => expect(within(panel).getAllByText("src/app.ts").length).toBeGreaterThan(0), { timeout: 3000 }).catch((e) => { console.log(panel.textContent?.slice(0, 600)); throw e; });
    expect(within(panel).getByText("const a = 2;")).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: "Accept src/app.ts" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/changes") && c.body.action === "accept" && c.body.path === "src/app.ts")).toBe(true));
    await within(panel).findByLabelText("Accepted");
    await user.click(within(panel).getByRole("tab", { name: /Files/ }));
    await within(panel).findByText("package.json");
  });

  it("offers slash commands, toggles plan mode, and sends the project and plan mode with the task", async () => {
    const user = await openAgent();
    const box = screen.getByRole("combobox", { name: "Task for the agent" });
    await user.type(box, "/");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    expect(within(menu).getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("/review"), expect.stringContaining("/ship")]));
    await user.type(box, "pl");
    await user.keyboard("{Enter}");
    expect(useStore.getState().planMode).toBe(true);
    expect(screen.getByRole("button", { name: /Plan mode/ }).getAttribute("aria-pressed")).toBe("true");

    await user.type(box, "Add input validation");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls.find((c) => c.url === "/api/chat")?.body).toMatchObject({ mode: "agent", message: "Add input validation", projectId: project.id, planMode: true }));

    await act(async () => {
      sse.push({ type: "start", conversationId: "c1", mode: "agent", provider: "Gateway", model: "gw-1" });
      sse.push({ type: "tool_start", step: { id: "s1_0", name: "exit_plan_mode", args: { plan: "1. Validate" }, status: "waiting", needsApproval: true } });
      sse.push({ type: "approval", id: "ap1", stepId: "s1_0", tool: "exit_plan_mode", args: {}, reason: "Approve?", preview: { plan: "## Steps\n1. Validate the **body**" } });
    });
    const card = await screen.findByRole("group", { name: "Plan ready for review" });
    expect(within(card).getByText("Steps")).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Approve plan" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/agent/approve" && c.body.approved === true)).toBe(true));
    await act(async () => {
      sse.push({ type: "tool_end", stepId: "s1_0", status: "done", ms: 5 });
      sse.push({ type: "plan_mode", active: false });
      sse.push({ type: "tool_start", step: { id: "s2_0", name: "edit_file", args: { path: "src/app.ts" }, status: "waiting", needsApproval: true } });
      sse.push({ type: "approval", id: "ap2", stepId: "s2_0", tool: "edit_file", args: { path: "src/app.ts" }, reason: "Edit src/app.ts", preview: { path: "src/app.ts", diff: DIFF, rule: "Edit" } });
    });
    expect(useStore.getState().planMode).toBe(false);
    const edit = await screen.findByRole("group", { name: "Approval needed" });
    expect(within(edit).getByText("Make this change?")).toBeTruthy();
    expect(within(edit).getByText("const a = 2;")).toBeTruthy();
    expect(within(edit).getByText("Edit", { selector: "code" })).toBeTruthy();
    await act(async () => { sse.push({ type: "terminal", stepId: "s3_0", command: "npm test", output: "4 passing", exitCode: 0, ms: 900 }); sse.close(); });
    expect(useStore.getState().terminals[project.id]?.[0]).toMatchObject({ command: "npm test", by: "agent" });
  });

  it("/help opens the guide and /clear starts a new task without sending anything", async () => {
    const user = await openAgent();
    const box = screen.getByRole("combobox", { name: "Task for the agent" });
    await user.type(box, "/help{Escape}");
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "The coding agent" });
    expect(calls.some((c) => c.url === "/api/chat")).toBe(false);
  });
});
