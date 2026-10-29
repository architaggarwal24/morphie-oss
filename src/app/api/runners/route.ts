import { z } from "zod";
import { route } from "@/server/http";
import { createRunner, listRunners } from "@/server/runners";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Your Morphie Runners and whether each is connected. */
export const GET = route({ auth: "user" }, async (c) => ({ runners: await listRunners(c.actor) }));

/** Add a runner: returns its token once (the start command carries it). */
export const POST = route({ auth: "user", rate: { bucket: "runners", limit: 10, windowMs: 60_000 } }, async (c) => {
  const b = await c.body(z.object({ name: z.string().trim().max(40).default("") }));
  const { runner, token } = await createRunner(c.actor, b.name);
  return { runner, token, runners: await listRunners(c.actor) };
});
