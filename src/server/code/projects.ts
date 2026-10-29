/**
 * Project service: creating a project (an empty folder or a clone), and packaging what's in it for download.
 * Used by POST /api/projects, the agent's create_project tool and the deliverables a run reports.
 */
import { isIP } from "node:net";
import { zipSync } from "fflate";
import type { ProjectView } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { config } from "../config";
import { countProjects, deleteProject, insertProject, listProjects } from "../data/projects";
import { getRunnerRow } from "../data/runners";
import { ApiError } from "../http";
import { checkLimit, recheckLimit, requireFeature } from "../plans";
import { sandboxFor, sandboxKind, SandboxError, SKIP_DIRS, type Sandbox } from "../sandbox";
import { isPrivateIp } from "../security";
import { githubRepo } from "./git";
import { ignoreScratch, SCRATCH } from "./scratch";

export const MAX_PROJECTS = 20;

/** A file name that works everywhere: "Friday Landing!" → "friday-landing". */
export function fileSlug(text: string, fallback = "project"): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60).replace(/-+$/, "") || fallback;
}

export interface CreateProjectInput {
  name?: string; repoUrl?: string; branch?: string;
  /** Where it runs: "server" (this server's sandbox), "lite" (files only) or "runner:<id>". Default: the server's, else Lite. */
  sandbox?: string;
}

/** Where a new project will run, checked: "" (the server's sandbox), "lite" or "runner:<id>" (one of the user's runners). */
async function placeFor(actor: Actor, wanted: string | undefined, cloning: boolean): Promise<string> {
  const server = sandboxKind();
  const where = !wanted ? (server === "none" ? "lite" : "") : wanted === "server" ? "" : wanted;
  if (where === "" && server === "none") throw new ApiError(400, "This server can't run code itself. Make a Lite project (files only) or use a Morphie Runner on your computer (Settings → Runners).", "sandbox");
  if (where.startsWith("runner:")) {
    if (!(await getRunnerRow(actor, where.slice(7)))) throw new ApiError(400, "That Morphie Runner doesn't exist any more.", "invalid");
  } else if (where !== "" && where !== "lite") throw new ApiError(400, "Choose where the project runs.", "invalid");
  if (cloning && where === "lite") throw new ApiError(400, "Lite projects can't clone repositories (they have no git). Use a Morphie Runner for this one.", "invalid");
  return where;
}

/** Create a project: an empty folder (git init), or a clone of a repository (https only, no credentials in the URL). */
export async function createProjectFor(actor: Actor, b: CreateProjectInput): Promise<{ project: ProjectView; projects: ProjectView[] }> {
  const where = await placeFor(actor, b.sandbox, !!b.repoUrl);
  const count = await countProjects(actor);
  await checkLimit(actor, "projects", count);
  if (count >= MAX_PROJECTS) throw new ApiError(400, `You can have up to ${MAX_PROJECTS} projects. Delete one first.`, "limit");
  if (b.repoUrl) await requireFeature(actor, "githubRepos");
  let repoUrl: string | null = null;
  if (b.repoUrl) {
    const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(b.repoUrl); // "owner/repo" means GitHub
    const raw = short ? `https://github.com/${short[1]}/${short[2]}` : b.repoUrl;
    let u: URL;
    try { u = new URL(raw); } catch { throw new ApiError(400, "Enter a repository URL like https://github.com/owner/repo, or owner/repo.", "invalid"); }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new ApiError(400, "Use an https:// repository URL without a username, password or query.", "invalid");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!config.allowPrivateUrls && (host === "localhost" || host.endsWith(".local") || (isIP(host) && isPrivateIp(host)))) throw new ApiError(400, "That repository is on a private network address.", "invalid");
    repoUrl = u.toString().replace(/\/$/, "");
  }
  const gh = githubRepo(repoUrl);
  const name = b.name || (gh ? gh.repo : repoUrl ? repoUrl.split("/").pop()!.replace(/\.git$/, "") : "") || "Untitled project";
  const project = await insertProject(actor, { name, repoUrl, branch: b.branch ?? null, sandbox: where });
  await recheckLimit(actor, "projects", () => countProjects(actor), () => deleteProject(actor, project.id));
  try {
    const sb = await sandboxFor(actor, project.id);
    if (repoUrl) {
      const r = await sb.clone(repoUrl, b.branch ?? null);
      if (r.exitCode !== 0) {
        const why = r.output.trim().split("\n").slice(-6).join("\n");
        const hint = /could not read Username|Authentication failed|not found/i.test(r.output) ? " If it's private, add a GitHub token in Settings → Tools." : "";
        throw new SandboxError(`git clone failed.${hint}\n${why}`);
      }
    } else if (sb.canExec) {
      await sb.exec("git init -q 2>/dev/null || true", { timeoutMs: 30_000 });
    }
    if (sb.canExec) await ignoreScratch(sb);
    await sb.checkpoint();
  } catch (e) {
    // Nothing half-made is left behind.
    await sandboxFor(actor, project.id).then((sb) => sb.destroy()).catch(() => {});
    await deleteProject(actor, project.id).catch(() => {});
    if (e instanceof SandboxError) throw new ApiError(400, e.message, "sandbox");
    throw e;
  }
  return { project, projects: await listProjects(actor) };
}

/** Not part of what the user downloads: dependencies, build output, git internals, Morphie's own scratch files. */
export function isDeliverable(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  if (SCRATCH.some((s) => (s.endsWith("/") ? path.startsWith(s) : path === s)) || path === ".morphie/.gitignore") return false;
  if (/(^|\/)\.DS_Store$|(^|\/)Thumbs\.db$/.test(path)) return false;
  return true;
}

/** The project's own files (what a zip would contain), smallest paths first. */
export async function projectFiles(sb: Sandbox, limit = 3000): Promise<Array<{ path: string; size?: number }>> {
  const all = await sb.glob("**/*", 20_000);
  const files = all.filter(isDeliverable).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return files.slice(0, limit).map((path) => ({ path }));
}

const MAX_ZIP_BYTES = 60 * 1024 * 1024;

/** Every deliverable file of the project in one zip, inside a folder named after it ("friday-landing/…"). */
export async function zipProject(sb: Sandbox, name: string): Promise<{ filename: string; bytes: Uint8Array; count: number }> {
  const slug = fileSlug(name);
  const files = await projectFiles(sb, 5000);
  if (!files.length) throw new ApiError(404, "The project has no files yet.", "empty");
  const entries: Record<string, Uint8Array> = {};
  let total = 0;
  let i = 0;
  // A few reads at a time: each one is a round trip to the container on Cloudflare.
  const worker = async () => {
    while (i < files.length) {
      const f = files[i++];
      const b64 = await sb.readBytes(f.path, 20 * 1024 * 1024).catch(() => null);
      if (b64 === null) continue;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      total += bytes.byteLength;
      if (total > MAX_ZIP_BYTES) throw new ApiError(413, "The project is too large to download as one zip (over 60 MB without node_modules and build output).", "too_large");
      entries[`${slug}/${f.path}`] = bytes;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { filename: `${slug}.zip`, bytes: zipSync(entries, { level: 6 }), count: Object.keys(entries).length };
}
