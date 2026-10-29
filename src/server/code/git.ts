import type { ChangedFile, ProjectChanges } from "@/lib/types";
import { guardedFetch } from "../net";
import { SandboxError, type ExecResult, type Sandbox } from "../sandbox/types";
import { capDiff } from "./diff";

/** Single-quote a value for bash. */
export const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const GIT = "git -c core.quotepath=false";
const PANEL_DIFF_CAP = 80_000;

/** Everything the Changes panel needs, in one command (one round trip to the container). */
const CHANGES_SCRIPT = `
set +e
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "@@NOGIT"; exit 0; fi
HASHEAD=0; git rev-parse --verify -q HEAD >/dev/null 2>&1 && HASHEAD=1
echo "@@BRANCH"; git branch --show-current
echo "@@AHEAD"; git rev-list --count @{u}..HEAD 2>/dev/null || echo "-"
echo "@@STATUS"; ${GIT} status --porcelain=v1 --untracked-files=all | head -n 500
echo "@@STAGED"; ${GIT} diff --cached --name-only | head -n 500
echo "@@NUMSTAT"; if [ $HASHEAD = 1 ]; then ${GIT} diff HEAD --numstat; else ${GIT} diff --cached --numstat; fi | head -n 500
echo "@@DIFF"; if [ $HASHEAD = 1 ]; then ${GIT} diff HEAD; else ${GIT} diff --cached; fi | head -c 300000
${GIT} ls-files --others --exclude-standard | head -n 60 | while IFS= read -r f; do ${GIT} diff --no-index -- /dev/null "$f" 2>/dev/null | head -c 20000; done
`;

function sections(out: string): Record<string, string> {
  const res: Record<string, string> = {};
  let key = "";
  for (const line of out.split("\n")) {
    const m = /^@@([A-Z]+)$/.exec(line);
    if (m) { key = m[1]; res[key] = ""; continue; }
    if (key) res[key] += line + "\n";
  }
  return res;
}

function untrackedCounts(diff: string): Map<string, number> {
  const out = new Map<string, number>();
  let cur: string | null = null;
  for (const l of diff.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(l);
    if (m) { cur = m[1]; out.set(cur, 0); continue; }
    if (cur && l.startsWith("+") && !l.startsWith("+++")) out.set(cur, (out.get(cur) ?? 0) + 1);
  }
  return out;
}

export async function getChanges(sb: Sandbox): Promise<ProjectChanges> {
  const r = await sb.exec(CHANGES_SCRIPT, { timeoutMs: 60_000 });
  if (r.output.includes("@@NOGIT")) return { git: false, branch: null, ahead: null, files: [], diff: "", truncated: false };
  const s = sections(r.output);
  const staged = new Set((s.STAGED ?? "").split("\n").filter(Boolean));
  const num = new Map<string, [number, number]>();
  for (const l of (s.NUMSTAT ?? "").split("\n")) {
    const [a, d, ...p] = l.split("\t");
    if (p.length) num.set(p.join("\t").replace(/^.* => /, ""), [Number(a) || 0, Number(d) || 0]);
  }
  const diff = s.DIFF ?? "";
  const untracked = untrackedCounts(diff);
  const files: ChangedFile[] = [];
  for (const l of (s.STATUS ?? "").split("\n")) {
    if (l.length < 4) continue;
    const x = l[0], y = l[1];
    let path = l.slice(3);
    if (path.includes(" -> ")) path = path.split(" -> ").pop()!;
    path = path.replace(/^"|"$/g, "");
    const code = x === "?" ? "?" : x === "R" || y === "R" ? "R" : x === "A" ? "A" : x === "D" || y === "D" ? "D" : "M";
    const [added, removed] = code === "?" ? [untracked.get(path) ?? 0, 0] : num.get(path) ?? [0, 0];
    files.push({ path, status: code as ChangedFile["status"], staged: x !== " " && x !== "?" && staged.has(path) && y === " ", added, removed });
  }
  const capped = capDiff(diff.trimEnd(), PANEL_DIFF_CAP);
  const ahead = (s.AHEAD ?? "").trim();
  return { git: true, branch: (s.BRANCH ?? "").trim() || null, ahead: /^\d+$/.test(ahead) ? Number(ahead) : null, files, diff: capped, truncated: capped.length < diff.trimEnd().length };
}

function check(r: ExecResult, what: string): ExecResult {
  if (r.exitCode !== 0) throw new SandboxError(`${what} failed:\n${r.output.trim().slice(-1500) || `exit code ${r.exitCode}`}`);
  return r;
}

