/**
 * Plans (hosted edition): who is on which plan, what it allows, and how many credits are left.
 *
 * Everything here is a no-op unless MORPHIE_PLANS is on: the open-source build has no plans, no limits and no hosted
 * AI, and then none of these functions touch the database. With plans on:
 *  - a verified email's membership (granted by an admin, or bought) picks the plan; anyone else is on Sketch (free);
 *  - MORPHIE_ADMIN_EMAILS (verified) are admins, with the top plan and no limits;
 *  - limits (projects, documents, designs…) and features (own keys, skill imports…) are checked where things are made;
 *  - Morphie AI calls are metered in credits (src/server/plans/hosted.ts).
 */
import {
  DEFAULT_MODELS, DEFAULT_PLANS, FEATURE_LABEL, firstPlanWith, isPlanId, multiplier, PLAN_ORDER,
  type HostedModel, type PlanDef, type PlanFeatures, type PlanId, type PlanLimits, type Vendor,
} from "@/lib/plans";
import type { AgentSettings, PlanStatus, PlanUsage, VendorSpend } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { config } from "../config";
import * as store from "../data/plans";
import { now } from "../db";
import { ApiError } from "../http";

// ------------------------------------------------------------------ configuration (admin-edited)

export interface PlanConfig {
  plans: PlanDef[]; models: HostedModel[]; budgets: Record<Vendor, number>; defaultModel: string;
  /** Free-model credits a day for an account whose email isn't verified (accounts are free to make, so farmable). */
  unverifiedFreeDaily: number;
}
interface StoredConfig { plans?: Array<Partial<PlanDef> & { id: string }>; models?: HostedModel[]; knownDefaults?: string[]; budgets?: Partial<Record<Vendor, number>>; defaultModel?: string; unverifiedFreeDaily?: number }

/** Monthly Morphie AI spend (USD, list price) per vendor before its models pause for everyone. 0 = no cap. */
export const DEFAULT_BUDGETS: Record<Vendor, number> = { gemini: 50, openai: 50, anthropic: 50 };
export const DEFAULT_MODEL = "gemini-3.8-flash";
export const DEFAULT_UNVERIFIED_FREE_DAILY = 10;
const CONFIG_KEY = "plans";
const CONFIG_TTL = 30_000;

let cfgCache: { at: number; cfg: PlanConfig } | null = null;
const entCache = new Map<string, { at: number; ent: Entitlements }>();
const ENT_TTL = 3_000;

export function _resetPlanCaches(): void { cfgCache = null; entCache.clear(); spendCache = null; }

/** Defaults, with the admin's saved changes on top. Models shipped after the admin last saved are added. */
export function mergeConfig(stored: StoredConfig | undefined): PlanConfig {
  const s = stored ?? {};
  const plans = DEFAULT_PLANS.map((d) => {
    const o = s.plans?.find((p) => p.id === d.id);
    if (!o) return d;
    return {
      ...d, ...o, id: d.id,
      limits: { ...d.limits, ...o.limits }, features: { ...d.features, ...o.features },
      price: { inr: { ...d.price.inr, ...o.price?.inr }, usd: { ...d.price.usd, ...o.price?.usd } },
    } as PlanDef;
  });
  let models = DEFAULT_MODELS;
  if (s.models?.length) {
    const known = new Set(s.knownDefaults ?? []);
    models = [...s.models.filter((m) => m && typeof m.id === "string" && isPlanId(m.tier)), ...DEFAULT_MODELS.filter((d) => !known.has(d.id) && !s.models!.some((m) => m.id === d.id))];
  }
  const defaultModel = s.defaultModel && models.some((m) => m.id === s.defaultModel) ? s.defaultModel : DEFAULT_MODEL;
  const unverifiedFreeDaily = typeof s.unverifiedFreeDaily === "number" && s.unverifiedFreeDaily >= 0 ? s.unverifiedFreeDaily : DEFAULT_UNVERIFIED_FREE_DAILY;
  return { plans, models, budgets: { ...DEFAULT_BUDGETS, ...s.budgets }, defaultModel, unverifiedFreeDaily };
}

export async function planConfig(): Promise<PlanConfig> {
  if (cfgCache && Date.now() - cfgCache.at < CONFIG_TTL) return cfgCache.cfg;
  const cfg = mergeConfig((await store.readConfig(CONFIG_KEY)) as StoredConfig | undefined);
  cfgCache = { at: Date.now(), cfg };
  return cfg;
}

