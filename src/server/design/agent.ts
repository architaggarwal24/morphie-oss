/**
 * The Design Agent.
 *   create: the model returns a complete design spec for a brand-new brief.
 *   edit:   the model returns a short list of *operations* applied to the current design, so
 *           "make it darker" can't come back as an unrelated site and small local models stay reliable.
 * Model output is untrusted: parsed defensively as JSON, converted to a design, validated. On failure the
 * model gets the *complete* list of problems and tries again (bounded). Nothing is executed. Plain
 * "use the X theme" requests skip the model entirely.
 */
import type { ChatMessage, Provider } from "../providers/types";
import { COMPONENTS } from "./components";
import { DesignValidationError, shortRepr } from "./fields";
import { ICON_NAMES } from "./icons";
import { ARCHETYPES } from "./layouts";
import { describeDesign, validateDesign, type Design, type Section } from "./schema";
import { COLOR_KEYS, FONT_NAMES, THEMES, applyTheme, getTheme, matchThemeRequest } from "./themes";

export const MAX_OPERATIONS = 12;
const MAX_MODEL_OUTPUT_CHARS = 100_000;
const MAX_JSON_DEPTH = 16;
const SUMMARY_MAX = 200;
const DEFAULT_MAX_REPAIRS = 2;

export class DesignAgentError extends Error {}
/** The model could not produce a valid design within the retry budget. Safe to show the user. */
export class DesignGenerationError extends DesignAgentError {}
/** Not a failure: the agent needs more information. The message is a normal reply. */
export class DesignClarification extends DesignAgentError {}
class DesignParseError extends Error {}
class Problem extends Error { constructor(public errors: string[], /** A create reply that parsed but didn't validate: fixable with operations. */ public draft?: Obj, public summary?: unknown) { super(errors.join("; ")); } }
class NewDesign extends Error {}

export interface DesignResult { design: Design; summary: string; kind: "create" | "edit" | "theme"; notes: string[] }
export type DesignProgress = { stage: "drafting" | "validating" | "repairing"; attempt: number };

// ------------------------------------------------------ reading model output

function tooDeep(value: unknown, limit = MAX_JSON_DEPTH): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    const children = Array.isArray(node) ? node : node && typeof node === "object" ? Object.values(node) : null;
    if (!children) continue;
    if (depth > limit) return true;
    for (const c of children) stack.push([c, depth + 1]);
  }
  return false;
}

/** End index (exclusive) of the balanced {...} starting at `start`, or -1. Depth-capped so hostile input is cheap. */
function balancedEnd(text: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") { if (++depth > 64) return -2; }
    else if (ch === "}" || ch === "]") { if (--depth === 0) return i + 1; if (depth < 0) return -1; }
  }
  return -1;
}

/** First valid JSON *object* in `text`: bare JSON, ```json fences, or chatty replies with stray braces. */
export function extractJsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || !text.trim()) throw new DesignParseError("The reply was empty.");
  if (text.length > MAX_MODEL_OUTPUT_CHARS) throw new DesignParseError("The reply was far too long to be a design.");
  let index = text.indexOf("{");
  for (let attempts = 0; index !== -1 && attempts < 40; attempts++) {
    const end = balancedEnd(text, index);
    if (end === -2) throw new DesignParseError("The reply was nested far too deeply to be a design.");
    if (end > 0) {
      try {
        const value = JSON.parse(text.slice(index, end));
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if (tooDeep(value)) throw new DesignParseError("The reply was nested far too deeply to be a design.");
          return value as Record<string, unknown>;
        }
      } catch (e) {
        if (e instanceof DesignParseError) throw e;
      }
    }
    index = text.indexOf("{", index + 1);
  }
  throw new DesignParseError("The reply did not contain a JSON object.");
}

function cleanSummary(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  const t = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return fallback;
  return t.length <= SUMMARY_MAX ? t : t.slice(0, SUMMARY_MAX - 1).trimEnd() + "…";
}

// -------------------------------------------------------------- operations

