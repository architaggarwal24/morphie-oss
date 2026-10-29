// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/components/App";
import { useDesign } from "@/lib/designStore";
import { useStore } from "@/lib/store";

const enc = new TextEncoder();
const initialStore = useStore.getInitialState();
const initialDesign = useDesign.getInitialState();

beforeAll(async () => {
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  // Radix Select uses pointer capture, which jsdom doesn't implement.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
});

const profile = (over = {}) => ({ id: "p1", kind: "custom", label: "Gateway", model: "gw-1", baseUrl: "https://gw.example/v1", hasKey: true, keyHint: "••••1234", options: {}, updatedAt: 1, ...over });
const catalog = [
  { kind: "openai", label: "OpenAI", blurb: "GPT models.", baseUrl: "https://api.openai.com/v1", requiresKey: true, defaultModel: "gpt-4o-mini", exampleModels: ["gpt-4o-mini"], nativeTools: true, canListModels: true, editableBaseUrl: false, group: "hosted" },
  { kind: "custom", label: "OpenAI-compatible (custom)", blurb: "Any OpenAI-style endpoint.", baseUrl: "", requiresKey: false, defaultModel: "", exampleModels: [], nativeTools: true, canListModels: true, editableBaseUrl: true, group: "custom" },
];
const presets = [
  { id: "codecraft", label: "CodeCraft API", baseUrl: "https://codecraftapi.com/v1", note: "Coding-agent gateway." },
  { id: "blank", label: "Something else", baseUrl: "", note: "Start from scratch." },
];
const tools = [
  { name: "calculator", label: "Calculator", description: "Maths.", risk: "safe", modes: ["chat", "agent"] },
  { name: "workspace_write", label: "Write file", description: "Writes files.", risk: "confirm", modes: ["agent"] },
];
const bootData = (over: Record<string, unknown> = {}) => ({
  version: "2.0.0", methods: { email: true, google: false, github: false },
  session: { user: { email: "ada@example.com", displayName: "Ada" }, expiresAt: Date.now() + 86_400_000, idleExpiresAt: Date.now() + 86_400_000 },
  catalog, customPresets: presets, profiles: [], activeId: null,
  settings: { maxSteps: 15, approval: "ask", alwaysAllow: [], disabledTools: [], memory: true }, tools,
  search: { user: false, server: false }, conversations: [], server: { allowPrivateUrls: true, maxUploadMb: 10, maxAgentSteps: 30 }, ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A hand-driven SSE response so tests control exactly when events arrive. */
function sseResponse() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { ctl = c; } }), { headers: { "content-type": "text/event-stream" } });
  return { response, push: (e: object) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)), close: () => ctl.close() };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;
let handlers: Handler[] = [];
let calls: Array<{ url: string; method: string; body: any }> = [];

beforeEach(async () => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", RO);
  calls = [];
  handlers = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: any = init.body;
    try { if (typeof body === "string") body = JSON.parse(body); } catch { /* keep */ }
    calls.push({ url, method: init.method ?? "GET", body });
    for (const h of handlers) { const r = await h(url, init); if (r) return r; }
    if (url === "/api/design" && !init.method) return json({ designs: [], themes: [] });
    if (url.startsWith("/api/workspace")) return json({ files: [] });
    if (url.startsWith("/api/conversations") && !init.method) return json({ conversations: [] });
    return json({ error: `unmocked ${init.method ?? "GET"} ${url}` }, 404);
  }));
  useStore.setState(initialStore, true);
  useDesign.setState(initialDesign, true);
  localStorage.clear();
});
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); });

const withBoot = (data: object) => handlers.unshift((url) => (url === "/api/bootstrap" ? json(data) : undefined));
const nav = async (name: string) => (await screen.findAllByRole("button", { name }))[0];

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Logged out: the page and the Chat tab only. Everything else asks for a login first.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const visitor = (over: Record<string, unknown> = {}) => ({ version: "2.0.0", methods: { email: true, google: true, github: true }, session: null, ...over });

/** Serves the visitor payload until a code is verified, then the account's (as the real server would). */
function serveLogin(account: Record<string, unknown> = bootData(), methods?: Record<string, boolean>, requestExtra: Record<string, unknown> = {}, sessionExtra: Record<string, unknown> = {}) {
  let loggedIn = false;
  handlers.unshift((url, init) => {
    if (url === "/api/bootstrap") return json(loggedIn ? account : visitor(methods ? { methods } : {}));
    if (url === "/api/auth/email/request") return json({ ok: true, expiresInMinutes: 10, resendAfterSeconds: 60, ...requestExtra });
    if (url === "/api/auth/session") return json({ authenticated: false, user: null, methods: visitor().methods, ...sessionExtra });
    if (url === "/api/auth/email/verify") {
      const body = JSON.parse(String(init.body));
      if (body.code !== "123456") return json({ error: "That code didn't work. Check it, or ask for a new one.", code: "invalid_code" }, 400);
      loggedIn = true;
      return json({ ok: true, created: true, user: { email: body.email } });
    }
    return undefined;
  });
}

type User = ReturnType<typeof userEvent.setup>;
const popup = () => screen.findByRole("dialog", { name: "Log in or sign up" });
const lockedTab = async (name: string) => (await screen.findAllByRole("button", { name: `${name} (log in required)` }))[0];
const shellIsInert = () => !!document.querySelector("#main")?.closest("[inert]");

/** Email, then the 6-digit code, with the mouse. */
async function logInWithEmail(user: User) {
  const d = within(await popup());
  await user.type(d.getByLabelText("Email address"), "ada@example.com");
  await user.click(d.getByRole("button", { name: /Email me a code/ }));
  await user.type(await d.findByLabelText("6-digit code"), "123456");
  await user.click(d.getByRole("button", { name: "Log in" }));
}
const popupGone = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

/** jsdom has no layout, so the dialog's focus trap (which skips elements with no offsetParent) needs a stand-in. */
function fakeLayout() {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get() { return (this as HTMLElement).parentElement; } });
  return () => { if (original) Object.defineProperty(HTMLElement.prototype, "offsetParent", original); else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent; };
}

