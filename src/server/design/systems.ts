/**
 * Design systems service: create (from a description, a website, a screenshot's palette, an existing design or by
 * hand), read with its documentation page, edit, delete, export.
 */
import { strToU8, zipSync } from "fflate";
import { checkLimit, recheckLimit } from "../plans";
import type { DesignSystemSummary, DesignSystemView, SystemSourceView } from "@/lib/types";
import type { Actor } from "../auth/actor";
import * as store from "../data/designSystems";
import { listDesignRows } from "../data/designs";
import { ApiError } from "../http";
import type { Provider } from "../providers/types";
import { fetchPublic } from "../tools/fetchUrl";
import { ToolError } from "../tools/types";
import { DesignValidationError } from "./fields";
import { slugify, type Design } from "./schema";
import {
  analyzeCss, analyzeHtml, emptyEvidence, evidenceSummary, generateSystem, SYSTEM_TASKS, SystemGenerationError, systemFromDesign, systemFromEvidence, validateSystem,
  type DesignSystem, type Evidence, type SystemSource,
} from "./system";
import { renderSystemDocs } from "./systemDocs";
import { exportSystem, SYSTEM_EXPORTS, type SystemExport } from "./systemExport";
import { normalizeHex } from "./themes";

export const MAX_SYSTEMS = 30;

export class SystemError extends ApiError {
  constructor(message: string, status = 400) { super(status, message, "design_system"); }
}

interface Stored { system: DesignSystem; source: SystemSource }

function parse(row: store.SystemRow): Stored | null {
  try {
    const raw = JSON.parse(row.json) as { system?: unknown; source?: SystemSource };
    return { system: validateSystem(raw.system ?? raw), source: raw.source ?? { kind: "manual", ref: "" } };
  } catch { return null; }
}

async function row(actor: Actor, id: string): Promise<store.SystemRow> {
  const r = /^[A-Za-z0-9_-]{6,40}$/.test(id) ? await store.getSystemRow(actor, id) : undefined;
  if (!r) throw new SystemError("That design system no longer exists.", 404);
  return r;
}

/** The validated system (404 if it isn't the caller's or no longer validates). */
export async function loadSystem(actor: Actor, id: string): Promise<DesignSystem> {
  const p = parse(await row(actor, id));
  if (!p) throw new SystemError("That design system can't be read any more.", 404);
  return p.system;
}

const summaryOf = (r: store.SystemRow, p: Stored): DesignSystemSummary => ({
  id: r.id, name: p.system.name, updatedAt: r.updated_at, source: p.source.kind,
  colors: { background: p.system.colors.background, surface: p.system.colors.surface, primary: p.system.colors.primary, secondary: p.system.colors.secondary, accent: p.system.colors.accent, text: p.system.colors.text },
  fonts: { heading: p.system.typography.heading, body: p.system.typography.body },
});

export async function listSystems(actor: Actor): Promise<DesignSystemSummary[]> {
  const out: DesignSystemSummary[] = [];
  for (const r of await store.listSystemRows(actor)) { const p = parse(r); if (p) out.push(summaryOf(r, p)); }
  return out;
}

export async function getSystem(actor: Actor, id: string): Promise<DesignSystemView> {
  const r = await row(actor, id);
  const p = parse(r);
  if (!p) throw new SystemError("That design system can't be read any more.", 404);
  const usedBy = (await listDesignRows(actor)).filter((d) => d.system_id === id).map((d) => ({ id: d.id, name: d.name }));
  return { ...summaryOf(r, p), system: p.system as unknown as DesignSystemView["system"], sourceRef: p.source.ref, docsHtml: renderSystemDocs(p.system), usedBy };
}

async function save(actor: Actor, system: DesignSystem, source: SystemSource): Promise<string> {
  await checkLimit(actor, "designSystems", () => store.countSystems(actor));
  if ((await store.countSystems(actor)) >= MAX_SYSTEMS) throw new SystemError(`You can keep up to ${MAX_SYSTEMS} design systems. Delete one first.`);
  const id = await store.insertSystem(actor, system.name, JSON.stringify({ system, source }));
  await recheckLimit(actor, "designSystems", () => store.countSystems(actor), () => store.deleteSystemRow(actor, id));
  return id;
}

// ------------------------------------------------------------------ create

export type CreateInput =
  | { from: "prompt"; prompt: string; name?: string }
  | { from: "url"; url: string; name?: string; notes?: string }
  | { from: "image"; palette: Array<{ hex: string; weight: number }>; notes?: string; name?: string; fileName?: string }
  | { from: "design"; design: Design; name?: string }
  | { from: "manual"; system: unknown };

/** Read a site: its HTML, then up to four of its stylesheets. Only public hosts; every hop re-checked. */
export async function siteEvidence(rawUrl: string, signal?: AbortSignal, fetchPage: typeof fetchPublic = fetchPublic): Promise<Evidence> {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const ev = emptyEvidence();
  let page;
  try { page = await fetchPage(url, signal); }
  catch (e) { throw new SystemError(e instanceof ToolError ? e.message : "Couldn't read that website."); }
  if (page.status >= 400) throw new SystemError(`That website answered ${page.status}.`);
  const base = new URL(page.url);
  const { stylesheets } = analyzeHtml(page.body, base, ev);
  const sheets = await Promise.allSettled(stylesheets.slice(0, 4).map((href) => fetchPage(href, signal)));
  for (const s of sheets) if (s.status === "fulfilled" && s.value.status < 400) analyzeCss(s.value.body, ev);
  if (!ev.colors.length && !ev.fonts.length) throw new SystemError("That page didn't expose any colours or fonts Morphie could read (it may render everything with JavaScript). Try a screenshot instead.");
  return ev;
}

