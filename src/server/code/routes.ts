import type { ProjectView } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { getProject } from "../data/projects";
import { ApiError } from "../http";
import { sandboxFor, SandboxError, type Sandbox } from "../sandbox";

/** The caller's project, or 404 (someone else's project looks exactly like a missing one). */
export async function ownProject(actor: Actor, id: string): Promise<ProjectView> {
  const p = /^[A-Za-z0-9_-]{6,64}$/.test(id) ? await getProject(actor, id) : null;
  if (!p) throw new ApiError(404, "That project no longer exists.", "not_found");
  return p;
}

/** Run something against the project's sandbox; sandbox problems become 400s with their message. */
export async function withSandbox<T>(actor: Actor, project: ProjectView, fn: (sb: Sandbox) => Promise<T>): Promise<T> {
  try { return await fn(await sandboxFor(actor, project.id)); }
  catch (e) { if (e instanceof SandboxError) throw new ApiError(400, e.message, "sandbox"); throw e; }
}

/** Wipe / account deletion: every project's files go too (containers, backups, local folders). Best effort. */
export async function destroyAllProjects(actor: Actor): Promise<void> {
  const { listProjects } = await import("../data/projects");
  for (const p of await listProjects(actor)) {
    await sandboxFor(actor, p.id).then((sb) => sb.destroy()).catch((e) => console.error("[projects] destroy", e));
  }
}