describe("logged out: the page and the Chat tab only", () => {
  it("a visitor gets the page with a working Chat tab, no Settings, and nothing requested beyond bootstrap", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    expect(await screen.findByLabelText("Message")).toBeTruthy();
    expect((await nav("Chat")).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull(); // the popup is only ever opened by an action
    await user.type(screen.getByLabelText("Search chats"), "abc"); // even searching an empty history asks the server nothing
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.map((c) => c.url)).toEqual(["/api/bootstrap"]);
  });

  it("Agent, Design, Documents and Memory are listed; clicking any opens the login popup and the tab does not switch", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    await screen.findByLabelText("Message");
    for (const name of ["Agent", "Design", "Documents", "Memory"]) {
      await user.click(await lockedTab(name));
      const d = await popup();
      expect(within(d).getByText(new RegExp(`Log in required to open ${name}`))).toBeTruthy();
      expect(useStore.getState().tab).toBe("chat");
      expect(screen.getByLabelText("Message")).toBeTruthy();                       // still the Chat composer
      expect((await nav("Chat")).getAttribute("aria-current")).toBe("page");
      await user.keyboard("{Escape}");
      await popupGone();
    }
    expect(calls.map((c) => c.url)).toEqual(["/api/bootstrap"]);
  });

  it("locked tabs announce that a login is required and that they open a dialog; Chat does not", async () => {
    withBoot(visitor());
    render(<App />);
    await screen.findByLabelText("Message");
    for (const name of ["Agent", "Design", "Documents", "Memory"]) {
      const b = await lockedTab(name);
      expect(b.getAttribute("aria-haspopup")).toBe("dialog");
      expect(b.textContent).toContain("log in required");
    }
    const chat = await nav("Chat");
    expect(chat.getAttribute("aria-haspopup")).toBeNull();
    expect(chat.textContent).not.toContain("log in required");
  });

  it("the theme toggle keeps working", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    await screen.findByLabelText("Message");
    await user.click((await screen.findAllByRole("button", { name: /^Theme: system/ }))[0]);
    expect(useStore.getState().theme).toBe("light");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("'Login / Sign up' replaces Settings in the rail; Settings appears once logged in", async () => {
    const user = userEvent.setup();
    serveLogin();
    render(<App />);
    const login = await nav("Login / Sign up");
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    await user.click(login);
    await logInWithEmail(user);
    await popupGone();
    expect(await nav("Settings")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Login / Sign up" })).toBeNull();
    expect(await screen.findByText("Connect your first model")).toBeTruthy(); // a brand-new account with nothing pending starts at Providers
  });
});

