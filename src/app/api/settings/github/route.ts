import { z } from "zod";
import type { Actor } from "@/server/auth/actor";
import { route } from "@/server/http";
import { requireFeature } from "@/server/plans";
import { deleteSecret, getSecret, setSecret } from "@/server/settings";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The GitHub token code projects use to clone private repositories, push and open pull requests. Stored encrypted. */
const state = async (actor: Actor) => ({ github: !!(await getSecret(actor, "github")) });

export const PUT = route({ auth: "user" }, async (c) => {
  const { token } = await c.body(z.object({
    token: z.string().trim().min(20, "That token looks too short.").max(300).regex(/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]+$/, "That doesn't look like a GitHub token (they start with ghp_ or github_pat_)."),
  }));
  await requireFeature(c.actor, "githubRepos");
  await setSecret(c.actor, "github", token);
  return state(c.actor);
});

export const DELETE = route({ auth: "user" }, async (c) => {
  await deleteSecret(c.actor, "github");
  return state(c.actor);
});