export async function savePlanConfig(cfg: PlanConfig): Promise<PlanConfig> {
  const stored: StoredConfig = { plans: cfg.plans, models: cfg.models, knownDefaults: DEFAULT_MODELS.map((m) => m.id), budgets: cfg.budgets, defaultModel: cfg.defaultModel, unverifiedFreeDaily: cfg.unverifiedFreeDaily };
  await store.writeConfig(CONFIG_KEY, stored);
  _resetPlanCaches();
  return planConfig();
}

export async function resetPlanConfig(): Promise<PlanConfig> {
  await store.writeConfig(CONFIG_KEY, {});
  _resetPlanCaches();
  return planConfig();
}

// ------------------------------------------------------------------ time windows (UTC)

const DAY = 86_400_000;
export function dayWindow(t: number): { start: number; end: number } {
  const start = Math.floor(t / DAY) * DAY;
  return { start, end: start + DAY };
}

/** `t` plus `k` months, keeping the day of the month where it exists (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(t: number, k: number): number {
  const d = new Date(t);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target.getTime();
}

/** The billing month containing `t`: from the plan's start date each month, or the calendar month without a plan. */
export function monthWindow(anchor: number | null, t: number): { start: number; end: number } {
  if (!anchor || anchor > t) {
    const d = new Date(t);
    return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
  }
  const a = new Date(anchor), b = new Date(t);
  let k = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  while (k > 0 && addMonths(anchor, k) > t) k--;
  while (addMonths(anchor, k + 1) <= t) k++;
  return { start: addMonths(anchor, k), end: addMonths(anchor, k + 1) };
}

// ------------------------------------------------------------------ entitlements

export interface Entitlements {
  enabled: boolean;
  plan: PlanDef;
  unlimited: boolean;
  admin: boolean;
  email: string | null;
  verified: boolean;
  membership: { source: string; billing: string | null; startsAt: number; endsAt: number | null } | null;
  period: { start: number; end: number };
  day: { start: number; end: number };
  cfg: PlanConfig;
}

const NO_LIMITS: PlanLimits = { monthlyCredits: Infinity, dailyCredits: Infinity, freeDailyCredits: Infinity, projects: Infinity, documents: Infinity, designs: Infinity, designSystems: Infinity, taskTokenBudget: Infinity };
const ALL_FEATURES: PlanFeatures = { byok: true, skillImports: true, githubRepos: true, webSearch: true, subagents: true };

export const plansEnabled = (): boolean => config.plansEnabled;

/** Is this verified email one of MORPHIE_ADMIN_EMAILS? */
export const isAdminEmail = (email: string | null | undefined, verified: boolean): boolean => !!email && verified && config.adminEmails.includes(email.toLowerCase());

/** What this user's plan allows right now. Free of database reads when plans are off. */
export async function entitlements(actor: Actor, t = now()): Promise<Entitlements> {
  if (!config.plansEnabled) {
    const open: PlanDef = { ...DEFAULT_PLANS[DEFAULT_PLANS.length - 1], limits: NO_LIMITS, features: ALL_FEATURES };
    return { enabled: false, plan: open, unlimited: true, admin: false, email: null, verified: false, membership: null, period: monthWindow(null, t), day: dayWindow(t), cfg: mergeConfig(undefined) };
  }
  const hit = entCache.get(actor.userId);
  if (hit && Date.now() - hit.at < ENT_TTL) return hit.ent;
  const [row, cfg] = await Promise.all([store.accountPlanRow(actor), planConfig()]);
  const verified = row?.email_verified_at != null;
  const email = row?.email?.toLowerCase() ?? null;
  const admin = isAdminEmail(email, verified);
  const live = row?.plan && isPlanId(row.plan) && row.starts_at != null && row.starts_at <= t && (row.ends_at == null || row.ends_at > t);
  const planId: PlanId = admin ? "morph" : live ? (row!.plan as PlanId) : "sketch";
  const base = cfg.plans.find((p) => p.id === planId)!;
  // An unverified account (password sign-up, no proof it owns the address) gets a smaller free allowance: accounts
  // cost nothing to make, and the free models run on the server's key. Verifying lifts it to the plan's own.
  const plan = verified ? base : { ...base, limits: { ...base.limits, freeDailyCredits: Math.min(base.limits.freeDailyCredits, cfg.unverifiedFreeDaily) } };
  const membership = live ? { source: row!.source ?? "admin", billing: row!.billing, startsAt: row!.starts_at!, endsAt: row!.ends_at } : null;
  const ent: Entitlements = {
    enabled: true, plan, unlimited: admin || (!!live && !!row!.unlimited), admin, email, verified, membership,
    period: monthWindow(membership?.startsAt ?? null, t), day: dayWindow(t), cfg,
  };
  entCache.set(actor.userId, { at: Date.now(), ent });
  return ent;
}

