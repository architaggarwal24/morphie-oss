import os from "node:os";
import path from "node:path";
import type { Actor } from "../auth/actor";
import { cfEnv } from "../cf";
import { getProject } from "../data/projects";
import { getRunnerRow } from "../data/runners";
import { getSecret } from "../settings";
import { CloudflareSandbox } from "./cloudflare";
import { LiteSandbox } from "./lite";
import { LocalSandbox } from "./local";
import { RunnerSandbox } from "./runner";
import { SandboxError, type Sandbox } from "./types";

export { LiteSandbox } from "./lite";
export { RunnerSandbox } from "./runner";

export * from "./types";

/** Where code projects run here: "cloudflare" (a container per project), "local" (a folder on this machine) or "none". */
export function sandboxKind(): "cloudflare" | "local" | "none" {
  // MORPHIE_SANDBOX=none: no code projects even where a binding exists (Workers Free has no containers; see wrangler.free.jsonc).
  if (process.env.MORPHIE_SANDBOX?.trim().toLowerCase() === "none") return "none";
  if (namespace()) return "cloudflare";
  if (process.env.NODE_ENV !== "production" || process.env.MORPHIE_LOCAL_SANDBOX === "1") return "local";
  return "none";
}

function namespace(): SandboxNamespaceLike | undefined {
  if (process.env.NODE_ENV === "test" && process.env.MORPHIE_TEST_CLOUDFLARE_SANDBOX !== "1") return undefined;
  try { return cfEnv().SANDBOX; } catch { return undefined; }
}

/** Git credentials for a local sandbox (given only to commands that need them, see gitToken.ts): a helper that reads the token from the environment, so it never lands in a file. */
function gitTokenEnv(token: string | undefined): Record<string, string> {
  if (!token) return {};
  return {
    GITHUB_TOKEN: token, GH_TOKEN: token,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "!f() { echo username=x-access-token; echo \"password=$GITHUB_TOKEN\"; }; f",
    // While the token is in the environment, the project's own git hooks don't run: a hook could read it.
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: path.join(os.tmpdir(), "morphie-no-git-hooks"), // doesn't exist, so no hooks run
  };
}

/** "Linux" from a runner's platform string ("linux x64 · bash"), for the system prompt. */
export const runnerShell = (platform: string) => `${platform.split("·")[1]?.trim() || "a shell"} on ${/^win32\b/i.test(platform) ? "Windows" : /^darwin\b/i.test(platform) ? "macOS" : "Linux"} (the user's own computer, through a Morphie Runner)`;

/** The sandbox for one of the user's projects. The caller has already checked the project belongs to them. */
export async function sandboxFor(actor: Actor, projectId: string): Promise<Sandbox> {
  const project = await getProject(actor, projectId);
  const where = project?.sandbox ?? "";
  if (where === "lite") return new LiteSandbox(actor.userId, projectId);
  if (where.startsWith("runner:")) {
    const runner = await getRunnerRow(actor, where.slice(7));
    if (!runner) throw new SandboxError("This project's Morphie Runner was removed. Add a runner again in Settings → Runners (the files are still on that computer).");
    return new RunnerSandbox(actor.userId, runner.id, projectId, runnerShell(runner.platform), await getSecret(actor, "github"));
  }
  const token = await getSecret(actor, "github");
  const ns = namespace();
  if (ns) return new CloudflareSandbox(ns, actor.userId, projectId, token);
  if (sandboxKind() === "local") return new LocalSandbox(actor.userId, projectId, {}, gitTokenEnv(token));
  throw new SandboxError("Code projects aren't available on this server: it has no sandbox. On Cloudflare, add the SANDBOX container binding (see README → Deploying); self-hosted, set MORPHIE_LOCAL_SANDBOX=1.");
}
