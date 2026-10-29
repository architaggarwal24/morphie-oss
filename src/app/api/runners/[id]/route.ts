import { route } from "@/server/http";
import { listRunners, removeRunner } from "@/server/runners";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Remove a runner: its token stops working at once. Someone else's runner is a 404. */
export const DELETE = route({ auth: "user" }, async (c) => {
  await removeRunner(c.actor, c.params.id);
  return { runners: await listRunners(c.actor) };
});
