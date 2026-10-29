/**
 * Morphie AI: models the server runs on its own API keys, included with a plan and paid for in credits.
 *
 * They appear next to your own providers as profiles with ids like `morphie:claude-sonnet-5-5`, so the composer's
 * model picker, the helper-model setting and the command palette all work unchanged. Using one checks the plan (does
 * it include the model?), the credits left (and falls back to the plan's free model when premium credits run out, if
 * you allow it), and the vendor's monthly budget. Every call then checks the credits again and is metered in credits.
 */
import { creditsFor, HOSTED_PREFIX, hostedModelId, hostedProfileId, planIncludes, firstPlanWith, multiplier, type HostedModel } from "@/lib/plans";
import type { AgentSettings, ProfileView } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { ApiError } from "../http";
import { createProvider, type ResolvedProfile } from "../providers/factory";
import { ProviderError, type ChatRequest, type ChatResult, type Provider, type ProviderModel } from "../providers/types";
import { estimateMessages, estimateTokens } from "../usage";
import * as store from "../data/plans";
import { now } from "../db";
import { assertCapacity, entitlements, hostedConfigured, remainingFor, usageFor, vendorKey, type Entitlements } from "./index";

export { HOSTED_PREFIX, hostedModelId, hostedProfileId };

/** How a hosted call is paid for: the free daily allowance or premium credits. usage.ts reads this to record credits. */
export interface HostedBilling { modelId: string; kind: "free" | "paid"; price: HostedModel["price"] }

/** Out of credits mid-run: the agent pauses (Continue picks it up). */
export class CreditsError extends ProviderError {
  constructor(message: string) { super(message, 402); }
}

const usable = (m: HostedModel) => m.enabled && !!vendorKey(m.vendor, m.free);

/** The plan's free model to fall back on: the configured default if it's free, else the first free one. */
function fallbackModel(e: Entitlements): HostedModel | undefined {
  const free = e.cfg.models.filter((m) => m.free && usable(m) && planIncludes(e.plan.id, m));
  return free.find((m) => m.id === e.cfg.defaultModel) ?? free[0];
}

/** The model a user with no provider chosen starts on. */
export function defaultHostedModel(e: Entitlements): HostedModel | undefined {
  const d = e.cfg.models.find((m) => m.id === e.cfg.defaultModel);
  return d && usable(d) && planIncludes(e.plan.id, d) ? d : fallbackModel(e);
}

/** Morphie AI models as profiles for the UI: every enabled model, marked locked when the plan doesn't include it. */
export async function hostedProfiles(actor: Actor): Promise<ProfileView[]> {
  if (!hostedConfigured()) return [];
  const e = await entitlements(actor);
  if (!e.enabled) return [];
  return e.cfg.models.filter((m) => m.enabled).map((m) => ({
    id: hostedProfileId(m.id), kind: m.vendor, label: "Morphie AI", model: m.id, hasKey: true, keyHint: "Included",
    options: { vision: m.vision, contextWindow: m.contextWindow }, updatedAt: 0,
    hosted: { tier: m.tier, locked: !planIncludes(e.plan.id, m), free: m.free, multiplier: multiplier(m, e.cfg.models), blurb: `${m.label}. ${m.blurb}`, available: !!vendorKey(m.vendor, m.free) },
  }));
}

/** Can this user pick that hosted model (for "Use this" and the helper setting)? Throws a clear reason if not. */
export async function assertHostedChoice(actor: Actor, profileId: string): Promise<HostedModel> {
  const id = hostedModelId(profileId);
  if (!id || !hostedConfigured()) throw new ApiError(404, "That model isn't available.", "not_found");
  const e = await entitlements(actor);
  const m = e.cfg.models.find((x) => x.id === id && x.enabled);
  if (!m || !e.enabled) throw new ApiError(404, "That model isn't available.", "not_found");
  if (!vendorKey(m.vendor, m.free)) throw new ApiError(400, `${m.label} isn't set up on this server yet.`, "unavailable");
  if (!planIncludes(e.plan.id, m)) {
    const up = firstPlanWith(e.cfg.plans, (p) => planIncludes(p.id, m));
    throw new ApiError(402, `${m.label} is part of the ${up?.name ?? "paid"} plan and up. See Settings → Plan.`, "plan_required");
  }
  return m;
}

const outOfCredits = (e: Entitlements, m: HostedModel): string =>
  m.free
    ? `You've used today's free-model credits on the ${e.plan.name} plan. They reset at midnight UTC${e.plan.id !== "morph" ? ", or upgrade in Settings → Plan for more" : ""}.`
    : `You've used your ${e.plan.name} plan's premium credits for now. They reset on the next billing day (or at midnight UTC for the daily cap). Switch to a free model, or upgrade in Settings → Plan.`;

/**
 * A hosted model ready to call, after the plan, credit and capacity checks. When premium credits are gone and the
 * user allows it, the plan's free model stands in (its label says so).
 */
