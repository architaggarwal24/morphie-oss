/**
 * The code sandbox on Cloudflare: one Durable Object (and the Linux container it starts) per code project.
 *
 * Built on Cloudflare Sandbox SDK 1.0: this Durable Object owns `ctx.container`; `Files` moves files in and out and
 * `DirectoryBackup` saves the project folder to R2 (bucket FILES) so it survives the container being recycled.
 *
 * Network: the container has no direct Internet (`enableInternet: false`). Every HTTP/HTTPS request it makes goes
 * through `SandboxOutbound` below, which allows only package registries and GitHub, and adds the user's GitHub token
 * to GitHub requests. The token never enters the container.
 */
import { DirectoryBackup, Files, SandboxFileError, type DirectoryBackupRecord } from "@cloudflare/sandbox";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export { DirectoryBackupGateway } from "@cloudflare/sandbox";

const ROOT = "/workspace/project";
const INACTIVITY_MS = 20 * 60_000;
const EXEC_DEFAULT_MS = 120_000;
const EXEC_MAX_MS = 600_000;
const OUTPUT_CAP = 30_000;
const SKIP_DIRS = [".git", "node_modules", ".next", ".open-next", "dist", "build", ".venv", "venv", "__pycache__", ".turbo", ".cache", "target"];
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
// exec() doesn't inherit start() env: pass these on every command so HTTPS through the outbound proxy is trusted.
const BASE_ENV: Record<string, string> = {
  HOME: "/root", TERM: "dumb", NO_COLOR: "1", CI: "1", GIT_TERMINAL_PROMPT: "0",
  NODE_EXTRA_CA_CERTS: CA, GIT_SSL_CAINFO: CA, CURL_CA_BUNDLE: CA, SSL_CERT_FILE: CA, REQUESTS_CA_BUNDLE: CA, PIP_CERT: CA,
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  // verify_project's headless browser (installed by sandbox/Dockerfile).
  CHROME_PATH: "/usr/bin/chromium",
};

/** Hosts the sandbox may reach (HTTPS only). Everything else gets a 403. */
const ALLOWED = [
  /^github\.com$/, /^api\.github\.com$/, /^codeload\.github\.com$/, /^(objects|raw|release-assets)\.githubusercontent\.com$/,
  /^registry\.npmjs\.org$/, /^registry\.yarnpkg\.com$/, /^nodejs\.org$/, /^pypi\.org$/, /^files\.pythonhosted\.org$/,
  /^(index|static)\.crates\.io$/, /^proxy\.golang\.org$/, /^sum\.golang\.org$/, /^deb\.debian\.org$/, /^security\.debian\.org$/,
];

interface Env {
  FILES: unknown;
  SANDBOX: { get(id: unknown): MorphieSandbox; idFromString(id: string): unknown };
}
interface ExecResult { exitCode: number; output: string; timedOut: boolean; truncated: boolean; ms: number }
interface Entry { path: string; type: "file" | "dir"; size?: number }

function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= OUTPUT_CAP) return { text, truncated: false };
  const head = Math.floor(OUTPUT_CAP / 3);
  return { text: `${text.slice(0, head)}\n…[${text.length - OUTPUT_CAP} characters omitted]…\n${text.slice(text.length - (OUTPUT_CAP - head))}`, truncated: true };
}

/** Same rules as src/server/sandbox/types.ts cleanRel (the server checks first; this is the second lock). */
function abs(rel: string | undefined, allowRoot = false): string {
  const raw = (rel ?? "").trim().replace(/^\.\/+/, "");
  const parts = raw.split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..") || raw.startsWith("/") || /[\0\\]/.test(raw)) throw new Error("That path leads outside the project.");
  if (!parts.length && !allowRoot) throw new Error("A path inside the project is required.");
  return parts.length ? `${ROOT}/${parts.join("/")}` : ROOT;
}