const SAFE_PATH = /^[^\0\n]{1,400}$/;
function relPath(p: string): string {
  const clean = p.replace(/^\.\/+/, "");
  if (!SAFE_PATH.test(clean) || clean.startsWith("/") || clean.split("/").includes("..")) throw new SandboxError("That path isn't valid.");
  return clean;
}

/** Accept = stage (keep) the change. No path = all of them. */
export async function acceptChange(sb: Sandbox, path?: string): Promise<void> {
  check(await sb.exec(path ? `git add -A -- ${sq(relPath(path))}` : "git add -A", { timeoutMs: 60_000 }), "Staging");
}

/** Reject = put the file back as it is in the last commit (a new file is removed). No path = every change. */
export async function rejectChange(sb: Sandbox, path?: string): Promise<void> {
  if (!path) {
    check(await sb.exec(`if git rev-parse --verify -q HEAD >/dev/null; then git reset -q --hard HEAD; else git rm -rq --cached . >/dev/null 2>&1; fi; git clean -fdq`, { timeoutMs: 60_000 }), "Discarding changes");
    return;
  }
  const p = sq(relPath(path));
  check(await sb.exec(`if git cat-file -e HEAD:${p} 2>/dev/null; then git restore --source=HEAD --staged --worktree -- ${p}; else git rm -q --cached --ignore-unmatch -- ${p} && rm -rf -- ${p}; fi`, { timeoutMs: 60_000 }), "Reverting");
}

export async function commitAll(sb: Sandbox, message: string): Promise<string> {
  const msg = message.trim();
  if (!msg) throw new SandboxError("Write a commit message first.");
  const r = check(await sb.exec(`git add -A && git commit -q -m ${sq(msg.slice(0, 5000))} && git log -1 --format='%h %s'`, { timeoutMs: 60_000 }), "Commit");
  return r.output.trim().split("\n").pop() ?? "";
}

export const BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\/-]{1,120}$/;

export async function createBranch(sb: Sandbox, name: string): Promise<void> {
  if (!BRANCH_RE.test(name) || name.startsWith("-")) throw new SandboxError("That isn't a valid branch name.");
  check(await sb.exec(`git switch -c ${sq(name)}`, { timeoutMs: 30_000 }), "Creating the branch");
}

export async function push(sb: Sandbox): Promise<string> {
  const r = check(await sb.exec("git push -u origin HEAD 2>&1", { timeoutMs: 180_000 }), "Push");
  return r.output.trim().slice(-600);
}

/** owner/repo from a GitHub URL (https or git@), or null. */
export function githubRepo(url: string | null | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function gh(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  const res = await guardedFetch(`https://api.github.com${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "Morphie", "x-github-api-version": "2022-11-28", ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  }, { allowPrivate: false });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.errors?.map((e: any) => e.message).filter(Boolean).join("; ");
    throw new SandboxError(`GitHub said: ${data?.message ?? res.status}${detail ? ` (${detail})` : ""}`);
  }
  return data;
}

/**
 * Open a pull request for the current branch: push it, then call the GitHub API with the user's token.
 * If the project is on the default branch, a new branch is created first.
 */
export async function openPullRequest(sb: Sandbox, opts: { token?: string; repoUrl: string | null; title: string; body?: string; base?: string; branch?: string }): Promise<{ url: string; number: number; branch: string }> {
  if (!opts.token) throw new SandboxError("Add a GitHub token in Settings → Tools first (it needs the repo scope, or Contents + Pull requests for a fine-grained token).");
  const remote = (await sb.exec("git remote get-url origin 2>/dev/null", { timeoutMs: 15_000 })).output.trim();
  const repo = githubRepo(remote) ?? githubRepo(opts.repoUrl);
  if (!repo) throw new SandboxError("This project's origin isn't a GitHub repository, so a pull request can't be opened.");
  const info = await gh(opts.token, `/repos/${repo.owner}/${repo.repo}`);
  const base = opts.base?.trim() || String(info.default_branch ?? "main");
  let branch = (await sb.exec("git branch --show-current", { timeoutMs: 15_000 })).output.trim();
  if (!branch || branch === base) {
    branch = opts.branch?.trim() || `morphie/${opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "changes"}-${Date.now().toString(36).slice(-4)}`;
    await createBranch(sb, branch);
  }
  const dirty = (await sb.exec("git status --porcelain", { timeoutMs: 30_000 })).output.trim();
  if (dirty) await commitAll(sb, opts.title);
  await push(sb);
  const pr = await gh(opts.token, `/repos/${repo.owner}/${repo.repo}/pulls`, { method: "POST", body: { title: opts.title.slice(0, 250), body: opts.body?.slice(0, 60_000) ?? "", head: branch, base } });
  return { url: String(pr.html_url), number: Number(pr.number), branch };
}
