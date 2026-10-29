// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/components/App";
import { passwordScore } from "@/components/LoginDialog";
import { AccountSection, describeDevice } from "@/components/settings/AccountSection";
import { useDesign } from "@/lib/designStore";
import { useStore } from "@/lib/store";

const initialStore = useStore.getInitialState();
const initialDesign = useDesign.getInitialState();
beforeAll(async () => {
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const session = { user: { email: "ada@example.com", displayName: "Ada" }, expiresAt: Date.now() + 86_400_000, idleExpiresAt: Date.now() + 86_400_000 };
const account = (methods: Record<string, boolean>) => ({
  version: "2", methods, session, catalog: [], customPresets: [], profiles: [], activeId: null,
  settings: { maxSteps: 15, approval: "ask", alwaysAllow: [], disabledTools: [], memory: true }, tools: [], search: { user: false, server: false }, conversations: [],
  server: { allowPrivateUrls: true, maxUploadMb: 10, maxAgentSteps: 30 },
});
type Handler = (url: string, init: RequestInit) => Response | undefined;
let handlers: Handler[] = [];
let calls: Array<{ url: string; method: string; body: any }> = [];
const reload = vi.fn();

beforeEach(async () => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", RO);
  calls = []; handlers = []; reload.mockClear();
  vi.stubGlobal("location", { ...window.location, reload, pathname: "/", search: "" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    let body: any = init.body; try { if (typeof body === "string") body = JSON.parse(body); } catch { /* keep */ }
    calls.push({ url, method: init.method ?? "GET", body });
    for (const h of handlers) { const r = h(url, init); if (r) return r; }
    if (url.startsWith("/api/conversations")) return json({ conversations: [] });
    return json({ error: `unmocked ${url}` }, 404);
  }));
  useStore.setState(initialStore, true);
  useDesign.setState(initialDesign, true);
});
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); });

/** Visitor until a login/signup succeeds, then the account. */
function serve(methods: Record<string, boolean>, extra: Handler[] = []) {
  let inside = false;
  handlers.push(...extra, (url, init) => {
    if (url === "/api/bootstrap") return json(inside ? account(methods) : { version: "2", methods, session: null });
    if (url === "/api/auth/password/login") {
      const b = JSON.parse(String(init.body));
      if (b.password !== "correct horse battery") return json({ error: "That email and password don't match.", code: "invalid_credentials" }, 400);
      inside = true; return json({ ok: true });
    }
    if (url === "/api/auth/password/signup") { inside = true; return json({ ok: true, created: true }); }
    if (url === "/api/auth/email/request") return json({ ok: true, resendAfterSeconds: 60, delivery: "console", devCode: "482913" });
    if (url === "/api/auth/email/verify") { inside = true; return json({ ok: true }); }
    return undefined;
  });
}
const openLogin = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click((await screen.findAllByRole("button", { name: "Login / Sign up" }))[0]);
  return within(await screen.findByRole("dialog", { name: "Log in or sign up" }));
};

