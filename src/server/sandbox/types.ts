/**
 * Where an agent's code project lives and runs. Four implementations behind one interface:
 * - CloudflareSandbox: a Linux container per project (Cloudflare Sandbox SDK), backed up to R2 between runs.
 * - LocalSandbox: a folder under the data directory on this machine (development / self-hosting), commands run
 *   through the local shell.
 * - LiteSandbox: files only, in storage (R2 or the data folder). No shell, so it works on every plan and host;
 *   good for static sites, which the Preview tab serves.
 * - RunnerSandbox: a folder on the user's own computer or VM, through a Morphie Runner they started there.
 * Paths are always relative to the project root; implementations refuse anything that escapes it.
 */
export interface ExecResult {
  exitCode: number;
  /** stdout and stderr interleaved as they arrived (what a terminal would show), capped. */
  output: string;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}

export interface ExecOptions {
  /** Default 120 s, at most 10 minutes. */
  timeoutMs?: number;
  /** Relative to the project root. */
  cwd?: string;
  signal?: AbortSignal;
  /** Live output (local only; the container returns it all at the end). */
  onOutput?: (chunk: string) => void;
}

export interface SandboxEntry { path: string; type: "file" | "dir"; size?: number }

export interface GrepOptions { path?: string; glob?: string; ignoreCase?: boolean; context?: number; maxResults?: number }

export interface Sandbox {
  readonly kind: "local" | "cloudflare" | "lite" | "runner";
  /** Commands can run (false for Lite projects: the shell tools are left out). */
  readonly canExec: boolean;
  /** Human description of the shell, for the system prompt ("bash on Linux", "cmd.exe on Windows"). */
  readonly shell: string;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** null when the file doesn't exist. */
  readFile(path: string): Promise<string | null>;
  /** A binary file as base64 (null when missing or larger than maxBytes). */
  readBytes(path: string, maxBytes?: number): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Files and folders under `dir` (default the root), `depth` levels deep. .git and node_modules are listed, not entered. */
  list(dir?: string, depth?: number): Promise<SandboxEntry[]>;
  /** Paths matching a glob ("src/**\/*.ts"), most recently modified first. */
  glob(pattern: string, limit?: number): Promise<string[]>;
  /** ripgrep-style "path:line:text" matches. */
  grep(pattern: string, opts?: GrepOptions): Promise<string>;
  /** Clone a repository into the (empty) project root. */
  clone(url: string, branch?: string | null): Promise<ExecResult>;
  /** Persist the project between runs (the container's disk is temporary). No-op locally. */
  checkpoint(): Promise<void>;
  /** Delete the project's files for good. */
  destroy(): Promise<void>;
}

export class SandboxError extends Error {}

export const EXEC_DEFAULT_MS = 120_000;
export const EXEC_MAX_MS = 600_000;
export const OUTPUT_CAP = 30_000;
/** Folders that are listed but never walked into (huge, generated, or private to git). */
export const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".open-next", "dist", "build", ".venv", "venv", "__pycache__", ".turbo", ".cache", "target"]);

/** Normalise a project-relative path. Rejects absolute paths, backslashes and anything that climbs out. */
export function cleanRel(p: string | undefined, { allowRoot = false } = {}): string {
  const raw = (p ?? "").trim().replace(/^\.\/+/, "");
  if (!raw || raw === ".") { if (allowRoot) return ""; throw new SandboxError("A path inside the project is required."); }
  if (raw.length > 400 || /[\0\\]/.test(raw)) throw new SandboxError("That path isn't valid.");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new SandboxError("Use a path relative to the project root, like src/index.ts.");
  const parts: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new SandboxError("Paths can't go above the project root.");
    parts.push(seg);
  }
  if (!parts.length) { if (allowRoot) return ""; throw new SandboxError("A path inside the project is required."); }
  return parts.join("/");
}

/** Keep the start and the end of long output (errors are usually at the end). */
export function capOutput(text: string, cap = OUTPUT_CAP): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  const head = Math.floor(cap / 3);
  return { text: `${text.slice(0, head)}\n…[${text.length - cap} characters omitted]…\n${text.slice(text.length - (cap - head))}`, truncated: true };
}

/** Glob → RegExp with the usual meaning: `**` any depth, `*` within a segment, `?` one char, `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  const g = glob.replace(/^\.\//, "");
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 3 : 2;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end > i) { re += "(?:" + g.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")"; i = end + 1; continue; }
      re += "\\{";
    } else if ("\\^$+.()|[]".includes(c)) re += "\\" + c;
    else re += c;
    i++;
  }
  // A pattern without a slash matches the file name at any depth (like ripgrep's --glob).
  return new RegExp(g.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}
