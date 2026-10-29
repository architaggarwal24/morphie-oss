import { z } from "zod";
import { route } from "@/server/http";
import { resolveDraft } from "@/server/profiles";
import { specFor } from "@/server/providers/catalog";
import { assertProviderHostAllowed, createProvider } from "@/server/providers/factory";
import { ProviderError } from "@/server/providers/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  profileId: z.string().max(40).optional(),
  kind: z.string().max(30).optional(),
  apiKey: z.string().max(600).optional(),
  baseUrl: z.string().max(500).optional(),
  options: z.unknown().optional(),
});

/** List the models a provider offers, using unsaved form values (a blank key falls back to the saved one). */
export const POST = route({ auth: "user", rate: { bucket: "models", limit: 30, windowMs: 60_000 } }, async (c) => {
  const b = await c.body(body);
  const draft = await resolveDraft(c.actor, { ...b, options: b.options as never, model: "x" });
  const spec = specFor(draft.kind)!;
  await assertProviderHostAllowed(draft);
  try {
    const models = await createProvider(draft).listModels(c.req.signal);
    return { models, source: "live" as const };
  } catch (e) {
    if (e instanceof ProviderError) {
      // Some providers have no /models endpoint: fall back to suggestions instead of failing the form.
      if (e.status === 404 && spec.exampleModels.length) {
        return { models: spec.exampleModels.map((id) => ({ id })), source: "examples" as const, warning: "This provider doesn't list its models, so these are suggestions. You can type any model ID." };
      }
      return Response.json({ error: e.message, code: "provider_error" }, { status: 502 });
    }
    throw e;
  }
});