type Obj = Record<string, any>;
type OpHandler = (design: Obj, op: Obj, path: string, errors: string[]) => void;
const clone = <T>(v: T): T => structuredClone(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const sectionList = (d: Obj) => (d.sections ?? []).map((s: Obj) => `${s.id} (${s.type})`).join(", ");

function resolve(design: Obj, target: unknown, path: string, errors: string[], field = "target"): Obj | null {
  if (typeof target !== "string" || !target.trim()) { errors.push(`${path}.${field}: is required (a section id)`); return null; }
  const key = target.trim().toLowerCase();
  const sections: Obj[] = design.sections ?? [];
  const exact = sections.find((s) => String(s.id ?? "").toLowerCase() === key);
  if (exact) return exact;
  const matches = sections.filter((s) => s.type === key);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) { errors.push(`${path}.${field}: ${JSON.stringify(target)} is ambiguous - it matches ${matches.map((s) => s.id).join(", ")}; use a section id`); return null; }
  errors.push(`${path}.${field}: no section ${JSON.stringify(target)} (available: ${sectionList(design)})`);
  return null;
}

function valuesOf(op: Obj, path: string, errors: string[], allowed: string[], what: string): Obj | null {
  const v = op.values;
  if (!v || typeof v !== "object" || Array.isArray(v) || !Object.keys(v).length) { errors.push(`${path}.values: must be an object with at least one field`); return null; }
  const unknown = Object.keys(v).filter((k) => !allowed.includes(k));
  if (unknown.length) { errors.push(`${path}.values: unknown ${what} field ${unknown.slice(0, 5).map((k) => `'${k}'`).join(", ")} (allowed: ${allowed.join(", ")})`); return null; }
  return v;
}

const setGroup = (group: string, allowed: string[], what: string): OpHandler => (design, op, path, errors) => {
  const v = valuesOf(op, path, errors, allowed, what);
  if (v) design[group] = { ...(design[group] ?? {}), ...clone(v) };
};

const OPS: Record<string, OpHandler> = {
  set_theme: setGroup("theme", [...COLOR_KEYS], "theme color"),
  apply_theme(design, op, path, errors) {
    const p = getTheme(op.preset);
    if (!p) { errors.push(`${path}.preset: unknown theme ${shortRepr(op.preset)} (available: ${Object.keys(THEMES).join(", ")})`); return; }
    design.theme = { ...p.colors }; design.typography = { ...p.typography }; design.style = { ...p.style };
  },
  set_typography: setGroup("typography", ["heading", "body", "scale"], "typography"),
  set_layout: setGroup("layout", ["max_width", "spacing"], "layout"),
  set_style: setGroup("style", ["radius", "shadow"], "style"),
  set_responsive: setGroup("responsive", ["tablet_columns", "mobile_columns", "mobile_nav"], "responsive"),
  update_section(design, op, path, errors) {
    const section = resolve(design, op.target, path, errors);
    if (!section) return;
    if (op.values && typeof op.values === "object" && ("type" in op.values || "id" in op.values)) {
      errors.push(`${path}.values: 'type' and 'id' cannot be changed (remove the section and add a new one)`); return;
    }
    const comp = COMPONENTS[section.type];
    const v = valuesOf(op, path, errors, Object.keys(comp.fields), section.type);
    if (v) Object.assign(section, clone(v));
  },
  add_section(design, op, path, errors) {
    if (!op.section || typeof op.section !== "object" || Array.isArray(op.section)) { errors.push(`${path}.section: must be an object with a 'type'`); return; }
    const sections: Obj[] = design.sections;
    let position: number;
    if (op.after != null) {
      const anchor = resolve(design, op.after, path, errors, "after");
      if (!anchor) return;
      position = sections.indexOf(anchor) + 1;
    } else {
      const footers = sections.map((s, i) => (s.type === "footer" ? i : -1)).filter((i) => i >= 0);
      position = footers.length ? footers[footers.length - 1] : sections.length;
    }
    sections.splice(position, 0, clone(op.section));
  },
  remove_section(design, op, path, errors) {
    const section = resolve(design, op.target, path, errors);
    if (!section) return;
    const removed = section.id;
    design.sections = design.sections.filter((s: Obj) => s !== section);
    for (const other of design.sections as Obj[]) {
      if (Array.isArray(other.links)) other.links = other.links.filter((l: Obj) => !(l && typeof l === "object" && l.target === removed));
      if (other.cta_target === removed) delete other.cta_target;
    }
  },
  move_section(design, op, path, errors) {
    const section = resolve(design, op.target, path, errors);
    const anchor = resolve(design, op.after, path, errors, "after");
    if (!section || !anchor) return;
    if (section === anchor) { errors.push(`${path}: cannot move a section after itself`); return; }
    const sections = (design.sections as Obj[]).filter((s) => s !== section);
    sections.splice(sections.indexOf(anchor) + 1, 0, section);
    design.sections = sections;
  },
  set_name(design, op, path, errors) {
    if (typeof op.value !== "string" || !op.value.trim()) { errors.push(`${path}.value: must be the new name (text)`); return; }
    design.name = op.value;
  },
};

