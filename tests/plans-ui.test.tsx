// @vitest-environment jsdom
/** Settings → Plan, Settings → Admin, the composer's model picker with Morphie AI, and "See plans" on refusals. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderChip } from "@/components/chat/ProviderChip";
import { AdminSection } from "@/components/settings/AdminSection";
import { PlanSection } from "@/components/settings/PlanSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { SettingsView } from "@/components/settings/SettingsView";
import { api } from "@/lib/api";
import { DEFAULT_MODELS, DEFAULT_PLANS, hostedProfileId, multiplier, planIncludes, type PlanId } from "@/lib/plans";
import { useStore } from "@/lib/store";
import { DEFAULT_AGENT_SETTINGS, type AdminOverview, type AdminPayments, type MemberView, type OrderView, type PlanStatus, type ProfileView } from "@/lib/types";

const initial = useStore.getInitialState();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let calls: Array<{ url: string; method: string; body: any }> = [];
let routes: Array<(url: string, method: string, body: any) => Response | undefined> = [];

const DAY = 86_400_000;
const status = (plan: PlanId, over: Partial<PlanStatus> = {}): PlanStatus => ({
  enabled: true, plan, unlimited: false, admin: false, verified: true, membership: plan === "sketch" ? null : { source: "admin", billing: null, startsAt: Date.UTC(2026, 9, 3), endsAt: null },
  usage: { month: 120, today: 40, freeToday: 12.5, bonus: 0 }, period: { start: Date.UTC(2026, 9, 3), end: Date.UTC(2026, 10, 3) }, day: { start: Date.now() - 1000, end: Date.now() + DAY },
  plans: DEFAULT_PLANS, models: DEFAULT_MODELS.map((m) => ({ ...m, multiplier: multiplier(m, DEFAULT_MODELS), available: m.id !== "gemini-4-argon" })), hosted: true, ...over,
});
const hostedProfiles = (plan: PlanId): ProfileView[] => DEFAULT_MODELS.map((m) => ({
  id: hostedProfileId(m.id), kind: m.vendor, label: "Morphie AI", model: m.id, hasKey: true, keyHint: "Included", options: {}, updatedAt: 0,
  hosted: { tier: m.tier, locked: !planIncludes(plan, m), free: m.free, multiplier: multiplier(m, DEFAULT_MODELS), blurb: m.blurb, available: m.id !== "gemini-4-argon" },
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
});
beforeEach(() => {
  calls = []; routes = [];
  class RO { observe() {} unobserve() {} disconnect() {} }
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ url, method, body });
    for (const r of routes) { const res = r(url, method, body); if (res) return res; }
    if (url === "/api/plan") return json(useStore.getState().plan);
    if (url === "/api/billing" && method === "GET") return json({ upi: { enabled: false, payee: "", vpa: "" }, autoConfirm: false, usd: false, orders: [] });
    return json({ error: `unmocked ${method} ${url}` }, 404);
  }));
  useStore.setState(initial, true);
  useStore.setState({ settings: { ...DEFAULT_AGENT_SETTINGS }, session: { user: { email: "ada@example.com", displayName: "Ada" }, expiresAt: Date.now() + DAY, idleExpiresAt: Date.now() + DAY } as never });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Settings → Plan", () => {
  it("shows the plan, its credit meters, and the four plans with prices and usage limits", async () => {
    useStore.setState({ plan: status("shift") });
    render(<PlanSection />);
    expect(screen.getByTestId("current-plan").textContent).toBe("Shift");
    expect(within(screen.getByTestId("meter-month")).getByText("120 / 1,000")).toBeTruthy();
    expect(within(screen.getByTestId("meter-today")).getByText("40 / 300")).toBeTruthy();
    expect(within(screen.getByTestId("meter-free")).getByText("12.5 / 200")).toBeTruthy();
    expect(screen.getByText(/credits renew on the 3rd of each month/)).toBeTruthy();
    // ₹ / $ and monthly / yearly.
    fireEvent.click(screen.getByRole("radio", { name: "₹ INR" }));
    expect(within(screen.getByTestId("plan-shape")).getByText("₹499")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "$ USD" }));
    fireEvent.click(screen.getByRole("radio", { name: /Yearly/ }));
    expect(within(screen.getByTestId("plan-morph")).getByText("$490")).toBeTruthy();
    expect(within(screen.getByTestId("plan-sketch")).getByText(/50 free-model credits a day/)).toBeTruthy();
    expect(within(screen.getByTestId("plan-morph")).getByText(/2,500 premium credits a month \(up to 800 a day\)/)).toBeTruthy();
    expect(within(screen.getByTestId("plan-shift")).getByRole("button", { name: "Current plan" })).toBeTruthy();
    // Models: what's included, what needs a bigger plan.
    expect(within(screen.getByTestId("model-claude-opus-5-5")).getByText("Morph")).toBeTruthy();
    expect(within(screen.getByTestId("model-claude-sonnet-5-5")).getByText("Included")).toBeTruthy();
    expect(within(screen.getByTestId("model-gemini-4-argon")).getByText("Not set up")).toBeTruthy();
    // Without payments set up, upgrading explains how to get it for now.
    fireEvent.click(screen.getByRole("radio", { name: "₹ INR" }));
    fireEvent.click(within(screen.getByTestId("plan-morph")).getByRole("button", { name: "Get Morph" }));
    expect(await screen.findByText(/An admin can move your account to Morph/)).toBeTruthy();
  });

  it("an unverified account sees its smaller free allowance and how to get the full one", async () => {
    const sketch = DEFAULT_PLANS.find((p) => p.id === "sketch")!;
    useStore.setState({ plan: { ...status("sketch"), verified: false, limits: { ...sketch.limits, freeDailyCredits: 10 } } });
    render(<PlanSection />);
    expect(within(screen.getByTestId("meter-free")).getByText("12.5 / 10")).toBeTruthy();
    expect(within(screen.getByTestId("meter-free")).getByText(/verify your email for 50 a day/)).toBeTruthy();
  });
  it("the free-model fallback is a setting", async () => {
    useStore.setState({ plan: status("shape") });
    routes.push((url, method, body) => (url === "/api/settings" && method === "PUT" ? json({ ...DEFAULT_AGENT_SETTINGS, ...body }) : undefined));
    render(<PlanSection />);
    await act(async () => { fireEvent.click(screen.getByRole("switch", { name: "Keep going on a free model" })); });
    expect(calls.find((c) => c.url === "/api/settings")!.body).toEqual({ planFallback: false });
  });

  it("unlimited accounts see usage without caps; Plan and Admin only appear when they apply", async () => {
    useStore.setState({ plan: status("morph", { unlimited: true, admin: true }), admin: true });
    render(<SettingsView />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("button", { name: /Plan & credits/ })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: /Admin/ })).toBeTruthy();
    cleanup();
    useStore.setState({ plan: null, admin: false });
    render(<SettingsView />);
    expect(within(screen.getByRole("navigation", { name: "Settings sections" })).queryByRole("button", { name: /Plan & credits|Admin/ })).toBeNull();
  });
});

describe("checkout", () => {
  const order = (over: Partial<OrderView> = {}): OrderView => ({ id: "MOABCD2345", plan: "shift", period: "month", currency: "inr", amount: 149_937, method: "upi", status: "pending", utr: null, createdAt: Date.now(), expiresAt: Date.now() + DAY, paidAt: null, reason: null, upi: { uri: "upi://pay?pa=me%40okhdfcbank&pn=Morphie&am=1499.37&cu=INR&tn=MOABCD2345", vpa: "me@okhdfcbank", payee: "Morphie" }, ...over });

  it("pays by UPI: exact amount and QR, then the UTR, then waits for the confirmation", async () => {
    useStore.setState({ plan: status("shape") });
    let current = order();
    routes.push((url, method, body) => {
      if (url === "/api/billing" && method === "GET") return json({ upi: { enabled: true, payee: "Morphie", vpa: "me@okhdfcbank" }, autoConfirm: true, usd: false, orders: [] });
      if (url === "/api/billing" && method === "POST") return json({ order: current, upi: { enabled: true, payee: "Morphie", vpa: "me@okhdfcbank" }, autoConfirm: true, usd: false, orders: [current] });
      if (url === "/api/billing/orders/MOABCD2345" && method === "POST") { current = order({ status: "submitted", utr: body.utr }); return json({ order: current }); }
      return undefined;
    });
    render(<PlanSection />);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/billing")).toBe(true));
    fireEvent.click(screen.getByRole("radio", { name: "₹ INR" }));
    fireEvent.click(within(screen.getByTestId("plan-shift")).getByRole("button", { name: "Get Shift" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "$ Card" }));
    expect(within(dialog).getByText(/coming soon/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("radio", { name: "₹ UPI" }));
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Pay ₹1,499 with UPI" })); });
    expect(calls.find((c) => c.url === "/api/billing" && c.method === "POST")!.body).toEqual({ plan: "shift", period: "month", currency: "inr" });
    expect(within(dialog).getByTestId("pay-amount").textContent).toContain("₹1,499.37");
    expect(within(dialog).getByRole("img", { name: "UPI QR code for ₹1,499.37" }).innerHTML).toContain("<svg");
    expect(within(dialog).getByText("me@okhdfcbank")).toBeTruthy();
    const send = within(dialog).getByRole("button", { name: "I've paid" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("After paying, enter the UPI reference"), { target: { value: "4302 1234 5678" } });
    await act(async () => { fireEvent.click(send); });
    expect(calls.find((c) => c.url === "/api/billing/orders/MOABCD2345")!.body).toEqual({ action: "submit", utr: "430212345678" });
    expect(within(dialog).getByTestId("checkout-waiting").textContent).toContain("430212345678");
  });
});

describe("Morphie AI in the model picker and Providers", () => {
  it("groups Morphie AI and your keys; a locked model points at the plan that has it", async () => {
    useStore.setState({ plan: status("shape"), profiles: hostedProfiles("shape"), activeId: "morphie:gemini-3.8-flash" });
    render(<ProviderChip />);
    fireEvent.click(screen.getByRole("button", { name: /Gemini 3.8 Flash/ }));
    const list = screen.getByRole("listbox", { name: "Switch provider" });
    expect(within(list).getByText("Morphie AI")).toBeTruthy();
    expect(within(list).queryByText("Gemini 4 Argon")).toBeNull(); // not set up on this server
    routes.push((url) => (url.endsWith("/activate") ? json({ profiles: hostedProfiles("shape"), activeId: "morphie:claude-haiku-5-5" }) : undefined));
    await act(async () => { fireEvent.click(within(list).getByRole("option", { name: /Claude Haiku 5.5/ })); });
    expect(calls.find((c) => c.url.endsWith("/activate"))!.url).toBe("/api/providers/morphie:claude-haiku-5-5/activate");
    fireEvent.click(screen.getByRole("button", { name: /Claude Haiku 5.5/ }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Switch provider" })).getByRole("option", { name: /Claude Opus 5.5/ }));
    const toast = useStore.getState().toasts.at(-1)!;
    expect(toast.text).toBe("Claude Opus 5.5 is part of Morph and up.");
    act(() => toast.action!.run());
    expect(useStore.getState()).toMatchObject({ tab: "settings", settingsSection: "plan" });
  });

  it("Providers shows Morphie AI, and own keys locked on Sketch", () => {
    const own: ProfileView = { id: "p_own12345", kind: "openai", label: "OpenAI", model: "gpt-6-luna", hasKey: true, keyHint: "••••1234", options: {}, updatedAt: 1, paused: true };
    useStore.setState({ plan: status("sketch"), profiles: [...hostedProfiles("sketch"), own], activeId: "morphie:gemini-3.8-flash" });
    render(<ProvidersSection />);
    expect(within(screen.getByTestId("hosted-gemini-3.8-flash")).getByText("Active")).toBeTruthy();
    expect(within(screen.getByTestId("hosted-claude-sonnet-5-5")).getByRole("button", { name: "Claude Sonnet 5.5 needs Shift" })).toBeTruthy();
    expect(screen.getByTestId("byok-locked").textContent).toContain("Shape and up");
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add provider/ })).toBeNull();
  });

  it("a plan refusal from the server gets a See plans button on its toast", async () => {
    useStore.setState({ plan: status("sketch") });
    routes.push((url) => (url === "/api/skills" ? json({ error: "Adding your own skills is part of the Shape plan and up. See Settings → Plan.", code: "plan_required" }, 402) : undefined));
    try { await api("/api/skills", { method: "POST", body: {} }); } catch (e) { useStore.getState().toast("error", (e as Error).message); }
    expect(useStore.getState().toasts.at(-1)!.action?.label).toBe("See plans");
  });
});

describe("Settings → Admin", () => {
  const overview = (): AdminOverview => ({
    enabled: true, plans: DEFAULT_PLANS, models: DEFAULT_MODELS, budgets: { gemini: 50, openai: 50, anthropic: 50 }, defaultModel: "gemini-3.8-flash", unverifiedFreeDaily: 10,
    spend: [
      { vendor: "gemini", usd: 1.2, budget: 50, calls: 20, keyed: true, free: { usd: 3, calls: 90 } },
      { vendor: "openai", usd: 0, budget: 50, calls: 0, keyed: false },
      { vendor: "anthropic", usd: 42, budget: 50, calls: 300, keyed: true },
    ],
    monthStart: Date.UTC(2026, 9, 1), counts: { users: 7, byPlan: { morph: 2 } }, keys: { openai: false, anthropic: true, gemini: false, geminiFree: true }, admins: ["boss@example.com"],
  });
  const member = (over: Partial<MemberView>): MemberView => ({ userId: "u1", email: "ada@example.com", verified: true, createdAt: 1, lastSeenAt: 2, plan: "sketch", unlimited: false, admin: false, membership: null, credits30: 12, ...over });

  it("lists members and gives a plan with no limits", async () => {
    let list = [member({}), member({ userId: null, email: "soon@example.com", verified: false, plan: "morph", unlimited: true, membership: { source: "admin", billing: null, startsAt: 1, endsAt: null, note: "tester" } })];
    routes.push((url, method, body) => {
      if (url === "/api/admin" && method === "GET") return json(overview());
      if (url.startsWith("/api/admin/members") && method === "GET") return json({ members: list });
      if (url === "/api/admin/members" && method === "POST") { list = [member({ plan: body.plan, unlimited: body.unlimited, membership: { source: "admin", billing: null, startsAt: 1, endsAt: null, note: body.note } })]; return json({ members: list }); }
      return undefined;
    });
    render(<AdminSection />);
    expect(await screen.findByTestId("member-ada@example.com")).toBeTruthy();
    expect(within(screen.getByTestId("member-soon@example.com")).getByText("Not signed up")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("member-ada@example.com")).getByRole("button", { name: "Give plan" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Morph" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "No limits" }));
    fireEvent.change(within(dialog).getByLabelText("Note (only admins see it)"), { target: { value: "me" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Save" })); });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ action: "grant", email: "ada@example.com", plan: "morph", days: 30, unlimited: true, note: "me" });
    await waitFor(() => expect(within(screen.getByTestId("member-ada@example.com")).getByText("Morph")).toBeTruthy());
  });

  it("Payments: checks an order and approves it; pastes a bank alert", async () => {
    const pay = (): AdminPayments => ({
      settings: { upi: { enabled: true, vpa: "me@okhdfcbank", payee: "Morphie" }, email: { enabled: false, domains: [] } }, inboundReady: false, inbox: [],
      orders: [{ id: "MOABCD2345", email: "ada@example.com", plan: "shift", period: "month", currency: "inr", amount: 149_937, method: "upi", status: "submitted", utr: "430212345678", createdAt: 1, expiresAt: 2, paidAt: null, reason: null }],
    });
    routes.push((url, method, body) => {
      if (url === "/api/admin" && method === "GET") return json(overview());
      if (url.startsWith("/api/admin/members")) return json({ members: [] });
      if (url === "/api/admin/payments" && method === "GET") return json(pay());
      if (url === "/api/admin/payments" && method === "POST") return json({ ...pay(), orders: [], ...(body.action === "check" ? { result: { outcome: "unmatched", reason: "No open order has this amount." } } : {}) });
      return undefined;
    });
    render(<AdminSection />);
    await screen.findByText("No one matches.");
    fireEvent.click(screen.getByRole("tab", { name: "Payments" }));
    const row = await screen.findByTestId("admin-order-MOABCD2345");
    expect(row.textContent).toContain("₹1,499.37");
    expect(row.textContent).toContain("430212345678");
    expect(screen.getByText(/Set MORPHIE_INBOUND_SECRET/)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Mark paid" })); });
    expect(calls.find((c) => c.url === "/api/admin/payments" && c.method === "POST")!.body).toEqual({ action: "approve", order: "MOABCD2345" });
    fireEvent.change(screen.getByLabelText("Paste a bank alert"), { target: { value: "INR 12.00 credited. UPI Ref 430200000000" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check" })); });
    expect(calls.filter((c) => c.method === "POST").at(-1)!.body).toEqual({ action: "check", raw: "Subject: Pasted alert\r\n\r\nINR 12.00 credited. UPI Ref 430200000000" });
    expect(screen.getByText("unmatched: No open order has this amount.")).toBeTruthy();
  });

  it("shows spend against budgets with a warning past 80%", async () => {
    routes.push((url, method) => (url === "/api/admin" && method === "GET" ? json(overview()) : url.startsWith("/api/admin/members") ? json({ members: [] }) : undefined));
    render(<AdminSection />);
    await screen.findByText("No one matches.");
    fireEvent.click(screen.getByRole("tab", { name: "Spend" }));
    expect(within(screen.getByTestId("spend-anthropic")).getByText("Over 80% of the budget.")).toBeTruthy();
    expect(within(screen.getByTestId("spend-openai")).getByText("No key")).toBeTruthy();
    expect(within(screen.getByTestId("spend-gemini")).getByText(/90 free-tier calls/)).toBeTruthy();
    // The free allowance for unverified accounts is saved with the budgets.
    routes.unshift((url, method) => (url === "/api/admin" && method === "PUT" ? json({ ...overview(), unverifiedFreeDaily: 0 }) : undefined));
    fireEvent.change(screen.getByLabelText("Credits / day"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save budgets" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin" && c.method !== "GET")?.body).toMatchObject({ unverifiedFreeDaily: 0 }));
  });
});
