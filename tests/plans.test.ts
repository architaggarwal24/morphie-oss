/** Plans (hosted edition): tiers, limits, Morphie AI models, credits, admin grants and spend guardrails. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as adminRoute from "@/app/api/admin/route";
import * as membersRoute from "@/app/api/admin/members/route";
import * as planRoute from "@/app/api/plan/route";
import * as activateRoute from "@/app/api/providers/[id]/activate/route";
import * as providersRoute from "@/app/api/providers/route";
import * as settingsRoute from "@/app/api/settings/route";
import { creditsFor, DEFAULT_MODELS, DEFAULT_PLANS, multiplier, planHighlights, typicalTaskCredits } from "@/lib/plans";
import { DEFAULT_AGENT_SETTINGS, type AgentEvent } from "@/lib/types";
import { runAgent } from "@/server/agent/loop";
import { createConversation, getMessages } from "@/server/conversations";
import { sqliteConn as db } from "@/server/db";
import { _resetPlanCaches, addMonths, applyPlan, assertCapacity, checkLimit, entitlements, monthWindow, planConfig, requireFeature } from "@/server/plans";
import { creditReserver, CreditsError, HostedProvider, resolveHosted } from "@/server/plans/hosted";
import { createProjectFor } from "@/server/code/projects";
import { countProjects } from "@/server/data/projects";
import { listProfiles } from "@/server/profiles";
import { _resetRateLimits } from "@/server/security";
import { metered } from "@/server/usage";
import { testActor } from "./helpers/actor";
import { Scripted } from "./helpers/scripted";
import { makeUser, signIn } from "./helpers/users";
import { Client } from "./helpers/client";

const ENV = { MORPHIE_PLANS: "on", MORPHIE_ADMIN_EMAILS: "boss@example.com", MORPHIE_AI_GEMINI_FREE_KEY: "g-free-key", MORPHIE_AI_ANTHROPIC_KEY: "sk-ant-test", MORPHIE_AI_OPENAI_KEY: "sk-oa-test" };
const DAY = 86_400_000;
let seq = 0;

function on() { Object.assign(process.env, ENV); _resetPlanCaches(); }
function off() { for (const k of Object.keys(ENV)) delete process.env[k]; _resetPlanCaches(); }

/** A signed-in account (verified email unless said otherwise). */
function person(email = `p${++seq}-${Date.now()}@example.com`, verified = true) {
  const u = makeUser(email);
  if (!verified) db().prepare("UPDATE users SET email_verified_at = NULL WHERE id = ?").run(u.userId);
  const c = new Client();
  signIn(c, u.userId);
  return { ...u, c, actor: { userId: u.userId, sessionId: "s" } };
}

function spend(userId: string, model: string, billing: "free" | "paid", credits: number, at = Date.now()) {
  db().prepare("INSERT INTO usage_events (user_id, at, feature, provider, model, input, output, cached, estimated, credits, billing) VALUES (?, ?, 'agent', 'Morphie AI', ?, 1000, 100, 0, 0, ?, ?)")
    .run(userId, at, model, credits, billing);
  _resetPlanCaches();
}

const boss = () => person("boss@example.com");
let bossC: Client;
async function grant(email: string, plan: string, extra: Record<string, unknown> = {}) {
  const r = await bossC.json(membersRoute.POST, "/api/admin/members", { method: "POST", body: { action: "grant", email, plan, days: 30, ...extra } });
  expect(r.status).toBe(200);
  _resetPlanCaches();
  return r.data;
}

beforeEach(() => { _resetRateLimits(); _resetPlanCaches(); });