function evidenceFromPalette(palette: Array<{ hex: string; weight: number }>, notes?: string): Evidence {
  const ev = emptyEvidence();
  for (const p of palette.slice(0, 16)) {
    const hex = normalizeHex(p.hex);
    if (hex && !ev.colors.some((c) => c.hex === hex)) ev.colors.push({ hex, count: Math.max(1, Math.round(Math.min(1, Math.max(0, p.weight)) * 100)), names: [] });
  }
  if (ev.colors.length < 2) throw new SystemError("Couldn't find enough colours in that image.");
  ev.notes = notes?.slice(0, 600);
  return ev;
}

export async function createSystem(actor: Actor, input: CreateInput, provider: Provider | null, signal?: AbortSignal, io: { fetchPage?: typeof fetchPublic } = {}): Promise<{ id: string; summary: string; notes: string[]; usedModel: boolean }> {
  let system: DesignSystem;
  let source: SystemSource;
  let summary = "";
  let notes: string[] = [];
  let usedModel = false;
  const rename = (s: DesignSystem, name?: string) => (name?.trim() ? validateSystem({ ...s, name: name.trim().slice(0, 60) }) : s);

  switch (input.from) {
    case "manual": {
      try { system = validateSystem(input.system, notes); } catch (e) { if (e instanceof DesignValidationError) throw new SystemError(e.message); throw e; }
      source = { kind: "manual", ref: "" };
      summary = `Saved ${system.name}.`;
      break;
    }
    case "design": {
      system = rename(systemFromDesign(input.design), input.name);
      source = { kind: "design", ref: input.design.name };
      summary = `Made ${system.name} from the design's tokens.`;
      break;
    }
    case "prompt": {
      if (!provider) throw new SystemError("Add an AI provider in Settings to generate a design system from a description.");
      try {
        const r = await generateSystem(provider, SYSTEM_TASKS.prompt, input.prompt, { signal });
        system = rename(r.system, input.name); summary = r.summary; notes = r.notes; usedModel = true;
      } catch (e) { if (e instanceof SystemGenerationError) throw new SystemError(e.message); throw e; }
      source = { kind: "prompt", ref: input.prompt.slice(0, 300) };
      break;
    }
    case "url":
    case "image": {
      const ev = input.from === "url" ? await siteEvidence(input.url, signal, io.fetchPage) : evidenceFromPalette(input.palette, input.notes);
      if (input.from === "url" && input.notes) ev.notes = input.notes.slice(0, 600);
      const draft = systemFromEvidence(ev, input.name?.trim() || undefined);
      system = draft;
      summary = input.from === "url" ? `Extracted ${draft.name} from ${ev.host}.` : `Built ${draft.name} from the image's palette.`;
      if (provider) {
        // The measured draft is the baseline; the model assigns roles, picks fonts and writes the voice.
        try {
          const r = await generateSystem(provider, SYSTEM_TASKS.evidence, `${evidenceSummary(ev)}\n\nA measured draft you may correct:\n${JSON.stringify(draft)}`, { signal, base: draft });
          system = rename(r.system, input.name); summary = r.summary; notes = r.notes; usedModel = true;
        } catch (e) {
          if (signal?.aborted) throw e;
          notes.push(`The model's version didn't validate, so this is the measured draft (${e instanceof Error ? e.message : "error"}).`);
        }
      } else notes.push("No AI provider is set up, so roles were assigned automatically from the measured colours.");
      source = { kind: input.from, ref: input.from === "url" ? (ev.host ?? input.url) : (input.fileName ?? "image").slice(0, 120) };
      break;
    }
  }
  const id = await save(actor, system, source);
  return { id, summary, notes: notes.slice(0, 6), usedModel };
}

export async function updateSystem(actor: Actor, id: string, raw: unknown): Promise<DesignSystemView> {
  const r = await row(actor, id);
  const prev = parse(r);
  let system: DesignSystem;
  try { system = validateSystem(raw); } catch (e) { if (e instanceof DesignValidationError) throw new SystemError(e.message); throw e; }
  await store.updateSystemRow(actor, id, system.name, JSON.stringify({ system, source: prev?.source ?? { kind: "manual", ref: "" } }));
  return getSystem(actor, id);
}

export async function deleteSystem(actor: Actor, id: string): Promise<void> {
  await row(actor, id);
  await store.deleteSystemRow(actor, id);
}

export async function exportSystemFiles(actor: Actor, id: string, format: string): Promise<{ name: string; format: SystemExport; files: Array<{ path: string; content: string }> }> {
  if (!(SYSTEM_EXPORTS as readonly string[]).includes(format)) throw new SystemError(`Unknown export format. Choose one of: ${SYSTEM_EXPORTS.join(", ")}.`);
  const system = await loadSystem(actor, id);
  return { name: system.name, format: format as SystemExport, files: exportSystem(system, format as SystemExport) };
}

export async function exportSystemZip(actor: Actor, id: string, format: string): Promise<{ filename: string; bytes: Uint8Array }> {
  const ex = await exportSystemFiles(actor, id, format);
  const root = `${slugify(ex.name, "design-system")}-${ex.format}`;
  const files: Record<string, Uint8Array> = {};
  for (const f of ex.files) files[`${root}/${f.path}`] = strToU8(f.content);
  return { filename: `${root}.zip`, bytes: zipSync(files, { level: 6, mtime: new Date("2026-01-01T00:00:00Z") }) };
}

export type { SystemSourceView };
