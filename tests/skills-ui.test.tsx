// @vitest-environment jsdom
/** Settings → Skills, the agent's slash menu, and the Design agent's skills chip. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/chat/Composer";
import { SkillsSection } from "@/components/settings/SkillsSection";
import { useDesign } from "@/lib/designStore";
import { useStore } from "@/lib/store";
import { DEFAULT_AGENT_SETTINGS, type SkillLibraryEntry, type SkillSummary } from "@/lib/types";

const initialStore = useStore.getInitialState();
const initialDesign = useDesign.getInitialState();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const skill = (over: Partial<SkillSummary>): SkillSummary => ({
  id: `builtin:${over.name}`, name: "x", description: "Does x.", scope: "agent", source: "builtin", manual: false, enabled: true, pinned: false, files: 0, editable: false, ...over,
});
const SKILLS = [
  skill({ name: "tdd-loop", description: "Write a failing test first, then the code." }),
  skill({ name: "frontend-aesthetics", description: "Distinctive, polished UI.", scope: "both" }),
  skill({ id: "s_1", name: "brand-voice", description: "Our tone.", source: "upload", editable: true }),
];
const LIB: SkillLibraryEntry[] = [
  { name: "systematic-debugging", repo: "obra/superpowers", summary: "Find the root cause before fixing.", scope: "agent", license: "MIT", category: "Engineering", installs: "40K", installed: false },
];

let calls: Array<{ url: string; method: string; body: any }> = [];
let routes: Array<(url: string, method: string, body: any) => Response | undefined> = [];

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
});

beforeEach(() => {
  calls = [];
  routes = [];
  class RO { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    let body: any = init.body;
    try { if (typeof body === "string") body = JSON.parse(body); } catch { /* keep */ }
    calls.push({ url, method, body });
    for (const r of routes) { const res = r(url, method, body); if (res) return res; }
    if (url === "/api/skills" && method === "GET") return json({ skills: SKILLS, library: LIB });
    if (url === "/api/settings" && method === "PUT") return json({ ...useStore.getState().settings, ...body });
    return json({ error: `unmocked ${method} ${url}` }, 404);
  }));
  useStore.setState(initialStore, true);
  useDesign.setState(initialDesign, true);
  useStore.setState({ settings: { ...DEFAULT_AGENT_SETTINGS }, session: { user: { email: "ada@example.com", displayName: "Ada" }, expiresAt: Date.now() + 86_400_000, idleExpiresAt: Date.now() + 86_400_000 } as never });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Settings → Skills", () => {
  it("lists built-in and installed skills, and switches or pins one through settings", async () => {
    render(<SkillsSection />);
    await screen.findByText("tdd-loop");
    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.getByText("Built-in")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Use tdd-loop" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/settings" && c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.url === "/api/settings")!.body.skills).toEqual({ disabled: ["tdd-loop"], pinned: [] });
    fireEvent.click(screen.getByRole("button", { name: "Always use frontend-aesthetics" }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/settings")).toHaveLength(2));
    expect(calls.filter((c) => c.url === "/api/settings")[1].body.skills.pinned).toEqual(["frontend-aesthetics"]);
    // Only skills you added can be deleted.
    expect(screen.queryByRole("button", { name: "Delete tdd-loop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete brand-voice" })).toBeTruthy();
  });

  it("searches, and installs from the library", async () => {
    routes.push((url, method, body) => (url === "/api/skills" && method === "POST" && body.from === "library"
      ? json({ skills: [...SKILLS, skill({ id: "s_2", name: "systematic-debugging", source: "github" })], library: [{ ...LIB[0], installed: true }], installed: ["systematic-debugging"] })
      : undefined));
    render(<SkillsSection />);
    await screen.findByText("tdd-loop");
    fireEvent.change(screen.getByLabelText("Search skills"), { target: { value: "brand" } });
    expect(screen.queryByText("tdd-loop")).toBeNull();
    expect(screen.getByText("brand-voice")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search skills"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: /Library/ }));
    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(screen.getByText("40K")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Install" })); });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ from: "library", name: "systematic-debugging" });
    await screen.findByText("Installed");
  });

  it("adds from a GitHub repository: lists what it found, then installs the picked ones", async () => {
    routes.push((url, method, body) => {
      if (url !== "/api/skills" || method !== "POST") return undefined;
      if (!body.pick) return json({ choices: [{ path: "skills/a", name: "alpha", description: "A." }, { path: "skills/b", name: "beta", description: "B." }] });
      return json({ skills: SKILLS, library: LIB, installed: ["beta"] });
    });
    render(<SkillsSection />);
    await screen.findByText("tdd-loop");
    fireEvent.click(screen.getByRole("button", { name: /Add skill/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("GitHub link"), { target: { value: "acme/skills" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Find skills" })); });
    await within(dialog).findByText("2 skills found");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Install beta" }));
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /Install 1 selected/ })); });
    const posts = calls.filter((c) => c.method === "POST" && c.url === "/api/skills");
    expect(posts.map((p) => p.body)).toEqual([{ from: "github", url: "acme/skills" }, { from: "github", url: "acme/skills", pick: ["skills/b"] }]);
    await waitFor(() => expect(useStore.getState().toasts.some((t) => t.text === "Installed beta.")).toBe(true));
  });
});

describe("skills elsewhere", () => {
  it("the agent's slash menu offers skills (not design-only ones)", async () => {
    useStore.setState({ skills: [...SKILLS, skill({ name: "poster-art", scope: "design" })], drafts: { chat: "", agent: "/" } });
    render(<Composer mode="agent" running={false} onStop={() => {}} focusKey="k" />);
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    const names = within(menu).getAllByRole("option").map((o) => o.querySelector("code")?.textContent);
    expect(names).toContain("/tdd-loop");
    expect(names).toContain("/frontend-aesthetics");
    expect(names).not.toContain("/poster-art");
    expect(within(menu).getAllByText("skill").length).toBeGreaterThanOrEqual(3);
  });

  it("the Design agent's chip lists design skills and remembers the picks", async () => {
    const { DesignView } = await import("@/components/design/DesignView");
    useStore.setState({ skills: SKILLS });
    routes.push((url) => (url === "/api/design" ? json({ designs: [], themes: [] }) : undefined));
    render(<DesignView />);
    const chip = await screen.findByRole("button", { name: /Skills: auto/ });
    fireEvent.click(chip);
    const list = screen.getByRole("listbox", { name: "Design skills" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("frontend-aesthetics")]);
    fireEvent.click(within(options[0]).getByRole("button"));
    expect(useDesign.getState().pickedSkills).toEqual(["frontend-aesthetics"]);
    expect(screen.getByRole("button", { name: /Skills · 1/ })).toBeTruthy();
  });
});
