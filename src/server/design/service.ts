/**
 * DesignService: glue between the Design Agent, per-project version history, persistence and the renderer.
 * Each user can keep several design projects. A project has a bounded (20) version history with a cursor;
 * version labels only ever increase. Every stored design is re-validated on load, and all changes to one
 * project are serialised so a slow edit and a click on Undo can't overwrite each other.
 */
import { withLock as lockUser } from "../coordinator";
import { zipSync, strToU8 } from "fflate";
import type { DesignPatch, DesignState, DesignSummary, DesignThemeView, DesignVersionView } from "@/lib/types";
import { randomId } from "../crypto";
import type { Actor } from "../auth/actor";
import * as store from "../data/designs";
import { now } from "../db";
import { ApiError } from "../http";
import { recheckLimit } from "../plans";
import type { Provider } from "../providers/types";
import { DesignAgent, type DesignProgress, type DesignResult } from "./agent";
import { DesignValidationError } from "./fields";
import { DEVICE_WIDTHS } from "./layouts";
import { applyOperations } from "./agent";
import { exportHtml, exportReact, renderEditor, renderPreview, type ExportFile } from "./renderer";
import { applySystemToDesign, systemBrief } from "./system";
import { loadSystem } from "./systems";
import { slugify, validateDesign, type Design } from "./schema";
import { FONT_TABLE, THEME_LIST, getTheme } from "./themes";

export const HISTORY_LIMIT = 20;
export const EXPORT_FORMATS = ["html", "react"] as const;
const NO_CHANGE = "That didn't change anything about the design.";
const DEFAULT_EDIT_SUMMARY = "Updated the design.";

export class DesignStateError extends ApiError {
  constructor(message: string, status = 409) { super(status, message, "design_state"); }
}

type DesignRow = store.DesignRow;

// ---- per-design mutex ---------------------------------------------------
// In the user's Coordinator (a Durable Object on Cloudflare), so two isolates can't edit the same design at once.
async function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const userId = key.slice(0, key.indexOf(":"));
  return lockUser(userId, `design:${key.slice(userId.length + 1)}`, fn, { ttlMs: 8 * 60_000, waitMs: 5 * 60_000 });
}

// ---- storage -----------------------------------------------------------
async function getRow(actor: Actor, id: string): Promise<DesignRow> {
  const row = await store.getDesignRow(actor, id);
  if (!row) throw new DesignStateError("That design no longer exists.", 404);
  return row;
}

/** Versions oldest→newest, each design re-validated; ones that no longer validate are dropped. */
async function loadVersions(actor: Actor, row: DesignRow): Promise<Array<{ version: number; design: Design; prompt: string; summary: string; createdAt: number }>> {
  const rows = await store.loadVersionRows(actor, row.id);
  const out = [];
  for (const r of rows) {
    try { out.push({ version: r.version, design: validateDesign(JSON.parse(r.json)), prompt: r.prompt, summary: r.summary, createdAt: r.created_at }); }
    catch (e) { if (!(e instanceof DesignValidationError) && !(e instanceof SyntaxError)) throw e; }
  }
  return out;
}

async function stateOf(actor: Actor, id: string): Promise<DesignState> {
  const row = await getRow(actor, id);
  const versions = await loadVersions(actor, row);
  if (!versions.length) throw new DesignStateError("That design has no readable versions.", 404);
  let idx = versions.findIndex((v) => v.version === row.cursor);
  if (idx < 0) idx = versions.length - 1;
  const cur = versions[idx];
  return {
    id: row.id, name: cur.design.name, systemId: row.system_id ?? null, design: cur.design as unknown as DesignState["design"], previewHtml: renderPreview(cur.design), updatedAt: row.updated_at,
    history: { version: cur.version, position: idx + 1, total: versions.length, canUndo: idx > 0, canRedo: idx < versions.length - 1, revision: row.revision },
    versions: versions.map((v, i): DesignVersionView => ({ version: v.version, summary: v.summary, prompt: v.prompt, createdAt: v.createdAt, current: i === idx })).reverse(),
  };
}

async function currentDesign(actor: Actor, id: string): Promise<Design> {
  return (await stateOf(actor, id)).design as unknown as Design;
}

/** The current version of one of the caller's designs (404 otherwise). */
export const currentDesignFor = (actor: Actor, id: string): Promise<Design> => currentDesign(actor, id);