describe("the login popup", () => {
  let restoreLayout = () => {};
  beforeEach(async () => { restoreLayout = fakeLayout(); });
  afterEach(async () => restoreLayout());

  it("is a labelled modal dialog over a dimmed, blurred page whose background is inert", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    await screen.findByLabelText("Message");
    expect(shellIsInert()).toBe(false);
    await user.click(await lockedTab("Agent"));
    const d = await popup();
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.getAttribute("aria-labelledby")).toBeTruthy();
    expect(within(d).getByRole("heading", { name: "Log in or sign up" })).toBeTruthy();
    expect(d.getAttribute("aria-describedby")).toBeTruthy();                       // says why it appeared
    const scrim = d.parentElement!.firstElementChild!;
    expect(scrim.className).toMatch(/bg-black\/50/);                               // dimmed
    expect(scrim.className).toMatch(/backdrop-blur/);                              // blurred
    expect(shellIsInert()).toBe(true);                                             // page behind: not clickable, not focusable, hidden from assistive tech
    expect(document.querySelector("#main")!.closest("[inert]")!.contains(d)).toBe(false);
    await user.keyboard("{Escape}");
    await popupGone();
    expect(shellIsInert()).toBe(false);
  });

  it("closes with Esc, an outside click or the X, and each time focus returns to the control that opened it", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    await screen.findByLabelText("Message");
    const close = {
      Escape: async () => { await user.keyboard("{Escape}"); },
      "an outside click": async (d: HTMLElement) => { await user.click(d.parentElement!.firstElementChild!); },
      "the X": async (d: HTMLElement) => { await user.click(within(d).getByRole("button", { name: "Close" })); },
    };
    for (const [how, run] of Object.entries(close)) {
      const trigger = await lockedTab("Agent");
      await user.click(trigger);
      const d = await popup();
      expect(within(d).getByLabelText("Email address")).toBe(document.activeElement); // focus moves in
      await run(d);
      await popupGone();
      expect(document.activeElement, `after closing with ${how}`).toBe(trigger);
      expect(useStore.getState().tab).toBe("chat");
      expect(useStore.getState().pendingTab).toBeNull();                          // abandoning the popup abandons the request
    }
  });

  it("traps focus: Tab and Shift+Tab cycle inside the dialog and never reach the page behind", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    await screen.findByLabelText("Message");
    await user.click(await lockedTab("Memory"));
    const d = await popup();
    const seen = new Set<Element>();
    for (let i = 0; i < 9; i++) { await user.tab(); expect(d.contains(document.activeElement), `Tab #${i + 1}`).toBe(true); seen.add(document.activeElement!); }
    expect(seen.size).toBeGreaterThan(2);                                          // it really cycles through several controls
    for (let i = 0; i < 9; i++) { await user.tab({ shift: true }); expect(d.contains(document.activeElement), `Shift+Tab #${i + 1}`).toBe(true); }
  });

  it("walks through email then a 6-digit code, and shows a wrong code as an alert without leaving", async () => {
    const user = userEvent.setup();
    serveLogin();
    render(<App />);
    await user.click(await lockedTab("Agent"));
    const d = within(await popup());
    expect(d.queryByLabelText("6-digit code")).toBeNull();                          // step 1: email only
    const send = d.getByRole("button", { name: /Email me a code/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await user.type(d.getByLabelText("Email address"), "ada@example.com");
    await user.click(send);
    expect(calls.find((c) => c.url === "/api/auth/email/request")!.body).toEqual({ email: "ada@example.com" });
    const code = await d.findByLabelText("6-digit code");                           // step 2
    expect(document.activeElement).toBe(code);
    expect(d.getByText(/If that address can receive email/)).toBeTruthy();           // never says whether the address has an account
    expect((d.getByRole("button", { name: "Log in" }) as HTMLButtonElement).disabled).toBe(true); // needs all six digits
    await user.type(code, "000000");
    await user.click(d.getByRole("button", { name: "Log in" }));
    expect((await d.findByRole("alert")).textContent).toMatch(/That code didn't work/);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useStore.getState().session).toBeNull();
  });

  describe("when no code arrives", () => {
    const askForCode = async (user: User) => {
      await user.click(await nav("Login / Sign up"));
      const d = within(await popup());
      await user.type(d.getByLabelText("Email address"), "ada@example.com");
      await user.click(d.getByRole("button", { name: /Email me a code/ }));
      await d.findByLabelText("6-digit code");
      return d;
    };

    it("in development it says plainly that nothing is emailed and where the code is", async () => {
      const user = userEvent.setup();
      serveLogin(bootData(), undefined, { delivery: "console" });
      render(<App />);
      const d = await askForCode(user);
      expect(d.getByText(/no email is sent/)).toBeTruthy();
      expect(d.getByText("[email:dev]")).toBeTruthy();
      expect(d.getByText(/terminal where the server is running/)).toBeTruthy();
      expect(d.queryByText(/is on its way/)).toBeNull();                              // no more waiting for an email that will never come
      expect(d.queryByRole("alert")).toBeNull();
      expect(calls.some((c) => c.url === "/api/auth/session")).toBe(false);          // nothing to double-check: it is not a failure
    });

    it("a normal send keeps the usual wording and no warning", async () => {
      const user = userEvent.setup();
      serveLogin();
      render(<App />);
      const d = await askForCode(user);
      expect(d.getByText(/If that address can receive email, a 6-digit code is on its way/)).toBeTruthy();
      expect(d.queryByText(/no email is sent/)).toBeNull();
      expect(d.queryByRole("alert")).toBeNull();
    });

    it("when the server already knows its mail is failing, the popup says so right away and points to Google/GitHub", async () => {
      const user = userEvent.setup();
      serveLogin(bootData(), undefined, { delivery: "failing" });
      render(<App />);
      const d = await askForCode(user);
      const alert = await d.findByRole("alert");
      expect(alert.textContent).toMatch(/couldn't send the email just now/);
      expect(alert.textContent).toMatch(/continue with Google or GitHub/);
      expect(alert.textContent).toMatch(/reason is in its log/);                      // for whoever runs the server; no config details shown to visitors
      expect(alert.textContent).not.toMatch(/SMTP|MORPHIE_|password/i);
    });

    it("a failure that only shows up a few seconds later is noticed, and clears again if the later check says it's fine", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
        serveLogin(bootData(), undefined, {}, { emailDelivery: "failing" });          // the answer was fine; the send failed after it
        render(<App />);
        const d = await askForCode(user);
        expect(d.queryByRole("alert")).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
        expect((await d.findByRole("alert")).textContent).toMatch(/couldn't send the email just now/);
        // the next check finds the mail working again (e.g. the retry went through): the warning goes away
        handlers.unshift((url) => (url === "/api/auth/session" ? json({ authenticated: false, user: null, methods: visitor().methods }) : undefined));
        await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
        await waitFor(() => expect(d.queryByRole("alert")).toBeNull());
      } finally { vi.useRealTimers(); }
    });

    it("asking for a different address starts clean", async () => {
      const user = userEvent.setup();
      serveLogin(bootData(), undefined, { delivery: "failing" });
      render(<App />);
      const d = await askForCode(user);
      await d.findByRole("alert");
      await user.click(d.getByRole("button", { name: "Use a different address" }));
      expect(d.queryByRole("alert")).toBeNull();
      expect(document.activeElement).toBe(d.getByLabelText("Email address"));
    });
  });

  it("offers Continue with Google / GitHub only when the server has them", async () => {
    const user = userEvent.setup();
    withBoot(visitor({ methods: { email: true, google: true, github: false } }));
    render(<App />);
    await user.click(await nav("Login / Sign up"));
    const d = within(await popup());
    expect(d.getByRole("link", { name: "Continue with Google" }).getAttribute("href")).toBe("/api/auth/oauth/google/start?returnTo=/");
    expect(d.queryByRole("link", { name: "Continue with GitHub" })).toBeNull();
    expect(d.getByLabelText("Email address")).toBeTruthy();
  });

  it("with only a provider configured there is no email form, and with nothing configured it says so", async () => {
    const user = userEvent.setup();
    withBoot(visitor({ methods: { email: false, google: false, github: true } }));
    const first = render(<App />);
    await user.click(await nav("Login / Sign up"));
    let d = within(await popup());
    expect(d.queryByLabelText("Email address")).toBeNull();
    expect(d.getByRole("link", { name: "Continue with GitHub" })).toBeTruthy();
    first.unmount();

    handlers = []; useStore.setState(initialStore, true);
    withBoot(visitor({ methods: { email: false, google: false, github: false } }));
    render(<App />);
    await user.click(await nav("Login / Sign up"));
    d = within(await popup());
    expect(d.getByText(/Login isn't set up on this server/)).toBeTruthy();
  });

  it("works from the keyboard alone: reach a locked tab, Enter, type the address, Enter, type the code, Enter", async () => {
    const user = userEvent.setup();
    serveLogin(bootData({ profiles: [profile()], activeId: "p1" }));
    render(<App />);
    (await lockedTab("Agent")).focus();                                              // arrived by Tab
    await user.keyboard("{Enter}");
    const d = within(await popup());
    expect(document.activeElement).toBe(d.getByLabelText("Email address"));
    await user.keyboard("ada@example.com{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(d.getByLabelText("6-digit code")));
    await user.keyboard("123456{Enter}");
    await popupGone();
    expect(await screen.findByLabelText("Task for the agent")).toBeTruthy();         // the Agent tab it asked for
    expect(useStore.getState().session?.user.email).toBe("ada@example.com");
  });
});

describe("chat while logged out", () => {
  let restoreLayout = () => {};
  beforeEach(async () => { restoreLayout = fakeLayout(); });
  afterEach(async () => restoreLayout());

  it("the composer is a normal text box: type, Shift+Enter for a new line, no popup, no requests", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    const box = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await user.type(box, "first line{Shift>}{Enter}{/Shift}second line");
    expect(box.value).toBe("first line\nsecond line");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.map((c) => c.url)).toEqual(["/api/bootstrap"]);
  });

  it("Send, Enter and the command palette each open the popup and keep the draft", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    const box = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await user.type(box, "keep me");

    await user.click(screen.getByRole("button", { name: "Send" }));                  // the button
    await popup();
    expect(box.value).toBe("keep me");
    await user.keyboard("{Escape}"); await popupGone();

    await user.click(box); await user.keyboard("{Enter}");                             // Enter in the box
    await popup();
    expect(box.value).toBe("keep me");
    await user.keyboard("{Escape}"); await popupGone();
    expect(document.activeElement).toBe(box);                                         // focus is back in the draft

    await user.keyboard("{Control>}k{/Control}");                                     // the palette
    await user.type(await screen.findByLabelText("Search commands"), "send");
    await user.keyboard("{Enter}");
    await popup();
    expect(box.value).toBe("keep me");
    await user.keyboard("{Escape}"); await popupGone();
    expect(box.value).toBe("keep me");

    expect(calls.some((c) => c.url === "/api/chat")).toBe(false);                     // nothing was sent, ever
  });

  it("after login the draft is restored and NOT sent: it goes only when Send is pressed", async () => {
    const user = userEvent.setup();
    serveLogin(bootData({ profiles: [profile()], activeId: "p1" }));
    const sse = sseResponse();
    handlers.push((url, init) => (url === "/api/chat" && init.method === "POST" ? sse.response : undefined));
    render(<App />);
    const box = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await user.type(box, "hello there");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await logInWithEmail(user);
    await popupGone();
    expect(await screen.findByRole("button", { name: /Gateway/ })).toBeTruthy();       // the account's data has loaded (its provider is in the chip)
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("hello there"); // restored, still on Chat
    expect(useStore.getState().tab).toBe("chat");
    expect(calls.some((c) => c.url === "/api/chat")).toBe(false);                     // not auto-sent

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/chat")!.body).toMatchObject({ message: "hello there", mode: "chat" }));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    await act(async () => { sse.push({ type: "done", reason: "complete" }); sse.close(); });
  });

  it("the provider chip ('Connect a provider') opens the popup, and after login provider setup resumes", async () => {
    const user = userEvent.setup();
    serveLogin(bootData({ profiles: [] }));
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Connect a provider/ }));
    const d = await popup();
    expect(within(d).getByText(/Log in required to open Settings/)).toBeTruthy();
    expect(useStore.getState().tab).toBe("chat");
    await logInWithEmail(user);
    await popupGone();
    expect(await screen.findByText("Connect your first model")).toBeTruthy();
    expect(useStore.getState().tab).toBe("settings");
    expect(useStore.getState().settingsSection).toBe("providers");
  });

  it("a suggestion card puts its prompt in the composer and opens the popup: nothing is sent", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Do some maths/ }));
    await popup();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toMatch(/18% of 74,500/);
    expect(calls.some((c) => c.url === "/api/chat")).toBe(false);
  });
});

