// @vitest-environment jsdom
/** Settings → Runners and choosing where a new project runs. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectDialog } from "@/components/code/ProjectPicker";
import { RunnersSection, runnerCommands } from "@/components/settings/RunnersSection";
import { useStore } from "@/lib/store";
import type { RunnerView } from "@/lib/types";

const initial = useStore.getInitialState();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let calls: Array<{ url: string; method: string; body: any }> = [];
let routes: Array<(url: string, method: string, body: any) => Response | undefined> = [];
const runner = (over: Partial<RunnerView> = {}): RunnerView => ({ id: "rn_abc123", name: "Laptop", platform: "", createdAt: 1, lastSeenAt: null, online: false, ...over });

beforeAll(() => { Element.prototype.scrollIntoView = () => {}; });
beforeEach(() => {
  calls = []; routes = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    for (const r of routes) { const res = r(url, method, body); if (res) return res; }
    return json({ error: `unmocked ${method} ${url}` }, 404);
  }));
  useStore.setState(initial, true);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Settings → Runners", () => {
  it("adds a runner, shows its start command, and notices when it connects", async () => {
    let online = false;
    routes.push((url, method) => {
      if (url === "/api/runners" && method === "GET") return json({ runners: calls.some((c) => c.method === "POST") ? [runner({ online, platform: online ? "linux x64 · bash" : "" })] : [] });
      if (url === "/api/runners" && method === "POST") return json({ runner: runner(), token: "mr_rnabc123.secretsecretsecretsecret", runners: [runner()] });
      return undefined;
    });
    render(<RunnersSection />);
    await screen.findByText("No runners yet");
    fireEvent.click(screen.getAllByRole("button", { name: /Add runner/ })[0]);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Laptop" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create" })); });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ name: "Laptop" });
    const cmd = await screen.findByTestId("runner-command");
    expect(cmd.textContent).toContain("node morphie-runner.mjs --server http://localhost:3000 --token mr_rnabc123.secretsecretsecretsecret");
    expect(screen.getByTestId("runner-status").textContent).toContain("Waiting for it to connect");
    expect(useStore.getState().code.runners).toHaveLength(1);
    online = true;
    await waitFor(() => expect(screen.getByTestId("runner-status").textContent).toContain("Connected"), { timeout: 5000 });
  });

  it("gives commands for macOS/Linux and Windows", () => {
    const c = runnerCommands("https://m.example", "mr_x.y");
    expect(c.unix).toBe("curl -fsSL https://m.example/morphie-runner.mjs -o morphie-runner.mjs && node morphie-runner.mjs --server https://m.example --token mr_x.y");
    expect(c.windows).toMatch(/^iwr https:\/\/m\.example\/morphie-runner\.mjs -OutFile morphie-runner\.mjs; node /);
  });
});

describe("new project: where it runs", () => {
  it("offers a connected runner or Lite when the server has no sandbox, and sends the choice", async () => {
    useStore.setState({ code: { sandbox: "none", github: false, runners: [runner({ online: true, platform: "darwin arm64 · bash" }), runner({ id: "rn_off999", name: "Old PC" })] } });
    routes.push((url, method) => (url === "/api/projects" && method === "POST" ? json({ project: { id: "p_123456", name: "Site", sandbox: "lite" }, projects: [] }) : undefined));
    render(<NewProjectDialog open onClose={() => {}} />);
    const group = screen.getByRole("radiogroup", { name: "Where it runs" });
    expect(within(group).queryByRole("radio", { name: /This server|Cloud sandbox/ })).toBeNull();
    expect(within(group).getByRole("radio", { name: /Runner · Laptop/ }).getAttribute("aria-checked")).toBe("true");
    expect(within(group).getByRole("radio", { name: /Runner · Old PC/ }).textContent).toContain("Offline");
    fireEvent.click(within(group).getByRole("radio", { name: /Lite/ }));
    expect(screen.queryByLabelText("Repository")).toBeNull(); // Lite can't clone
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create empty project" })); });
    expect(calls.find((c) => c.url === "/api/projects")!.body).toEqual({ sandbox: "lite" });
  });
});
