import { z } from "zod";
import { devCommand, devServer, findStaticRoot, listShots, previewToken, readPackage, startDevServer, stopDevServer } from "@/server/code/preview";
import { ownProject, withSandbox } from "@/server/code/routes";
import { ApiError, route } from "@/server/http";
import { sandboxKind } from "@/server/sandbox";
import { LocalSandbox } from "@/server/sandbox/local";
import type { Actor } from "@/server/auth/actor";
import type { ProjectView } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the Preview tab can show for this project right now. */
async function status(actor: Actor, project: ProjectView) {
  return withSandbox(actor, project, async (sb) => {
    const kind = sb.kind;
    const [root, pkg, shots] = await Promise.all([findStaticRoot(sb), readPackage(sb), listShots(sb)]);
    const dev = devCommand(pkg, "<port>");
    const shotsToken = shots.length ? previewToken(actor.userId, project.id, ".morphie/shots") : null;
    return {
      sandbox: kind,
      staticUrl: root ? `/api/preview/${previewToken(actor.userId, project.id, root)}/index.html` : null,
      staticRoot: root,
      dev: kind === "local"
        ? { available: !!dev, command: dev }
        : { available: false, command: null, reason: kind === "lite" ? "A Lite project has no dev server: the Files view shows its site (index.html and everything next to it)." : kind === "runner" ? "The project runs on your own computer: start its dev server there and open it in your browser. The Files view shows its static files." : "Live dev servers run with the local sandbox (npm run dev). Here the preview shows the project's static files and verify_project's screenshots." },
      server: kind === "local" ? devServer(actor.userId, project.id) : null,
      shots: shots.map((name) => ({ name, url: `/api/preview/${shotsToken}/${encodeURIComponent(name)}` })),
    };
  });
}

export const GET = route({ auth: "user" }, async (c) => status(c.actor, await ownProject(c.actor, c.params.id)));

export const POST = route({ auth: "user" }, async (c) => {
  const project = await ownProject(c.actor, c.params.id);
  const b = await c.body(z.object({ action: z.enum(["start", "stop"]) }));
  if (b.action === "stop") stopDevServer(c.actor.userId, project.id);
  else {
    if (sandboxKind() !== "local") throw new ApiError(400, "Dev servers only run with the local sandbox.", "unsupported");
    await withSandbox(c.actor, project, async (sb) => {
      if (!(sb instanceof LocalSandbox)) throw new ApiError(400, "Dev servers only run with the local sandbox.", "unsupported");
      try { await startDevServer(sb, c.actor.userId, project.id); }
      catch (e) { throw new ApiError(400, e instanceof Error ? e.message : "The dev server couldn't start.", "preview"); }
    });
  }
  return status(c.actor, project);
});
