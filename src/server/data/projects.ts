import type { ProjectView } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { randomId } from "../crypto";
import { db, now, stmt } from "../db";
import { NotFoundError } from "./errors";

/** Code projects: every query is scoped to the owner, so a project id alone proves nothing. */
interface ProjectRow { id: string; name: string; repo_url: string | null; branch: string | null; sandbox: string | null; created_at: number; updated_at: number }
const toView = (r: ProjectRow): ProjectView => ({ id: r.id, name: r.name, repoUrl: r.repo_url, branch: r.branch, sandbox: r.sandbox ?? "", createdAt: r.created_at, updatedAt: r.updated_at });

export async function listProjects(actor: Actor): Promise<ProjectView[]> {
  return (await db().all<ProjectRow>("SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100", actor.userId)).map(toView);
}

export async function getProject(actor: Actor, id: string): Promise<ProjectView | null> {
  const r = await db().get<ProjectRow>("SELECT * FROM projects WHERE id = ? AND user_id = ?", id, actor.userId);
  return r ? toView(r) : null;
}

export async function countProjects(actor: Actor): Promise<number> {
  return (await db().get<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?", actor.userId))?.n ?? 0;
}

export async function insertProject(actor: Actor, p: { name: string; repoUrl: string | null; branch: string | null; sandbox?: string }): Promise<ProjectView> {
  const id = randomId(10);
  const t = now();
  await db().run("INSERT INTO projects (id, user_id, name, repo_url, branch, sandbox, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id, actor.userId, p.name.slice(0, 80), p.repoUrl, p.branch, p.sandbox ?? "", t, t);
  return (await getProject(actor, id))!;
}

export async function updateProject(actor: Actor, id: string, patch: { name?: string; branch?: string | null }): Promise<ProjectView> {
  const cur = await getProject(actor, id);
  if (!cur) throw new NotFoundError("Project not found");
  await db().run("UPDATE projects SET name = ?, branch = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    (patch.name ?? cur.name).slice(0, 80), patch.branch === undefined ? cur.branch : patch.branch, now(), id, actor.userId);
  return (await getProject(actor, id))!;
}

export async function touchProject(actor: Actor, id: string): Promise<void> {
  await db().run("UPDATE projects SET updated_at = ? WHERE id = ? AND user_id = ?", now(), id, actor.userId);
}

/** The project goes; its tasks stay in the history as ordinary agent tasks. */
export async function deleteProject(actor: Actor, id: string): Promise<void> {
  if (!(await getProject(actor, id))) throw new NotFoundError("Project not found");
  await db().batch([
    stmt("UPDATE conversations SET project_id = NULL WHERE user_id = ? AND project_id = ?", actor.userId, id),
    stmt("DELETE FROM projects WHERE id = ? AND user_id = ?", id, actor.userId),
  ]);
}