/** Apply operations to a copy of `design`. Returns [workingCopy, errors]; the copy is NOT validated yet. */
export function applyOperations(design: unknown, operations: unknown): [Obj, string[]] {
  const working = clone(design) as Obj;
  if (!Array.isArray(operations)) return [working, ["operations: must be a list"]];
  if (operations.length > MAX_OPERATIONS) return [working, [`operations: too many operations (${operations.length}, max ${MAX_OPERATIONS})`]];
  const errors: string[] = [];
  operations.forEach((op, i) => {
    const path = `operations[${i}]`;
    if (!op || typeof op !== "object" || Array.isArray(op)) { errors.push(`${path}: must be an object`); return; }
    const name = (op as Obj).op;
    const handler = typeof name === "string" && has(OPS, name) ? OPS[name] : undefined;
    if (!handler) { errors.push(`${path}: unknown operation ${shortRepr(name)} (use one of ${Object.keys(OPS).join(", ")})`); return; }
    handler(working, op as Obj, path, errors);
  });
  return [working, errors];
}

// ------------------------------------------------- create vs. edit routing

const STRONG_RESET = /\b(start (over|again|fresh)|brand[- ]new|new (design|website|web site|site)|(another|different|completely different) (design|website|site|layout)|redo everything|scrap (this|it|that|everything|all of (this|it)))\b/i;
const WEAK_RESET = /\bfrom scratch\b/i;
const SECTION_WORDS = /\b(hero|navbar|nav|footer|section|cards?|pricing|tiers?|features?|testimonials?|faq|cta|header|headline|title|copy|text|button|paragraph|subtitle|links?|menu)\b/i;

export function wantsNewDesign(text: unknown): boolean {
  if (typeof text !== "string") return false;
  if (STRONG_RESET.test(text)) return true;
  return WEAK_RESET.test(text) && !SECTION_WORDS.test(text);
}
const briefAfterReset = (t: string) => t.replace(new RegExp(STRONG_RESET.source, "gi"), " ").replace(new RegExp(WEAK_RESET.source, "gi"), " ").replace(/^[ ,.:;\-!]+|[ ,.:;\-!]+$/g, "");

const NEEDS_BRIEF = "Sure. What should I design? For example: “A dark landing page for a fintech startup” or “A portfolio site for a wedding photographer”.";

// ----------------------------------------------------------------- prompts

const EXAMPLE_DESIGN = {
  name: "Northwind Coffee",
  theme: { background: "#14110f", surface: "#1f1a17", primary: "#e0a458", secondary: "#b9835a", accent: "#f2d7a1", text: "#f6efe6" },
  typography: { heading: "Fraunces", body: "Inter", scale: "normal" },
  layout: { max_width: "1200px", spacing: "comfortable" },
  style: { radius: "md", shadow: "soft" },
  responsive: { tablet_columns: 2, mobile_columns: 1, mobile_nav: "collapse" },
  sections: [
    { type: "navbar", brand: "Northwind", links: [{ label: "Beans" }, { label: "Subscribe" }], cta: "Order now" },
    { type: "hero", badge: "Roasted in Leeds", title: "Coffee that tastes like the farm it came from", subtitle: "Small-lot beans, roasted to order and posted the same day.", cta: "Shop beans", secondary_cta: "How we roast", layout: "split", size: "lg" },
    { type: "features", title: "Why people switch", columns: 3, items: [
      { title: "Traceable", body: "Every bag names the farm and the harvest.", icon: "globe" },
      { title: "Roasted to order", body: "Nothing sits on a shelf for weeks.", icon: "clock" },
      { title: "Fair prices", body: "We publish what farmers are paid.", icon: "heart" }] },
    { type: "cta", title: "Your first bag ships free", subtitle: "Cancel any time.", cta: "Start a subscription" },
    { type: "footer", brand: "Northwind Coffee", tagline: "Small-lot coffee, honestly priced.", columns: [{ title: "Shop", links: ["Beans", "Gifts"] }], copyright: "© 2026 Northwind Coffee" },
  ],
};

