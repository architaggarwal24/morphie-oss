/**
 * Read skills straight from a GitHub repository: one API call for the file tree, then the raw files. Works with
 * "owner/repo", "owner/repo/path", and github.com URLs to a repo, a folder (/tree/<ref>/<path>) or a SKILL.md
 * (/blob/<ref>/<path>/SKILL.md). Public repositories only, unless a GitHub token is saved in Settings → Tools.
 */
import { config } from "../config";
import { guardedFetch } from "../net";
import { frontMatter } from "./parse";

export class GitHubSkillError extends Error {}

export interface RepoRef { owner: string; repo: string; ref?: string; path: string }
export interface FoundSkill { dir: string; name: string; description: string }
export interface SkillFiles { dir: string; markdown: string; files: Array<{ path: string; bytes: Uint8Array }>; url: string; ref: string }

export const LIMITS = { files: 300, fileBytes: 2_000_000, totalBytes: 12_000_000, choices: 60 };
const SKIP = /(^|\/)(node_modules|\.git|__pycache__|\.venv|dist|build|\.DS_Store)(\/|$)/;
const PART = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseGitHubUrl(input: string): RepoRef {
  let s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  s = s.replace(/^git@github\.com:/, "https://github.com/");
  let parts: string[];
  let ref: string | undefined;
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { throw new GitHubSkillError("That isn't a valid URL."); }
    if (!/^(www\.)?github\.com$/i.test(u.hostname)) throw new GitHubSkillError("Only github.com links are supported.");
    parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[2] === "tree" || parts[2] === "blob") { ref = parts[3]; parts = [parts[0], parts[1], ...parts.slice(4)]; }
  } else parts = s.split("/").filter(Boolean);
  const [owner, repo, ...rest] = parts;
  if (!owner || !repo || !PART.test(owner) || !PART.test(repo)) throw new GitHubSkillError("Enter a GitHub repository like owner/repo, or a link to it.");
  if (ref && !/^[A-Za-z0-9._\/-]{1,120}$/.test(ref)) throw new GitHubSkillError("That branch name isn't valid.");
  let path = rest.join("/");
  if (/(^|\/)SKILL\.md$/i.test(path)) path = path.split("/").slice(0, -1).join("/");
  if (path.split("/").some((p) => p === ".." || p === ".")) throw new GitHubSkillError("That path isn't valid.");
  return { owner, repo, ref, path };
}

async function get(url: string, token: string | undefined, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { "user-agent": "Morphie", accept: url.includes("api.github.com") ? "application/vnd.github+json" : "*/*" };
  if (token && url.startsWith("https://api.github.com/")) headers.authorization = `Bearer ${token}`;
  try { return await guardedFetch(url, { headers, signal }, { allowPrivate: config.allowPrivateUrls }); }
  catch { throw new GitHubSkillError("Couldn't reach GitHub. Check your connection and try again."); }
}

async function api<T>(path: string, token: string | undefined, signal?: AbortSignal): Promise<T> {
  const res = await get(`https://api.github.com${path}`, token, signal);
  if (res.status === 404) throw new GitHubSkillError("That repository or branch wasn't found (private repositories need a GitHub token in Settings → Tools).");
  if (res.status === 403 || res.status === 429) throw new GitHubSkillError("GitHub's rate limit was hit. Add a GitHub token in Settings → Tools, or try again in a while.");
  if (!res.ok) throw new GitHubSkillError(`GitHub answered ${res.status}.`);
  return (await res.json()) as T;
}

async function raw(r: RepoRef & { ref: string }, path: string, token: string | undefined, signal?: AbortSignal): Promise<Uint8Array> {
  const url = `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${encodeURIComponent(r.ref).replace(/%2F/g, "/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const res = await get(url, token, signal);
  if (!res.ok) throw new GitHubSkillError(`Couldn't download ${path} (${res.status}).`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > LIMITS.fileBytes) throw new GitHubSkillError(`${path} is too large.`);
  return buf;
}

interface TreeEntry { path: string; type: string; size?: number }

