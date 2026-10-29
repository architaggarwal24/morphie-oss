import { hostedModelId } from "@/lib/plans";
import type { AgentSettings } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { ApiError } from "../http";
import { requireFeature } from "../plans";
import { resolveHosted } from "../plans/hosted";
import { listProfiles, resolveProfile } from "../profiles";
import { getSettings } from "../settings";
import { assertProviderHostAllowed, createProvider, type ResolvedProfile } from "./factory";
import type { Provider } from "./types";

/** The user's active provider, ready to call — or a clear, actionable error. */
export async function activeProvider(actor: Actor): Promise<Provider> {
  return (await activeSetup(actor)).provider;
}

/**
 * The active provider and the profile it came from (for per-provider settings such as the task token budget).
 * A Morphie AI model (hosted edition) goes through its plan and credit checks; your own key needs a plan that allows it.
 */
export async function activeSetup(actor: Actor, settings?: Pick<AgentSettings, "planFallback">): Promise<{ provider: Provider; profile: ResolvedProfile }> {
  const { activeId } = await listProfiles(actor);
  if (activeId && hostedModelId(activeId)) return resolveHosted(actor, activeId, settings ?? await getSettings(actor));
  const profile = activeId ? await resolveProfile(actor, activeId) : null;
  if (!profile) throw new ApiError(400, "Add an AI provider in Settings to get started.", "no_provider");
  await requireFeature(actor, "byok");
  await assertProviderHostAllowed(profile);
  return { provider: createProvider(profile), profile };
}

/**
 * The helper model (Settings → Agent): a cheaper provider for sub-agents, summaries and memory. Falls back to the main
 * model when none is chosen or the chosen one can't be used.
 */
export async function helperProvider(actor: Actor, settings: AgentSettings, main: Provider): Promise<Provider> {
  if (!settings.helperProfileId) return main;
  try {
    if (hostedModelId(settings.helperProfileId)) return (await resolveHosted(actor, settings.helperProfileId, settings)).provider;
    const p = await resolveProfile(actor, settings.helperProfileId);
    if (!p) return main;
    await requireFeature(actor, "byok");
    await assertProviderHostAllowed(p);
    return createProvider(p);
  } catch { return main; }
}

/** Tokens one agent run may use: the provider's own budget when it sets one, otherwise the general setting. */
export function taskBudget(settings: AgentSettings, profile?: ResolvedProfile | null): number {
  const own = profile?.options.taskTokenBudget;
  return typeof own === "number" && own > 0 ? own : settings.taskTokenBudget;
}