describe("the command palette while logged out", () => {
  it("navigation and action commands open the popup, 'Log in or sign up' is offered, and Settings is not", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    await screen.findByLabelText("Message");
    for (const [query, expected] of [["go to agent", /Log in required to open Agent/], ["new design", /Log in required to open Design/], ["go to memory", /Log in required to open Memory/], ["add a provider", /Log in required to open Settings/]] as const) {
      await user.keyboard("{Control>}k{/Control}");
      await user.type(await screen.findByLabelText("Search commands"), query);
      await user.keyboard("{Enter}");
      expect(within(await popup()).getByText(expected)).toBeTruthy();
      expect(useStore.getState().tab).toBe("chat");
      expect(screen.queryByLabelText("Search commands")).toBeNull();                 // the palette made way for it
      await user.keyboard("{Escape}"); await popupGone();
    }
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByLabelText("Search commands"), "log in");
    expect(screen.getByRole("option", { name: /Log in or sign up/ })).toBeTruthy();
    await user.clear(screen.getByLabelText("Search commands"));
    await user.type(screen.getByLabelText("Search commands"), "settings");
    expect(screen.queryByRole("option", { name: /Open Settings/ })).toBeNull();
  });

  it("theme commands work and do not open the popup", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    await screen.findByLabelText("Message");
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByLabelText("Search commands"), "dark");
    await user.keyboard("{Enter}");
    expect(useStore.getState().theme).toBe("dark");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("commands that only concern the Chat tab (Go to Chat, New chat) just work", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    render(<App />);
    await screen.findByLabelText("Message");
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByLabelText("Search commands"), "new chat");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useStore.getState().tab).toBe("chat");
  });
});

