import { z } from "zod";
import { route } from "@/server/http";
import { resolveDraft } from "@/server/profiles";
import { testProvider } from "@/server/providerTest";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  profileId: z.string().max(40).optional(),
  kind: z.string().max(30).optional(),
  model: z.string().max(200).optional(),
  apiKey: z.string().max(600).optional(),
  baseUrl: z.string().max(500).optional(),
  label: z.string().max(60).optional(),
  options: z.unknown().optional(),
});

export const POST = route({ auth: "user", rate: { bucket: "provider-test", limit: 12, windowMs: 60_000 } }, async (c) => {
  const b = await c.body(body);
  const draft = await resolveDraft(c.actor, { ...b, options: b.options as never });
  if (!draft.model) return { ok: false, message: "Choose a model first." };
  return await testProvider(draft, c.req.signal);
});
