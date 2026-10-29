import { DEFAULT_AGENT_SETTINGS, TASK_BUDGET, type AgentSettings } from "@/lib/types";
import { config } from "./config";
import { normalizeRules } from "./code/permissions";
import { decrypt, encrypt } from "./crypto";
import type { Actor } from "./auth/actor";
import * as store from "./data/settings";

export async function getSettings(actor: Actor): Promise<AgentSettings> {
  const json = await store.readSettingsJson(actor);
  let stored: Partial<AgentSettings> = {};
  try { stored = json ? JSON.parse(json) : {}; } catch { /* defaults */ }
  return normalizeSettings({ ...DEFAULT_AGENT_SETTINGS, ...stored });
}

export function normalizeSettings(s: Partial<AgentSettings>): AgentSettings {
  const d = DEFAULT_AGENT_SETTINGS;
  const names = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(x)))].slice(0, 300) : []);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[a-z_]{1,40}$/.test(x)).slice(0, 40) : []);
  return {
    planFallback: s.planFallback !== false,
    taskTokenBudget: Math.min(TASK_BUDGET.max, Math.max(TASK_BUDGET.min, Math.round(Number(s.taskTokenBudget ?? d.taskTokenBudget)) || d.taskTokenBudget)),
    skills: { disabled: names(s.skills?.disabled), pinned: names(s.skills?.pinned) },
    helperProfileId: typeof s.helperProfileId === "string" && /^(?:[A-Za-z0-9_-]{4,64}|morphie:[A-Za-z0-9._-]{1,80})$/.test(s.helperProfileId) ? s.helperProfileId : null,
    approval: s.approval === "always" || s.approval === "never" ? s.approval : "ask",
    alwaysAllow: list(s.alwaysAllow),
    disabledTools: list(s.disabledTools),
    memory: s.memory !== false,
    temperature: typeof s.temperature === "number" ? Math.min(2, Math.max(0, s.temperature)) : undefined,
    permissions: { allow: normalizeRules(s.permissions?.allow), deny: normalizeRules(s.permissions?.deny) },
  };
}

export async function saveSettings(actor: Actor, patch: Partial<AgentSettings>): Promise<AgentSettings> {
  const next = normalizeSettings({ ...(await getSettings(actor)), ...patch });
  await store.writeSettingsJson(actor, JSON.stringify(next));
  return next;
}

// ------------------------------------------------------------- user secrets

export type SecretName = "tavily" | "github";

/**
 * Secrets are encrypted here, in one place, so that when per-user data keys arrive this is the single hook
 * where values get re-encrypted under the right key.
 */
export async function setSecret(actor: Actor, name: SecretName, value: string): Promise<void> {
  await store.writeSecretEnc(actor, name, encrypt(value));
}

export async function getSecret(actor: Actor, name: SecretName): Promise<string | undefined> {
  const enc = await store.readSecretEnc(actor, name);
  if (!enc) return undefined;
  try { return decrypt(enc); } catch { return undefined; }
}

export async function deleteSecret(actor: Actor, name: SecretName): Promise<void> {
  await store.deleteSecret(actor, name);
}