/** Add a version to a project (dropping any redo branch and, once full, the oldest). Returns false if identical. */
async function push(actor: Actor, row: DesignRow, design: Design, summary: string, prompt: string): Promise<boolean> {
  const versions = await loadVersions(actor, row);
  const cur = versions.find((v) => v.version === row.cursor) ?? versions[versions.length - 1];
  if (cur && JSON.stringify(cur.design) === JSON.stringify(design)) return false;
  await store.pushVersion(actor, row, {
    json: JSON.stringify(design), prompt: prompt.slice(0, 2000), summary, name: design.name.slice(0, 60),
    keepUpTo: cur?.version ?? 0, historyLimit: HISTORY_LIMIT, now: now(),
  });
  return true;
}

// ---- public API --------------------------------------------------------
const agent = new DesignAgent();

export async function listDesigns(actor: Actor): Promise<DesignSummary[]> {
  return (await store.listDesignRows(actor)).map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at, version: r.cursor, versions: r.n }));
}

/** Throws a 404 unless this actor owns the design. Cheap: reads one row, renders nothing. */
export async function requireDesign(actor: Actor, id: string): Promise<void> {
  await getRow(actor, id);
}

export async function getDesign(actor: Actor, id: string): Promise<DesignState> {
  return stateOf(actor, id);
}

export function catalog(): { themes: DesignThemeView[]; deviceWidths: typeof DEVICE_WIDTHS; fonts: Array<{ family: string; category: string }> } {
  return {
    themes: THEME_LIST.map((t) => ({ id: t.id, name: t.name, description: t.description, colors: { ...t.colors } })), deviceWidths: DEVICE_WIDTHS,
    fonts: FONT_TABLE.map((f) => ({ family: f.family, category: f.category })),
  };
}

export interface CommitResult { state: DesignState; changed: boolean; kind: DesignResult["kind"]; summary: string; notes: string[] }

async function commit(actor: Actor, row: DesignRow | null, result: DesignResult, prompt: string): Promise<CommitResult> {
  let id: string;
  let changed: boolean;
  if (!row) {
    id = randomId(9);
    await store.insertDesign(actor, { id, name: result.design.name.slice(0, 60), now: now() });
    // Two new designs at once could both pass the route's checkLimit; the second one is taken back here.
    await recheckLimit(actor, "designs", async () => (await store.listDesignRows(actor)).length, () => store.deleteDesign(actor, id));
    changed = await push(actor, await getRow(actor, id), result.design, result.summary, prompt);
  } else {
    id = row.id;
    changed = await push(actor, row, result.design, result.summary, prompt);
  }
  const summary = changed ? result.summary : result.kind === "edit" && result.summary !== DEFAULT_EDIT_SUMMARY ? `${NO_CHANGE} ${result.summary}` : NO_CHANGE;
  return { state: await stateOf(actor, id), changed, kind: result.kind, summary, notes: result.notes.slice(0, 5) };
}

/** One chat turn in Design: create a new project (designId = null) or edit an existing one. */
export async function handleMessage(actor: Actor, designId: string | null, text: string, provider: Provider, opts: { signal?: AbortSignal; onProgress?: (p: DesignProgress) => void; systemId?: string | null; guidance?: string } = {}): Promise<CommitResult> {
  return await withLock(`${actor.userId}:${designId ?? "new"}`, async () => {
    const row = designId ? await getRow(actor, designId) : null;
    const current = row ? await currentDesign(actor, row.id) : null;
    // A new design can start from a design system: the agent writes for that brand, then the tokens are enforced.
    const system = !row && opts.systemId ? await loadSystem(actor, opts.systemId) : null;
    const instruction = system ? `${text}\n\n(${systemBrief(system)})` : text;
    const result = await agent.respond(instruction, current, provider, opts);
    if (system && result.kind === "create") {
      result.design = validateDesign(applySystemToDesign(result.design, system), result.notes);
    }
    const out = await commit(actor, row, result, text);
    if (system) { await store.setDesignSystem(actor, out.state.id, opts.systemId!); out.state = await stateOf(actor, out.state.id); }
    return out;
  });
}

