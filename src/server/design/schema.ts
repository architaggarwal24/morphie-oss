/**
 * Strict design schema. Nothing an LLM produces reaches the renderer, the database or the browser
 * without passing through validateDesign(): allowlisted keys only, every value type/length/enum
 * checked, all problems collected at once, defaults filled in, and idempotent (re-validating a valid
 * design returns it unchanged). It never evaluates or executes anything from the design.
 */
import { COMPONENTS } from "./components";
import { DesignValidationError, Enum, Font, Hex, INVALID, Int, ListOf, MaxWidth, Obj, Str, ValidationState, shortRepr, type Cleaned } from "./fields";
import { DEFAULT_LAYOUT, DEFAULT_RESPONSIVE, DEFAULT_STYLE, MOBILE_COLUMNS, MOBILE_NAV, RADIUS, SECTION_TYPES, SHADOWS, SPACING, TABLET_COLUMNS, TYPE_SCALE } from "./layouts";
import { contrastRatio, ensureReadable, type Colors } from "./themes";

export { DesignValidationError };
export const MAX_SECTIONS = 20;
export const MAX_DESIGN_CHARS = 200_000;

export interface Section { id: string; type: string; [key: string]: unknown }
export interface Design {
  name: string;
  theme: Colors;
  typography: { heading: string; body: string; scale: string };
  layout: { max_width: string; spacing: string };
  style: { radius: string; shadow: string };
  responsive: { tablet_columns: number; mobile_columns: number; mobile_nav: string };
  sections: Section[];
}

class Sections extends ListOf {
  constructor() { super(null, { minItems: 1, maxItems: MAX_SECTIONS }); }
  protected cleanItem(item: unknown, path: string, st: ValidationState): Cleaned {
    if (!item || typeof item !== "object" || Array.isArray(item)) { st.error(path, "must be an object"); return INVALID; }
    const rawType = (item as Record<string, unknown>).type;
    const kind = typeof rawType === "string" ? rawType.trim().toLowerCase() : null;
    const component = kind && Object.prototype.hasOwnProperty.call(COMPONENTS, kind) ? COMPONENTS[kind] : undefined;
    if (!component) { st.error(`${path}.type`, `must be one of ${SECTION_TYPES.join(", ")} (got ${shortRepr(rawType)})`); return INVALID; }
    return component.schema().clean(item, path, st);
  }
  describe() { return `list of 1-${MAX_SECTIONS} sections`; }
}

const hexes = () => Object.fromEntries(["background", "surface", "primary", "secondary", "accent", "text"].map((k) => [k, new Hex()]));

const DESIGN = new Obj({
  name: new Str(60),
  theme: new Obj(hexes()),
  typography: new Obj({ heading: new Font(), body: new Font(), scale: new Enum(Object.keys(TYPE_SCALE), { default: "normal" }) }),
  layout: new Obj({ max_width: new MaxWidth({ default: DEFAULT_LAYOUT.max_width }), spacing: new Enum(Object.keys(SPACING), { default: DEFAULT_LAYOUT.spacing }) }, { optional: true }),
  style: new Obj({ radius: new Enum(Object.keys(RADIUS), { default: DEFAULT_STYLE.radius }), shadow: new Enum(SHADOWS, { default: DEFAULT_STYLE.shadow }) }, { optional: true }),
  responsive: new Obj({
    tablet_columns: new Int(Math.min(...TABLET_COLUMNS), Math.max(...TABLET_COLUMNS), { default: DEFAULT_RESPONSIVE.tablet_columns }),
    mobile_columns: new Int(Math.min(...MOBILE_COLUMNS), Math.max(...MOBILE_COLUMNS), { default: DEFAULT_RESPONSIVE.mobile_columns }),
    mobile_nav: new Enum(MOBILE_NAV, { default: DEFAULT_RESPONSIVE.mobile_nav }),
  }, { optional: true }),
  sections: new Sections(),
});

/** One line per top-level key, for prompts. */
export function describeDesign(): string {
  return Object.entries(DESIGN.fields).map(([k, f]) => `  ${k}: ${f.describe()}`).join("\n");
}

export function slugify(text: unknown, fallback = "section"): string {
  let slug = String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/^-+|-+$/g, "");
  if (!slug) return fallback;
  if (!/^[a-z]/.test(slug)) slug = "s-" + slug;
  if (slug.startsWith("mf-")) slug = "s-" + slug.slice(3); // "mf-" is reserved for generated CSS/markup
  return slug.slice(0, 32).replace(/-+$/, "") || fallback;
}