/** The repository's files (one API call). */
async function tree(r: RepoRef, token: string | undefined, signal?: AbortSignal): Promise<{ ref: string; entries: TreeEntry[] }> {
  const ref = r.ref ?? (await api<{ default_branch: string }>(`/repos/${r.owner}/${r.repo}`, token, signal)).default_branch;
  const t = await api<{ tree: TreeEntry[]; truncated?: boolean }>(`/repos/${r.owner}/${r.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token, signal);
  return { ref, entries: t.tree ?? [] };
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * Find the skills under `r.path`. With `want` (a skill name, e.g. from the library), returns just that one, found by
 * its folder name even if the repository moved it. Several found and none wanted: returns the choices.
 */
export async function findSkills(r: RepoRef, opts: { token?: string; signal?: AbortSignal; want?: string } = {}): Promise<{ ref: string; entries: TreeEntry[]; found: FoundSkill[] }> {
  const { ref, entries } = await tree(r, opts.token, opts.signal);
  const all = entries.filter((e) => e.type === "blob" && /(^|\/)SKILL\.md$/i.test(e.path) && !SKIP.test(e.path)).map((e) => dirOf(e.path));
  let dirs = all.filter((d) => !r.path || d === r.path || d.startsWith(r.path + "/"));
  if (opts.want) {
    const exact = dirs.filter((d) => d === r.path || d.split("/").pop() === opts.want);
    dirs = exact.length ? exact : all.filter((d) => d.split("/").pop() === opts.want);
  }
  if (!dirs.length) throw new GitHubSkillError(opts.want ? `No skill called ${opts.want} was found in ${r.owner}/${r.repo}.` : `No SKILL.md was found in ${r.owner}/${r.repo}${r.path ? `/${r.path}` : ""}.`);
  const withRef = { ...r, ref };
  const found: FoundSkill[] = [];
  for (const dir of dirs.slice(0, LIMITS.choices)) {
    if (dirs.length === 1) { found.push({ dir, name: dir.split("/").pop() || r.repo, description: "" }); break; }
    try {
      const { fields } = frontMatter(decode(await raw(withRef, dir ? `${dir}/SKILL.md` : "SKILL.md", opts.token, opts.signal)));
      found.push({ dir, name: fields.name || dir.split("/").pop() || r.repo, description: (fields.description ?? "").replace(/\s+/g, " ").slice(0, 300) });
    } catch { found.push({ dir, name: dir.split("/").pop() || r.repo, description: "" }); }
  }
  return { ref, entries, found };
}

/** Download one skill folder: SKILL.md plus its other files (within the size limits). */
export async function downloadSkill(r: RepoRef, ref: string, entries: TreeEntry[], dir: string, opts: { token?: string; signal?: AbortSignal } = {}): Promise<SkillFiles> {
  const withRef = { ...r, ref };
  const prefix = dir ? `${dir}/` : "";
  const blobs = entries.filter((e) => e.type === "blob" && e.path.startsWith(prefix) && !SKIP.test(e.path.slice(prefix.length)));
  const md = blobs.find((e) => /^SKILL\.md$/i.test(e.path.slice(prefix.length)));
  if (!md) throw new GitHubSkillError(`No SKILL.md in ${dir || "the repository root"}.`);
  const others = blobs.filter((e) => e !== md && (e.size ?? 0) <= LIMITS.fileBytes).slice(0, LIMITS.files);
  // A skill at the repository root would otherwise carry the whole repository along.
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  if (dir || others.length <= 40) {
    let total = 0;
    let i = 0;
    const worker = async () => {
      while (i < others.length) {
        const e = others[i++];
        total += e.size ?? 0;
        if (total > LIMITS.totalBytes) return;
        files.push({ path: e.path.slice(prefix.length), bytes: await raw(withRef, e.path, opts.token, opts.signal) });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }
  return { dir, ref, markdown: decode(await raw(withRef, md.path, opts.token, opts.signal)), files, url: `https://github.com/${r.owner}/${r.repo}/tree/${ref}/${dir}`.replace(/\/$/, "") };
}