/** Restyle a design with a design system (a new, undoable version) and link it; null just unlinks. */
export async function applySystem(actor: Actor, designId: string, systemId: string | null): Promise<CommitResult> {
  return await withLock(`${actor.userId}:${designId}`, async () => {
    const row = await getRow(actor, designId);
    if (!systemId) {
      await store.setDesignSystem(actor, designId, null);
      return { state: await stateOf(actor, designId), changed: false, kind: "theme", summary: "Unlinked the design system.", notes: [] };
    }
    const system = await loadSystem(actor, systemId);
    const notes: string[] = [];
    const design = validateDesign(applySystemToDesign(await currentDesign(actor, designId), system), notes);
    const changed = await push(actor, row, design, `Applied the ${system.name} design system.`, `Apply ${system.name}`);
    await store.setDesignSystem(actor, designId, systemId);
    return { state: await stateOf(actor, designId), changed, kind: "theme", summary: changed ? `Applied ${system.name}.` : `Already matches ${system.name}; linked it.`, notes: notes.slice(0, 5) };
  });
}

// ---- visual editing ------------------------------------------------------

const PATH_RE = /^[a-z_]{1,30}(\.(\d{1,2}|[a-z_]{1,30})){0,4}$/;

/** Set one text field, addressed by a path relative to its section ("items.0.title"). Only existing text can change. */
function setText(design: Design, sectionId: string, path: string, value: string): string {
  const section = design.sections.find((s) => s.id === sectionId);
  if (!section) throw new DesignStateError("That section no longer exists. Refresh the preview.", 400);
  if (!PATH_RE.test(path) || /(^|\.)(id|type)$/.test(path)) throw new DesignStateError("That can't be edited.", 400);
  const parts = path.split(".");
  let node: any = section;
  for (const p of parts.slice(0, -1)) {
    node = /^\d+$/.test(p) ? (Array.isArray(node) ? node[Number(p)] : undefined) : node && typeof node === "object" && !Array.isArray(node) ? node[p] : undefined;
    if (node == null || typeof node !== "object") throw new DesignStateError("That text no longer exists. Refresh the preview.", 400);
  }
  const last = parts[parts.length - 1];
  const key: string | number = /^\d+$/.test(last) ? Number(last) : last;
  if (typeof (node as any)[key] !== "string") throw new DesignStateError("Only text can be edited in place.", 400);
  (node as any)[key] = value;
  return `${section.type}`;
}

function describePatch(p: DesignPatch, d: Design): string {
  const kind = "section" in p ? d.sections.find((s) => s.id === p.section)?.type ?? "section" : "";
  switch (p.op) {
    case "set_text": return `Edited text in the ${kind}.`;
    case "move": return `Moved the ${kind} ${p.direction}.`;
    case "duplicate": return `Duplicated the ${kind}.`;
    case "remove": return `Removed the ${kind}.`;
    case "set_color": return `Changed the ${p.key} colour to ${p.value}.`;
  }
}

/** Apply visual edits as one new version. Everything is re-validated, so limits (lengths, one navbar…) still hold. */
export async function patchDesign(actor: Actor, designId: string, patches: DesignPatch[]): Promise<CommitResult> {
  if (!patches.length || patches.length > 20) throw new DesignStateError("Send between 1 and 20 edits.", 400);
  return await withLock(`${actor.userId}:${designId}`, async () => {
    const row = await getRow(actor, designId);
    const before = await currentDesign(actor, designId);
    let d = structuredClone(before);
    for (const p of patches) {
      if (p.op === "set_text") setText(d, p.section, p.path, p.value);
      else if (p.op === "set_color") d.theme = { ...d.theme, [p.key]: p.value };
      else if (p.op === "remove") {
        const [next, errors] = applyOperations(d, [{ op: "remove_section", target: p.section }]);
        if (errors.length) throw new DesignStateError(errors[0], 400);
        d = next as Design;
      } else if (p.op === "duplicate") {
        const i = d.sections.findIndex((s) => s.id === p.section);
        if (i < 0) throw new DesignStateError("That section no longer exists.", 400);
        if (d.sections[i].type === "navbar" || d.sections[i].type === "footer") throw new DesignStateError(`A page can only have one ${d.sections[i].type}.`, 400);
        const { id: _id, ...copy } = structuredClone(d.sections[i]);
        d.sections.splice(i + 1, 0, copy as Design["sections"][number]);
      } else if (p.op === "move") {
        const i = d.sections.findIndex((s) => s.id === p.section);
        const j = p.direction === "up" ? i - 1 : i + 1;
        if (i < 0) throw new DesignStateError("That section no longer exists.", 400);
        const fixed = (k: number) => d.sections[k]?.type === "navbar" || d.sections[k]?.type === "footer";
        if (j < 0 || j >= d.sections.length || fixed(i) || fixed(j)) throw new DesignStateError(`That section can't move ${p.direction}.`, 400);
        [d.sections[i], d.sections[j]] = [d.sections[j], d.sections[i]];
      }
    }
    const notes: string[] = [];
    let valid: Design;
    try { valid = validateDesign(d, notes); }
    catch (e) { if (e instanceof DesignValidationError) throw new DesignStateError(`That edit doesn't fit: ${e.errors.slice(0, 2).join("; ")}`, 400); throw e; }
    const summary = patches.length === 1 ? describePatch(patches[0], before) : `Made ${patches.length} visual edits.`;
    const changed = await push(actor, row, valid, summary, "Visual edit");
    return { state: await stateOf(actor, designId), changed, kind: "edit", summary: changed ? summary : NO_CHANGE, notes: notes.slice(0, 5) };
  });
}

