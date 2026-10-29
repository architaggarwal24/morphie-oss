import { z } from "zod";
import { deleteSystem, getSystem, listSystems, updateSystem } from "@/server/design/systems";
import { route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ auth: "user" }, async (c) => ({ system: await getSystem(c.actor, c.params.id) }));

/** Save edited tokens (the whole system; it is validated again). */
export const PATCH = route({ auth: "user", rate: { bucket: "systems-edit", limit: 120, windowMs: 60_000 } }, async (c) => {
  const b = await c.body(z.object({ system: z.record(z.string(), z.unknown()) }), 100_000);
  return { system: await updateSystem(c.actor, c.params.id, b.system), systems: await listSystems(c.actor) };
});

export const DELETE = route({ auth: "user" }, async (c) => {
  await deleteSystem(c.actor, c.params.id);
  return { systems: await listSystems(c.actor) };
});
