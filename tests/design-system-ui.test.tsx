// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/components/App";
import { EditablePreview } from "@/components/design/Preview";
import { useDesign } from "@/lib/designStore";
import { useStore } from "@/lib/store";
import { paletteFromPixels } from "@/lib/palette";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const initialStore = useStore.getInitialState();
const initialDesign = useDesign.getInitialState();
const colors = { background: "#fbf7f1", surface: "#ffffff", primary: "#9a4b1c", secondary: "#3b2a20", accent: "#d4a373", text: "#24170f" };
const systemJson = { name: "Ember & Oak", description: "Warm coffee brand.", colors: { ...colors, success: "#3f7d4e", warning: "#b7791f", danger: "#b4232a", info: "#2b6cb0" }, typography: { heading: "Fraunces", body: "Inter", mono: "JetBrains Mono", scale: "normal", ratio: "1.25" }, shape: { radius: "sm", shadow: "soft" }, layout: { spacing: "comfortable", max_width: "1200px" }, voice: { tone: "Warm", principles: [] }, guidelines: [] };
const view = { id: "sys1", name: "Ember & Oak", updatedAt: 1, source: "prompt", colors, fonts: { heading: "Fraunces", body: "Inter" }, system: systemJson, sourceRef: "", docsHtml: "<!doctype html><title>docs</title>", usedBy: [] };
const boot = {
  version: "2.0.0", methods: { email: true, google: false, github: false },
  session: { user: { email: "ada@example.com", displayName: "Ada" }, expiresAt: Date.now() + 86_400_000, idleExpiresAt: Date.now() + 86_400_000 },
  catalog: [], customPresets: [], profiles: [{ id: "p1", kind: "custom", label: "Gateway", model: "gw-1", hasKey: true, options: {}, updatedAt: 1 }], activeId: "p1",
  settings: { maxSteps: 15, approval: "ask", alwaysAllow: [], disabledTools: [], memory: true, permissions: { allow: [], deny: [] } },
  tools: [], search: { user: false, server: false }, conversations: [], server: { allowPrivateUrls: true, maxUploadMb: 10, maxAgentSteps: 30 }, projects: [], code: { sandbox: "local", github: false },
};
let calls: Array<{ url: string; method: string; body: any }> = [];

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  window.matchMedia ??= ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
});
beforeEach(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", RO);
  calls = [];
  let systems: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    let body: any = init.body;
    try { if (typeof body === "string") body = JSON.parse(body); } catch { /* keep */ }
    calls.push({ url, method: init.method ?? "GET", body });
    if (url === "/api/bootstrap") return json(boot);
    if (url === "/api/design") return json({ designs: [], themes: [], systems, fonts: [{ family: "Fraunces", category: "serif" }, { family: "Inter", category: "sans" }, { family: "JetBrains Mono", category: "mono" }] });
    if (url === "/api/systems" && init.method === "POST") { systems = [view]; return json({ id: "sys1", summary: "A warm system.", notes: [], usedModel: true, system: view, systems }); }
    if (url === "/api/systems/sys1" && init.method === "PATCH") return json({ system: { ...view, system: body.system, name: body.system.name }, systems });
    if (url === "/api/systems/sys1") return json({ system: view });
    return json({ error: `unmocked ${url}` }, 404);
  }));
  useStore.setState(initialStore, true);
  useDesign.setState(initialDesign, true);
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("design systems UI", () => {
  it("creates a system from a description, shows its docs and saves token edits", async () => {
    render(<App />);
    const user = userEvent.setup();
    await act(async () => { await useStore.getState().boot(); });
    act(() => useStore.getState().setTab("design"));
    await user.click(await screen.findByRole("tab", { name: /^Systems/ }));
    await user.type(screen.getByLabelText("Describe the brand"), "A warm coffee roaster");
    await user.click(screen.getByRole("button", { name: /Create system/ }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/systems" && c.method === "POST")?.body).toEqual({ from: "prompt", prompt: "A warm coffee roaster" }));
    expect(await screen.findByTitle("Ember & Oak documentation")).toBeTruthy();
    const hex = screen.getByLabelText("primary hex");
    await user.clear(hex);
    await user.type(hex, "#112233{Enter}");
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body.system.colors.primary).toBe("#112233"), { timeout: 2000 });
  });
});

describe("visual editor messages", () => {
  it("only trusts messages from its own frame, with the right shape", async () => {
    const onEdit = vi.fn(), onScroll = vi.fn();
    render(<EditablePreview html='<script nonce="abc">x</script>' device="desktop" sections={[{ id: "hero", type: "hero" }]} onEdit={onEdit} onSection={() => {}} onScroll={onScroll} />);
    const frame = screen.getByTitle("Design editor") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    const send = (data: unknown, source: unknown = frame.contentWindow) => act(() => { window.dispatchEvent(new MessageEvent("message", { data, source: source as Window })); });
    send({ source: "morphie-editor", type: "edit", section: "hero", path: "title", value: "Hello" });
    expect(onEdit).toHaveBeenCalledWith("hero", "title", "Hello");
    send({ source: "morphie-editor", type: "edit", section: "hero", path: "title", value: "Spoofed" }, window);
    send({ source: "morphie-editor", type: "edit", section: "hero", path: "title", value: "x".repeat(1000) });
    send({ source: "other", type: "edit", section: "hero", path: "title", value: "Nope" });
    expect(onEdit).toHaveBeenCalledTimes(1);
    send({ source: "morphie-editor", type: "select", section: "hero", rect: { x: 0, y: 10, w: 100, h: 50 } });
    expect(await screen.findByRole("toolbar", { name: "hero section" })).toBeTruthy();
    send({ source: "morphie-editor", type: "scroll", y: 120 });
    expect(onScroll).toHaveBeenCalledWith(120);
  });
});

describe("palette extraction", () => {
  it("finds the dominant colours and keeps a small vivid accent", () => {
    const px: number[] = [];
    const add = (r: number, g: number, b: number, n: number) => { for (let i = 0; i < n; i++) px.push(r, g, b, 255); };
    add(250, 248, 245, 7000); add(30, 30, 35, 2500); add(230, 60, 40, 300); add(20, 120, 220, 60);
    const p = paletteFromPixels(new Uint8ClampedArray(px));
    expect(p[0].hex).toBe("#faf8f5");
    expect(p.map((c) => c.hex)).toEqual(expect.arrayContaining(["#1e1e23", "#e63c28", "#1478dc"]));
    expect(p[0].weight).toBeGreaterThan(0.6);
  });
});

