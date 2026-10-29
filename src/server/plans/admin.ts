/**
 * Settings → Admin (MORPHIE_ADMIN_EMAILS): give anyone a plan (for testing, friends, or a manual payment), add bonus
 * credits, edit the plans and the Morphie AI model list, and watch spend against each vendor's monthly budget.
 */
import { z } from "zod";
import { isPlanId, PLAN_ORDER, type PlanId } from "@/lib/plans";
import type { AdminOverview, MemberView } from "@/lib/types";
import { config } from "../config";
import * as store from "../data/plans";
import { now } from "../db";
import { ApiError } from "../http";
import { forgetEntitlements, isAdminEmail, monthWindow, planConfig, savePlanConfig, resetPlanConfig, vendorSpend, type PlanConfig } from "./index";

const money = z.number().min(0).max(1_000_000);
const count = z.number().int().min(0).max(1_000_000);

export const planSchema = z.object({
  id: z.enum(PLAN_ORDER as [PlanId, ...PlanId[]]),
  name: z.string().trim().min(1).max(30),
  tagline: z.string().trim().max(120),
  limits: z.object({
    monthlyCredits: count, dailyCredits: count, freeDailyCredits: count, projects: count, documents: z.number().int().min(0).max(50),
    designs: count, designSystems: z.number().int().min(0).max(30), taskTokenBudget: z.number().int().min(20_000).max(1_000_000),
  }),
  features: z.object({ byok: z.boolean(), skillImports: z.boolean(), githubRepos: z.boolean(), webSearch: z.boolean(), subagents: z.boolean() }),
  price: z.object({ inr: z.object({ month: money, year: money }), usd: z.object({ month: money, year: money }) }),
});

export const modelSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/, "Model ids use letters, digits, dots, dashes and underscores."),
  vendor: z.enum(["gemini", "openai", "anthropic"]),
  label: z.string().trim().min(1).max(60),
  blurb: z.string().trim().max(160),
  tier: z.enum(PLAN_ORDER as [PlanId, ...PlanId[]]),
  free: z.boolean(),
  price: z.object({ input: z.number().min(0).max(1000), output: z.number().min(0).max(1000), cached: z.number().min(0).max(1000).optional() }),
  enabled: z.boolean(),
  vision: z.boolean().optional(),
  contextWindow: z.number().int().min(4_000).max(10_000_000).optional(),
});

export const configPatch = z.object({
  plans: z.array(planSchema).length(4).optional(),
  models: z.array(modelSchema).min(1).max(60).optional(),
  budgets: z.object({ gemini: money, openai: money, anthropic: money }).optional(),
  defaultModel: z.string().max(80).optional(),
  unverifiedFreeDaily: z.number().int().min(0).max(100_000).optional(),
  reset: z.literal(true).optional(),
});

export async function adminOverview(): Promise<AdminOverview> {
  const cfg = await planConfig();
  const [spend, counts] = await Promise.all([vendorSpend(cfg), store.memberCounts()]);
  const k = config.hostedKeys;
  return {
    enabled: config.plansEnabled, plans: cfg.plans, models: cfg.models, budgets: cfg.budgets, defaultModel: cfg.defaultModel, unverifiedFreeDaily: cfg.unverifiedFreeDaily,
    spend, monthStart: monthWindow(null, now()).start, counts,
    keys: { openai: !!k.openai, anthropic: !!k.anthropic, gemini: !!k.gemini, geminiFree: !!k.geminiFree },
    admins: config.adminEmails,
  };
}

export async function updateConfig(patch: z.infer<typeof configPatch>): Promise<AdminOverview> {
  if (patch.reset) { await resetPlanConfig(); return adminOverview(); }
  const cur = await planConfig();
  const models = patch.models ?? cur.models;
  const ids = models.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new ApiError(400, "Two models have the same id.", "invalid");
  const plans = patch.plans ? PLAN_ORDER.map((id) => patch.plans!.find((p) => p.id === id)) : cur.plans;
  if (plans.some((p) => !p)) throw new ApiError(400, "Send all four plans.", "invalid");
  const defaultModel = patch.defaultModel ?? cur.defaultModel;
  const def = models.find((m) => m.id === defaultModel);
  if (!def || !def.enabled || def.tier !== "sketch") throw new ApiError(400, "The default model must be an enabled Sketch (free plan) model.", "invalid");
  const next: PlanConfig = { plans: plans as PlanConfig["plans"], models, budgets: patch.budgets ?? cur.budgets, defaultModel, unverifiedFreeDaily: patch.unverifiedFreeDaily ?? cur.unverifiedFreeDaily };
  await savePlanConfig(next);
  return adminOverview();
}

const DAY = 86_400_000;

export async function members(q: string): Promise<MemberView[]> {
  const rows = await store.listMembers(q.trim().slice(0, 100), now() - 30 * DAY);
  const t = now();
  return rows.map((r) => {
    const live = !!r.plan && isPlanId(r.plan) && r.starts_at != null && r.starts_at <= t && (r.ends_at == null || r.ends_at > t);
    const admin = isAdminEmail(r.email, !!r.verified);
    return {
      userId: r.id, email: r.email, verified: !!r.verified, createdAt: r.created_at, lastSeenAt: r.last_seen_at,
      plan: admin ? "morph" : live ? (r.plan as PlanId) : "sketch", unlimited: admin || (live && !!r.unlimited), admin,
      membership: r.plan ? { source: r.source ?? "admin", billing: r.billing, startsAt: r.starts_at ?? 0, endsAt: r.ends_at, note: r.note ?? "" } : null,
      credits30: Math.round(Number(r.credits) * 10) / 10,
    };
  });
}

const email = z.string().trim().toLowerCase().email("Enter a valid email address.").max(200);
export const memberAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("grant"), email, plan: z.enum(PLAN_ORDER as [PlanId, ...PlanId[]]),
    /** Days the plan lasts (0 = until revoked). */
    days: z.number().int().min(0).max(3660), unlimited: z.boolean().default(false), note: z.string().trim().max(200).default(""),
  }),
  z.object({ action: z.literal("revoke"), email }),
  z.object({ action: z.literal("credits"), email, credits: z.number().min(-100_000).max(100_000).refine((n) => n !== 0, "Enter a number of credits."), days: z.number().int().min(1).max(3660).default(30), note: z.string().trim().max(200).default("") }),
]);

export async function applyMemberAction(a: z.infer<typeof memberAction>, by: string): Promise<void> {
  if (a.action === "revoke") {
    if (!(await store.deleteMembership(a.email))) throw new ApiError(404, "That email has no plan to remove.", "not_found");
  } else if (a.action === "grant") {
    const t = now();
    const prev = await store.getMembership(a.email);
    // Same plan again (an extension) keeps its billing day; a different plan starts today.
    const keep = prev && prev.plan === a.plan && (prev.ends_at == null || prev.ends_at > t);
    await store.upsertMembership({
      email: a.email, plan: a.plan, unlimited: a.unlimited ? 1 : 0, source: "admin", billing: null,
      starts_at: keep ? prev!.starts_at : t, ends_at: a.days ? t + a.days * DAY : null, note: a.note, granted_by: by,
    });
  } else {
    await store.insertCreditGrant({ email: a.email, credits: a.credits, expiresAt: now() + a.days * DAY, note: a.note, by });
  }
  forgetEntitlements();
}