describe("after login the pending action resumes", () => {
  it("opens the tab that was asked for, loads the data and closes the popup", async () => {
    const user = userEvent.setup();
    serveLogin(bootData({ profiles: [profile()], activeId: "p1", conversations: [{ id: "c9", title: "Old chat", mode: "chat", pinned: false, updatedAt: Date.now(), createdAt: 1 }] }));
    render(<App />);
    await user.click(await lockedTab("Documents"));
    await logInWithEmail(user);
    await popupGone();
    expect(await screen.findByRole("heading", { name: "Documents" })).toBeTruthy();
    expect(useStore.getState().tab).toBe("documents");
    expect(useStore.getState().conversations.map((c) => c.id)).toEqual(["c9"]);       // the account's data is loaded
    expect(useStore.getState().loginOpen).toBe(false);
    expect(useStore.getState().pendingTab).toBeNull();
    expect(calls.filter((c) => c.url === "/api/bootstrap")).toHaveLength(2);          // once as a visitor, once as the account
  });

  it("Google/GitHub: only { tab, draft } is kept in sessionStorage across the redirect, and it is restored (then removed) on return", async () => {
    const user = userEvent.setup();
    withBoot(visitor());
    const first = render(<App />);
    await user.type(await screen.findByLabelText("Message"), "my draft");
    await user.click(await lockedTab("Agent"));
    const google = within(await popup()).getByRole("link", { name: "Continue with Google" });
    google.addEventListener("click", (e) => e.preventDefault());                       // jsdom can't navigate away
    await user.click(google);
    const stored = sessionStorage.getItem("morphie.login")!;
    expect(JSON.parse(stored)).toEqual({ tab: "agent", draft: "my draft" });
    expect(sessionStorage.length).toBe(1);                                             // nothing else
    expect(stored).not.toMatch(/ada@|session|token|code/i);

    // …the provider sends them back to a fresh page load, now signed in
    first.unmount(); handlers = []; useStore.setState(initialStore, true);
    withBoot(bootData({ profiles: [profile()], activeId: "p1" }));
    render(<App />);
    expect(await screen.findByLabelText("Task for the agent")).toBeTruthy();           // the tab it asked for
    expect(useStore.getState().drafts.chat).toBe("my draft");                          // the draft is back
    expect(sessionStorage.getItem("morphie.login")).toBeNull();                        // and gone from storage
    expect(calls.some((c) => c.url === "/api/chat")).toBe(false);
    await user.click(await nav("Chat"));
    expect((await screen.findByLabelText("Message") as HTMLTextAreaElement).value).toBe("my draft");
  });

  it("a Google/GitHub login that fails still gives the draft back, explains why, and cleans the address", async () => {
    sessionStorage.setItem("morphie.login", JSON.stringify({ tab: "agent", draft: "do not lose me" }));
    history.replaceState(null, "", "/?auth_error=denied");
    withBoot(visitor());
    render(<App />);
    expect(((await screen.findByLabelText("Message")) as HTMLTextAreaElement).value).toBe("do not lose me");
    expect(await screen.findByText("Login was cancelled.")).toBeTruthy();
    expect(useStore.getState().tab).toBe("chat");                                       // not logged in, so still only Chat
    expect(sessionStorage.getItem("morphie.login")).toBeNull();
    expect(location.search).toBe("");
  });

  it("ignores anything unexpected in the stored redirect state", async () => {
    sessionStorage.setItem("morphie.login", JSON.stringify({ tab: "../../admin", draft: 42, extra: "x" }));
    withBoot(bootData({ profiles: [profile()], activeId: "p1" }));
    render(<App />);
    expect(await screen.findByLabelText("Message")).toBeTruthy();
    expect(useStore.getState().tab).toBe("chat");
    expect(useStore.getState().drafts.chat).toBe("");
    expect(sessionStorage.getItem("morphie.login")).toBeNull();
  });
});

describe("logged in vs session ends", () => {
  it("signed in there is no login item or popup, and Settings → Account has the email, Sign out and Sign out everywhere (no login form)", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile()], activeId: "p1" }));
    render(<App />);
    await screen.findByLabelText("Message");
    expect(screen.queryByRole("button", { name: "Login / Sign up" })).toBeNull();
    expect(screen.queryByRole("button", { name: /log in required/ })).toBeNull();
    await user.click(await nav("Settings"));
    await user.click(await screen.findByRole("button", { name: "Account" }));
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeTruthy();
    expect(screen.queryByLabelText("Email address")).toBeNull();
  });

  it("when the server answers 401 mid-session the page drops back to Chat as a visitor, and nothing of the account stays in memory", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile()], activeId: "p1", conversations: [{ id: "c9", title: "Private chat", mode: "chat", pinned: false, updatedAt: Date.now(), createdAt: 1 }] }));
    handlers.push((url, init) => (url === "/api/settings" && init.method === "PUT" ? json({ error: "Sign in to use this.", code: "unauthenticated" }, 401) : undefined));
    render(<App />);
    await user.click(await nav("Settings"));
    useDesign.setState({ designs: [{ id: "d1", name: "Secret design", version: 1, updatedAt: 1 }] as never, loaded: true });
    await act(async () => { await useStore.getState().setSettings({ maxSteps: 3 }); });
    expect(await nav("Login / Sign up")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(await screen.findByLabelText("Message")).toBeTruthy();                      // Chat, as a visitor
    expect(useStore.getState().session).toBeNull();
    expect(useStore.getState().conversations).toEqual([]);
    expect(useStore.getState().profiles).toEqual([]);
    expect(useDesign.getState().designs).toEqual([]);
    expect(screen.queryByText("Private chat")).toBeNull();
    expect(await screen.findByText(/You've been logged out/)).toBeTruthy();
  });
});

describe("dialogs", () => {
  it("keep focus where the user is typing when the page behind re-renders (a toast appearing or expiring)", async () => {
    const user = userEvent.setup();
    withBoot(bootData());
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /^OpenAI-compatible$/ }));
    const key = within(await screen.findByRole("dialog")).getByLabelText("API key");
    await user.type(key, "sk-");
    await act(async () => { useStore.getState().toast("ok", "Logged in."); });       // re-renders the page behind, handing the dialog a new onClose
    await user.keyboard("secret");                                                    // keeps typing wherever focus is (user.type would click the field and hide a focus jump)
    expect(document.activeElement).toBe(key);
    expect((key as HTMLInputElement).value).toBe("sk-secret");
  });
});

