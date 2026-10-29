import { z } from "zod";
import { ownProject, withSandbox } from "@/server/code/routes";
import { route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The Terminal panel: the user runs a command in their own project (no approval: it's them). */
export const POST = route({ auth: "user", rate: { bucket: "exec", limit: 60, windowMs: 60_000 } }, async (c) => {
  const project = await ownProject(c.actor, c.params.id);
  const b = await c.body(z.object({ command: z.string().trim().min(1, "Type a command.").max(10_000), timeoutMs: z.number().int().min(1000).max(600_000).optional() }));
  return await withSandbox(c.actor, project, async (sb) => {
    const r = await sb.exec(b.command, { timeoutMs: b.timeoutMs ?? 120_000 });
    await sb.checkpoint().catch((e) => console.error("[sandbox] checkpoint", e));
    return r;
  });
});
