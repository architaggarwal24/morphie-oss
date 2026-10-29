// @vitest-environment jsdom
/**
 * The UX details layered on top of the main flows (tests/ui.test.tsx): shortcuts, skeletons, revalidation,
 * optimistic switching, undo toasts, interruptible popovers, view transitions, idempotent retries.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/components/App";
import { useDesign } from "@/lib/designStore";
import { ariaShortcut, isTypingTarget, matches, shortcutKeys, shortcutLabel, SHORTCUTS } from "@/lib/shortcuts";
import { useStore } from "@/lib/store";

const initialStore = useStore.getInitialState();
const initialDesign = useDesign.getInitialState();

beforeAll(async () => {
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
});

const profile = (over = {}) => ({ id: "p1", kind: "custom", label: "Gateway", model: "gw-1", baseUrl: "https://gw.example/v1", hasKey: true, keyHint: "••••1234", options: {}, updatedAt: 1, ...over });
const bootData = (over: Record<string, unknown> = {}) => ({
  version: "2.0.0", methods: { email: true, google: false, github: false },
  session: { user: { email: "ada@example.com", displayName: "Ada" }, expiresAt: Date.now() + 86_400_000, idleExpiresAt: Date.now() + 86_400_000 },
  catalog: [], customPresets: [], profiles: [profile()], activeId: "p1",
  settings: { maxSteps: 15, approval: "ask", alwaysAllow: [], disabledTools: [], memory: true }, tools: [],
  search: { user: false, server: false }, conversations: [], server: { allowPrivateUrls: true, maxUploadMb: 10, maxAgentSteps: 30 }, ...over,
});
const isGet = (init: RequestInit) => !init.method || init.method === "GET";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;
let handlers: Handler[] = [];
let calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];

beforeEach(async () => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", RO);
  calls = [];
  handlers = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: any = init.body;
    try { if (typeof body === "string") body = JSON.parse(body); } catch { /* keep */ }
    calls.push({ url, method: init.method ?? "GET", body, headers: { ...(init.headers as Record<string, string> | undefined) } });
    for (const h of handlers) { const r = await h(url, init); if (r) return r; }
    if (url === "/api/design" && isGet(init)) return json({ designs: [], themes: [] });
    if (url.startsWith("/api/workspace")) return json({ files: [] });
    if (url.startsWith("/api/conversations") && isGet(init)) return json({ conversations: [] });
    if (url === "/api/documents" && isGet(init)) return json({ documents: [] });
    if (url === "/api/memory" && isGet(init)) return json({ memories: [] });
    return json({ error: `unmocked ${init.method ?? "GET"} ${url}` }, 404);
  }));
  useStore.setState(initialStore, true);
  useDesign.setState(initialDesign, true);
  localStorage.clear();
});
afterEach(async () => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const withBoot = (data: object) => handlers.unshift((url) => (url === "/api/bootstrap" ? json(data) : undefined));
const nav = async (name: string) => (await screen.findAllByRole("button", { name }))[0];
const designState = (history: Partial<{ canUndo: boolean; canRedo: boolean }> = {}) => ({
  id: "d1", name: "Acme", previewHtml: "<p>Acme</p>", updatedAt: 1, versions: [],
  design: { name: "Acme", theme: { background: "#fff" }, typography: { heading: "Inter", body: "Inter", scale: "normal" }, layout: { max_width: "1200px", spacing: "comfortable" }, style: { radius: "sm", shadow: "none" }, responsive: { tablet_columns: 2, mobile_columns: 1, mobile_nav: "collapse" }, sections: [] },
  history: { version: 2, position: 2, total: 2, canUndo: true, canRedo: false, revision: 2, ...history },
});

// ───────────────────────────────────────────────────────────────────────────────────────────── 4. shortcut hints
describe("shortcut hints", () => {
  it("label the modifier ⌘ on Apple platforms and Ctrl elsewhere", async () => {
    expect(shortcutKeys(SHORTCUTS.palette, true)).toEqual(["⌘", "K"]);
    expect(shortcutKeys(SHORTCUTS.palette, false)).toEqual(["Ctrl", "K"]);
    expect(shortcutLabel(SHORTCUTS.redo, true)).toBe("⌘⇧Z");
    expect(shortcutLabel(SHORTCUTS.redo, false)).toBe("Ctrl+Shift+Z");
    expect(ariaShortcut(SHORTCUTS.undo, true)).toBe("Meta+Z");
    expect(ariaShortcut(SHORTCUTS.undo, false)).toBe("Control+Z");
  });

  it("match only the platform's own modifier, and Shift must agree", async () => {
    const e = (o: Partial<KeyboardEvent>) => ({ key: "z", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
    expect(matches(e({ metaKey: true }), SHORTCUTS.undo, true)).toBe(true);
    expect(matches(e({ ctrlKey: true }), SHORTCUTS.undo, true)).toBe(false);
    expect(matches(e({ ctrlKey: true }), SHORTCUTS.undo, false)).toBe(true);
    expect(matches(e({ ctrlKey: true, shiftKey: true }), SHORTCUTS.undo, false)).toBe(false);
    expect(matches(e({ ctrlKey: true, shiftKey: true, key: "Z" }), SHORTCUTS.redo, false)).toBe(true);
  });

  it("know when someone is typing", async () => {
    const text = document.createElement("input");
    const box = document.createElement("input"); box.type = "checkbox";
    const area = document.createElement("textarea");
    const editable = document.createElement("div"); editable.contentEditable = "true";
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect([text, area, editable].map(isTypingTarget)).toEqual([true, true, true]);
    expect([box, document.createElement("button"), null].map(isTypingTarget)).toEqual([false, false, false]);
  });

  it("design Undo/Redo show their shortcut in the tooltip, and Ctrl+Z undoes the design but not while typing in a field", async () => {
    const user = userEvent.setup();
    withBoot(bootData());
    handlers.push(
      (url) => (url === "/api/design" ? json({ designs: [{ id: "d1", name: "Acme", updatedAt: 1, version: 2, versions: 2 }], themes: [] }) : undefined),
      (url) => (url === "/api/design/d1" ? json({ state: designState() }) : undefined),
      (url, init) => (url === "/api/design/d1/undo" && init.method === "POST" ? json({ state: designState({ canUndo: false, canRedo: true }) }) : undefined),
    );
    render(<App />);
    await user.click(await nav("Design"));
    await act(async () => { await useDesign.getState().open("d1"); });
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(undo.getAttribute("data-tooltip")).toMatch(/^Undo \((⌘Z|Ctrl\+Z)\)$/);
    expect(undo.getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+Z$/);
    expect(screen.getByRole("button", { name: "Redo" }).getAttribute("data-tooltip")).toMatch(/^Redo \((⌘⇧Z|Ctrl\+Shift\+Z)\)$/);

    const mod = navigator.platform.includes("Mac") ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(screen.getByLabelText("Design instruction"), { key: "z", ...mod }); // typing: the field's own undo
    expect(calls.some((c) => c.url === "/api/design/d1/undo")).toBe(false);
    fireEvent.keyDown(document.body, { key: "z", ...mod });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/design/d1/undo")).toBe(true));
  });

  it("the command palette lists every Settings page, the System theme, recent chats, and draws shortcuts as keys", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ conversations: [{ id: "c9", title: "Quarterly numbers", mode: "chat", pinned: false, createdAt: 1, updatedAt: 1 }] }));
    handlers.push((url) => (url === "/api/conversations/c9" ? json({ messages: [] }) : undefined));
    render(<App />);
    await screen.findByLabelText("Message");
    await user.click(screen.getByRole("button", { name: "Search and commands" }));
    const box = await screen.findByRole("combobox", { name: "Search commands" });
    const list = screen.getByRole("listbox", { name: "Commands" });
    for (const name of ["Settings: Account", "Settings: Providers", "Settings: Tools", "Settings: Data & privacy", "System theme", "Quarterly numbers"]) {
      expect(within(list).getByText(name)).toBeTruthy();
    }
    await user.keyboard("{ArrowDown}");
    expect(box.getAttribute("aria-activedescendant")).toBe(within(list).getAllByRole("option")[1].id);
    await user.type(box, "quarterly");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(useStore.getState().activeConv.chat).toBe("c9"));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────── 1. skeleton loaders
import { renderHook } from "@testing-library/react";
import { useDelayedFlag } from "@/components/ui";

/** A response the test releases by hand. */
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("skeleton loaders", () => {
  it("only appear once loading has taken longer than 300ms", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on), { initialProps: { on: true } });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(299); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
  });

  it("a slow document list shows rows of gray blocks, then the real rows in the same list shape", async () => {
    const user = userEvent.setup();
    withBoot(bootData());
    const slow = deferred();
    handlers.push((url, init) => (url === "/api/documents" && isGet(init) ? slow.promise : undefined));
    render(<App />);
    await user.click(await nav("Documents"));
    expect(screen.queryByRole("list", { name: "Loading documents" })).toBeNull();          // not in the first 300ms
    const skeleton = await screen.findByRole("list", { name: "Loading documents" });
    expect(skeleton.querySelectorAll("li")).toHaveLength(3);
    expect(skeleton.closest("[aria-busy=true]")).toBeTruthy();
    await act(async () => { slow.resolve(json({ documents: [{ id: "x", name: "notes.md", kind: "md", size: 2048, chunkCount: 2, createdAt: Date.now() }] })); });
    expect(await screen.findByText("notes.md")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Loading documents" })).toBeNull();
    expect(screen.getByRole("list", { name: "Uploaded documents" }).className).toBe(skeleton.className); // same list frame: nothing jumps
  });

  it("opening a conversation never flashes the empty-chat hero while its history loads, and a failed load offers a retry", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ conversations: [{ id: "c1", title: "Old chat", mode: "chat", pinned: false, createdAt: 1, updatedAt: Date.now() }] }));
    let fail = true;
    const slow = deferred();
    handlers.push((url) => (url === "/api/conversations/c1" ? (fail ? json({ error: "Database is busy." }, 500) : slow.promise) : undefined));
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Old chat/ }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/think through/)).toBeNull();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByText(/think through/)).toBeNull();
    expect(await screen.findByLabelText("Loading conversation")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("Loading conversation").children.length).toBeGreaterThan(0), { timeout: 1000 });
    await act(async () => { slow.resolve(json({ messages: [{ id: 1, role: "user", content: "earlier question", createdAt: 1 }] })); });
    expect(await screen.findByText("earlier question")).toBeTruthy();
    expect(screen.queryByLabelText("Loading conversation")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────── 6. stale-while-revalidate
import { onRevalidate } from "@/lib/revalidate";

describe("stale-while-revalidate", () => {
  it("revisiting Documents shows the cached list instantly and refreshes it in the background", async () => {
    const user = userEvent.setup();
    withBoot(bootData());
    const doc = (name: string) => ({ id: name, name, kind: "md", size: 10, chunkCount: 1, createdAt: Date.now() });
    let second: ReturnType<typeof deferred> | null = null;
    let n = 0;
    handlers.push((url, init) => {
      if (url !== "/api/documents" || !isGet(init)) return undefined;
      n += 1;
      if (n === 1) return json({ documents: [doc("first.md")] });
      second = deferred();
      return second.promise;
    });
    render(<App />);
    await user.click(await nav("Documents"));
    expect(await screen.findByText("first.md")).toBeTruthy();
    await user.click(await nav("Memory"));
    await user.click(await nav("Documents"));
    expect(screen.getByText("first.md")).toBeTruthy();                 // cached: no loading state at all
    expect(screen.queryByLabelText("Loading documents")).toBeNull();
    await waitFor(() => expect(n).toBe(2));                            // ...while it refetches
    await act(async () => { second!.resolve(json({ documents: [doc("first.md"), doc("second.md")] })); });
    expect(await screen.findByText("second.md")).toBeTruthy();
  });

  it("focus and coming back online refresh the conversation list (keeping the search) and the open history", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ conversations: [{ id: "c1", title: "Old chat", mode: "chat", pinned: false, createdAt: 1, updatedAt: Date.now() }] }));
    handlers.push((url) => (url === "/api/conversations/c1" ? json({ messages: [] }) : undefined));
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Old chat/ }));
    await act(async () => { await useStore.getState().refreshConversations("old"); });
    const before = calls.length;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(calls.slice(before).map((c) => c.url)).toEqual(expect.arrayContaining(["/api/conversations?q=old", "/api/conversations/c1"])));
    expect(calls.slice(before).filter((c) => c.url === "/api/conversations/c1")).toHaveLength(1);
  });

  it("folds focus + visibilitychange (which arrive together) into one refresh, and also fires when the network returns", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const stop = onRevalidate(fn);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2500);
    window.dispatchEvent(new Event("online"));
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(2500);
    window.dispatchEvent(new Event("focus"));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────── 2. optimistic updates
