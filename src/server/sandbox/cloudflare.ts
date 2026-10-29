import { cleanRel, globToRegExp, SandboxError, type ExecOptions, type ExecResult, type GrepOptions, type Sandbox, type SandboxEntry } from "./types";
import { needsGitHubToken } from "./gitToken";

/**
 * Talks to the MorphieSandbox Durable Object (worker/sandbox.ts) over RPC: one object, and one container, per project.
 * Paths are checked here first (cleanRel) and again inside the object.
 */
export class CloudflareSandbox implements Sandbox {
  readonly kind = "cloudflare" as const;
  readonly canExec = true;
  readonly shell = "bash on Linux (Debian, in an isolated container; only GitHub and package registries are reachable)";
  private stub: SandboxStub;
  constructor(ns: SandboxNamespaceLike, userId: string, projectId: string, private githubToken?: string) {
    this.stub = ns.get(ns.idFromName(`${userId}:${projectId}`));
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SandboxError(/container|no container|not running|capacity/i.test(msg) ? `The project sandbox couldn't start: ${msg}` : msg);
    }
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = cleanRel(opts.cwd, { allowRoot: true });
    // The token never enters the container (the outbound proxy adds it to GitHub requests), and only while a git or gh
    // network command runs: other commands' requests to GitHub go out without it.
    const githubToken = this.githubToken && needsGitHubToken(command) ? this.githubToken : undefined;
    const r = await this.call(() => this.stub.exec(command, { cwd, timeoutMs: opts.timeoutMs, githubToken }));
    opts.onOutput?.(r.output);
    return r;
  }
  async readFile(path: string): Promise<string | null> { const p = cleanRel(path); return await this.call(() => this.stub.readFile(p)); }
  async readBytes(path: string, maxBytes = 5_000_000): Promise<string | null> { const p = cleanRel(path); return await this.call(() => this.stub.readBytes(p, maxBytes)); }
  async writeFile(path: string, content: string): Promise<void> { const p = cleanRel(path); return this.call(() => this.stub.writeFile(p, content)); }
  async remove(path: string): Promise<void> { const p = cleanRel(path); return this.call(() => this.stub.remove(p)); }
  async list(dir?: string, depth = 2): Promise<SandboxEntry[]> { const d = cleanRel(dir, { allowRoot: true }); return this.call(() => this.stub.list(d, depth)); }
  async glob(pattern: string, limit = 200): Promise<string[]> {
    const re = globToRegExp(pattern);
    const all = await this.call(() => this.stub.files_());
    return all.filter((f) => re.test(f)).slice(0, limit);
  }
  async grep(pattern: string, opts: GrepOptions = {}): Promise<string> {
    const o = { ...opts, path: opts.path ? cleanRel(opts.path) : undefined };
    return this.call(() => this.stub.grep(pattern, o));
  }
  clone(url: string, branch?: string | null): Promise<ExecResult> { return this.call(() => this.stub.clone(url, branch ?? null, this.githubToken)); }
  checkpoint(): Promise<void> { return this.call(() => this.stub.checkpoint()); }
  destroy(): Promise<void> { return this.call(() => this.stub.destroy()); }
}
