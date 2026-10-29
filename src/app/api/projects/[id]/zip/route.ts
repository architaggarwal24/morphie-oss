import { zipProject } from "@/server/code/projects";
import { ownProject, withSandbox } from "@/server/code/routes";
import { route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** The whole project as one zip named after it (dependencies, build output and .git left out). */
export const GET = route({ auth: "user", rate: { bucket: "project-zip", limit: 20, windowMs: 60_000 } }, async (c) => {
  const project = await ownProject(c.actor, c.params.id);
  const z = await withSandbox(c.actor, project, (sb) => zipProject(sb, project.name));
  return new Response(z.bytes as unknown as BodyInit, {
    headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${z.filename}"`, "x-content-type-options": "nosniff", "cache-control": "no-store" },
  });
});