describe("the plan catalog", () => {
  it("has four tiers that name their usage limits, and twelve models across them", () => {
    expect(DEFAULT_PLANS.map((p) => p.name)).toEqual(["Sketch", "Shape", "Shift", "Morph"]);
    const [sketch, shape, shift, morph] = DEFAULT_PLANS.map((p) => planHighlights(p, DEFAULT_PLANS, DEFAULT_MODELS));
    expect(sketch[0]).toBe("Gemini 3.8 Flash and Gemini 3.5 Flash-Lite");
    expect(sketch.join(" | ")).toMatch(/50 free-model credits a day .*2 projects · 5 documents · 5 designs.*Agent tasks up to 200k tokens/);
    expect(shape[0]).toBe("Everything in Sketch, plus GPT-6 Luna, GPT-6.1 Terra and Claude Haiku 5.5");
    expect(shape.join(" | ")).toMatch(/300 premium credits a month \(up to 100 a day\)/);
    expect(shape.at(-1)).toBe("Your own API keys, skill imports, GitHub repos and web search");
    expect(shift[0]).toBe("Everything in Shape, plus GPT-6.1 Sol, Claude Sonnet 5.5 and Gemini 3.1 Pro");
    expect(morph[0]).toBe("Everything in Shift, plus Claude Opus 5.5, Claude Fable 5.1, GPT-6 Astra and Gemini 4 Argon");
    expect(morph.join(" | ")).toMatch(/2,500 premium credits a month/);
    // ₹ and $, monthly and yearly (two months free).
    for (const p of DEFAULT_PLANS) { expect(p.price.inr.year).toBe(p.price.inr.month * 10); expect(p.price.usd.year).toBe(p.price.usd.month * 10); }
  });

  it("prices calls in credits (1 credit = $0.01 at list price), with cache hits cheaper", () => {
    const opus = DEFAULT_MODELS.find((m) => m.id === "claude-opus-5-5")!;
    expect(creditsFor(opus.price, { input: 1_000_000, output: 0 })).toBe(400);
    expect(creditsFor(opus.price, { input: 1_000_000, cached: 1_000_000, output: 0 })).toBe(40);
    expect(creditsFor(opus.price, { input: 0, output: 100_000 })).toBe(200);
    expect(multiplier(opus, DEFAULT_MODELS)).toBe(40);
    expect(multiplier(DEFAULT_MODELS.find((m) => m.id === "claude-haiku-5-5")!, DEFAULT_MODELS)).toBe(1);
    expect(typicalTaskCredits(DEFAULT_MODELS[0])).toBe(15.75);
  });

  it("billing months follow the plan's start day, clamped to short months", () => {
    const jan31 = Date.UTC(2026, 0, 31, 10);
    expect(new Date(addMonths(jan31, 1)).toISOString().slice(0, 10)).toBe("2026-02-28");
    const w = monthWindow(jan31, Date.UTC(2026, 2, 15));
    expect([new Date(w.start).toISOString().slice(0, 10), new Date(w.end).toISOString().slice(0, 10)]).toEqual(["2026-02-28", "2026-03-31"]);
    const cal = monthWindow(null, Date.UTC(2026, 9, 28, 12));
    expect(new Date(cal.start).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("with plans off (the open-source build)", () => {
  beforeAll(off);
  it("changes nothing: no hosted models, no limits, no plan in the API", async () => {
    const p = person();
    const e = await entitlements(p.actor);
    expect(e.enabled).toBe(false);
    await requireFeature(p.actor, "byok");
    await checkLimit(p.actor, "projects", 10_000);
    expect(applyPlan(DEFAULT_AGENT_SETTINGS, e)).toBe(DEFAULT_AGENT_SETTINGS);
    expect((await listProfiles(p.actor)).profiles).toEqual([]);
    const plan = await p.c.json(planRoute.GET, "/api/plan");
    expect(plan.data.enabled).toBe(false);
    expect((await p.c.json(adminRoute.GET, "/api/admin")).status).toBe(403);
  });
});

describe("with plans on (hosted edition)", () => {
  beforeAll(() => { on(); bossC = boss().c; });
  afterAll(off);

  it("a new account is on Sketch, on the free model, with bigger models shown locked", async () => {
    const p = person();
    const { profiles, activeId } = await listProfiles(p.actor);
    expect(activeId).toBe("morphie:gemini-3.8-flash");
    const by = Object.fromEntries(profiles.map((x) => [x.model, x.hosted]));
    expect(by["gemini-3.8-flash"]).toMatchObject({ tier: "sketch", locked: false, free: true, available: true });
    expect(by["claude-opus-5-5"]).toMatchObject({ tier: "morph", locked: true, multiplier: 40, available: true });
    expect(by["gemini-4-argon"]).toMatchObject({ available: false }); // no paid Gemini key on this server
    const plan = await p.c.json(planRoute.GET, "/api/plan");
    expect(plan.data).toMatchObject({ enabled: true, plan: "sketch", unlimited: false, admin: false, verified: true, hosted: true, usage: { month: 0, today: 0, freeToday: 0, bonus: 0 } });
    expect(plan.data.plans).toHaveLength(4);
  });

  it("Sketch can't use its own keys or locked models, and says which plan can", async () => {
    const p = person();
    const save = await p.c.json(providersRoute.POST, "/api/providers", { method: "POST", body: { kind: "openai", model: "gpt-6-luna", apiKey: "sk-test-123456789012" } });
    expect(save.status).toBe(402);
    expect(save.data).toMatchObject({ code: "plan_required", error: expect.stringContaining("the Shape plan") });
    const locked = await p.c.json(activateRoute.POST, "/api/providers/x/activate", { method: "POST", params: { id: "morphie:claude-opus-5-5" } });
    expect(locked.status).toBe(402);
    expect(locked.data.error).toBe("Claude Opus 5.5 is part of the Morph plan and up. See Settings → Plan.");
    const unset = await p.c.json(activateRoute.POST, "/api/providers/x/activate", { method: "POST", params: { id: "morphie:gemini-4-argon" } });
    expect(unset.status).toBe(400);
    const ok = await p.c.json(activateRoute.POST, "/api/providers/x/activate", { method: "POST", params: { id: "morphie:gemini-3.5-flash-lite" } });
    expect(ok.status).toBe(200);
    expect(ok.data.activeId).toBe("morphie:gemini-3.5-flash-lite");
    // The helper model can be a hosted one too (only ones the plan includes).
    expect((await p.c.json(settingsRoute.PUT, "/api/settings", { method: "PUT", body: { helperProfileId: "morphie:gemini-3.8-flash" } })).data.helperProfileId).toBe("morphie:gemini-3.8-flash");
    expect((await p.c.json(settingsRoute.PUT, "/api/settings", { method: "PUT", body: { helperProfileId: "morphie:gpt-6-astra" } })).status).toBe(402);
  });

  it("limits and features follow the plan", async () => {
    const p = person();
    await expect(checkLimit(p.actor, "projects", 1)).resolves.toBeUndefined();
    await expect(checkLimit(p.actor, "projects", 2)).rejects.toMatchObject({ status: 402, code: "plan_limit", message: "Your Sketch plan includes 2 projects. Delete one, or move up to Shape for 5." });
    await expect(checkLimit(p.actor, "designSystems", 0)).rejects.toMatchObject({ message: "Design systems are part of the Shape plan and up. See Settings → Plan." });
    await expect(requireFeature(p.actor, "skillImports")).rejects.toMatchObject({ code: "plan_required" });
    const s = applyPlan({ ...DEFAULT_AGENT_SETTINGS, taskTokenBudget: 900_000 }, await entitlements(p.actor));
    expect(s.disabledTools).toEqual(expect.arrayContaining(["web_search", "task"]));
    expect(s.taskTokenBudget).toBe(200_000);
  });

  it("projects made at the same moment can't go past the plan's limit together", async () => {
    const p = person();
    const results = await Promise.allSettled([1, 2, 3, 4].map((i) => createProjectFor(p.actor, { name: `p${i}` })));
    expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(2);
    expect(await countProjects(p.actor)).toBeLessThanOrEqual(2);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 402, code: "plan_limit" });
  });

  it("an admin gives plans (even before sign-up), bonus credits, and takes them back; others can't", async () => {
    const p = person();
    expect((await p.c.json(adminRoute.GET, "/api/admin")).status).toBe(403);
    expect((await p.c.json(membersRoute.POST, "/api/admin/members", { method: "POST", body: { action: "grant", email: p.email, plan: "morph", days: 0 } })).status).toBe(403);

    await grant(p.email, "shift");
    expect((await entitlements(p.actor)).plan.id).toBe("shift");
    await requireFeature(p.actor, "byok");
    const { profiles } = await listProfiles(p.actor);
    expect(profiles.find((x) => x.model === "claude-sonnet-5-5")!.hosted!.locked).toBe(false);
    expect(profiles.find((x) => x.model === "claude-opus-5-5")!.hosted!.locked).toBe(true);

    // A plan for someone who hasn't signed up yet applies once they do.
    const later = `later-${Date.now()}@example.com`;
    const listed = await grant(later, "morph", { unlimited: true, days: 0, note: "tester" });
    expect(listed.members[0]).toMatchObject({ email: later, userId: null, plan: "morph", unlimited: true, membership: { note: "tester", endsAt: null } });
    const q = person(later);
    expect(await entitlements(q.actor)).toMatchObject({ plan: { id: "morph" }, unlimited: true });

    // Bonus credits.
    const r = await bossC.json(membersRoute.POST, "/api/admin/members", { method: "POST", body: { action: "credits", email: p.email, credits: 250 } });
    expect(r.status).toBe(200);
    _resetPlanCaches();
    expect((await p.c.json(planRoute.GET, "/api/plan")).data.usage.bonus).toBe(250);

    // Taking it back: Sketch again.
    expect((await bossC.json(membersRoute.POST, "/api/admin/members", { method: "POST", body: { action: "revoke", email: p.email } })).status).toBe(200);
    _resetPlanCaches();
    expect((await entitlements(p.actor)).plan.id).toBe("sketch");
    const search = await bossC.json(membersRoute.GET, `/api/admin/members?q=${encodeURIComponent(p.email)}`);
    expect(search.data.members).toEqual([expect.objectContaining({ email: p.email, plan: "sketch", membership: null })]);
  });

  it("an unverified account gets a smaller free allowance (admin-set), and verifying lifts it", async () => {
    const u = person(`unver-${Date.now()}@example.com`, false);
    expect((await entitlements(u.actor)).plan.limits.freeDailyCredits).toBe(10);
    expect((await u.c.json(planRoute.GET, "/api/plan")).data).toMatchObject({ verified: false, limits: { freeDailyCredits: 10 } });
    spend(u.userId, "gemini-3.8-flash", "free", 10);
    await expect(resolveHosted(u.actor, "morphie:gemini-3.8-flash")).rejects.toMatchObject({ code: "credits" });
    // The admin can change it (0 = no free credits until the email is verified).
    expect((await bossC.json(adminRoute.PUT, "/api/admin", { method: "PUT", body: { unverifiedFreeDaily: 0 } })).data.unverifiedFreeDaily).toBe(0);
    _resetPlanCaches();
    expect((await entitlements(u.actor)).plan.limits.freeDailyCredits).toBe(0);
    // Verified: the plan's own 50.
    db().prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").run(Date.now(), u.userId);
    _resetPlanCaches();
    expect((await entitlements(u.actor)).plan.limits.freeDailyCredits).toBe(50);
    expect((await resolveHosted(u.actor, "morphie:gemini-3.8-flash")).provider.model).toBe("gemini-3.8-flash");
    await bossC.json(adminRoute.PUT, "/api/admin", { method: "PUT", body: { unverifiedFreeDaily: 10 } });
  });

  it("plans only apply to verified emails, end on time, and admins (verified) get everything", async () => {
    const u = person(`unverified-${Date.now()}@example.com`, false);
    await grant(u.email, "morph");
    expect((await entitlements(u.actor)).plan.id).toBe("sketch");
    const p = person();
    await grant(p.email, "shape", { days: 30 });
    db().prepare("UPDATE memberships SET ends_at = ? WHERE email = ?").run(Date.now() - 1000, p.email);
    _resetPlanCaches();
    expect((await entitlements(p.actor)).plan.id).toBe("sketch");
    const b = await entitlements({ userId: (db().prepare("SELECT id FROM users WHERE email = 'boss@example.com'").get() as { id: string }).id, sessionId: "s" });
    expect(b).toMatchObject({ admin: true, unlimited: true, plan: { id: "morph" } });
  });

  it("free models stop at the daily allowance; premium credits fall back to the free model (if allowed)", async () => {
    const p = person();
    spend(p.userId, "gemini-3.8-flash", "free", 50);
    await expect(resolveHosted(p.actor, "morphie:gemini-3.8-flash", { planFallback: true })).rejects.toMatchObject({ status: 402, code: "credits", message: expect.stringContaining("today's free-model credits") });
    // Yesterday's use doesn't count today.
    const q = person();
    spend(q.userId, "gemini-3.8-flash", "free", 500, Date.now() - 2 * DAY);
    expect((await resolveHosted(q.actor, "morphie:gemini-3.8-flash")).provider.model).toBe("gemini-3.8-flash");

    const r = person();
    await grant(r.email, "shift");
    spend(r.userId, "claude-sonnet-5-5", "paid", 300); // the daily cap
    const fell = await resolveHosted(r.actor, "morphie:claude-sonnet-5-5", { planFallback: true });
    expect(fell.fellBack).toBe("Claude Sonnet 5.5");
    expect(fell.provider.model).toBe("gemini-3.8-flash");
    expect(fell.provider.label).toBe("Morphie AI (Claude Sonnet 5.5 credits used up)");
    await expect(resolveHosted(r.actor, "morphie:claude-sonnet-5-5", { planFallback: false })).rejects.toMatchObject({ code: "credits" });
    // The meters show it.
    expect((await r.c.json(planRoute.GET, "/api/plan")).data.usage).toMatchObject({ month: 300, today: 300 });
  });

  it("a hosted model stops before the call that would go past the credits, and every call is metered in credits", async () => {
    const p = person();
    const conv = await createConversation(testActor(p.userId), "chat");
    const hosted = new HostedProvider(new Scripted([{ content: "one", usage: { input: 1_000_000, output: 0 } }, { content: "two" }]), { modelId: "claude-opus-5-5", kind: "paid", price: { input: 4, output: 20, cached: 0.4 } }, 300, "Out of credits.", "Morphie AI");
    const m = metered(hosted, { actor: p.actor, feature: "chat", conversationId: conv.id });
    await m.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(hosted.creditsLeft).toBe(-100);
    await expect(m.chat({ messages: [{ role: "user", content: "again" }] })).rejects.toBeInstanceOf(CreditsError);
    const rows = db().prepare("SELECT credits, billing, model FROM usage_events WHERE user_id = ?").all(p.userId);
    expect(rows).toEqual([{ credits: 400, billing: "paid", model: "test" }]);
  });

  it("parallel runs can't spend the same credits twice: each call holds its credits until its cost is recorded", async () => {
    const p = person();
    spend(p.userId, "gemini-3.8-flash", "free", 40); // 10 of Sketch's 50 free credits left today
    const e = await entitlements(p.actor);
    const model = e.cfg.models.find((m) => m.id === "gemini-3.8-flash")!;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const slow = { kind: "gemini", label: "t", model: "gemini-3.8-flash", nativeTools: false, vision: false, contextWindow: 1e6,
      listModels: async () => [], chat: async () => { await gate; return { content: "done", toolCalls: [], usage: { input: 1000, output: 100 } }; } };
    // Two runs started at the same moment: each one's own count says 10 credits are left.
    const a = new HostedProvider(slow as never, { modelId: model.id, kind: "free", price: model.price }, 10, "Out of free credits.", "Morphie AI", creditReserver(p.actor, e, model));
    const b = new HostedProvider(slow as never, { modelId: model.id, kind: "free", price: model.price }, 10, "Out of free credits.", "Morphie AI", creditReserver(p.actor, e, model));
    const ma = metered(a, { actor: p.actor, feature: "agent" }), mb = metered(b, { actor: p.actor, feature: "agent" });
    const first = ma.chat({ messages: [{ role: "user", content: "big job" }], maxTokens: 10_000_000 });
    await new Promise((r) => setTimeout(r, 20)); // a's hold is in place
    await expect(mb.chat({ messages: [{ role: "user", content: "another" }], maxTokens: 10_000_000 })).rejects.toBeInstanceOf(CreditsError);
    open();
    await first;
    // a's real cost is recorded and its hold is gone; b never ran.
    expect(db().prepare("SELECT COUNT(*) AS n FROM credit_holds WHERE user_id = ?").get(p.userId)).toEqual({ n: 0 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ? AND billing = 'free'").get(p.userId)).toEqual({ n: 2 });
    // A call that fails outright releases its hold at once.
    const failing = new HostedProvider({ ...slow, chat: async () => { throw new Error("boom"); } } as never, { modelId: model.id, kind: "free", price: model.price }, 10, "x", "Morphie AI", creditReserver(p.actor, e, model));
    await expect(metered(failing, { actor: p.actor, feature: "agent" }).chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow("boom");
    expect(db().prepare("SELECT COUNT(*) AS n FROM credit_holds WHERE user_id = ?").get(p.userId)).toEqual({ n: 0 });
  });
  it("running out of credits mid-task pauses the agent (Continue picks it up)", async () => {
    const actor = testActor(`credits_${Date.now()}_abcdefgh`);
    const conv = await createConversation(actor, "agent");
    const events: AgentEvent[] = [];
    const hosted = new HostedProvider(new Scripted([]), { modelId: "gpt-6.1-sol", kind: "paid", price: { input: 2, output: 10 } }, 0, "You've used your Shift plan's premium credits for now.", "Morphie AI");
    await runAgent({ actor, conversationId: conv.id, mode: "agent", message: "build it", provider: hosted, signal: new AbortController().signal, settings: { ...DEFAULT_AGENT_SETTINGS, memory: false }, emit: (e) => events.push(e) });
    expect(events.find((e) => e.type === "notice")).toMatchObject({ text: "You've used your Shift plan's premium credits for now." });
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "credits", continuable: true });
    const last = (await getMessages(actor, conv.id)).at(-1)!;
    expect(last.meta).toMatchObject({ reason: "credits", continuable: true });
  });

  it("a vendor at its monthly budget pauses its models for everyone (free-tier Gemini on its own key never counts)", async () => {
    const cfg = await planConfig();
    const p = person();
    spend(p.userId, "claude-haiku-5-5", "paid", 5_000); // $50
    const haiku = cfg.models.find((m) => m.id === "claude-haiku-5-5")!;
    await expect(assertCapacity(haiku, cfg)).rejects.toMatchObject({ status: 503, code: "capacity" });
    spend(p.userId, "gemini-3.8-flash", "free", 9_000);
    await expect(assertCapacity(cfg.models.find((m) => m.id === "gemini-3.8-flash")!, cfg)).resolves.toBeUndefined();
    const o = await bossC.json(adminRoute.GET, "/api/admin");
    const anthropic = o.data.spend.find((s: { vendor: string }) => s.vendor === "anthropic");
    expect(anthropic).toMatchObject({ budget: 50, keyed: true });
    expect(anthropic.usd).toBeGreaterThanOrEqual(50);
    expect(o.data.spend.find((s: { vendor: string }) => s.vendor === "gemini").free.usd).toBeGreaterThanOrEqual(90);
    // Raising the budget lets them through again.
    const up = await bossC.json(adminRoute.PUT, "/api/admin", { method: "PUT", body: { budgets: { gemini: 50, openai: 50, anthropic: 500 } } });
    expect(up.status).toBe(200);
    await expect(assertCapacity(haiku, await planConfig())).resolves.toBeUndefined();
  });

  it("admins edit plans and models; the plan cards and limits follow", async () => {
    const o = (await bossC.json(adminRoute.GET, "/api/admin")).data;
    const plans = o.plans.map((p: any) => (p.id === "sketch" ? { ...p, limits: { ...p.limits, projects: 3, freeDailyCredits: 80 } } : p));
    const r = await bossC.json(adminRoute.PUT, "/api/admin", { method: "PUT", body: { plans } });
    expect(r.status).toBe(200);
    const p = person();
    await expect(checkLimit(p.actor, "projects", 2)).resolves.toBeUndefined();
    const st = (await p.c.json(planRoute.GET, "/api/plan")).data;
    expect(planHighlights(st.plans[0], st.plans, st.models).join(" ")).toContain("80 free-model credits a day");
    // The default model has to be a free-plan one.
    expect((await bossC.json(adminRoute.PUT, "/api/admin", { method: "PUT", body: { defaultModel: "claude-opus-5-5" } })).status).toBe(400);
    // Turning a model off hides it.
    const models = o.models.map((m: any) => (m.id === "gpt-6-luna" ? { ...m, enabled: false } : m));
    expect((await bossC.json(adminRoute.PUT, "/api/admin", { method: "PUT", body: { models } })).status).toBe(200);
    expect((await listProfiles(p.actor)).profiles.some((x) => x.model === "gpt-6-luna")).toBe(false);
    expect((await bossC.json(adminRoute.PUT, "/api/admin", { method: "PUT", body: { reset: true } })).data.plans[0].limits.projects).toBe(2);
  });
});
