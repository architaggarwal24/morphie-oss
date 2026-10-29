/**
 * Skills: playbooks (a SKILL.md plus optional files) the agent loads when a task matches, the way Claude Code does.
 *
 *  - Built-in: Morphie's own (./builtin.ts).
 *  - Installed: from GitHub (a link or the library), an upload (.md / .zip / .skill), or written in the app.
 *  - Project: SKILL.md folders inside a code project's .morphie/skills/ or .claude/skills/.
 *
 * Only names and descriptions go into the prompt; a skill's instructions are loaded with the use_skill tool when the
 * agent decides it applies (or up front when the user pins it: /name, or "always on").
 */
import { unzipSync } from "fflate";
import type { AgentSettings, SkillChoice, SkillLibraryEntry, SkillScope, SkillSource, SkillSummary, SkillView } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { blobs } from "../blobs";
import * as store from "../data/skills";
import { ApiError } from "../http";
import type { Sandbox } from "../sandbox/types";
import { getSecret } from "../settings";
import { BUILTIN_SKILLS } from "./builtin";
import { downloadSkill, findSkills, GitHubSkillError, parseGitHubUrl } from "./github";
import { LIBRARY } from "./library";
import { parseSkill, SkillFormatError, type ParsedSkill } from "./parse";

export const MAX_SKILLS = 200;
const MAX_UPLOAD_FILES = 300;

export class SkillError extends ApiError {
  constructor(message: string, status = 400) { super(status, message, "skill"); }
}

interface StoredSource { kind: "github" | "upload" | "editor"; url?: string; repo?: string; ref?: string; dir?: string; fileName?: string }
interface StoredFile { path: string; size: number }

const BUILTINS: Array<ParsedSkill & { markdown: string }> = BUILTIN_SKILLS.map((b) => ({ ...parseSkill(b.markdown), markdown: b.markdown }));

const fileKey = (actor: Actor, id: string, i: number) => `skills/${actor.userId}/${id}/f${i}`;
const filesOf = (row: store.SkillRow): StoredFile[] => { try { return JSON.parse(row.files) as StoredFile[]; } catch { return []; } };
const sourceOf = (row: store.SkillRow): StoredSource => { try { return JSON.parse(row.source) as StoredSource; } catch { return { kind: "editor" }; } };
const asScope = (s: string): SkillScope => (s === "design" || s === "both" ? s : "agent");
const appliesTo = (scope: SkillScope, want: "agent" | "design") => scope === "both" || scope === want;

/** A skill inside a code project (found by loadProjectInfo). */
export interface ProjectSkill { name: string; description: string; scope: SkillScope; manual: boolean; dir: string }

function summary(s: { id: string; name: string; description: string; scope: SkillScope; manual: boolean; source: SkillSource; sourceUrl?: string; license?: string; files: number; updatedAt?: number; editable: boolean }, settings: AgentSettings): SkillSummary {
  return { ...s, enabled: !settings.skills.disabled.includes(s.name), pinned: settings.skills.pinned.includes(s.name) };
}

function rowSummary(row: store.SkillRow, settings: AgentSettings): SkillSummary {
  const src = sourceOf(row);
  let license: string | undefined;
  try { license = parseSkill(row.markdown, row.name).license; } catch { license = undefined; }
  return summary({
    id: row.id, name: row.name, description: row.description, scope: asScope(row.scope), manual: !!row.manual, source: src.kind,
    sourceUrl: src.url, license, files: filesOf(row).length, updatedAt: row.updated_at, editable: src.kind !== "github",
  }, settings);
}

/** Every skill this user has: installed ones first (they replace a built-in of the same name), then the built-ins. */
export async function listSkills(actor: Actor, settings: AgentSettings, project: ProjectSkill[] = []): Promise<SkillSummary[]> {
  const rows = await store.listSkillRows(actor);
  const taken = new Set<string>();
  const out: SkillSummary[] = [];
  for (const p of project) {
    if (taken.has(p.name)) continue;
    taken.add(p.name);
    out.push(summary({ id: `project:${p.name}`, name: p.name, description: p.description, scope: p.scope, manual: p.manual, source: "project", files: 0, editable: false }, settings));
  }
  for (const r of rows) if (!taken.has(r.name)) { taken.add(r.name); out.push(rowSummary(r, settings)); }
  for (const b of BUILTINS) if (!taken.has(b.name)) {
    taken.add(b.name);
    out.push(summary({ id: `builtin:${b.name}`, name: b.name, description: b.description, scope: b.scope, manual: b.manual, source: "builtin", license: "MIT", files: 0, editable: false }, settings));
  }
  return out;
}