export function forgetEntitlements(userId?: string): void {
  if (userId) entCache.delete(userId); else entCache.clear();
}

/** Admin rights (Settings → Admin). Works with plans on or off, so the owner can set plans up before turning them on. */
export async function isAdmin(actor: Actor): Promise<boolean> {
  if (!config.adminEmails.length) return false;
  const row = await store.accountPlanRow(actor);
  return isAdminEmail(row?.email, row?.email_verified_at != null);
}

export async function requireAdmin(actor: Actor): Promise<string> {
  const row = await store.accountPlanRow(actor);
  if (!isAdminEmail(row?.email, row?.email_verified_at != null)) throw new ApiError(403, "Only admins can do that.", "forbidden");
  return row!.email!.toLowerCase();
}

/** Refuse a feature the plan doesn't include, naming the plan that does. */
export async function requireFeature(actor: Actor, feature: keyof PlanFeatures): Promise<void> {
  const e = await entitlements(actor);
  if (!e.enabled || e.plan.features[feature]) return;
  const up = firstPlanWith(e.cfg.plans, (p) => p.features[feature]);
  throw new ApiError(402, `${FEATURE_LABEL[feature]} ${feature === "webSearch" || feature === "subagents" ? "are" : "is"} part of ${up ? `the ${up.name} plan` : "a paid plan"} and up. See Settings → Plan.`, "plan_required");
}

const NOUNS = { projects: ["project", "projects"], documents: ["document", "documents"], designs: ["design", "designs"], designSystems: ["design system", "design systems"] } as const;
export type CountedThing = keyof typeof NOUNS;

/** Refuse making one more of something when the plan's limit is reached (`current` = how many exist now). */
export async function checkLimit(actor: Actor, thing: CountedThing, current: number | (() => Promise<number>)): Promise<void> {
  const e = await entitlements(actor);
  if (!e.enabled) return;
  const limit = e.plan.limits[thing];
  const n = typeof current === "function" ? await current() : current;
  if (n < limit) return;
  throw limitError(e, thing, limit);
}

/**
 * The second half of a counted limit: after making the new one, count again and take it back if two requests at
 * the same moment both got past checkLimit. Check-then-insert alone lets parallel requests go over the limit.
 */
export async function recheckLimit(actor: Actor, thing: CountedThing, count: () => Promise<number>, undo: () => Promise<unknown>): Promise<void> {
  const e = await entitlements(actor);
  if (!e.enabled) return;
  const limit = e.plan.limits[thing];
  if ((await count()) <= limit) return;
  await undo();
  throw limitError(e, thing, limit);
}

function limitError(e: Entitlements, thing: CountedThing, limit: number): ApiError {
  const [one, many] = NOUNS[thing];
  if (limit <= 0) {
    const up = firstPlanWith(e.cfg.plans, (p) => p.limits[thing] > 0);
    return new ApiError(402, `${many[0].toUpperCase()}${many.slice(1)} are part of ${up ? `the ${up.name} plan` : "a paid plan"} and up. See Settings → Plan.`, "plan_required");
  }
  const up = firstPlanWith(e.cfg.plans, (p) => p.limits[thing] > limit);
  return new ApiError(402, `Your ${e.plan.name} plan includes ${limit} ${limit === 1 ? one : many}. Delete one${up ? `, or move up to ${up.name} for ${up.limits[thing]}` : ""}.`, "plan_limit");
}

/** The settings a run actually gets: tools the plan leaves out are off, and the task budget is capped. */
export function applyPlan(settings: AgentSettings, e: Entitlements): AgentSettings {
  if (!e.enabled) return settings;
  const off = [!e.plan.features.webSearch && "web_search", !e.plan.features.subagents && "task"].filter(Boolean) as string[];
  return {
    ...settings,
    disabledTools: [...new Set([...settings.disabledTools, ...off])],
    taskTokenBudget: Math.min(settings.taskTokenBudget, e.plan.limits.taskTokenBudget),
  };
}

export const capBudget = (budget: number, e: Entitlements): number => (e.enabled ? Math.min(budget, e.plan.limits.taskTokenBudget) : budget);

// ------------------------------------------------------------------ credits

export async function usageFor(actor: Actor, e: Entitlements): Promise<PlanUsage> {
  const [sums, bonus] = await Promise.all([store.creditSums(actor, e.period.start, e.day.start), e.email ? store.bonusCredits(e.email) : 0]);
  return { ...sums, bonus };
}