describe("optimistic updates", () => {
  const two = { profiles: [profile(), profile({ id: "p2", label: "Backup", model: "bk-2" })], activeId: "p1" };

  it("switching provider in the composer shows the new model before the server answers", async () => {
    const user = userEvent.setup();
    withBoot(bootData(two));
    const slow = deferred();
    handlers.push((url) => (url === "/api/providers/p2/activate" ? slow.promise : undefined));
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Gateway/ }));
    await user.click(screen.getByRole("option", { name: /Backup/ }));
    expect(screen.getByRole("button", { name: /Backup/ })).toBeTruthy();       // already switched
    await act(async () => { slow.resolve(json({ profiles: two.profiles, activeId: "p2" })); });
    expect(useStore.getState().activeId).toBe("p2");
  });

  it("rolls back and explains when the switch fails", async () => {
    const user = userEvent.setup();
    withBoot(bootData(two));
    handlers.push((url) => (url === "/api/providers/p2/activate" ? json({ error: "That provider was removed." }, 404) : undefined));
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Gateway/ }));
    await user.click(screen.getByRole("option", { name: /Backup/ }));
    expect(await screen.findByText("That provider was removed.")).toBeTruthy();
    expect(useStore.getState().activeId).toBe("p1");
    expect(screen.getByRole("button", { name: /Gateway/ })).toBeTruthy();
  });

  it("pin and rename change the sidebar at once and undo themselves on failure", async () => {
    withBoot(bootData({ conversations: [{ id: "c1", title: "Plans", mode: "chat", pinned: false, createdAt: 1, updatedAt: Date.now() }] }));
    handlers.push((url, init) => (url === "/api/conversations/c1" && init.method === "PATCH" ? json({ error: "Offline." }, 503) : undefined));
    render(<App />);
    await screen.findByRole("button", { name: /Plans/ });
    let p!: Promise<void>;
    act(() => { p = useStore.getState().pinConversation("c1", true); });
    expect(useStore.getState().conversations[0].pinned).toBe(true);
    await act(async () => { await p; });
    expect(useStore.getState().conversations[0].pinned).toBe(false);
    act(() => { p = useStore.getState().renameConversation("c1", "Better plans"); });
    expect(useStore.getState().conversations[0].title).toBe("Better plans");
    await act(async () => { await p; });
    expect(useStore.getState().conversations[0].title).toBe("Plans");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────── 5. undo toasts
import { UNDO_MS } from "@/lib/store";

describe("undo toasts", () => {
  const conv = { id: "c1", title: "Plans", mode: "chat", pinned: false, createdAt: 1, updatedAt: Date.now() };
  const deletes = () => calls.filter((c) => c.method === "DELETE");

  it("delete happens at once with no dialog; Undo brings it back and nothing is ever sent", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ conversations: [conv] }));
    render(<App />);
    await screen.findByRole("button", { name: /Plans/ });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Plans/ })).toBeNull();
    const toast = screen.getByText("Deleted “Plans”.").closest("[role=status]") as HTMLElement;
    expect(toast).toBeTruthy();
    await user.click(within(toast).getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: /Plans/ })).toBeTruthy();
    expect(deletes()).toEqual([]);
  });

  it("closing the toast sends the delete right away; a failed delete puts the item back and says why", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ conversations: [conv] }));
    let ok = false;
    handlers.push((url, init) => (url === "/api/conversations/c1" && init.method === "DELETE" ? (ok ? json({ ok: true }) : json({ error: "Database is busy." }, 503)) : undefined));
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByText("Deleted “Plans”.").closest("[role=status]") as HTMLElement).getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Couldn't delete: Database is busy.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Plans/ })).toBeTruthy();

    ok = true;
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByText("Deleted “Plans”.").closest("[role=status]") as HTMLElement).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(deletes()).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /Plans/ })).toBeNull();
    expect(useStore.getState().conversations).toEqual([]);
  });

  it("without Undo the request goes after the window; leaving the page sends pending deletes with keepalive", async () => {
    vi.useFakeTimers();
    useStore.setState({ session: bootData().session as never, conversations: [conv as never, { ...conv, id: "c2", title: "Other" } as never] });
    act(() => { void useStore.getState().deleteConversation("c1"); });
    expect(useStore.getState().hidden["conv:c1"]).toBe(true);
    await act(async () => { vi.advanceTimersByTime(UNDO_MS - 1); });
    expect(deletes()).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(deletes().map((c) => c.url)).toEqual(["/api/conversations/c1"]);

    act(() => { void useStore.getState().deleteConversation("c2"); });
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    const last = (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.at(-1)!;
    expect(last[0]).toBe("/api/conversations/c2");
    expect(last[1].keepalive).toBe(true);
  });

  it("a background refresh during the Undo window doesn't bring the item back", async () => {
    const user = userEvent.setup();
    withBoot(bootData());
    handlers.push((url, init) => (url === "/api/documents" && isGet(init) ? json({ documents: [{ id: "d1", name: "notes.md", kind: "md", size: 1, chunkCount: 1, createdAt: Date.now() }] }) : undefined));
    render(<App />);
    await user.click(await nav("Documents"));
    await user.click(await screen.findByRole("button", { name: "Delete notes.md" }));
    expect(screen.queryByText("notes.md")).toBeNull();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/documents").length).toBe(2));
    expect(screen.queryByText("notes.md")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Undo" }));       // and Undo still restores it
    expect(await screen.findByText("notes.md")).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────── 11. interruptible animations
describe("interruptible menus", () => {
  it("the provider menu stays mounted: closing hides and disables it instead of removing it, so a reopen reverses in place", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile(), profile({ id: "p2", label: "Backup", model: "bk-2" })] }));
    render(<App />);
    const chip = await screen.findByRole("button", { name: /Gateway/ });
    const menu = document.querySelector('[aria-label="Switch provider"]') as HTMLElement;
    expect(menu.hidden).toBe(true);
    expect(menu.hasAttribute("inert")).toBe(true); // a closing menu never catches clicks meant for the page
    await user.click(chip);
    expect(document.querySelector('[aria-label="Switch provider"]')).toBe(menu);
    expect(menu.hidden).toBe(false);
    expect(menu.className).toContain("pop");
    expect(menu.className).not.toContain("animate-");
    await user.click(chip);
    expect(menu.hidden).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────── 9. view transitions
describe("view transitions", () => {
  const setReducedMotion = (on: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches: on && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));

  it("a tab switch runs inside startViewTransition, with exactly one sliding active pill per bar", async () => {
    const user = userEvent.setup();
    setReducedMotion(false);
    const start = vi.fn((cb: () => void) => { cb(); return {}; });
    (document as unknown as { startViewTransition?: unknown }).startViewTransition = start;
    try {
      withBoot(bootData());
      render(<App />);
      await user.click(await nav("Memory"));
      expect(start).toHaveBeenCalledTimes(1);
      expect(await screen.findByRole("heading", { name: "Memory" })).toBeTruthy();
      const navs = screen.getAllByRole("navigation", { name: "Primary" });
      expect(navs.map((n) => n.querySelectorAll("[data-tab-marker]").length)).toEqual([1, 1]);
      for (const n of navs) expect(n.querySelector("[data-tab-marker]")!.closest("button")!.textContent).toContain("Memory");
      await user.click(await nav("Memory"));                         // same tab again: nothing to animate
      expect(start).toHaveBeenCalledTimes(1);
    } finally { delete (document as unknown as { startViewTransition?: unknown }).startViewTransition; }
  });

  it("with reduced motion the switch is instant and no transition starts", async () => {
    const user = userEvent.setup();
    setReducedMotion(true);
    const start = vi.fn();
    (document as unknown as { startViewTransition?: unknown }).startViewTransition = start;
    try {
      withBoot(bootData());
      render(<App />);
      await user.click(await nav("Memory"));
      expect(await screen.findByRole("heading", { name: "Memory" })).toBeTruthy();
      expect(start).not.toHaveBeenCalled();
    } finally { delete (document as unknown as { startViewTransition?: unknown }).startViewTransition; }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────── 19. idempotency keys
import { api, newIdempotencyKey, RETRY_DELAYS_MS } from "@/lib/api";

describe("idempotency keys (client)", () => {
  it("a keyed request that loses its connection is retried with the same key; an unkeyed one is not", async () => {
    let n = 0;
    handlers.push((url) => {
      if (url !== "/api/memory/x") return undefined;
      n += 1;
      if (n < 3) throw new TypeError("Failed to fetch");
      return json({ ok: true });
    });
    vi.useFakeTimers();
    const key = newIdempotencyKey();
    const p = api("/api/memory/x", { method: "POST", body: { a: 1 }, idempotencyKey: key });
    for (const d of RETRY_DELAYS_MS) await act(async () => { await vi.advanceTimersByTimeAsync(d); });
    expect(await p).toEqual({ ok: true });
    const tries = calls.filter((c) => c.url === "/api/memory/x");
    expect(tries).toHaveLength(3);
    expect(new Set(tries.map((c) => c.headers["idempotency-key"]))).toEqual(new Set([key]));

    n = 0;
    await expect(api("/api/memory/x", { method: "POST", body: { a: 1 } })).rejects.toMatchObject({ code: "network" });
    expect(n).toBe(1);
  });

  it("each send and each Add carries its own fresh key; Add is disabled while it runs", async () => {
    const user = userEvent.setup();
    withBoot(bootData());
    const slow = deferred();
    handlers.push((url, init) => (url === "/api/memory" && init.method === "POST" ? slow.promise : undefined));
    render(<App />);
    await user.click(await nav("Memory"));
    await user.type(await screen.findByLabelText("New memory"), "I prefer short answers");
    await user.click(screen.getByRole("button", { name: /Add/ }));
    expect((screen.getByRole("button", { name: /Add/ }) as HTMLButtonElement).disabled).toBe(true);
    const post = calls.find((c) => c.url === "/api/memory" && c.method === "POST")!;
    expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{32,36}$/);
    await act(async () => { slow.resolve(json({ memories: [] })); });
    expect(newIdempotencyKey()).not.toBe(post.headers["idempotency-key"]);
  });
});