export class MorphieSandbox extends DurableObject<Env> {
  // The container and the SDK helpers. Typed loosely: the Container API is newer than most published type packages.
  private container: any;
  private files: Files;
  private backups: DirectoryBackup;
  private ready: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.container = (ctx as any).container;
    if (!this.container) throw new Error("This Durable Object has no container attached. Check the containers entry in wrangler.jsonc.");
    this.files = new Files(this.container);
    this.backups = new DirectoryBackup(this.container, (ctx as any).exports.DirectoryBackupGateway, { binding: "FILES", prefix: `sandboxes/${ctx.id.toString()}/` });
    if (this.container.running) void ctx.blockConcurrencyWhile(() => this.container.setInactivityTimeout(INACTIVITY_MS));
  }

  /** Start the container if needed: network policy first, then the project folder restored from its last backup. */
  private ensure(): Promise<void> {
    if (this.ready && this.container.running) return this.ready;
    this.ready = (async () => {
      if (this.container.running) return;
      this.container.start({ image: this.container.images.sandbox, instance: "standard-1", enableInternet: false, labels: { app: "morphie" } });
      const outbound = (this.ctx as any).exports.SandboxOutbound({ props: { sandboxId: this.ctx.id.toString() } });
      // Order matters: the backup gateway's route first, then the catch-alls (which take every host registered after them).
      await this.backups.intercept();
      await this.container.interceptAllOutboundHttp(outbound);
      await this.container.interceptOutboundHttps("*", outbound);
      await this.container.setInactivityTimeout(INACTIVITY_MS);
      const record = await this.ctx.storage.get<DirectoryBackupRecord>("backup");
      if (record) await this.backups.restore(record, { dir: ROOT });
      else await this.files.mkdir(ROOT, { recursive: true });
    })().catch((e) => { this.ready = undefined; throw e; });
    return this.ready;
  }

  /** The user's GitHub token for this call (kept in this object's storage; read by the outbound proxy, never by the container). */
  private async setToken(token: string | undefined): Promise<void> {
    if (token) await this.ctx.storage.put("githubToken", token);
    else await this.ctx.storage.delete("githubToken");
  }
  async githubToken(): Promise<string | undefined> { return this.ctx.storage.get<string>("githubToken"); }

  private async run(argv: string[], cwd = ROOT, timeoutMs = EXEC_DEFAULT_MS): Promise<ExecResult> {
    const started = Date.now();
    const signal = AbortSignal.timeout(Math.min(EXEC_MAX_MS, Math.max(1000, timeoutMs)));
    let exitCode = 1, raw = "", timedOut = false;
    try {
      const proc = await this.container.exec(argv, { cwd, env: BASE_ENV, stdout: "pipe", stderr: "combined", signal });
      const out = await proc.output();
      exitCode = out.exitCode;
      raw = new TextDecoder().decode(out.stdout);
    } catch (e) {
      timedOut = signal.aborted;
      raw = timedOut ? "" : String((e as Error)?.message ?? e);
      exitCode = timedOut ? 124 : 1;
    }
    const { text, truncated } = cap(raw);
    return { exitCode, output: text, timedOut, truncated, ms: Date.now() - started };
  }

  async exec(command: string, opts: { cwd?: string; timeoutMs?: number; githubToken?: string } = {}): Promise<ExecResult> {
    await this.ensure();
    await this.setToken(opts.githubToken);
    return this.run(["/bin/bash", "-lc", command], abs(opts.cwd, true), opts.timeoutMs);
  }

  async readFile(path: string): Promise<string | null> {
    await this.ensure();
    try { return await (await this.files.readFile(abs(path))).text(); }
    catch (e) { if (SandboxFileError.is(e) && (e as any).code === "ENOENT") return null; throw e; }
  }

  /** A binary file as base64 (screenshots, downloads). null when missing or larger than maxBytes. */
  async readBytes(path: string, maxBytes = 5_000_000): Promise<string | null> {
    await this.ensure();
    try {
      const buf = new Uint8Array(await (await this.files.readFile(abs(path))).arrayBuffer());
      if (buf.byteLength > maxBytes) return null;
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(bin);
    } catch (e) { if (SandboxFileError.is(e) && (e as any).code === "ENOENT") return null; throw e; }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ensure();
    const full = abs(path);
    await this.files.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await this.files.writeFile(full, content);
  }

  async remove(path: string): Promise<void> {
    await this.ensure();
    await this.files.remove(abs(path), { recursive: true, force: true });
  }

  async list(dir?: string, depth = 2): Promise<Entry[]> {
    await this.ensure();
    const base = abs(dir, true);
    const prune = SKIP_DIRS.flatMap((d) => ["-not", "-path", `*/${d}/*`]);
    const r = await this.run(["find", base, "-mindepth", "1", "-maxdepth", String(Math.min(6, Math.max(1, depth))), ...prune, "-printf", "%y\t%s\t%P\n"], ROOT, 30_000);
    const rel = base === ROOT ? "" : base.slice(ROOT.length + 1) + "/";
    return r.output.split("\n").filter(Boolean).slice(0, 2000).flatMap((line) => {
      const [y, size, p] = line.split("\t");
      if (y !== "f" && y !== "d") return [];
      return [{ path: rel + p, type: y === "d" ? ("dir" as const) : ("file" as const), ...(y === "f" ? { size: Number(size) } : {}) }];
    }).sort((a, b) => a.path.localeCompare(b.path));
  }

  /** All files ripgrep sees (respecting .gitignore), newest first; the server filters by glob. */
  async files_(limit = 20_000): Promise<string[]> {
    await this.ensure();
    const r = await this.run(["rg", "--files", "--hidden", "--glob", "!.git", "--sortr", "modified"], ROOT, 60_000);
    return r.output.split("\n").filter(Boolean).slice(0, limit);
  }

  async grep(pattern: string, opts: { path?: string; glob?: string; ignoreCase?: boolean; context?: number; maxResults?: number } = {}): Promise<string> {
    await this.ensure();
    const args = ["rg", "-n", "--no-heading", "--color", "never", "--hidden", "--glob", "!.git", "--max-columns", "400"];
    if (opts.ignoreCase) args.push("-i");
    if (opts.context) args.push("-C", String(Math.min(5, opts.context)));
    if (opts.glob) args.push("--glob", opts.glob);
    args.push("--", pattern, opts.path ? abs(opts.path).slice(ROOT.length + 1) : ".");
    const r = await this.run(args, ROOT, 60_000);
    return r.output.split("\n").slice(0, Math.min(500, opts.maxResults ?? 100) * (1 + 2 * (opts.context ?? 0))).join("\n");
  }

  async clone(url: string, branch: string | null, githubToken?: string): Promise<ExecResult> {
    await this.ensure();
    await this.setToken(githubToken);
    const b = branch ? ["--branch", branch] : [];
    return this.run(["git", "clone", "--depth", "50", ...b, "--", url, "."], ROOT, 300_000);
  }

  /** Save the project folder to R2 (dependencies and build output excluded; they can be reinstalled). */
  async checkpoint(): Promise<void> {
    if (!this.container.running) return;
    const previous = await this.ctx.storage.get<DirectoryBackupRecord>("backup");
    const record = await this.backups.backup({ dir: ROOT, name: "project", exclude: ["node_modules/", ".next/", ".open-next/", ".venv/", "venv/", "__pycache__/", ".turbo/", ".cache/", "target/"] });
    await this.ctx.storage.put("backup", record);
    if (previous) await this.backups.delete(previous).catch(() => {});
  }

  async destroy(): Promise<void> {
    const record = await this.ctx.storage.get<DirectoryBackupRecord>("backup");
    if (record) await this.backups.delete(record).catch(() => {});
    if (this.container.running) await this.container.destroy();
    await this.ctx.storage.deleteAll();
    this.ready = undefined;
  }
}

/**
 * Every HTTP(S) request from a sandbox container lands here. HTTPS to the allow-list goes through; GitHub requests get
 * the project owner's token (looked up in the sandbox's own storage); everything else is refused.
 */
export class SandboxOutbound extends WorkerEntrypoint<Env, { sandboxId: string }> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return new Response(`${url.hostname}: only HTTPS is allowed from the sandbox\n`, { status: 403 });
    if (!ALLOWED.some((re) => re.test(url.hostname))) return new Response(`${url.hostname} is not reachable from the sandbox (allowed: package registries and GitHub)\n`, { status: 403 });
    if (url.hostname === "github.com" || url.hostname === "api.github.com") {
      const props = (this.ctx as any).props as { sandboxId: string };
      const token = await this.env.SANDBOX.get(this.env.SANDBOX.idFromString(props.sandboxId)).githubToken();
      if (token) {
        const headers = new Headers(request.headers);
        headers.set("authorization", url.hostname === "api.github.com" ? `Bearer ${token}` : `Basic ${btoa(`x-access-token:${token}`)}`);
        return fetch(new Request(request, { headers }));
      }
    }
    return fetch(request);
  }
}
