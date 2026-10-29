import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { pickWindowsBash } from "./winShell";
import { needsGitHubToken } from "./gitToken";
import {
  capOutput, cleanRel, EXEC_DEFAULT_MS, EXEC_MAX_MS, globToRegExp, SandboxError, SKIP_DIRS,
  type ExecOptions, type ExecResult, type GrepOptions, type Sandbox, type SandboxEntry,
} from "./types";

/**
 * A code project as a folder on this machine: `<data dir>/projects/<user>/<project>/`. Commands run through the local
 * shell with the project as working directory and a scrubbed environment (none of Morphie's own secrets).
 *
 * This is real code execution on the host, so it is for development and self-hosting by the machine's owner:
 * it is off in production unless MORPHIE_LOCAL_SANDBOX=1, and every command still goes through the approval rules.
 */
let cachedShell: { cmd: string; args: (c: string) => string[]; label: string } | undefined;
function shell() {
  if (cachedShell) return cachedShell;
  if (process.platform === "win32") {
    // Git for Windows ships bash; prefer it so the model's usual commands work (never the WSL launcher, see
    // winShell.ts). Otherwise fall back to cmd.exe.
    const where = (cmd: string) => { const r = spawnSync("where", [cmd], { encoding: "utf8", timeout: 5000 }); return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : []; };
    const bash = pickWindowsBash({
      override: process.env.MORPHIE_BASH, whereBash: where("bash"), whereGit: where("git"), exists: (p) => fs.existsSync(p),
      programDirs: [process.env.ProgramFiles, process.env.ProgramW6432, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")].filter((d): d is string => !!d),
    });
    cachedShell = bash ? { cmd: bash, args: (c) => ["-c", c], label: "bash (Git for Windows)" } : { cmd: process.env.ComSpec || "cmd.exe", args: (c) => ["/d", "/s", "/c", c], label: "cmd.exe on Windows" };
  } else {
    const bash = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    cachedShell = { cmd: bash, args: (c) => ["-c", c], label: `${path.basename(bash)} on ${process.platform === "darwin" ? "macOS" : "Linux"}` };
  }
  return cachedShell;
}

/** The variables a build needs, and nothing that belongs to Morphie (keys, secrets, database paths). */
function childEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ALLUSERSPROFILE", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "NVM_DIR", "NVM_HOME", "NVM_SYMLINK", "VOLTA_HOME", "CHROME_PATH"];
  const env: Record<string, string> = {};
  // Windows names its variables case-insensitively ("Path"): copy each once, under the name it really has.
  const actual = new Map(Object.keys(process.env).map((k) => [k.toLowerCase(), k]));
  for (const k of keep) { const name = actual.get(k.toLowerCase()); const v = name ? process.env[name] : undefined; if (name && v) env[name] = v; }
  return { ...env, HOME: process.env.HOME ?? process.env.USERPROFILE ?? home, TERM: "dumb", NO_COLOR: "1", CI: "1", GIT_TERMINAL_PROMPT: "0", ...withGitConfig(extra) } as unknown as NodeJS.ProcessEnv;
}

/**
 * Git settings every sandbox command gets, ahead of any in `extra` (the GitHub token's credential helper). core.autocrlf
 * is off so git never rewrites line endings in the user's files, even when their own git config turns it on (the
 * Windows default): a restored or cloned file comes back byte for byte.
 */
export const SANDBOX_GIT_CONFIG: Array<[string, string]> = [["core.autocrlf", "false"]];

