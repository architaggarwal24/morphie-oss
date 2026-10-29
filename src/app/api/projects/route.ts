import { z } from "zod";
import { createProjectFor } from "@/server/code/projects";
import { listProjects } from "@/server/data/projects";
import { route } from "@/server/http";
import { sandboxKind } from "@/server/sandbox";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = route({ auth: "user" }, async (c) => ({ projects: await listProjects(c.actor), sandbox: sandboxKind() }));

const body = z.object({
  name: z.string().trim().max(80).optional(),
  repoUrl: z.string().trim().max(300).optional().transform((v) => v || undefined),
  branch: z.string().trim().max(120).regex(/^[A-Za-z0-9._\/-]*$/, "That isn't a valid branch name.").optional().transform((v) => v || undefined),
  /** Where it runs: "server", "lite" or "runner:<id>". */
  sandbox: z.string().trim().max(80).regex(/^(server|lite|runner:[A-Za-z0-9_-]{6,40})$/, "Choose where the project runs.").optional(),
});

/** Create a project: an empty folder, or a clone of a repository (https only, no credentials in the URL). */
export const POST = route({ auth: "user", rate: { bucket: "projects", limit: 10, windowMs: 60_000 } }, async (c) => {
  return await createProjectFor(c.actor, await c.body(body));
});
