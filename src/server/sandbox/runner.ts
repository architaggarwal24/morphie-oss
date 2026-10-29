import { coordinator } from "../coordinator";
import { randomId } from "../crypto";
import { cleanRel, EXEC_DEFAULT_MS, EXEC_MAX_MS, SandboxError, type ExecOptions, type ExecResult, type GrepOptions, type Sandbox, type SandboxEntry } from "./types";
import { needsGitHubToken } from "./gitToken";

/**
 * A project on the user's own computer or VM, through a Morphie Runner they started there (public/morphie-runner.mjs).
 * The runner connects out to Morphie and long-polls for work, so nothing needs to reach into their network. Each
 * operation is a job that goes through the user's Coordinator (src/server/coordinator-core.ts) to the runner and back.
 */
export class RunnerSandbox implements Sandbox {
  readonly kind = "runner" as const;
  readonly canExec = true;
  constructor(private userId: string, private runnerId: string, private projectId: string, readonly shell: string, private githubToken?: string) {}

  private async call<T>(op: string, args: unknown[], timeoutMs = 60_000): Promise<T> {
    const r = await coordinator(this.userId).runJob(this.runnerId, { id: randomId(12), project: this.projectId, op, args }, timeoutMs);
    if (!r.ok) throw new SandboxError(r.error ?? "The runner couldn't do that.");
    return r.value as T;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = Math.min(EXEC_MAX_MS, Math.max(1000, opts.timeoutMs ?? EXEC_DEFAULT_MS));
    const cwd = opts.cwd ? cleanRel(opts.cwd, { allowRoot: true }) : "";
    // The token goes to the runner only for git / gh network commands (gitToken.ts); other commands never see it.
    const githubToken = this.githubToken && needsGitHubToken(command) ? this.githubToken : undefined;
    const r = await this.call<ExecResult>("exec", [command, { cwd, timeoutMs, githubToken }], timeoutMs + 30_000);
    opts.onOutput?.(r.output);
    return r;
  }
  async readFile(rel: string) { return this.call<string | null>("readFile", [cleanRel(rel)]); }
  async readBytes(rel: string, maxBytes = 5_000_000) { return this.call<string | null>("readBytes", [cleanRel(rel), maxBytes]); }
  async writeFile(rel: string, content: string) { return this.call<void>("writeFile", [cleanRel(rel), content]); }
  async remove(rel: string) { return this.call<void>("remove", [cleanRel(rel)]); }
  async list(dir?: string, depth = 2) { return this.call<SandboxEntry[]>("list", [cleanRel(dir, { allowRoot: true }), depth]); }
  async glob(pattern: string, limit = 200) { return this.call<string[]>("glob", [pattern, limit]); }
  async grep(pattern: string, opts: GrepOptions = {}) { return this.call<string>("grep", [pattern, opts]); }
  async clone(url: string, branch?: string | null) { return this.call<ExecResult>("clone", [url, branch ?? null, this.githubToken], 330_000); }
  async checkpoint(): Promise<void> { /* the files are on the runner's disk */ }
  async destroy() { return this.call<void>("destroy", []); }
}