const presetLines = () => Object.values(THEMES).map((p) => {
  const c = p.colors;
  return `  ${p.id}: ${p.description} background ${c.background}, surface ${c.surface}, primary ${c.primary}, secondary ${c.secondary}, accent ${c.accent}, text ${c.text}; ${p.typography.heading} / ${p.typography.body}; radius ${p.style.radius}, shadow ${p.style.shadow}`;
}).join("\n");

const archetypeLines = () => Object.entries(ARCHETYPES).map(([k, a]) => `  ${k}: ${a.description} Sections: ${a.sections.join(", ")}.${k === "dashboard" ? " Use compact spacing and a wide max_width." : ""}`).join("\n");
const componentLines = () => Object.values(COMPONENTS).map((c) => "  " + c.describe()).join("\n");

const COMMON_RULES = `- Reply with ONE JSON object and nothing else: no markdown, no code fences, no commentary.
- Colors are #rrggbb hex only. Text must contrast with both background and surface (aim for 7:1, never below 4.5:1).
- Fonts must come from the allowed list. Icons must come from the allowed list.
- Every text value must respect its length limit (≤N means at most N characters); over-long values are rejected.
- Write specific, believable copy for this product. No lorem ipsum, no placeholders like "Feature One". Plain language, sentence case, concrete claims.
- Section types are limited to the ones listed. navbar (if any) comes first and footer (if any) last; at most one of each.
- Links are in-page anchors: a navbar link's "target" is another section's id.
`;

/** Skills' design guidance, after the fixed rules (it varies by request, so it sits outside the cached prefix). */
export const GUIDANCE_MARK = "Design guidance from skills";
const guidanceBlock = (g?: string) => (g?.trim() ? `${GUIDANCE_MARK} (apply it where it fits the brief; the JSON rules above always win):\n${g.trim()}\n\n` : "");

export function buildCreatePrompt(guidance?: string): string {
  return buildCreatePromptBase() + (guidance?.trim() ? `\n${guidanceBlock(guidance)}` : "");
}

function buildCreatePromptBase(): string {
  return `You are Morphie's design agent. You turn a description of a website or UI into a strict JSON design specification that Morphie renders live.

${COMMON_RULES}
Reply shape: {"summary": "<one sentence describing what you designed>", "design": {...}}

Design schema:
${describeDesign()}

Section types:
${componentLines()}

Allowed fonts: ${FONT_NAMES.join(", ")}
Allowed icons: ${ICON_NAMES.join(", ")}

Theme presets you can start from or adapt (any palette is allowed as long as it is readable):
${presetLines()}

Page kinds:
${archetypeLines()}

Choose a palette, typography, and shape that fit the brief's mood (a "premium dark" brief means a dark background and restrained accents). Make responsive choices deliberately: tablet_columns/mobile_columns control how grids collapse.

Example reply:
${JSON.stringify({ summary: "A warm, editorial landing page for a small coffee roaster.", design: EXAMPLE_DESIGN })}
`;
}

const OPERATIONS_REFERENCE = `Operations (use the fewest that do the job; anything you do not mention stays exactly as it is):
  {"op":"set_theme","values":{"background":"#..","surface":"#..","primary":"#..","secondary":"#..","accent":"#..","text":"#.."}}   (any subset)
  {"op":"apply_theme","preset":"<preset id>"}                        replaces colors, fonts, radius and shadow with a preset
  {"op":"set_typography","values":{"heading":"<font>","body":"<font>","scale":"compact|normal|large"}}
  {"op":"set_layout","values":{"max_width":"1200px","spacing":"compact|comfortable|spacious"}}
  {"op":"set_style","values":{"radius":"none|sm|md|lg|xl","shadow":"none|soft|strong|glow"}}
  {"op":"set_responsive","values":{"tablet_columns":1-3,"mobile_columns":1-2,"mobile_nav":"collapse|stack"}}
  {"op":"update_section","target":"<section id>","values":{...only the fields to change...}}    (lists such as items are replaced whole)
  {"op":"add_section","section":{"type":"...", ...all its fields...},"after":"<section id>"}     (omit "after" to add just before the footer)
  {"op":"remove_section","target":"<section id>"}
  {"op":"move_section","target":"<section id>","after":"<section id>"}
  {"op":"set_name","value":"<new name>"}

How common requests map to operations:
  "Make it darker"                   set_theme: much darker background and surface (keep text readable, lighten text if needed)
  "Use purple accents"               set_theme: purple primary, secondary and accent; leave background and surface alone
  "Make the hero bigger"             update_section on the hero: size md -> lg -> xl (and/or layout "split")
  "Remove pricing"                   remove_section on the pricing section
  "Make the cards more rounded"      set_style: radius one or two steps up (none < sm < md < lg < xl)
  "Use the Premium theme"            apply_theme with that preset id
  "Add an FAQ"                       add_section with real questions and answers written for this product
`;