describe("first run & provider setup", () => {
  it("lands on Settings → Providers when nothing is connected", async () => {
    withBoot(bootData());
    render(<App />);
    expect(await screen.findByText("Connect your first model")).toBeTruthy();
  });

  it("configures an OpenAI-compatible provider entirely from the UI and saves the right payload", async () => {
    const user = userEvent.setup();
    withBoot(bootData());
    handlers.push(
      (url, init) => (url === "/api/providers/models" ? json({ models: [{ id: "cc-fast" }, { id: "cc-pro" }], source: "live" }) : undefined),
      (url, init) => (url === "/api/providers" && init.method === "POST" ? json({ profile: profile({ label: "CodeCraft API", model: "cc-pro" }), profiles: [profile({ label: "CodeCraft API", model: "cc-pro" })], activeId: "p1" }) : undefined),
    );
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /^OpenAI-compatible$/ }));
    const dialog = await screen.findByRole("dialog");
    const d = within(dialog);

    await user.click(d.getByRole("combobox", { name: "Preset" }));
    await user.click(await screen.findByRole("option", { name: /CodeCraft API/ }));
    expect((d.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://codecraftapi.com/v1");
    expect((d.getByLabelText("Name") as HTMLInputElement).value).toBe("CodeCraft API");

    await user.type(d.getByLabelText("API key"), "cc-secret-key-000");
    await user.click(d.getByRole("button", { name: "Fetch models" }));
    await waitFor(() => expect(d.getByText("2 models found.")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/providers/models")!.body).toMatchObject({ kind: "custom", apiKey: "cc-secret-key-000", baseUrl: "https://codecraftapi.com/v1" });

    await user.clear(d.getByLabelText("Model"));
    await user.type(d.getByLabelText("Model"), "cc-pro");

    await user.click(d.getByRole("button", { name: /Advanced connection settings/ }));
    await user.click(d.getByRole("combobox", { name: "Authentication style" }));
    await user.click(await screen.findByRole("option", { name: /x-api-key/ }));
    await user.click(d.getByRole("button", { name: /Add header/ }));
    await user.type(d.getByLabelText("Header-Name 1"), "X-Team");
    await user.type(d.getByLabelText("value 1"), "alpha");
    await user.click(d.getByRole("button", { name: /Add parameter/ }));
    await user.type(d.getByLabelText("name 1"), "api-version");
    await user.type(d.getByLabelText("value 1", { selector: "input[type=text]" }), "2024");
    await user.click(d.getByRole("switch", { name: "Native tool calling" }));   // off → prompt-based tools
    await user.click(d.getByRole("switch", { name: "Stream responses" }));      // off
    await user.type(d.getByLabelText("Temperature"), "0.3");

    await user.click(d.getByRole("button", { name: "Save & use" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/providers" && c.method === "POST")).toBe(true));
    const saved = calls.find((c) => c.url === "/api/providers" && c.method === "POST")!.body;
    expect(saved).toMatchObject({
      kind: "custom", label: "CodeCraft API", model: "cc-pro", apiKey: "cc-secret-key-000", baseUrl: "https://codecraftapi.com/v1", activate: true,
      options: { authStyle: "x-api-key", extraHeaders: { "X-Team": "alpha" }, queryParams: { "api-version": "2024" }, nativeTools: false, streaming: false, temperature: 0.3 },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useStore.getState().activeId).toBe("p1");
  });

  it("shows the connection-test result including tool-calling status", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile()], activeId: "p1" }));
    handlers.push((url) => (url === "/api/providers/test" ? json({ ok: true, message: "Connected in 42 ms.", latencyMs: 42, reply: "pong", tools: "not_detected", hint: "Turn off native tool calling." }) : undefined));
    render(<App />);
    await user.click(await nav("Settings"));
    await user.click(await screen.findByRole("button", { name: /Edit/ }));
    const d = within(await screen.findByRole("dialog"));
    await user.click(d.getByRole("button", { name: /Test connection/ }));
    expect(await d.findByText("Connected in 42 ms.")).toBeTruthy();
    expect(d.getByText("not detected")).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/providers/test")!.body).toMatchObject({ profileId: "p1", kind: "custom", model: "gw-1" });
  });
});

describe("chat", () => {
  it("streams a reply live, then shows the persisted conversation", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile()], activeId: "p1" }));
    const sse = sseResponse();
    handlers.push(
      (url, init) => (url === "/api/chat" && init.method === "POST" ? sse.response : undefined),
      (url) => (url === "/api/conversations/c1" ? json({ conversation: { id: "c1" }, messages: [{ id: 1, role: "user", content: "hello", createdAt: 1 }, { id: 2, role: "assistant", content: "Hello **world**", createdAt: 2, meta: { model: "gw-1" } }] }) : undefined),
    );
    render(<App />);
    const box = await screen.findByLabelText("Message");
    await user.type(box, "hello{Enter}");
    expect(calls.find((c) => c.url === "/api/chat")!.body).toMatchObject({ message: "hello", mode: "chat" });

    await act(async () => { sse.push({ type: "start", conversationId: "c1", mode: "chat", provider: "Gateway", model: "gw-1" }); sse.push({ type: "text", delta: "Hel" }); });
    expect(await screen.findByText("Hel")).toBeTruthy();
    expect(screen.getAllByText("hello")).toHaveLength(1);                     // the user's message is shown once, not twice
    expect(calls.some((c) => c.url === "/api/conversations/c1")).toBe(false); // and history isn't re-fetched mid-run
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();       // live controls while streaming

    await act(async () => { sse.push({ type: "text", delta: "lo" }); sse.push({ type: "title", title: "hello" }); sse.push({ type: "done", reason: "complete" }); sse.close(); });
    await waitFor(() => expect(screen.getByText("world").tagName).toBe("STRONG"));    // markdown rendered from persisted message
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });

  it("explains how to fix things when no provider is connected", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [], activeId: null }));
    render(<App />);
    await user.click((await screen.findAllByRole("button", { name: "Chat" }))[0]);
    expect(await screen.findByRole("button", { name: /Connect a provider/ })).toBeTruthy();
  });
});