describe("logging in without email", () => {
  it("password is the first tab when the server offers it; a wrong password stays in the popup with the reason", async () => {
    const user = userEvent.setup();
    serve({ email: true, google: false, github: false, password: true });
    render(<App />);
    const d = await openLogin(user);
    expect(d.getByRole("tab", { name: /Password/ }).getAttribute("aria-selected")).toBe("true");
    await user.type(d.getByLabelText("Email"), "ada@example.com");
    await user.type(d.getByLabelText("Password"), "wrong password!!");
    await user.click(d.getByRole("button", { name: "Log in" }));
    expect(await d.findByText("That email and password don't match.")).toBeTruthy();
    await user.clear(d.getByLabelText("Password"));
    await user.type(d.getByLabelText("Password"), "correct horse battery{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useStore.getState().session?.user.email).toBe("ada@example.com");
  });

  it("creating an account asks for a 10+ character password, shows its strength, and sends name, email and password", async () => {
    const user = userEvent.setup();
    serve({ email: false, google: false, github: false, password: true });
    render(<App />);
    const d = await openLogin(user);
    expect(d.queryByRole("tab")).toBeNull();                                    // only one way in: no tabs
    await user.click(d.getByRole("button", { name: "Create an account" }));
    await user.type(d.getByLabelText("Name (optional)"), "Ada");
    await user.type(d.getByLabelText("Email"), "ada@example.com");
    await user.type(d.getByLabelText("Password"), "short");
    expect((d.getByRole("button", { name: "Create account" }) as HTMLButtonElement).disabled).toBe(true);
    expect(d.getByText("Too short")).toBeTruthy();
    await user.type(d.getByLabelText("Password"), " but now long enough 7!");
    expect(d.queryByText("Too short")).toBeNull();
    await user.click(d.getByRole("button", { name: "Show password" }));
    expect((d.getByLabelText("Password") as HTMLInputElement).type).toBe("text");
    await user.click(d.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/auth/password/signup")?.body).toEqual({ email: "ada@example.com", password: "short but now long enough 7!", name: "Ada" }));
    expect(await screen.findByText("Welcome to Morphie! Your account is ready.")).toBeTruthy();
  });

  it("in development the email code is shown and filled in, so Log in just works", async () => {
    const user = userEvent.setup();
    serve({ email: true, google: false, github: false, password: true });
    render(<App />);
    const d = await openLogin(user);
    await user.click(d.getByRole("tab", { name: /Email code/ }));
    await user.type(d.getByLabelText("Email address"), "ada@example.com");
    await user.click(d.getByRole("button", { name: /Email me a code/ }));
    expect(await d.findByText("482913")).toBeTruthy();
    expect((d.getByLabelText("6-digit code") as HTMLInputElement).value).toBe("482913");
    await user.click(d.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(useStore.getState().session).not.toBeNull());
  });

  it("Forgot password? switches to an email code when the server can send one, and isn't offered when it can't", async () => {
    const user = userEvent.setup();
    serve({ email: true, google: false, github: false, password: true });
    const first = render(<App />);
    let d = await openLogin(user);
    await user.click(d.getByRole("button", { name: "Forgot password?" }));
    expect(d.getByRole("tab", { name: /Email code/ }).getAttribute("aria-selected")).toBe("true");
    expect(d.getByLabelText("Email address")).toBeTruthy();
    first.unmount();
    handlers = []; useStore.setState(initialStore, true);
    serve({ email: false, google: false, github: false, password: true });
    render(<App />);
    d = await openLogin(user);
    expect(d.queryByRole("button", { name: "Forgot password?" })).toBeNull();
  });

  it("scores passwords for the meter", async () => {
    expect([passwordScore(""), passwordScore("short"), passwordScore("tencharsxx"), passwordScore("Correcthorse9x"), passwordScore("Long Passphrase With 4 Words!")]).toEqual([0, 0, 1, 3, 4]);
  });
});

describe("the Account page", () => {
  const acct = { email: "ada@example.com", displayName: "Ada", emailVerified: true, hasPassword: false, createdAt: Date.UTC(2026, 0, 5), identities: [{ provider: "github", email: "ada@example.com" }] };
  const sessions = [
    { id: "a".repeat(64), current: true, createdAt: 1, lastSeenAt: Date.now(), ip: null, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130 Safari/537.36" },
    { id: "b".repeat(64), current: false, createdAt: 1, lastSeenAt: Date.now() - 3_600_000, ip: "203.0.113.9", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1" },
  ];
  const mount = (extra: Handler[] = []) => {
    useStore.setState({ session, methods: { email: true, google: true, github: true, password: true } });
    handlers.push(...extra, (url, init) => (url === "/api/account" && (init.method ?? "GET") === "GET" ? json({ account: acct, sessions }) : undefined));
    return render(<AccountSection />);
  };

  it("shows profile, verified email, linked logins and devices", async () => {
    mount();
    expect(await screen.findByText("Verified")).toBeTruthy();
    const methods = screen.getByRole("region", { name: "Sign-in methods" });
    expect(within(methods).getByText("Linked (ada@example.com).")).toBeTruthy();
    expect(within(methods).getByRole("button", { name: "Set a password" })).toBeTruthy();
    const devices = await screen.findByRole("list", { name: "Active sessions" });
    expect(within(devices).getByText("Chrome on macOS")).toBeTruthy();
    expect(within(devices).getByText("This device")).toBeTruthy();
    expect(within(devices).getByText("Safari on iOS")).toBeTruthy();
  });

  it("offers Connect for a configured provider, Disconnect for a linked one, and a setup guide otherwise", async () => {
    const user = userEvent.setup();
    useStore.setState({ session, methods: { email: true, google: false, github: true, password: true } });
    handlers.push(
      (url, init) => (url === "/api/account/identities/github" && init.method === "DELETE" ? json({ account: { ...acct, identities: [] }, sessions }) : undefined),
      (url, init) => (url === "/api/account" && (init.method ?? "GET") === "GET" ? json({ account: { ...acct, hasPassword: true }, sessions }) : undefined),
    );
    render(<AccountSection />);
    const methods = await screen.findByRole("region", { name: "Sign-in methods" });
    await within(methods).findByText("Linked (ada@example.com).");
    // Google isn't configured on the server: a guide with the exact redirect URI to register
    await user.click(within(methods).getByRole("button", { name: /Set up/ }));
    const guide = within(await screen.findByRole("dialog", { name: "Set up Google sign-in" }));
    expect(guide.getByText(`${location.origin}/api/auth/oauth/google/callback`)).toBeTruthy();
    expect(guide.getByText("GOOGLE_CLIENT_ID=your-client-id")).toBeTruthy();
    await user.click(guide.getByRole("button", { name: "Done" }));
    // GitHub is linked: disconnecting asks first, then calls the API
    await user.click(within(methods).getByRole("button", { name: "Disconnect GitHub" }));
    await user.click(within(await screen.findByRole("dialog", { name: /Disconnect GitHub/ })).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/account/identities/github" && c.method === "DELETE")).toBe(true));
    // ...after which it offers to connect again, via the link-mode OAuth start
    const connect = await within(methods).findByRole("link", { name: /Connect GitHub/ });
    expect(connect.getAttribute("href")).toBe("/api/auth/oauth/github/start?link=1");
  });

  it("renames you everywhere, signs out one device, and sets a first password", async () => {
    const user = userEvent.setup();
    mount([
      (url, init) => (url === "/api/account" && init.method === "PATCH" ? json({ account: { ...acct, displayName: "Ada L." }, sessions }) : undefined),
      (url, init) => (url === `/api/account/sessions/${"b".repeat(64)}` && init.method === "DELETE" ? json({ sessions: [sessions[0]] }) : undefined),
      (url) => (url === "/api/account/password" ? json({ ok: true, signedOutOthers: 0 }) : undefined),
    ]);
    await user.click(await screen.findByRole("button", { name: /Edit name/ }));
    const field = screen.getByLabelText("Display name");
    await user.clear(field);
    await user.type(field, "Ada L.{Enter}");
    await waitFor(() => expect(useStore.getState().session?.user.displayName).toBe("Ada L."));

    await user.click(screen.getByRole("button", { name: "Sign out Safari on iOS" }));
    await waitFor(() => expect(screen.queryByText("Safari on iOS")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Set a password" }));
    expect(screen.queryByLabelText("Current password")).toBeNull();               // none yet, so none asked for
    await user.type(screen.getByLabelText("New password"), "a long new passphrase");
    await user.click(screen.getByRole("button", { name: "Save password" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/account/password")?.body).toEqual({ next: "a long new passphrase" }));
  });

  it("deleting the account needs the email typed exactly", async () => {
    const user = userEvent.setup();
    mount([(url, init) => (url === "/api/account" && init.method === "DELETE" ? json({ ok: true }) : undefined)]);
    await user.click(await screen.findByRole("button", { name: /Delete my account/ }));
    const forever = screen.getByRole("button", { name: "Delete forever" }) as HTMLButtonElement;
    await user.type(screen.getByLabelText(/Type ada@example.com to confirm/), "ada@example.co");
    expect(forever.disabled).toBe(true);
    await user.type(screen.getByLabelText(/Type ada@example.com to confirm/), "m");
    await user.click(forever);
    await waitFor(() => expect(calls.find((c) => c.url === "/api/account" && c.method === "DELETE")?.body).toEqual({ confirmEmail: "ada@example.com" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("names devices from their browser", async () => {
    expect(describeDevice(null).label).toBe("Unknown device");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Firefox/131.0").label).toBe("Firefox on Windows");
  });
});