/** Credits left for this model: the free daily allowance for free models, otherwise the month (and today's cap). */
export function remainingFor(e: Entitlements, u: PlanUsage, model: Pick<HostedModel, "free">): number {
  if (!e.enabled || e.unlimited) return Infinity;
  const l = e.plan.limits;
  if (model.free) return l.freeDailyCredits - u.freeToday;
  const month = l.monthlyCredits + u.bonus - u.month;
  return l.dailyCredits > 0 ? Math.min(month, l.dailyCredits - u.today) : month;
}

/** Morphie AI provider keys: the free Gemini models use the free-tier key when there is one. */
export function vendorKey(vendor: Vendor, free = false): string | undefined {
  const k = config.hostedKeys;
  if (vendor === "gemini") return free ? k.geminiFree || k.gemini : k.gemini;
  return k[vendor];
}

export const hostedConfigured = (): boolean => config.plansEnabled && Object.values(config.hostedKeys).some(Boolean);

const modelViews = (cfg: PlanConfig) => cfg.models.map((m) => ({ ...m, multiplier: multiplier(m, cfg.models), available: !!vendorKey(m.vendor, m.free) }));

/** Settings → Plan: your plan, what's used, every plan and model. */
export async function planStatus(actor: Actor): Promise<PlanStatus> {
  const e = await entitlements(actor);
  const usage = e.enabled ? await usageFor(actor, e) : { month: 0, today: 0, freeToday: 0, bonus: 0 };
  const cfg = e.enabled ? e.cfg : await planConfig();
  return {
    enabled: e.enabled, plan: e.plan.id, unlimited: e.unlimited, admin: e.enabled ? e.admin : await isAdmin(actor), verified: e.verified, limits: e.plan.limits,
    membership: e.membership, usage, period: e.period, day: e.day, plans: cfg.plans, models: modelViews(cfg), hosted: hostedConfigured(),
  };
}

// ------------------------------------------------------------------ spend guardrails

let spendCache: { at: number; since: number; spend: VendorSpend[] } | null = null;
const SPEND_TTL = 60_000;

/** This calendar month's Morphie AI spend per vendor at list price, against the admin's budgets. */
export async function vendorSpend(cfg: PlanConfig, t = now()): Promise<VendorSpend[]> {
  const since = monthWindow(null, t).start;
  if (spendCache && spendCache.since === since && Date.now() - spendCache.at < SPEND_TTL) return spendCache.spend;
  const rows = await store.hostedSpend(since);
  const vendorOf = new Map(cfg.models.map((m) => [m.id, m.vendor]));
  const k = config.hostedKeys;
  const spend: VendorSpend[] = (["gemini", "openai", "anthropic"] as Vendor[]).map((vendor) => {
    const mine = rows.filter((r) => (vendorOf.get(r.model) ?? guessVendor(r.model)) === vendor);
    // Free-tier calls cost nothing when they go through a separate free-tier key.
    const freeRows = vendor === "gemini" && k.geminiFree ? mine.filter((r) => r.billing === "free") : [];
    const paidRows = mine.filter((r) => !freeRows.includes(r));
    const usd = (rs: typeof rows) => Math.round(rs.reduce((s, r) => s + r.credits, 0)) / 100;
    return {
      vendor, usd: usd(paidRows), budget: cfg.budgets[vendor] ?? 0, calls: paidRows.reduce((s, r) => s + r.calls, 0), keyed: !!(vendorKey(vendor) || vendorKey(vendor, true)),
      free: freeRows.length ? { usd: usd(freeRows), calls: freeRows.reduce((s, r) => s + r.calls, 0) } : undefined,
    };
  });
  spendCache = { at: Date.now(), since, spend };
  return spend;
}

const guessVendor = (model: string): Vendor | undefined => (/^gemini/.test(model) ? "gemini" : /^claude/.test(model) ? "anthropic" : /^(gpt|o\d)/.test(model) ? "openai" : undefined);

/** Refuse a hosted model whose vendor has used this month's budget (free-tier Gemini on its own key never counts). */
export async function assertCapacity(model: HostedModel, cfg: PlanConfig): Promise<void> {
  const budget = cfg.budgets[model.vendor] ?? 0;
  if (budget <= 0) return;
  if (model.free && model.vendor === "gemini" && config.hostedKeys.geminiFree) return;
  const s = (await vendorSpend(cfg)).find((v) => v.vendor === model.vendor);
  if (s && s.usd >= budget) throw new ApiError(503, `Morphie AI has reached this month's capacity for ${model.label}. Pick another model for now (or use your own key).`, "capacity");
}

export const PLAN_IDS = PLAN_ORDER;