export async function getSkillView(actor: Actor, settings: AgentSettings, id: string): Promise<SkillView> {
  if (id.startsWith("builtin:")) {
    const b = BUILTINS.find((x) => x.name === id.slice(8));
    if (!b) throw new SkillError("That skill doesn't exist.", 404);
    return { ...summary({ id, name: b.name, description: b.description, scope: b.scope, manual: b.manual, source: "builtin", license: "MIT", files: 0, editable: false }, settings), markdown: b.markdown, fileList: [] };
  }
  const row = /^[A-Za-z0-9_-]{6,40}$/.test(id) ? await store.getSkillRow(actor, id) : undefined;
  if (!row || row.id !== id) throw new SkillError("That skill doesn't exist.", 404);
  return { ...rowSummary(row, settings), markdown: row.markdown, fileList: filesOf(row) };
}

/** Store a skill (new, or replacing `replaceId`). Its files go to blob storage. */
async function save(actor: Actor, markdown: string, files: Array<{ path: string; bytes: Uint8Array }>, source: StoredSource, opts: { replaceId?: string; fallbackName?: string } = {}): Promise<string> {
  let parsed: ParsedSkill;
  try { parsed = parseSkill(markdown, opts.fallbackName); } catch (e) { if (e instanceof SkillFormatError) throw new SkillError(e.message); throw e; }
  const existing = await store.getSkillRow(actor, parsed.name);
  let id = opts.replaceId;
  if (existing && existing.id !== id) {
    const src = sourceOf(existing);
    // Installing the same GitHub skill again updates it; anything else with that name is a clash.
    if (!(source.kind === "github" && src.kind === "github" && src.repo === source.repo && src.dir === source.dir)) {
      throw new SkillError(`A skill called ${parsed.name} is already installed. Delete it or rename this one (the name: line).`, 409);
    }
    id = existing.id;
  }
  if (!id && (await store.countSkills(actor)) >= MAX_SKILLS) throw new SkillError(`You can install up to ${MAX_SKILLS} skills. Delete some first.`);
  const kept = files.filter((f) => f.path && !f.path.includes("..") && !f.path.startsWith("/")).slice(0, MAX_UPLOAD_FILES);
  const record: store.SkillRecord = {
    name: parsed.name, description: parsed.description, scope: parsed.scope, manual: parsed.manual, source: JSON.stringify(source), markdown,
    files: JSON.stringify(kept.map((f) => ({ path: f.path, size: f.bytes.byteLength }))),
  };
  if (id) {
    const before = await store.getSkillRow(actor, id);
    // Replacing SKILL.md alone (an edit in the app) keeps the skill's other files.
    if (before && !kept.length && source.kind !== "github") record.files = before.files;
    else await blobs().deletePrefix(`skills/${actor.userId}/${id}/`);
    await store.updateSkillRow(actor, id, record);
  } else id = await store.insertSkill(actor, record);
  if (kept.length) for (let i = 0; i < kept.length; i++) await blobs().put(fileKey(actor, id, i), kept[i].bytes);
  return id;
}

export async function createSkill(actor: Actor, markdown: string): Promise<string> {
  return save(actor, markdown, [], { kind: "editor" });
}

export async function editSkill(actor: Actor, id: string, markdown: string): Promise<string> {
  const row = await store.getSkillRow(actor, id);
  if (!row || row.id !== id) throw new SkillError("That skill doesn't exist.", 404);
  const src = sourceOf(row);
  if (src.kind === "github") throw new SkillError("Skills installed from GitHub are updated from GitHub. Copy it to a new skill to change it.");
  return save(actor, markdown, [], src, { replaceId: id });
}

export async function deleteSkill(actor: Actor, id: string): Promise<void> {
  const row = await store.getSkillRow(actor, id);
  if (!row || row.id !== id) throw new SkillError("That skill doesn't exist.", 404);
  await store.deleteSkillRow(actor, id);
  await blobs().deletePrefix(`skills/${actor.userId}/${id}/`).catch(() => {});
}

// ------------------------------------------------------------------ installing

export type InstallResult = { installed: string[]; choices?: undefined } | { installed?: undefined; choices: SkillChoice[] };

/** Install from a GitHub link. Several skills there and no `pick`: returns them to choose from. */
export async function installFromGitHub(actor: Actor, url: string, opts: { pick?: string[]; want?: string; signal?: AbortSignal } = {}): Promise<InstallResult> {
  try {
    const r = parseGitHubUrl(url);
    const token = await getSecret(actor, "github");
    const { ref, entries, found } = await findSkills(r, { token, signal: opts.signal, want: opts.want });
    if (found.length > 1 && !opts.pick?.length && !opts.want) return { choices: found.map((f) => ({ path: f.dir, name: f.name, description: f.description })) };
    const chosen = opts.pick?.length ? found.filter((f) => opts.pick!.includes(f.dir)) : found.slice(0, 1);
    if (!chosen.length) throw new SkillError("None of the chosen skills were found.");
    const installed: string[] = [];
    for (const f of chosen) {
      const dl = await downloadSkill(r, ref, entries, f.dir, { token, signal: opts.signal });
      const id = await save(actor, dl.markdown, dl.files, { kind: "github", url: dl.url, repo: `${r.owner}/${r.repo}`, ref, dir: f.dir }, { fallbackName: f.dir.split("/").pop() || r.repo });
      installed.push((await store.getSkillRow(actor, id))!.name);
    }
    return { installed };
  } catch (e) {
    if (e instanceof GitHubSkillError) throw new SkillError(e.message);
    throw e;
  }
}