export async function resolveHosted(actor: Actor, profileId: string, settings?: Pick<AgentSettings, "planFallback">): Promise<{ provider: Provider; profile: ResolvedProfile; fellBack?: string }> {
  let m = await assertHostedChoice(actor, profileId);
  const e = await entitlements(actor);
  const u = await usageFor(actor, e);
  let remaining = remainingFor(e, u, m);
  let fellBack: string | undefined;
  if (remaining <= 0 && !m.free && settings?.planFallback !== false) {
    const f = fallbackModel(e);
    if (f && remainingFor(e, u, f) > 0) { fellBack = m.label; m = f; remaining = remainingFor(e, u, f); }
  }
  if (remaining <= 0) throw new ApiError(402, outOfCredits(e, m), "credits");
  await assertCapacity(m, e.cfg);
  const profile: ResolvedProfile = {
    id: hostedProfileId(m.id), kind: m.vendor, label: "Morphie AI", model: m.id, apiKey: vendorKey(m.vendor, m.free),
    options: { vision: m.vision, contextWindow: m.contextWindow },
  };
  const inner = createProvider(profile);
  const provider = new HostedProvider(inner, { modelId: m.id, kind: m.free ? "free" : "paid", price: m.price }, remaining, outOfCredits(e, m), fellBack ? `Morphie AI (${fellBack} credits used up)` : "Morphie AI", creditReserver(actor, e, m));
  return { provider, profile, fellBack };
}

/** Each call sets its credits aside in the database first (see HostedProvider.chat). Unlimited accounts skip it. */
export function creditReserver(actor: Actor, e: Entitlements, model: HostedModel): Reserver | undefined {
  if (!e.enabled || e.unlimited) return undefined;
  const kind = model.free ? "free" : "paid";
  return {
    async place(estimate) {
      const left = remainingFor(e, await usageFor(actor, e), model);
      if (left <= 0) return null;
      const t = now();
      const id = await store.placeHold(actor, kind, Math.max(0.01, Math.min(estimate, left)), t, t + HOLD_TTL_MS);
      // Counted after inserting, so of two calls racing for the last credits at most one goes ahead.
      if (remainingFor(e, await usageFor(actor, e), model) < -1e-6) { await store.releaseHold(actor, id); return null; }
      return id;
    },
    release: (id) => store.releaseHold(actor, id),
  };
}

/** How long credits stay on hold if a call never reports back (a crash, an evicted isolate). */
export const HOLD_TTL_MS = 15 * 60_000;
/** Output tokens to set aside for a call that doesn't say its maximum. */
const DEFAULT_OUTPUT_HOLD = 4096;

/** Sets credits aside before a call (null = not enough left) and drops the hold once the call is recorded. */
export interface Reserver { place(estimate: number): Promise<string | null>; release(id: string): Promise<void> }

/** A hosted model: stops before a call once the credits are gone, and counts what each call used. */
export class HostedProvider implements Provider {
  private pending: string[] = [];
  constructor(private inner: Provider, readonly billing: HostedBilling, private remaining: number, private exhausted: string, readonly label: string, private reserve?: Reserver) {}
  get kind() { return this.inner.kind; }
  get model() { return this.inner.model; }
  get nativeTools() { return this.inner.nativeTools; }
  get vision() { return this.inner.vision; }
  get contextWindow() { return this.inner.contextWindow; }
  /** Credits left as of the last call (tests, and the run's own accounting). */
  get creditsLeft() { return this.remaining; }
  listModels(signal?: AbortSignal): Promise<ProviderModel[]> { return this.inner.listModels(signal); }
  async chat(req: ChatRequest): Promise<ChatResult> {
    if (this.remaining <= 0) throw new CreditsError(this.exhausted);
    // The credits this call could cost go on hold in the database first. A run's own count (`remaining`) can't see
    // other runs; the hold can, so parallel runs (tabs, sub-agents) can't spend the same credits twice.
    let hold: string | null = null;
    if (this.reserve) {
      const estimate = creditsFor(this.billing.price, { input: estimateMessages(req.messages, req.tools), output: req.maxTokens ?? DEFAULT_OUTPUT_HOLD, cached: 0 });
      hold = await this.reserve.place(estimate);
      if (!hold) { this.remaining = 0; throw new CreditsError(this.exhausted); }
      this.pending.push(hold);
    }
    let res: ChatResult;
    try { res = await this.inner.chat(req); }
    catch (e) {
      // A stopped call is still recorded (usage.ts), then settled; anything else cost nothing, so let go now.
      if (hold && !req.signal?.aborted) { this.pending = this.pending.filter((h) => h !== hold); await this.reserve!.release(hold).catch(() => {}); }
      throw e;
    }
    const reported = res.usage && (res.usage.input || res.usage.output);
    const u = reported ? res.usage! : { input: estimateMessages(req.messages, req.tools), output: estimateTokens(res.content + (res.reasoning ?? "")) };
    this.remaining -= creditsFor(this.billing.price, u);
    return res;
  }
  /** Called by usage.ts once a call's real cost is recorded: its hold is no longer needed. */
  async settle(): Promise<void> {
    const ids = this.pending; this.pending = [];
    for (const id of ids) await this.reserve?.release(id).catch((e) => console.error("[credits] couldn't release a hold", e));
  }
}

/** The billing of a (possibly wrapped) provider, if it's a hosted one. */
export const billingOf = (p: Provider): HostedBilling | undefined => (p instanceof HostedProvider ? p.billing : undefined);
