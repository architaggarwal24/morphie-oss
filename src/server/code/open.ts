import type { ProjectView } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { sandboxFor } from "../sandbox";
import { getSecret } from "../settings";
import { loadProjectInfo, type CodeContext, type ProjectInfo } from "./project";

/** What a run in a code project needs: its sandbox and context, and what the system prompt says about it. */
export interface RunCode {
  ctx: CodeContext;
  info: ProjectInfo & { shell: string; sandbox: "local" | "cloudflare" | "lite" | "runner"; github: boolean; project: string; repoUrl: string | null };
}

/** Open a project for a run: start (or reach) its sandbox and read its instructions, settings and git state. */
export async function openCode(actor: Actor, project: ProjectView): Promise<RunCode> {
  const sandbox = await sandboxFor(actor, project.id);
  const info = await loadProjectInfo(sandbox);
  const githubToken = await getSecret(actor, "github");
  const ctx: CodeContext = { project, sandbox, read: new Set(), githubToken, projectDeny: info.deny, changed: [] };
  return { ctx, info: { ...info, shell: sandbox.shell, sandbox: sandbox.kind, github: !!githubToken, project: project.name, repoUrl: project.repoUrl } };
}
