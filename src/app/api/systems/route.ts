import { z } from "zod";
import { currentDesignFor } from "@/server/design/service";
import { createSystem, getSystem, listSystems } from "@/server/design/systems";
import { route } from "@/server/http";
import { activeProvider } from "@/server/providers/active";
import { metered } from "@/server/usage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = route({ auth: "user" }, async (c) => ({ systems: await listSystems(c.actor) }));

const NAME = z.string().trim().max(60).optional();
const body = z.discriminatedUnion("from", [
  z.object({ from: z.literal("prompt"), prompt: z.string().trim().min(3, "Describe the brand or product first.").max(4000), name: NAME }),
  z.object({ from: z.literal("url"), url: z.string().trim().min(4, "Enter a website address.").max(500), name: NAME, notes: z.string().max(600).optional() }),
  z.object({ from: z.literal("image"), palette: z.array(z.object({ hex: z.string().regex(/^#[0-9a-fA-F]{6}$/), weight: z.number().min(0).max(1) })).min(2).max(16), notes: z.string().max(600).optional(), name: NAME, fileName: z.string().max(120).optional() }),
  z.object({ from: z.literal("design"), designId: z.string().max(40), name: NAME }),
  z.object({ from: z.literal("manual"), system: z.record(z.string(), z.unknown()) }),
]);

/** Create a design system. Description and website/image sources use the active AI provider when there is one. */
export const POST = route({ auth: "user", rate: { bucket: "systems", limit: 12, windowMs: 60_000 } }, async (c) => {
  const b = await c.body(body, 200_000);
  const needsModel = b.from === "prompt" || b.from === "url" || b.from === "image";
  const main = needsModel ? await activeProvider(c.actor).catch(() => null) : null;
  const provider = main ? metered(main, { actor: c.actor, feature: "design_system" }) : null;
  const input = b.from === "design" ? { from: "design" as const, name: b.name, design: await currentDesignFor(c.actor, b.designId) } : b;
  const out = await createSystem(c.actor, input, provider, c.req.signal);
  return { ...out, system: await getSystem(c.actor, out.id), systems: await listSystems(c.actor) };
});
