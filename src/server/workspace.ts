import type { Actor } from "./auth/actor";
import { blobs } from "./blobs";

/**
 * The agent's private folder of text files, one per account. Stored through `blobs()` under
 * `workspace/<userId>/<path>`: R2 on Cloudflare, `data/workspace/<userId>/` locally (the same folder as before).
 */
const MAX_FILE = 200_000;
const MAX_FILES = 100;
const MAX_TOTAL = 5_000_000;
const MAX_DEPTH = 4;

export class WorkspaceError extends Error {}
/** The file does not exist in *this actor's* workspace (another user's files are indistinguishable from missing ones). */
export class WorkspaceNotFoundError extends WorkspaceError {}

export interface WorkspaceFile { path: string; size: number; modified: number }

function prefix(actor: Actor): string {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(actor.userId)) throw new WorkspaceError("Invalid user.");
  return `workspace/${actor.userId}/`;
}

/** Normalise a user/model supplied relative path, rejecting anything that could escape the sandbox. */
export function cleanPath(rel: string): string {
  if (typeof rel !== "string" || !rel.trim()) throw new WorkspaceError("A file path is required.");
  if (rel.length > 120 || /[\0\\]/.test(rel) || rel.startsWith("/")) throw new WorkspaceError("Use a short relative path like notes/plan.md.");
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length || parts.length > MAX_DEPTH) throw new WorkspaceError(`Paths can be at most ${MAX_DEPTH} folders deep.`);
  for (const p of parts) {
    if (p === ".." || p.startsWith(".") || !/^[A-Za-z0-9._-]{1,64}$/.test(p)) {
      throw new WorkspaceError("Path segments may only use letters, digits, dot, dash and underscore, and can't start with a dot.");
    }
  }
  return parts.join("/");
}

const keyOf = (actor: Actor, rel: string) => prefix(actor) + cleanPath(rel);

export async function listFiles(actor: Actor): Promise<WorkspaceFile[]> {
  const pre = prefix(actor);
  const all = await blobs().list(pre);
  return all
    .map((o) => ({ path: o.key.slice(pre.length), size: o.size, modified: o.modified }))
    .filter((f) => f.path.split("/").length <= MAX_DEPTH)
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_FILES * 2);
}

export async function readFile(actor: Actor, rel: string): Promise<string> {
  const data = await blobs().get(keyOf(actor, rel));
  if (!data) throw new WorkspaceNotFoundError(`No file at ${cleanPath(rel)}.`);
  return new TextDecoder().decode(data);
}

export async function writeFile(actor: Actor, rel: string, content: string): Promise<{ path: string; size: number; created: boolean }> {
  if (typeof content !== "string") throw new WorkspaceError("File content must be text.");
  const size = new TextEncoder().encode(content).byteLength;
  if (size > MAX_FILE) throw new WorkspaceError(`Files can be at most ${MAX_FILE / 1000} KB.`);
  const clean = cleanPath(rel);
  const files = await listFiles(actor);
  const existing = files.find((f) => f.path === clean);
  if (!existing && files.length >= MAX_FILES) throw new WorkspaceError(`The workspace is limited to ${MAX_FILES} files.`);
  const total = files.reduce((n, f) => n + f.size, 0) - (existing?.size ?? 0);
  if (total + size > MAX_TOTAL) throw new WorkspaceError("The workspace is full (5 MB). Delete some files first.");
  await blobs().put(keyOf(actor, clean), content);
  return { path: clean, size, created: !existing };
}

export async function deleteFile(actor: Actor, rel: string): Promise<void> {
  const key = keyOf(actor, rel);
  if (!(await blobs().head(key))) throw new WorkspaceNotFoundError(`No file at ${cleanPath(rel)}.`);
  await blobs().delete(key);
}

export async function clearWorkspace(actor: Actor): Promise<void> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(actor.userId)) return;
  await blobs().deletePrefix(prefix(actor));
  // Saved agent-run state (for Continue) goes with the rest of the account's files.
  await blobs().deletePrefix(`runs/${actor.userId}/`);
  // Installed skills' files (their rows go with the rest of the account's rows).
  await blobs().deletePrefix(`skills/${actor.userId}/`);
}