export async function installFromLibrary(actor: Actor, name: string, signal?: AbortSignal): Promise<InstallResult> {
  const entry = LIBRARY.find((l) => l.name === name);
  if (!entry) throw new SkillError("That skill isn't in the library.", 404);
  return installFromGitHub(actor, `${entry.repo}/${entry.path}`, { want: entry.name, signal });
}

/** Re-download a GitHub skill (its latest version on the same branch). */
export async function updateFromGitHub(actor: Actor, id: string, signal?: AbortSignal): Promise<void> {
  const row = await store.getSkillRow(actor, id);
  if (!row || row.id !== id) throw new SkillError("That skill doesn't exist.", 404);
  const src = sourceOf(row);
  if (src.kind !== "github" || !src.repo) throw new SkillError("Only skills installed from GitHub can be updated.");
  const [owner, repo] = src.repo.split("/");
  try {
    const token = await getSecret(actor, "github");
    const r = { owner, repo, ref: src.ref, path: src.dir ?? "" };
    const { ref, entries } = await findSkills(r, { token, signal });
    const dl = await downloadSkill(r, ref, entries, src.dir ?? "", { token, signal });
    await save(actor, dl.markdown, dl.files, { ...src, ref }, { replaceId: id });
  } catch (e) {
    if (e instanceof GitHubSkillError) throw new SkillError(e.message);
    throw e;
  }
}

/** A SKILL.md, or a .zip / .skill archive holding one or more skill folders. */
export async function installFromUpload(actor: Actor, fileName: string, bytes: Uint8Array): Promise<{ installed: string[] }> {
  if (/\.(md|markdown)$/i.test(fileName)) {
    const id = await save(actor, new TextDecoder().decode(bytes), [], { kind: "upload", fileName }, { fallbackName: fileName.replace(/\.(md|markdown)$/i, "").replace(/^SKILL$/i, "") || undefined });
    return { installed: [(await store.getSkillRow(actor, id))!.name] };
  }
  if (!/\.(zip|skill)$/i.test(fileName)) throw new SkillError("Upload a SKILL.md, or a .zip / .skill file containing one.");
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes); } catch { throw new SkillError("That archive couldn't be read."); }
  const paths = Object.keys(entries).filter((p) => !p.endsWith("/") && !/(^|\/)(__MACOSX|\.git|node_modules)(\/|$)/.test(p));
  const skillDirs = paths.filter((p) => /(^|\/)SKILL\.md$/i.test(p)).map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""));
  if (!skillDirs.length) throw new SkillError("No SKILL.md was found in that archive.");
  const installed: string[] = [];
  for (const dir of skillDirs.slice(0, 50)) {
    const prefix = dir ? `${dir}/` : "";
    const md = paths.find((p) => p.toLowerCase() === `${prefix}skill.md`.toLowerCase())!;
    const files = paths.filter((p) => p !== md && p.startsWith(prefix) && !skillDirs.some((d) => d !== dir && d.startsWith(prefix) && p.startsWith(`${d}/`)))
      .map((p) => ({ path: p.slice(prefix.length), bytes: entries[p] }));
    const id = await save(actor, new TextDecoder().decode(entries[md]), files, { kind: "upload", fileName }, { fallbackName: dir.split("/").pop() || fileName.replace(/\.(zip|skill)$/i, "") });
    installed.push((await store.getSkillRow(actor, id))!.name);
  }
  return { installed };
}

export async function library(actor: Actor): Promise<SkillLibraryEntry[]> {
  const rows = await store.listSkillRows(actor);
  const have = new Set(rows.map((r) => r.name));
  return LIBRARY.map((l) => ({ name: l.name, repo: l.repo, summary: l.summary, scope: l.scope, license: l.license, category: l.category, installs: l.installs, installed: have.has(l.name) }));
}

// ------------------------------------------------------------------ runtime

export interface LoadedSkill {
  name: string;
  source: SkillSource;
  body: string;
  /** Paths of the skill's other files, relative to its folder. */
  files: string[];
  /** Where the files already are inside the project (project skills). */
  projectDir?: string;
  read(path: string): Promise<Uint8Array | null>;
}