/** Everything in the edit prompt that doesn't depend on the design: it comes first, so providers can cache it. */
export const EDIT_CURRENT_MARK = "Current design (JSON):";

export function buildEditPrompt(current: Design, guidance?: string): string {
  return `You are Morphie's design agent. You EDIT an existing website design by returning operations. Never return a whole new design.

${COMMON_RULES}
Reply shape: {"summary": "<one sentence describing what you changed>", "operations": [ ... ]}
If the user is clearly asking for a completely different website rather than a change to this one, reply {"new_design": true} instead.
If nothing needs to change, reply with an empty operations list and say why in the summary.

${OPERATIONS_REFERENCE}
Theme presets: ${Object.keys(THEMES).join(", ")}
Allowed fonts: ${FONT_NAMES.join(", ")}
Allowed icons: ${ICON_NAMES.join(", ")}
Section fields:
${componentLines()}

${guidanceBlock(guidance)}${EDIT_CURRENT_MARK}
${JSON.stringify(current)}
`;
}

/** The fix for a draft that almost validated: operations on it, instead of the model writing the whole design again. */
function repairWithOperations(errors: string[]): string {
  const shown = errors.slice(0, 12).map((e) => `- ${e}`).join("\n") + (errors.length > 12 ? `\n- ...and ${errors.length - 12} more` : "");
  return `Your design is nearly right, but these fields are invalid:\n${shown}\n\nDon't send the whole design again. Reply with ONE JSON object {"operations": [...]} that fixes exactly these problems, using these operations on your design (section ids as in your reply):\n${OPERATIONS_REFERENCE}`;
}

// ------------------------------------------------------------------- agent

function repairMessage(errors: string[], kind: string): string {
  const shown = errors.slice(0, 12);
  let lines = shown.map((e) => `- ${e}`).join("\n");
  if (errors.length > shown.length) lines += `\n- ...and ${errors.length - shown.length} more`;
  const shape = kind === "edit" ? '{"summary": "...", "operations": [...]}' : '{"summary": "...", "design": {...}}';
  return `Your reply could not be used:\n${lines}\n\nReply again with ONE corrected JSON object only, shaped like ${shape}.`;
}

export class DesignAgent {
  constructor(private maxRepairs = DEFAULT_MAX_REPAIRS) {}

