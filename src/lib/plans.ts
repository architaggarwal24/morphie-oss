/**
 * Morphie plans: four tiers (Sketch → Shape → Shift → Morph), the AI models Morphie hosts, and the credit math.
 * Pure data and functions, shared by the server (enforcement) and the browser (plan cards, model picker).
 *
 * Credits: 1 credit = $0.01 of model usage at the provider's list price, so a model that costs 20× more per token
 * uses credits 20× faster. Premium (paid) models draw on the plan's monthly credits (with a daily cap); the free
 * Gemini models draw on a separate daily allowance, so running out of premium credits never locks you out.
 * Admins can change every number here from Settings → Admin; these are the defaults.
 */

export type PlanId = "sketch" | "shape" | "shift" | "morph";
export const PLAN_ORDER: PlanId[] = ["sketch", "shape", "shift", "morph"];
export type Vendor = "gemini" | "openai" | "anthropic";
export type Currency = "inr" | "usd";
export type Interval = "month" | "year";

/** What one credit is worth in US dollars of model usage. */
export const CREDIT_USD = 0.01;

export interface PlanLimits {
  /** Premium-model credits per billing month (plus any bonus credits). */
  monthlyCredits: number;
  /** Most premium credits one day can use (stops one day draining the month). */
  dailyCredits: number;
  /** Free-model (Gemini free tier) credits per day. */
  freeDailyCredits: number;
  projects: number;
  documents: number;
  designs: number;
  designSystems: number;
  /** The most tokens one agent task may use before it pauses. */
  taskTokenBudget: number;
}

export interface PlanFeatures {
  /** Use your own API keys (any provider) alongside Morphie AI. */
  byok: boolean;
  /** Add skills from the library, GitHub, an upload, or write your own. */
  skillImports: boolean;
  /** Clone GitHub repositories into projects and save a GitHub token. */
  githubRepos: boolean;
  /** The agent's web_search tool. */
  webSearch: boolean;
  /** The agent's task tool (sub-agents that work in parallel). */
  subagents: boolean;
}

export interface PlanPrice { inr: Record<Interval, number>; usd: Record<Interval, number> }

export interface PlanDef {
  id: PlanId;
  name: string;
  tagline: string;
  limits: PlanLimits;
  features: PlanFeatures;
  price: PlanPrice;
}

export interface HostedModel {
  /** The provider's API model id. Morphie's profile id for it is `morphie:<id>`. */
  id: string;
  vendor: Vendor;
  label: string;
  blurb: string;
  /** The lowest plan that includes it. */
  tier: PlanId;
  /** Served from a free tier (Gemini): uses the free daily allowance, not premium credits. */
  free: boolean;
  /** USD per 1M tokens. `cached` is the price of a cache hit (defaults to a tenth of input). */
  price: { input: number; output: number; cached?: number };
  enabled: boolean;
  vision?: boolean;
  contextWindow?: number;
}

const ALL: PlanFeatures = { byok: true, skillImports: true, githubRepos: true, webSearch: true, subagents: true };

export const DEFAULT_PLANS: PlanDef[] = [
  {
    id: "sketch", name: "Sketch", tagline: "Start shaping ideas, free.",
    limits: { monthlyCredits: 0, dailyCredits: 0, freeDailyCredits: 50, projects: 2, documents: 5, designs: 5, designSystems: 0, taskTokenBudget: 200_000 },
    features: { byok: false, skillImports: false, githubRepos: false, webSearch: false, subagents: false },
    price: { inr: { month: 0, year: 0 }, usd: { month: 0, year: 0 } },
  },
  {
    id: "shape", name: "Shape", tagline: "For side projects taking form.",
    limits: { monthlyCredits: 300, dailyCredits: 100, freeDailyCredits: 100, projects: 5, documents: 25, designs: 25, designSystems: 2, taskTokenBudget: 400_000 },
    features: { ...ALL, subagents: false },
    price: { inr: { month: 499, year: 4_990 }, usd: { month: 7, year: 70 } },
  },
  {
    id: "shift", name: "Shift", tagline: "For builders shipping every week.",
    limits: { monthlyCredits: 1_000, dailyCredits: 300, freeDailyCredits: 200, projects: 20, documents: 50, designs: 100, designSystems: 10, taskTokenBudget: 1_000_000 },
    features: ALL,
    price: { inr: { month: 1_499, year: 14_990 }, usd: { month: 19, year: 190 } },
  },
  {
    id: "morph", name: "Morph", tagline: "Every top model, the highest limits.",
    limits: { monthlyCredits: 2_500, dailyCredits: 800, freeDailyCredits: 400, projects: 100, documents: 50, designs: 500, designSystems: 30, taskTokenBudget: 1_000_000 },
    features: ALL,
    price: { inr: { month: 3_999, year: 39_990 }, usd: { month: 49, year: 490 } },
  },
];