describe("agent mode", () => {
  it("shows the live plan + step timeline and an approval card whose buttons talk to the server", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile()], activeId: "p1" }));
    const sse = sseResponse();
    handlers.push(
      (url, init) => (url === "/api/chat" && init.method === "POST" ? sse.response : undefined),
      (url, init) => (url === "/api/agent/approve" ? json({ ok: true }) : undefined),
      (url) => (url === "/api/conversations/a1" ? json({ conversation: { id: "a1" }, messages: [] }) : undefined),
    );
    render(<App />);
    await user.click(await nav("Agent"));
    await user.type(await screen.findByLabelText("Task for the agent"), "write a note{Enter}");
    expect(calls.find((c) => c.url === "/api/chat")!.body).toMatchObject({ mode: "agent", message: "write a note" });

    await act(async () => {
      sse.push({ type: "start", conversationId: "a1", mode: "agent", provider: "Gateway", model: "gw-1" });
      sse.push({ type: "step", n: 1, max: 15 });
      sse.push({ type: "plan", items: [{ text: "Draft the note", status: "active" }, { text: "Save it", status: "pending" }] });
      sse.push({ type: "tool_start", step: { id: "s1_0", name: "workspace_write", args: { path: "notes/a.md", content: "# Hi" }, status: "waiting", needsApproval: true } });
      sse.push({ type: "approval", id: "ap1", stepId: "s1_0", tool: "workspace_write", args: { path: "notes/a.md", content: "# Hi" }, reason: "Write notes/a.md (4 characters)" });
    });
    expect(await screen.findByText("Allow this action?")).toBeTruthy();
    expect(screen.getAllByText("Draft the note").length).toBeGreaterThan(0);          // plan card
    expect(screen.getByText("Needs your approval")).toBeTruthy();
    expect(screen.getByText("Step 1/15")).toBeTruthy();

    await user.click(screen.getByLabelText(/Always allow/));
    await user.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/agent/approve")?.body).toEqual({ id: "ap1", approved: true, always: true }));
    expect(screen.queryByText("Allow this action?")).toBeNull();

    await act(async () => { sse.push({ type: "tool_end", stepId: "s1_0", status: "done", ms: 8, summary: "Created notes/a.md" }); sse.push({ type: "text", delta: "Saved." }); sse.push({ type: "done", reason: "complete" }); sse.close(); });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull());
  });

  it("lets the user deny an action", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile()], activeId: "p1" }));
    const sse = sseResponse();
    handlers.push((url, init) => (url === "/api/chat" && init.method === "POST" ? sse.response : undefined), (url) => (url === "/api/agent/approve" ? json({ ok: true }) : undefined));
    render(<App />);
    await user.click(await nav("Agent"));
    await user.type(await screen.findByLabelText("Task for the agent"), "delete it{Enter}");
    await act(async () => {
      sse.push({ type: "start", conversationId: "a2", mode: "agent", provider: "G", model: "m" });
      sse.push({ type: "tool_start", step: { id: "s1_0", name: "workspace_delete", args: { path: "x.md" }, status: "waiting" } });
      sse.push({ type: "approval", id: "ap9", stepId: "s1_0", tool: "workspace_delete", args: { path: "x.md" }, reason: "Delete x.md" });
    });
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/agent/approve")?.body).toEqual({ id: "ap9", approved: false, always: undefined }));
    await act(async () => { sse.push({ type: "done", reason: "complete" }); sse.close(); });
  });
});

describe("design studio", () => {
  const design = { name: "Acme", theme: { background: "#fff", surface: "#f4f4f5", primary: "#18181b", secondary: "#52525b", accent: "#2563eb", text: "#18181b" }, typography: { heading: "Inter", body: "Inter", scale: "normal" }, layout: { max_width: "1200px", spacing: "comfortable" }, style: { radius: "sm", shadow: "none" }, responsive: { tablet_columns: 2, mobile_columns: 1, mobile_nav: "collapse" }, sections: [{ id: "hero", type: "hero" }, { id: "footer", type: "footer" }] };
  const state = { id: "d1", name: "Acme", design, previewHtml: "<!DOCTYPE html><html><body><h1>Acme hero</h1></body></html>", updatedAt: 1, history: { version: 1, position: 1, total: 1, canUndo: false, canRedo: false, revision: 1 }, versions: [{ version: 1, summary: "Created Acme.", prompt: "acme", createdAt: 1, current: true }] };

  it("generates a design and renders it in a fully sandboxed iframe", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile()], activeId: "p1" }));
    const sse = sseResponse();
    handlers.push((url, init) => (url === "/api/design" && init.method === "POST" ? sse.response : undefined));
    render(<App />);
    await user.click(await nav("Design"));
    await user.type(await screen.findByLabelText("Design instruction"), "a landing page for acme{Enter}");
    expect(calls.find((c) => c.url === "/api/design" && c.method === "POST")!.body).toMatchObject({ message: "a landing page for acme", designId: null });
    await act(async () => { sse.push({ type: "stage", stage: "drafting", attempt: 0 }); });
    expect(await screen.findByText("Designing…")).toBeTruthy();
    await act(async () => { sse.push({ type: "result", state, changed: true, kind: "create", summary: "A clean landing page.", notes: ["adjusted theme.text"] }); sse.close(); });

    const frame = (await screen.findByTitle("Design preview")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");                 // empty sandbox = no scripts, no same-origin, no forms
    expect(frame.getAttribute("srcdoc")).toContain("Acme hero");
    expect(screen.getByText("A clean landing page.")).toBeTruthy();
    expect(screen.getByText("1 automatic adjustment")).toBeTruthy();
    expect(screen.getAllByText("hero").length).toBeGreaterThan(0);    // inspector outline
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("command palette", () => {
  it("opens with Ctrl+K, filters, and navigates", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile()], activeId: "p1" }));
    render(<App />);
    await screen.findByLabelText("Message");
    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByLabelText("Search commands");
    await user.type(input, "memory");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeTruthy();
  });
});