function unique(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base.slice(0, 28)}-${n}`)) n++;
  return `${base.slice(0, 28)}-${n}`;
}

function assignIds(sections: Section[]): void {
  const used = new Set<string>();
  for (const s of sections) if (s.id) { s.id = unique(slugify(s.id, s.type), used); used.add(s.id); }
  for (const s of sections) if (!s.id) { s.id = unique(s.type, used); used.add(s.id); }
}

function resolveNavLinks(sections: Section[], st: ValidationState): void {
  const ids = new Set(sections.map((s) => s.id));
  const firstOfType = new Map<string, string>();
  for (const s of sections) if (!firstOfType.has(s.type)) firstOfType.set(s.type, s.id);
  sections.forEach((section, si) => {
    if (section.type !== "navbar") return;
    ((section.links as Array<Record<string, string>>) ?? []).forEach((link, li) => {
      if (link.target !== undefined) {
        const cleaned = link.target.replace(/^#+/, "");
        if (ids.has(cleaned)) { link.target = cleaned; return; }
        st.note(`sections[${si}].links[${li}]`, `target ${shortRepr(link.target)} matches no section; link left without a target`);
        delete link.target;
      }
      const key = slugify(link.label, "");
      if (ids.has(key)) link.target = key;
      else if (firstOfType.has(key)) link.target = firstOfType.get(key)!;
    });
  });
}

function resolveCtaTargets(sections: Section[], st: ValidationState): void {
  const ids = new Set(sections.map((s) => s.id));
  sections.forEach((section, si) => {
    if (section.type !== "navbar" && section.type !== "hero") return;
    if (!section.cta) { delete section.cta_target; return; }
    if (section.cta_target !== undefined) {
      const cleaned = String(section.cta_target).replace(/^#+/, "");
      if (ids.has(cleaned)) { section.cta_target = cleaned; return; }
      st.note(`sections[${si}]`, `cta_target ${shortRepr(section.cta_target)} matches no section; linking automatically`);
      delete section.cta_target;
    }
    for (const kind of ["cta", "pricing"]) {
      const match = sections.find((o) => o.type === kind && o !== section);
      if (match) { section.cta_target = match.id; break; }
    }
  });
}

function finalize(design: Design, st: ValidationState): void {
  const sections = design.sections;
  const navbars = sections.filter((s) => s.type === "navbar");
  const footers = sections.filter((s) => s.type === "footer");
  for (const [kind, found] of [["navbar", navbars], ["footer", footers]] as const) {
    if (found.length > 1) st.error("sections", `only one ${kind} is allowed (found ${found.length})`);
  }
  if (st.errors.length) return;

  const middle = sections.filter((s) => s.type !== "navbar" && s.type !== "footer");
  const ordered = [...navbars, ...middle, ...footers];
  if (ordered.some((s, i) => s !== sections[i])) st.note("sections", "moved the navbar to the top and the footer to the bottom");
  assignIds(ordered);
  resolveNavLinks(ordered, st);
  resolveCtaTargets(ordered, st);
  design.sections = ordered.map(({ id, type, ...rest }) => ({ id, type, ...rest }));

  const t = design.theme;
  const fixed = ensureReadable(t.text, [t.background, t.surface]);
  if (fixed !== t.text) {
    const ratio = Math.min(contrastRatio(fixed, t.background), contrastRatio(fixed, t.surface));
    st.note("theme.text", `adjusted ${t.text} to ${fixed} to keep text readable (contrast ${ratio.toFixed(1)}:1)`);
    t.text = fixed;
  }
}

/**
 * Validate and normalise a design. Returns a new object (never mutates `raw`).
 * Throws DesignValidationError listing every problem. Non-fatal adjustments are appended to `notes`.
 */
export function validateDesign(raw: unknown, notes?: string[]): Design {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DesignValidationError(["The design must be a JSON object."]);
  const st = new ValidationState(notes);
  const cleaned = DESIGN.clean(raw, "", st) as Design | typeof INVALID;
  if (st.errors.length || cleaned === INVALID) throw new DesignValidationError(st.errors);
  finalize(cleaned, st);
  if (st.errors.length) throw new DesignValidationError(st.errors);
  return cleaned;
}