  /** Create a design, or edit `current`, according to `instruction`. */
  async respond(instruction: string, current: Design | null, provider: Provider, opts: { signal?: AbortSignal; onProgress?: (p: DesignProgress) => void; guidance?: string } = {}): Promise<DesignResult> {
    const text = typeof instruction === "string" ? instruction.trim() : "";
    if (!text) throw new DesignClarification("Tell me what you'd like to design, or what to change.");
    const reset = wantsNewDesign(text);
    const themeId = matchThemeRequest(text);

    if (current && !reset) {
      if (themeId) return this.applyPreset(current, themeId);
      const quick = quickEdit(text, current);
      if (quick) return quick;
      return this.converse("edit", text, current, provider, opts);
    }
    if (themeId) {
      throw new DesignClarification("There's no design to restyle yet. Describe the site you want (for example “A landing page for a bakery”) and then I can switch its theme.");
    }
    if (reset && (briefAfterReset(text).match(/[A-Za-z']+/g) ?? []).length < 2) throw new DesignClarification(NEEDS_BRIEF);
    return this.converse("create", text, null, provider, opts);
  }

  applyPreset(current: Design, themeId: string): DesignResult {
    const preset = THEMES[themeId];
    const notes: string[] = [];
    const design = validateDesign(applyTheme(current, themeId), notes);
    return { design, summary: `Switched to the ${preset.name} theme.`, kind: "theme", notes };
  }

  private async converse(kind: "create" | "edit", text: string, current: Design | null, provider: Provider, opts: { signal?: AbortSignal; onProgress?: (p: DesignProgress) => void; guidance?: string }): Promise<DesignResult> {
    const system = kind === "edit" ? buildEditPrompt(current!, opts.guidance) : buildCreatePrompt(opts.guidance);
    // The rules and references never change: everything before the skills' guidance and the current design is a cacheable prefix.
    const g = system.indexOf(GUIDANCE_MARK);
    const split = g > 0 ? g : kind === "edit" ? system.indexOf(EDIT_CURRENT_MARK) : system.length;
    let messages: ChatMessage[] = [{ role: "system", content: system, cacheSplit: split > 0 ? split : undefined }, { role: "user", content: text }];
    let errors: string[] = [];
    let draft: Obj | undefined;
    let draftSummary: unknown;
    for (let attempt = 0; attempt <= this.maxRepairs; attempt++) {
      opts.onProgress?.({ stage: attempt === 0 ? "drafting" : "repairing", attempt });
      const reply = await provider.chat({ messages, signal: opts.signal, temperature: attempt === 0 ? 0.4 : 0.1 });
      const raw = typeof reply.content === "string" ? reply.content : "";
      opts.onProgress?.({ stage: "validating", attempt });
      const fixing = draft;
      try {
        // A repair of a parsed draft comes back as operations on it (or, if the model insists, a whole design).
        return fixing ? this.interpretFix(raw, fixing, draftSummary) : this.interpret(kind, raw, current);
      } catch (e) {
        if (e instanceof NewDesign) return this.converse("create", text, null, provider, opts);
        if (!(e instanceof Problem)) throw e;
        errors = e.errors;
        draft = fixing ? undefined : e.draft;
        if (e.draft) draftSummary = e.summary;
      }
      // Errors only (and, for a draft, a request for operations): the model doesn't rewrite what was already right.
      const ask = draft && errors.length <= 8 ? repairWithOperations(errors) : repairMessage(errors, kind);
      if (!(draft && errors.length <= 8)) draft = undefined;
      messages = [...messages, { role: "assistant", content: raw.slice(0, kind === "edit" ? 2000 : 12_000) }, { role: "user", content: ask }];
    }
    const detail = errors.length ? ` (${errors[0]})` : "";
    const keep = current ? " Your current design is unchanged." : "";
    throw new DesignGenerationError(`I couldn't turn that into a valid design after a few tries${detail}.${keep} Try rephrasing, or ask for a smaller change.`);
  }

  private interpret(kind: "create" | "edit", raw: string, current: Design | null): DesignResult {
    let payload: Record<string, unknown>;
    try { payload = extractJsonObject(raw); }
    catch (e) { throw new Problem([`${(e as Error).message} Reply with a single JSON object and nothing else.`]); }

    const notes: string[] = [];
    if (kind === "create") {
      const candidate = has(payload, "design") ? payload.design : payload;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Problem(["design: must be an object"]);
      let design: Design;
      try { design = validateDesign(candidate, notes); } catch (e) { if (e instanceof DesignValidationError) throw new Problem(e.errors, candidate as Obj, payload.summary); throw e; }
      return { design, summary: cleanSummary(payload.summary, `Created ${design.name}.`), kind: "create", notes };
    }
    if (payload.new_design === true) throw new NewDesign();
    if (!has(payload, "operations")) {
      if (has(payload, "design")) throw new Problem(["You returned a whole design. Edits must be returned as `operations` that change the current design; do not return a new design."]);
      throw new Problem(["The reply has no `operations` list."]);
    }
    const [working, opErrors] = applyOperations(current, payload.operations);
    if (opErrors.length) throw new Problem(opErrors);
    let design: Design;
    try { design = validateDesign(working, notes); } catch (e) { if (e instanceof DesignValidationError) throw new Problem(e.errors); throw e; }
    return { design, summary: cleanSummary(payload.summary, "Updated the design."), kind: "edit", notes };
  }

  /** A repair reply for a create draft: operations applied to the draft, or a whole corrected design. */
  private interpretFix(raw: string, draft: Obj, draftSummary: unknown): DesignResult {
    let payload: Record<string, unknown>;
    try { payload = extractJsonObject(raw); }
    catch (e) { throw new Problem([`${(e as Error).message} Reply with a single JSON object and nothing else.`]); }
    if (!has(payload, "operations")) return this.interpret("create", raw, null);
    const [working, opErrors] = applyOperations(draft, payload.operations);
    if (opErrors.length) throw new Problem(opErrors);
    const notes: string[] = [];
    let design: Design;
    try { design = validateDesign(working, notes); } catch (e) { if (e instanceof DesignValidationError) throw new Problem(e.errors); throw e; }
    return { design, summary: cleanSummary(payload.summary ?? draftSummary, `Created ${design.name}.`), kind: "create", notes };
  }
}

// ------------------------------------------------------------ quick edits
// Simple, unambiguous requests are applied directly: no model call, no tokens.

const RADII = ["none", "sm", "md", "lg", "xl"];
const SPACINGS = ["compact", "comfortable", "spacious"];

function quickOps(text: string, d: Design): { ops: Obj[]; summary: string } | null {
  const t = text.trim().replace(/[.!]+$/, "").replace(/^(please|can you|could you)\s+/i, "").trim();
  let m: RegExpExecArray | null;
  if ((m = /^(?:remove|delete|drop|get rid of)\s+(?:the\s+)?([a-z][a-z -]{1,30}?)(?:\s+section)?$/i.exec(t))) {
    const want = m[1].toLowerCase().replace(/s$/, "").replace(/\s+/g, "-");
    const aliases: Record<string, string> = { nav: "navbar", navigation: "navbar", header: "navbar", "call-to-action": "cta", testimonial: "testimonials", feature: "features", question: "faq", "frequently-asked-question": "faq", price: "pricing", plan: "pricing" };
    const type = aliases[want] ?? want;
    const hits = d.sections.filter((s) => s.id.toLowerCase() === want || s.type === type || s.type === `${type}s`);
    if (hits.length !== 1) return null;
    return { ops: [{ op: "remove_section", target: hits[0].id }], summary: `Removed the ${hits[0].type} section.` };
  }
  if ((m = /^(?:rename (?:it|the (?:site|design|page))|change the (?:site |design |page )?name|call it)\s+(?:to\s+)?["“']?([^"”']{1,60})["”']?$/i.exec(t))) {
    return { ops: [{ op: "set_name", value: m[1].trim() }], summary: `Renamed it to ${m[1].trim()}.` };
  }
  if ((m = /^(?:use|switch to|change (?:the )?fonts? to|set (?:the )?fonts? to)\s+(?:the\s+)?([a-z0-9 ]{2,40}?)(?:\s+font)?$/i.exec(t))) {
    const font = FONT_NAMES.find((f) => f.toLowerCase() === m![1].toLowerCase().trim());
    if (!font) return null;
    return { ops: [{ op: "set_typography", values: { heading: font, body: font } }], summary: `Switched the fonts to ${font}.` };
  }
  const radius = RADII.indexOf(d.style.radius);
  if (/^(?:make (?:it|the (?:cards|corners|buttons))\s+)?(?:more rounded|rounder)(?: corners)?$/i.test(t) && radius >= 0 && radius < RADII.length - 1) {
    return { ops: [{ op: "set_style", values: { radius: RADII[radius + 1] } }], summary: `Rounded the corners more (${RADII[radius + 1]}).` };
  }
  if (/^(?:make (?:it|the (?:cards|corners|buttons))\s+)?(?:less rounded|sharper|square(?:r)?)(?: corners)?$/i.test(t) && radius > 0) {
    return { ops: [{ op: "set_style", values: { radius: RADII[radius - 1] } }], summary: `Made the corners sharper (${RADII[radius - 1]}).` };
  }
  const spacing = SPACINGS.indexOf(d.layout.spacing);
  if (/^(?:make it |give it )?(?:more spacious|more (?:white ?space|breathing room)|airier|less cramped)$/i.test(t) && spacing >= 0 && spacing < SPACINGS.length - 1) {
    return { ops: [{ op: "set_layout", values: { spacing: SPACINGS[spacing + 1] } }], summary: "Added more space between things." };
  }
  if (/^(?:make it |)(?:more compact|tighter|denser|less spacious)$/i.test(t) && spacing > 0) {
    return { ops: [{ op: "set_layout", values: { spacing: SPACINGS[spacing - 1] } }], summary: "Tightened the spacing." };
  }
  return null;
}

export function quickEdit(text: string, current: Design): DesignResult | null {
  const q = quickOps(text, current);
  if (!q) return null;
  const [working, errors] = applyOperations(current, q.ops);
  if (errors.length) return null;
  const notes: string[] = [];
  try { return { design: validateDesign(working, notes), summary: q.summary, kind: "edit", notes }; }
  catch { return null; }
}

export type { Section };
