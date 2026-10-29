import { z } from "zod";
import { acceptChange, commitAll, createBranch, getChanges, openPullRequest, push, rejectChange } from "@/server/code/git";
import { ownProject, withSandbox } from "@/server/code/routes";
import { ignoreScratch } from "@/server/code/scratch";
import { touchProject } from "@/server/data/projects";
import { route } from "@/server/http";
import { getSecret } from "@/server/settings";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The working tree's changes (git status + diff): what the Changes panel shows. */
export const GET = route({ auth: "user" }, async (c) => {
  const project = await ownProject(c.actor, c.params.id);
  return await withSandbox(c.actor, project, async (sb) => { await ignoreScratch(sb); return getChanges(sb); });
});

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), path: z.string().max(400).optional() }),
  z.object({ action: z.literal("reject"), path: z.string().max(400).optional() }),
  z.object({ action: z.literal("commit"), message: z.string().trim().min(1, "Write a commit message first.").max(5000) }),
  z.object({ action: z.literal("branch"), name: z.string().trim().min(1).max(120) }),
  z.object({ action: z.literal("push") }),
  z.object({ action: z.literal("pr"), title: z.string().trim().min(1, "Give the pull request a title.").max(250), body: z.string().max(60_000).optional(), base: z.string().max(120).optional() }),
]);

/** Accept (stage) or reject (revert) changes, commit, branch, push, open a pull request. Returns the new state. */
export const POST = route({ auth: "user", rate: { bucket: "git", limit: 60, windowMs: 60_000 } }, async (c) => {
  const project = await ownProject(c.actor, c.params.id);
  const b = await c.body(action);
  return await withSandbox(c.actor, project, async (sb) => {
    let result: Record<string, unknown> = {};
    if (b.action === "accept") await acceptChange(sb, b.path);
    else if (b.action === "reject") await rejectChange(sb, b.path);
    else if (b.action === "commit") result = { commit: await commitAll(sb, b.message) };
    else if (b.action === "branch") await createBranch(sb, b.name);
    else if (b.action === "push") result = { pushed: await push(sb) };
    else result = { pr: await openPullRequest(sb, { token: await getSecret(c.actor, "github"), repoUrl: project.repoUrl, title: b.title, body: b.body, base: b.base }) };
    await sb.checkpoint().catch((e) => console.error("[sandbox] checkpoint", e));
    await touchProject(c.actor, project.id);
    return { ...result, changes: await getChanges(sb) };
  });
});
