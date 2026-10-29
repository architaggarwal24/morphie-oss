import { z } from "zod";
import { route } from "@/server/http";
import { listProfiles, resolveDraft, saveProfile } from "@/server/profiles";
import { specFor } from "@/server/providers/catalog";
import { assertProviderHostAllowed, createProvider } from "@/server/providers/factory";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ auth: "user" }, async (c) => await listProfiles(c.actor));

const body = z.object({
  id: z.string().max(40).optional(),
  kind: z.string().max(30),
  label: z.string().max(60).optional(),
  model: z.string().min(1, "Choose a model.").max(200),
  apiKey: z.string().max(600).optional(),
  clearKey: z.boolean().optional(),
  baseUrl: z.string().max(500).optional(),
  options: z.unknown().optional(),
  activate: z.boolean().optional(),
});

export const POST = route({ auth: "user", rate: { bucket: "providers", limit: 30, windowMs: 60_000 } }, async (c) => {
  const b = await c.body(body);
  if (!specFor(b.kind)) return Response.json({ error: "Unknown provider.", code: "invalid" }, { status: 400 });
  // Validate the whole configuration (URL rules, key present, options) before anything is stored.
  const draft = await resolveDraft(c.actor, { profileId: b.id, kind: b.kind, model: b.model, apiKey: b.apiKey, baseUrl: b.baseUrl, label: b.label, options: b.options as never });
  await assertProviderHostAllowed(draft);
  createProvider(draft);
  const profile = await saveProfile(c.actor, { ...b, options: draft.options });
  return { profile, ...(await listProfiles(c.actor)) };
});