export interface SkillListing { name: string; description: string; scope: SkillScope; manual: boolean; source: SkillSource }

/** What a run (or a design request) can use: the enabled skills for its scope, and how to load one. */
export interface SkillRuntime {
  /** The ones the model may pick itself (enabled, not manual-only). */
  available: SkillListing[];
  /** Enabled, always-on skills for this scope. */
  pinned: string[];
  /** Every enabled skill for this scope, by name (for /name). */
  has(name: string): boolean;
  load(name: string): Promise<LoadedSkill | null>;
}

export async function skillRuntime(actor: Actor, settings: AgentSettings, scope: "agent" | "design", project?: { sandbox: Sandbox; skills: ProjectSkill[] }): Promise<SkillRuntime> {
  const all = (await listSkills(actor, settings, project?.skills ?? [])).filter((s) => s.enabled && appliesTo(s.scope, scope));
  const byName = new Map(all.map((s) => [s.name, s]));
  return {
    available: all.filter((s) => !s.manual).map((s) => ({ name: s.name, description: s.description, scope: s.scope, manual: s.manual, source: s.source })),
    pinned: all.filter((s) => s.pinned).map((s) => s.name),
    has: (name) => byName.has(name),
    async load(name) {
      const s = byName.get(name);
      if (!s) return null;
      if (s.source === "builtin") {
        const b = BUILTINS.find((x) => x.name === name)!;
        return { name, source: "builtin", body: b.body, files: [], read: async () => null };
      }
      if (s.source === "project" && project) {
        const p = project.skills.find((x) => x.name === name)!;
        const text = await project.sandbox.readFile(`${p.dir}/SKILL.md`).catch(() => null);
        if (text === null) return null;
        const files = (await project.sandbox.glob(`${p.dir}/**`, 200).catch(() => [])).filter((f) => !/\/SKILL\.md$/i.test(f)).map((f) => f.slice(p.dir.length + 1));
        let body = text;
        try { body = parseSkill(text, name).body; } catch { /* use it as it is */ }
        return {
          name, source: "project", body, files, projectDir: p.dir,
          read: async (path) => { const t = await project.sandbox.readFile(`${p.dir}/${path}`).catch(() => null); return t === null ? null : new TextEncoder().encode(t); },
        };
      }
      const row = await store.getSkillRow(actor, s.id);
      if (!row) return null;
      const files = filesOf(row);
      let body = row.markdown;
      try { body = parseSkill(row.markdown, row.name).body; } catch { /* as stored */ }
      return {
        name, source: s.source, body, files: files.map((f) => f.path),
        read: async (path) => { const i = files.findIndex((f) => f.path === path); return i < 0 ? null : blobs().get(fileKey(actor, row.id, i)); },
      };
    },
  };
}

/** Pinned skills, loaded in full, as the block that goes in front of the task. */
export async function pinnedBlock(rt: SkillRuntime, names: string[]): Promise<{ text: string; used: string[] }> {
  const used: string[] = [];
  const parts: string[] = [];
  for (const n of [...new Set(names)].slice(0, 6)) {
    const s = await rt.load(n);
    if (!s) continue;
    used.push(n);
    parts.push(`<skill name="${n}">\n${s.body.slice(0, 24_000)}\n</skill>${s.files.length ? `\n(The ${n} skill has more files: ${s.files.slice(0, 30).join(", ")}. Read them with read_skill_file.)` : ""}`);
  }
  return { used, text: parts.length ? `The user wants these skills applied to this task. Follow them.\n\n${parts.join("\n\n")}` : "" };
}

/** For the Design agent (which has no tools): the guidance of the design skills that fit this request. */
export async function designGuidance(rt: SkillRuntime, instruction: string, picked: string[] = []): Promise<{ text: string; used: string[] }> {
  const words = new Set((instruction.toLowerCase().match(/[a-z]{4,}/g) ?? []));
  const score = (s: SkillListing) => {
    let n = 0;
    for (const w of `${s.name} ${s.description}`.toLowerCase().match(/[a-z]{4,}/g) ?? []) if (words.has(w)) n++;
    return n + (s.name === "frontend-aesthetics" ? 1 : 0);
  };
  const auto = rt.available.map((s) => ({ s, n: score(s) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 2).map((x) => x.s.name);
  const names = [...new Set([...picked.filter((p) => rt.has(p)), ...rt.pinned, ...auto])].slice(0, 4);
  const used: string[] = [];
  const parts: string[] = [];
  let budget = 16_000;
  for (const n of names) {
    const s = await rt.load(n);
    if (!s || budget <= 0) continue;
    const body = s.body.slice(0, Math.min(6000, budget));
    budget -= body.length;
    used.push(n);
    parts.push(`<skill name="${n}">\n${body}\n</skill>`);
  }
  return { used, text: parts.join("\n\n") };
}