/** The preview with in-place editing switched on (see renderEditor). */
export async function editorHtml(actor: Actor, designId: string, scroll = 0): Promise<string> {
  return renderEditor(await currentDesign(actor, designId), { nonce: randomId(16), scroll });
}

export async function applyThemePreset(actor: Actor, designId: string, themeId: string): Promise<CommitResult> {
  const preset = getTheme(themeId);
  if (!preset) throw new DesignStateError("Unknown theme.", 400);
  return await withLock(`${actor.userId}:${designId}`, async () => {
    const row = await getRow(actor, designId);
    return commit(actor, row, agent.applyPreset(await currentDesign(actor, designId), preset.id), `Use the ${preset.name} theme`);
  });
}

async function moveCursor(actor: Actor, id: string, pick: (versions: number[], at: number) => number | null, none: string): Promise<DesignState> {
  return await withLock(`${actor.userId}:${id}`, async () => {
    const row = await getRow(actor, id);
    const versions = (await loadVersions(actor, row)).map((v) => v.version);
    const at = Math.max(0, versions.indexOf(row.cursor));
    const target = pick(versions, at);
    if (target === null || target === row.cursor) throw new DesignStateError(none);
    await store.setCursor(actor, id, target, now());
    return stateOf(actor, id);
  });
}

export const undo = (u: Actor, id: string) => moveCursor(u, id, (v, at) => (at > 0 ? v[at - 1] : null), "Nothing to undo.");
export const redo = (u: Actor, id: string) => moveCursor(u, id, (v, at) => (at < v.length - 1 ? v[at + 1] : null), "Nothing to redo.");
export const restoreVersion = (u: Actor, id: string, version: number) => moveCursor(u, id, (v) => (v.includes(version) ? version : null), "That version is no longer available.");

export async function renameDesign(actor: Actor, id: string, name: string): Promise<DesignState> {
  return await withLock(`${actor.userId}:${id}`, async () => {
    const row = await getRow(actor, id);
    const design = { ...(await currentDesign(actor, id)), name };
    const valid = validateDesign(design);
    await push(actor, row, valid, `Renamed to ${valid.name}.`, `Rename to ${name}`);
    return stateOf(actor, id);
  });
}

export async function deleteDesign(actor: Actor, id: string): Promise<void> {
  await getRow(actor, id);
  await store.deleteDesign(actor, id);
}

export async function exportDesign(actor: Actor, id: string, fmt: string): Promise<{ format: string; designName: string; files: ExportFile[] }> {
  if (!(EXPORT_FORMATS as readonly string[]).includes(fmt)) throw new DesignStateError(`Unknown export format. Choose one of: ${EXPORT_FORMATS.join(", ")}.`, 400);
  const design = await currentDesign(actor, id);
  return { format: fmt, designName: design.name, files: fmt === "html" ? exportHtml(design) : exportReact(design) };
}

export async function exportZip(actor: Actor, id: string, fmt: string): Promise<{ filename: string; bytes: Uint8Array }> {
  const ex = await exportDesign(actor, id, fmt);
  const root = `${slugify(ex.designName, "design")}-${fmt}`;
  const files: Record<string, Uint8Array> = {};
  for (const f of ex.files) files[`${root}/${f.path}`] = strToU8(f.content);
  return { filename: `${root}.zip`, bytes: zipSync(files, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") }) };
}