export const DEFAULT_MODELS: HostedModel[] = [
  { id: "gemini-3.8-flash", vendor: "gemini", label: "Gemini 3.8 Flash", blurb: "Google's best free model: fast and capable at code.", tier: "sketch", free: true, price: { input: 0.75, output: 3.75 }, enabled: true, vision: true, contextWindow: 1_000_000 },
  { id: "gemini-3.5-flash-lite", vendor: "gemini", label: "Gemini 3.5 Flash-Lite", blurb: "The quickest free model, for light tasks.", tier: "sketch", free: true, price: { input: 0.3, output: 2.5 }, enabled: true, vision: true, contextWindow: 1_000_000 },
  { id: "gpt-6-luna", vendor: "openai", label: "GPT-6 Luna", blurb: "OpenAI's most efficient model for focused tasks.", tier: "shape", free: false, price: { input: 0.1, output: 0.5, cached: 0.01 }, enabled: true, vision: true },
  { id: "gpt-6.1-terra", vendor: "openai", label: "GPT-6.1 Terra", blurb: "Fast, good at visual reasoning and natural writing.", tier: "shape", free: false, price: { input: 1, output: 5, cached: 0.05 }, enabled: true, vision: true },
  { id: "claude-haiku-5-5", vendor: "anthropic", label: "Claude Haiku 5.5", blurb: "Anthropic's fastest model.", tier: "shape", free: false, price: { input: 0.1, output: 0.5, cached: 0.01 }, enabled: true, vision: true, contextWindow: 1_000_000 },
  { id: "gpt-6.1-sol", vendor: "openai", label: "GPT-6.1 Sol", blurb: "Near-flagship results for complex work.", tier: "shift", free: false, price: { input: 2, output: 10, cached: 0.1 }, enabled: true, vision: true },
  { id: "claude-sonnet-5-5", vendor: "anthropic", label: "Claude Sonnet 5.5", blurb: "The best balance of speed and intelligence.", tier: "shift", free: false, price: { input: 2, output: 10, cached: 0.2 }, enabled: true, vision: true, contextWindow: 1_000_000 },
  { id: "gemini-3.1-pro-preview", vendor: "gemini", label: "Gemini 3.1 Pro", blurb: "Google's deep reasoner for long contexts.", tier: "shift", free: false, price: { input: 2, output: 12, cached: 0.2 }, enabled: true, vision: true, contextWindow: 1_000_000 },
  { id: "claude-opus-5-5", vendor: "anthropic", label: "Claude Opus 5.5", blurb: "Built for long-running agentic coding.", tier: "morph", free: false, price: { input: 4, output: 20, cached: 0.4 }, enabled: true, vision: true, contextWindow: 1_000_000 },
  { id: "claude-fable-5-1", vendor: "anthropic", label: "Claude Fable 5.1", blurb: "Anthropic's most capable model for the hardest work.", tier: "morph", free: false, price: { input: 10, output: 50, cached: 1 }, enabled: true, vision: true, contextWindow: 1_000_000 },
  { id: "gpt-6-astra", vendor: "openai", label: "GPT-6 Astra", blurb: "OpenAI's flagship for demanding reasoning and code.", tier: "morph", free: false, price: { input: 10, output: 50, cached: 1 }, enabled: true, vision: true },
  { id: "gemini-4-argon", vendor: "gemini", label: "Gemini 4 Argon", blurb: "Google's newest flagship.", tier: "morph", free: false, price: { input: 2, output: 10, cached: 0.2 }, enabled: true, vision: true, contextWindow: 1_000_000 },
];

export const VENDOR_LABEL: Record<Vendor, string> = { gemini: "Google Gemini", openai: "OpenAI", anthropic: "Anthropic" };

export const HOSTED_PREFIX = "morphie:";
export const hostedProfileId = (modelId: string) => `${HOSTED_PREFIX}${modelId}`;
export const hostedModelId = (profileId: string | null | undefined): string | null =>
  profileId && profileId.startsWith(HOSTED_PREFIX) ? profileId.slice(HOSTED_PREFIX.length) : null;