export function withGitConfig(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const pairs = [...SANDBOX_GIT_CONFIG];
  const n = Number(extra.GIT_CONFIG_COUNT) || 0;
  for (let i = 0; i < n; i++) if (extra[`GIT_CONFIG_KEY_${i}`]) pairs.push([extra[`GIT_CONFIG_KEY_${i}`], extra[`GIT_CONFIG_VALUE_${i}`] ?? ""]);
  for (const [k, v] of Object.entries(extra)) if (!/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) out[k] = v;
  pairs.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${i}`] = k; out[`GIT_CONFIG_VALUE_${i}`] = v; });
  out.GIT_CONFIG_COUNT = String(pairs.length);
  return out;
}

export class LocalSandbox implements Sandbox {
  readonly kind = "local" as const;
  readonly canExec = true;
  readonly root: string;
  /** `tokenEnv`: the GitHub credentials, added only for commands that need them (gitToken.ts). */
  constructor(userId: string, projectId: string, private extraEnv: Record<string, string> = {}, private tokenEnv: Record<string, string> = {}) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(userId) || !/^[A-Za-z0-9_-]{6,64}$/.test(projectId)) throw new SandboxError("Invalid project.");
    this.root = path.join(config.dataDir, "projects", userId, projectId);
    fs.mkdirSync(this.root, { recursive: true });
  }
  get shell(): string { return shell().label; }

  /** Absolute path for a project-relative one; never outside the root, never through a symlink that leaves it. */
  private abs(rel: string | undefined, allowRoot = false): string {
    const clean = cleanRel(rel, { allowRoot });
    const real = fs.realpathSync(this.root);
    const full = path.join(real, ...clean.split("/").filter(Boolean));
    let probe = full;
    while (!fs.existsSync(probe) && probe !== real) probe = path.dirname(probe);
    const resolved = fs.realpathSync(probe);
    if (resolved !== real && !resolved.startsWith(real + path.sep)) throw new SandboxError("That path leads outside the project.");
    return full;
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const timeout = Math.min(EXEC_MAX_MS, Math.max(1000, opts.timeoutMs ?? EXEC_DEFAULT_MS));
    const cwd = this.abs(opts.cwd, true);
    const sh = shell();
    const started = Date.now();
    return new Promise((resolve) => {
      let out = "";
      let timedOut = false;
      const env = Object.keys(this.tokenEnv).length && needsGitHubToken(command) ? { ...this.extraEnv, ...this.tokenEnv } : this.extraEnv;
      const child = spawn(sh.cmd, sh.args(command), { cwd, env: childEnv(this.root, env), detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const killTree = () => {
        try { if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]); else process.kill(-child.pid!, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      };
      const timer = setTimeout(() => { timedOut = true; killTree(); }, timeout);
      const onAbort = () => killTree();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const take = (b: Buffer) => {
        const s = b.toString("utf8");
        if (out.length < 2_000_000) out += s;
        opts.onOutput?.(s);
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const done = (code: number | null) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        const { text, truncated } = capOutput(out);
        resolve({ exitCode: code ?? (timedOut ? 124 : 1), output: text, timedOut, truncated, ms: Date.now() - started });
      };
      child.on("error", (e) => { out += `\n${e.message}`; done(127); });
      child.on("close", done);
    });
  }

  /**
   * Start a long-running process in the project (the live preview's dev server), detached from any request.
   * The caller owns it: it must stop it with `killServer`.
   */
  spawnServer(command: string, env: Record<string, string>): ChildProcess {
    const sh = shell();
    return spawn(sh.cmd, sh.args(command), { cwd: this.root, env: childEnv(this.root, { ...this.extraEnv, ...env }), detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  }

  async readFile(rel: string): Promise<string | null> {
    const f = this.abs(rel);
    try { const st = fs.statSync(f); if (!st.isFile()) throw new SandboxError(`${cleanRel(rel)} is a folder, not a file.`); return fs.readFileSync(f, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }

  async readBytes(rel: string, maxBytes = 5_000_000): Promise<string | null> {
    const f = this.abs(rel);
    try { const st = fs.statSync(f); if (!st.isFile() || st.size > maxBytes) return null; return fs.readFileSync(f).toString("base64"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const f = this.abs(rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content, "utf8");
  }

  async remove(rel: string): Promise<void> { fs.rmSync(this.abs(rel), { recursive: true, force: true }); }

  async list(dir?: string, depth = 2): Promise<SandboxEntry[]> {
    const base = this.abs(dir, true);
    const realRoot = fs.realpathSync(this.root);
    const out: SandboxEntry[] = [];
    const walk = (d: string, level: number) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= 2000) return;
        const full = path.join(d, e.name);
        const rel = path.relative(realRoot, full).split(path.sep).join("/");
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          out.push({ path: rel, type: "dir" });
          if (level < depth && !SKIP_DIRS.has(e.name)) walk(full, level + 1);
        } else if (e.isFile()) out.push({ path: rel, type: "file", size: fs.statSync(full).size });
      }
    };
    walk(fs.realpathSync(base), 1);
    return out;
  }

  /** Every regular file in the project (skipping SKIP_DIRS), with its modification time. */
  private allFiles(sub = ""): Array<{ rel: string; mtime: number; size: number }> {
    const realRoot = fs.realpathSync(this.root);
    const start = sub ? this.abs(sub, true) : realRoot;
    const out: Array<{ rel: string; mtime: number; size: number }> = [];
    const walk = (d: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= 20_000) return;
        const full = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); }
        else if (e.isFile()) { const st = fs.statSync(full); out.push({ rel: path.relative(realRoot, full).split(path.sep).join("/"), mtime: st.mtimeMs, size: st.size }); }
      }
    };
    if (fs.existsSync(start) && fs.statSync(start).isFile()) { const st = fs.statSync(start); return [{ rel: path.relative(realRoot, start).split(path.sep).join("/"), mtime: st.mtimeMs, size: st.size }]; }
    walk(start);
    return out;
  }

  async glob(pattern: string, limit = 200): Promise<string[]> {
    const re = globToRegExp(pattern);
    return this.allFiles().filter((f) => re.test(f.rel)).sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.rel);
  }

  async grep(pattern: string, opts: GrepOptions = {}): Promise<string> {
    let re: RegExp;
    try { re = new RegExp(pattern, opts.ignoreCase ? "i" : ""); } catch (e) { throw new SandboxError(`Invalid regular expression: ${(e as Error).message}`); }
    const only = opts.glob ? globToRegExp(opts.glob) : undefined;
    const ctx = Math.min(5, Math.max(0, opts.context ?? 0));
    const max = Math.min(500, opts.maxResults ?? 100);
    const lines: string[] = [];
    let hits = 0;
    for (const f of this.allFiles(opts.path ? cleanRel(opts.path) : "")) {
      if (hits >= max) break;
      if ((only && !only.test(f.rel)) || f.size > 1_000_000) continue;
      let text: string;
      try { text = fs.readFileSync(path.join(this.root, f.rel), "utf8"); } catch { continue; }
      if (text.includes("\u0000")) continue; // binary
      const rows = text.split(/\r?\n/);
      let lastPrinted = -1;
      for (let i = 0; i < rows.length && hits < max; i++) {
        if (!re.test(rows[i])) continue;
        hits++;
        for (let j = Math.max(0, i - ctx, lastPrinted + 1); j <= Math.min(rows.length - 1, i + ctx); j++) {
          lines.push(`${f.rel}${j === i ? ":" : "-"}${j + 1}${j === i ? ":" : "-"}${rows[j].slice(0, 400)}`);
          lastPrinted = j;
        }
        if (ctx) lines.push("--");
      }
    }
    return lines.join("\n");
  }

  async clone(url: string, branch?: string | null): Promise<ExecResult> {
    if (fs.readdirSync(this.root).length) throw new SandboxError("The project folder isn't empty, so a repository can't be cloned into it.");
    const b = branch ? ` --branch ${JSON.stringify(branch)}` : "";
    return this.exec(`git clone --depth 50${b} -- ${JSON.stringify(url)} .`, { timeoutMs: 300_000 });
  }

  async checkpoint(): Promise<void> { /* the folder is already on disk */ }

  async destroy(): Promise<void> { fs.rmSync(this.root, { recursive: true, force: true }); }
}

/** Stop a process started with spawnServer, and everything it started. */
export function killServer(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  try { if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]); else process.kill(-child.pid, "SIGTERM"); }
  catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
}