describe("runs that pause, continue, deliver and keep going in the background", () => {
  const agentConv = (id: string, title: string) => ({ id, title, mode: "agent", pinned: false, updatedAt: Date.now(), createdAt: 1, projectId: null });
  const reply = (meta: Record<string, unknown>, content = "Here's where it got to.") => ({ id: 2, role: "assistant", content, createdAt: 2, meta });
  const ask = { id: 1, role: "user", content: "build the landing page", createdAt: 1 };

  it("a paused reply says why and offers Continue, which resumes the run without a new message", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile()], activeId: "p1", conversations: [agentConv("a5", "Landing page")] }));
    const sse = sseResponse();
    handlers.push(
      (url) => (url === "/api/conversations/a5" ? json({ conversation: agentConv("a5", "Landing page"), messages: [ask, reply({ reason: "budget", continuable: true, budget: { used: 512_000, limit: 500_000 } })] }) : undefined),
      (url, init) => (url === "/api/chat" && init.method === "POST" ? sse.response : undefined),
    );
    render(<App />);
    await user.click(await nav("Agent"));
    await user.click(await screen.findByRole("button", { name: /Landing page/ }));
    expect(await screen.findByText(/Paused: it used this task's token budget/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(calls.find((c) => c.url === "/api/chat")!.body).toEqual({ conversationId: "a5", mode: "agent", continue: true });
    await act(async () => {
      sse.push({ type: "start", conversationId: "a5", mode: "agent", provider: "Gateway", model: "gw-1", seq: 1 });
      sse.push({ type: "budget", used: 84_000, budget: 500_000, seq: 2 });
      sse.push({ type: "text", delta: "Finishing the pricing section.", seq: 3 });
    });
    expect(await screen.findByText("84k / 500k")).toBeTruthy();       // the budget meter, not a step counter
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull(); // the old reply's button goes while it runs
    expect(screen.queryAllByText("build the landing page")).toHaveLength(1); // no second user bubble
    await act(async () => { sse.push({ type: "done", reason: "complete", seq: 4 }); sse.close(); });
  });

  it("shows a project's deliverables as one zip named after it when there are more than 10 files", async () => {
    const user = userEvent.setup();
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `src/file${i}.ts` }));
    withBoot(bootData({ profiles: [profile()], activeId: "p1", conversations: [agentConv("a6", "Friday")] }));
    handlers.push((url) => (url === "/api/conversations/a6" ? json({ conversation: agentConv("a6", "Friday"), messages: [ask, reply({ reason: "complete", deliverables: { kind: "project", name: "friday-landing", slug: "friday-landing", projectId: "pr1", files, total: 23, verified: true, checks: "install · build · test · loaded 1 page" } })] }) : undefined));
    render(<App />);
    await user.click(await nav("Agent"));
    await user.click(await screen.findByRole("button", { name: /Friday/ }));
    const card = await screen.findByRole("region", { name: "Deliverables" });
    expect(within(card).getByText("Verified")).toBeTruthy();
    expect(within(card).getByText(/23 files · install · build · test/)).toBeTruthy();
    expect(within(card).getByRole("button", { name: /friday-landing\.zip/ }).closest("a")!.getAttribute("href")).toBe("/api/projects/pr1/zip");
    expect(within(card).queryByText("src/file0.ts")).toBeNull();
    await user.click(within(card).getByRole("button", { name: /Show the first 10 files/ }));
    expect(within(card).getByText("src/file0.ts").closest("a")!.getAttribute("href")).toBe("/api/projects/pr1/file?path=src%2Ffile0.ts&download=1");
    expect(within(card).getByText(/13 more in the zip/)).toBeTruthy();
  });

  it("ten files or fewer are listed one by one, with a zip of just those files named after their folder", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile()], activeId: "p1", conversations: [agentConv("a8", "Notes")] }));
    handlers.push((url) => (url === "/api/conversations/a8" ? json({ conversation: agentConv("a8", "Notes"), messages: [ask, reply({ reason: "complete", files: ["friday-landing/index.html", "friday-landing/style.css"], deliverables: { kind: "workspace", name: "friday-landing", slug: "friday-landing", files: [{ path: "friday-landing/index.html" }, { path: "friday-landing/style.css" }], total: 2 } })] }) : undefined));
    render(<App />);
    await user.click(await nav("Agent"));
    await user.click(await screen.findByRole("button", { name: /Notes/ }));
    const card = await screen.findByRole("region", { name: "Deliverables" });
    expect(within(card).getByText("friday-landing/style.css").closest("a")!.getAttribute("href")).toBe("/api/workspace/file?path=friday-landing%2Fstyle.css&download=1");
    const zip = within(card).getByRole("button", { name: /friday-landing\.zip/ }).closest("a")!.getAttribute("href")!;
    expect(new URLSearchParams(zip.split("?")[1]).get("name")).toBe("friday-landing");
    expect(new URLSearchParams(zip.split("?")[1]).get("paths")).toBe("friday-landing/index.html,friday-landing/style.css");
  });

  it("opening a conversation whose agent is still working follows the run live, and Stop asks the server to stop it", async () => {
    const user = userEvent.setup();
    withBoot(bootData({ profiles: [profile()], activeId: "p1", conversations: [agentConv("a7", "Background job")], running: ["a7"] }));
    const sse = sseResponse();
    handlers.push(
      (url) => (url === "/api/conversations/a7" ? json({ conversation: agentConv("a7", "Background job"), messages: [ask], running: true }) : undefined),
      (url) => (url === "/api/runs/a7?from=0" ? sse.response : undefined),
      (url, init) => (url === "/api/runs/a7/stop" && init.method === "POST" ? json({ stopped: true }) : undefined),
    );
    render(<App />);
    await user.click(await nav("Agent"));
    expect(await screen.findByText("Working…")).toBeTruthy(); // the sidebar knows it's running before it's opened
    await user.click(await screen.findByRole("button", { name: /Background job/ }));
    await act(async () => {
      sse.push({ type: "start", conversationId: "a7", mode: "agent", provider: "Gateway", model: "gw-1", seq: 1 });
      sse.push({ type: "text", delta: "Still building the hero section", seq: 2 });
    });
    expect(await screen.findByText("Still building the hero section")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/runs/a7/stop" && c.method === "POST")).toBe(true));
    await act(async () => { sse.push({ type: "done", stopped: true, reason: "aborted", continuable: true, seq: 3 }); sse.close(); });
  });

  it("Settings → Usage shows where the tokens went", async () => {
    const user = userEvent.setup();
    const t = (input: number, output: number, cached = 0) => ({ input, output, cached, calls: 3, estimated: 0 });
    withBoot(bootData({ profiles: [profile()], activeId: "p1" }));
    handlers.push((url) => (url === "/api/usage?days=30" ? json({ days: 30, total: t(120_000, 8_000, 90_000), byDay: [{ day: "2026-10-27", ...t(120_000, 8_000, 90_000) }], byFeature: [{ key: "code", ...t(100_000, 6_000) }, { key: "subagent", ...t(20_000, 2_000) }], byModel: [{ key: "gw-1", ...t(120_000, 8_000) }], conversations: [{ id: "c1", title: "Friday landing", ...t(120_000, 8_000) }], designs: [] }) : undefined));
    render(<App />);
    await user.click(await nav("Settings"));
    await user.click(await screen.findByRole("button", { name: "Usage" }));
    const total = (await screen.findByText("Total tokens")).parentElement!;
    expect(within(total).getByText("128k")).toBeTruthy();
    expect(screen.getByText("75% from the prompt cache")).toBeTruthy();
    expect(screen.getByText("Code projects")).toBeTruthy();
    expect(screen.getByText("Friday landing")).toBeTruthy();
  });
});