export const planRank = (id: PlanId) => PLAN_ORDER.indexOf(id);
export const planIncludes = (plan: PlanId, model: Pick<HostedModel, "tier">) => planRank(plan) >= planRank(model.tier);
export const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && (PLAN_ORDER as string[]).includes(v);

/** Credits a call used: uncached input, cache hits and output at the model's list price. */
export function creditsFor(price: HostedModel["price"], u: { input: number; output: number; cached?: number }): number {
  const cached = Math.max(0, Math.min(u.input, u.cached ?? 0));
  const usd = ((u.input - cached) * price.input + cached * (price.cached ?? price.input / 10) + u.output * price.output) / 1_000_000;
  return Math.round((usd / CREDIT_USD) * 1000) / 1000;
}

/** How fast a model uses credits next to the cheapest premium model ("×20"), from output prices. */
export function multiplier(model: HostedModel, models: HostedModel[]): number {
  const base = Math.min(...models.filter((m) => !m.free && m.enabled).map((m) => m.price.output), model.price.output);
  const x = model.price.output / (base || 1);
  return x < 10 ? Math.round(x * 2) / 2 : Math.round(x);
}

/** A typical agent task (about 200k tokens in, half of them cache hits, and 20k out) in credits. */
export function typicalTaskCredits(model: HostedModel): number {
  return creditsFor(model.price, { input: 200_000, cached: 100_000, output: 20_000 });
}

export const formatPrice = (amount: number, currency: Currency) =>
  amount === 0 ? (currency === "inr" ? "₹0" : "$0") : currency === "inr" ? `₹${amount.toLocaleString("en-IN")}` : `$${amount.toLocaleString("en-US")}`;

const n = (v: number) => v.toLocaleString("en-US");
const listNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * What a plan includes, in words: its models, its usage limits and its features. Plan cards show these, so they
 * always match the limits actually enforced (an admin's edits included).
 */
export function planHighlights(plan: PlanDef, plans: PlanDef[], models: HostedModel[]): string[] {
  const on = models.filter((m) => m.enabled);
  const prev = plans[plans.findIndex((p) => p.id === plan.id) - 1];
  const own = on.filter((m) => m.tier === plan.id).map((m) => m.label);
  const out: string[] = [];
  if (!prev) out.push(own.length ? `${listNames(own)}` : "Free models");
  else out.push(own.length ? `Everything in ${prev.name}, plus ${listNames(own)}` : `Every model in ${prev.name}`);
  const l = plan.limits;
  const freeModel = on.find((m) => m.free);
  const perTask = freeModel ? Math.max(1, typicalTaskCredits(freeModel)) : 15;
  if (l.monthlyCredits > 0) out.push(`${n(l.monthlyCredits)} premium credits a month (up to ${n(l.dailyCredits)} a day)`);
  out.push(`${n(l.freeDailyCredits)} free-model credits a day (≈ ${n(Math.max(1, Math.floor(l.freeDailyCredits / perTask)))} agent tasks on ${freeModel?.label ?? "free models"})`);
  out.push(`${n(l.projects)} projects · ${n(l.documents)} documents · ${n(l.designs)} designs${l.designSystems ? ` · ${n(l.designSystems)} design systems` : ""}`);
  out.push(`Agent tasks up to ${l.taskTokenBudget >= 1_000_000 ? `${l.taskTokenBudget / 1_000_000}M` : `${Math.round(l.taskTokenBudget / 1000)}k`} tokens`);
  const f = plan.features;
  const extras = [f.byok && "your own API keys", f.skillImports && "skill imports", f.githubRepos && "GitHub repos", f.webSearch && "web search", f.subagents && "sub-agents"].filter(Boolean) as string[];
  if (extras.length) out.push(`${extras[0][0].toUpperCase()}${listNames(extras).slice(1)}`);
  return out;
}

/** The plan that unlocks a feature or model first (for "Upgrade to Shape" hints). */
export function firstPlanWith(plans: PlanDef[], test: (p: PlanDef) => boolean): PlanDef | undefined {
  return [...plans].sort((a, b) => planRank(a.id) - planRank(b.id)).find(test);
}

export const FEATURE_LABEL: Record<keyof PlanFeatures, string> = {
  byok: "Using your own API keys", skillImports: "Adding your own skills", githubRepos: "GitHub repositories",
  webSearch: "Web search", subagents: "Sub-agents",
};
