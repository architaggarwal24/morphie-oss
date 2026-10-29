import { stopDevServer } from "@/server/code/preview";
import { z } from "zod";
import { listCommands, loadProjectInfo } from "@/server/code/project";
import { ownProject, withSandbox } from "@/server/code/routes";
import { deleteProject, listProjects, updateProject } from "@/server/data/projects";
import { route } from "@/server/http";
import { sandboxFor } from "@/server/sandbox";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The project, its slash commands (built-in + .morphie/commands) and which memory file it has. */
export const GET = route({ auth: "user" }, async (c) => {
  const project = await ownProject(c.actor, c.params.id);
  const info = await withSandbox(c.actor, project, (sb) => loadProjectInfo(sb));
  return { project, commands: listCommands(info.commands), memory: info.memory?.path ?? null, git: info.git };
});

export const PATCH = route({ auth: "user" }, async (c) => {
  await ownProject(c.actor, c.params.id);
  const b = await c.body(z.object({ name: z.string().trim().min(1).max(80) }));
  const project = await updateProject(c.actor, c.params.id, { name: b.name });
  return { project, projects: await listProjects(c.actor) };
});

/** Deletes the files for good (the container and its backups too). Its tasks stay, as ordinary agent tasks. */
export const DELETE = route({ auth: "user" }, async (c) => {
  const project = await ownProject(c.actor, c.params.id);
  stopDevServer(c.actor.userId, project.id);
  await sandboxFor(c.actor, project.id).then((sb) => sb.destroy()).catch((e) => console.error("[projects] destroy", e));
  await deleteProject(c.actor, project.id);
  return { projects: await listProjects(c.actor) };
});
