/**
 * Design systems: a brand's tokens (colour roles, fonts, type and spacing scales, shape, elevation), its voice and
 * its do/don't guidelines, in one validated object. A design system can be generated from a description, a live
 * website or a screenshot's palette, saved, edited, applied to designs, documented and exported.
 *
 * Like designs, everything a model or a web page produces passes through validateSystem(): allowlisted keys, hex
 * colours, fonts from the allowlist, enums for every other knob. That keeps systems safe to render and export.
 */
import type { ChatMessage, Provider } from "../providers/types";
import { extractJsonObject } from "./agent";
import { DesignValidationError, Enum, Font, Hex, INVALID, ListOf, MaxWidth, Obj, Str, ValidationState, shortRepr } from "./fields";
import { DEFAULT_LAYOUT, RADIUS, SHADOWS, SPACING, TYPE_SCALE } from "./layouts";
import type { Design } from "./schema";
import { FONTS, FONT_NAMES, contrastRatio, ensureReadable, hexToRgb, mix, onColor, relativeLuminance, rgbToHex, saturation, type RGB } from "./themes";

// ------------------------------------------------------------------ types

export const ROLE_KEYS = ["background", "surface", "primary", "secondary", "accent", "text"] as const;
export const SEMANTIC_KEYS = ["success", "warning", "danger", "info"] as const;
export const RATIOS = ["1.125", "1.2", "1.25", "1.333", "1.5"] as const;
export type ColorRole = (typeof ROLE_KEYS)[number] | (typeof SEMANTIC_KEYS)[number];

export interface DesignSystem {
  name: string;
  description: string;
  colors: Record<ColorRole, string>;
  typography: { heading: string; body: string; mono: string; scale: string; ratio: string };
  shape: { radius: string; shadow: string };
  layout: { spacing: string; max_width: string };
  voice: { tone: string; principles: string[] };
  guidelines: Array<{ title: string; do: string; dont?: string }>;
}
export interface SystemSource { kind: "prompt" | "url" | "image" | "design" | "manual"; ref: string }

const SEMANTIC_DEFAULTS: Record<(typeof SEMANTIC_KEYS)[number], string> = { success: "#16a34a", warning: "#d97706", danger: "#dc2626", info: "#2563eb" };

const SYSTEM = new Obj({
  name: new Str(60),
  description: new Str(300, { default: "" }),
  colors: new Obj({
    ...Object.fromEntries(ROLE_KEYS.map((k) => [k, new Hex()])),
    ...Object.fromEntries(SEMANTIC_KEYS.map((k) => [k, new Hex({ default: SEMANTIC_DEFAULTS[k] })])),
  }),
  typography: new Obj({
    heading: new Font(), body: new Font(), mono: new Font({ default: "JetBrains Mono" }),
    scale: new Enum(Object.keys(TYPE_SCALE), { default: "normal" }),
    ratio: new Enum(RATIOS, { default: "1.25", fallback: "1.25" }),
  }),
  shape: new Obj({ radius: new Enum(Object.keys(RADIUS), { default: "md" }), shadow: new Enum(SHADOWS, { default: "soft" }) }, { optional: true }),
  layout: new Obj({ spacing: new Enum(Object.keys(SPACING), { default: DEFAULT_LAYOUT.spacing }), max_width: new MaxWidth({ default: DEFAULT_LAYOUT.max_width }) }, { optional: true }),
  voice: new Obj({ tone: new Str(160, { default: "" }), principles: new ListOf(new Str(140), { maxItems: 5, default: [] }) }, { optional: true }),
  guidelines: new ListOf(new Obj({ title: new Str(60), do: new Str(200), dont: new Str(200, { optional: true }) }), { maxItems: 8, default: [] }),
});

export function describeSystem(): string {
  return Object.entries(SYSTEM.fields).map(([k, f]) => `  ${k}: ${f.describe()}`).join("\n");
}

/** Validate and normalise. Throws DesignValidationError with every problem; adjustments go to `notes`. */
export function validateSystem(raw: unknown, notes?: string[]): DesignSystem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DesignValidationError(["The design system must be a JSON object."]);
  const st = new ValidationState(notes);
  const out = SYSTEM.clean(raw, "", st) as DesignSystem | typeof INVALID;
  if (st.errors.length || out === INVALID) throw new DesignValidationError(st.errors);
  const s = out;
  if (FONTS[s.typography.mono].category !== "mono") { st.note("typography.mono", `${s.typography.mono} isn't a monospace font; using JetBrains Mono`); s.typography.mono = "JetBrains Mono"; }
  const c = s.colors;
  const fixed = ensureReadable(c.text, [c.background, c.surface]);
  if (fixed !== c.text) { st.note("colors.text", `adjusted ${c.text} to ${fixed} so text stays readable`); c.text = fixed; }
  // Semantic colours are used for text and icons on the page too: keep them at least 3:1 against the background.
  for (const k of SEMANTIC_KEYS) {
    const f = ensureReadable(c[k], [c.background], 3);
    if (f !== c[k]) { st.note(`colors.${k}`, `adjusted ${c[k]} to ${f} for contrast`); c[k] = f; }
  }
  return s;
}

// ------------------------------------------------------------ derived tokens

/** 50…950 tints and shades of one colour (500 is the colour itself). */
export function colorScale(base: string): Record<string, string> {
  const steps: Array<[string, string, number]> = [
    ["50", "#ffffff", 0.94], ["100", "#ffffff", 0.86], ["200", "#ffffff", 0.7], ["300", "#ffffff", 0.5], ["400", "#ffffff", 0.25],
    ["500", "#ffffff", 0], ["600", "#000000", 0.14], ["700", "#000000", 0.3], ["800", "#000000", 0.45], ["900", "#000000", 0.6], ["950", "#000000", 0.72],
  ];
  return Object.fromEntries(steps.map(([k, to, w]) => [k, w ? mix(base, to, w) : base]));
}

/** A neutral ramp between the page background and the text colour (light → dark regardless of theme). */
export function neutralScale(s: DesignSystem): Record<string, string> {
  const light = relativeLuminance(s.colors.background) >= relativeLuminance(s.colors.text) ? s.colors.background : s.colors.text;
  const dark = light === s.colors.background ? s.colors.text : s.colors.background;
  const ws = [0.03, 0.07, 0.14, 0.24, 0.38, 0.52, 0.64, 0.75, 0.85, 0.92, 0.97];
  const keys = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
  return Object.fromEntries(keys.map((k, i) => [k, mix(light, dark, ws[i])]));
}

export const TYPE_STEPS: Array<[string, number]> = [["xs", -2], ["sm", -1], ["base", 0], ["lg", 1], ["xl", 2], ["2xl", 3], ["3xl", 4], ["4xl", 5], ["5xl", 6]];
export function typeScale(s: DesignSystem): Array<{ name: string; px: number; rem: string; line: number }> {
  const base = TYPE_SCALE[s.typography.scale].base;
  const r = Number(s.typography.ratio);
  return TYPE_STEPS.map(([name, n]) => {
    const px = Math.round(base * r ** n);
    return { name, px, rem: `${+(px / 16).toFixed(4)}rem`, line: n <= 0 ? TYPE_SCALE[s.typography.scale].line : n <= 2 ? 1.35 : 1.15 };
  });
}

export const SPACE_STEPS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];
export function spacingScale(s: DesignSystem): Array<{ name: string; px: number }> {
  const unit = s.layout.spacing === "compact" ? 3.5 : 4;
  return SPACE_STEPS.map((n) => ({ name: String(n), px: Math.round(n * unit) }));
}

export function radiusScale(s: DesignSystem): Record<string, string> {
  const r = RADIUS[s.shape.radius];
  if (!r.card) return { none: "0px", sm: "0px", md: "0px", lg: "0px", xl: "0px", full: "9999px" };
  const ctl = r.control >= 999 ? Math.round(r.card / 2) : r.control;
  return { none: "0px", sm: `${Math.max(2, Math.round(ctl / 2))}px`, md: `${ctl}px`, lg: `${r.card}px`, xl: `${Math.round(r.card * 1.5)}px`, full: "9999px" };
}

export function shadowScale(s: DesignSystem): Record<string, string> {
  const p = s.colors.primary;
  const [r, g, b] = hexToRgb(p);
  const dark = relativeLuminance(s.colors.background) < 0.2;
  const a = (x: number) => (dark ? Math.min(0.85, x * 1.8) : x);
  switch (s.shape.shadow) {
    case "none": return { sm: "none", md: "none", lg: "none" };
    case "glow": return { sm: `0 0 0 1px rgba(${r}, ${g}, ${b}, 0.35)`, md: `0 0 18px -4px rgba(${r}, ${g}, ${b}, 0.5), 0 0 0 1px rgba(${r}, ${g}, ${b}, 0.3)`, lg: `0 0 36px -6px rgba(${r}, ${g}, ${b}, 0.6), 0 0 0 1px rgba(${r}, ${g}, ${b}, 0.35)` };
    case "strong": return { sm: `0 2px 6px rgba(0, 0, 0, ${a(0.18)})`, md: `0 12px 32px -10px rgba(0, 0, 0, ${a(0.45)})`, lg: `0 24px 60px -20px rgba(0, 0, 0, ${a(0.6)})` };
    default: return { sm: `0 1px 3px rgba(0, 0, 0, ${a(0.08)})`, md: `0 10px 30px -12px rgba(0, 0, 0, ${a(0.3)})`, lg: `0 20px 50px -18px rgba(0, 0, 0, ${a(0.4)})` };
  }
}

/** Everything an export or the docs page needs, computed once. */
export function derive(s: DesignSystem) {
  const c = s.colors;
  return {
    onPrimary: onColor(c.primary), onSecondary: onColor(c.secondary), onAccent: onColor(c.accent),
    muted: ensureReadable(mix(c.text, c.background, 0.38), [c.background, c.surface]),
    border: mix(c.background, c.text, 0.14), borderStrong: mix(c.background, c.text, 0.28),
    primaryScale: colorScale(c.primary), secondaryScale: colorScale(c.secondary), accentScale: colorScale(c.accent), neutral: neutralScale(s),
    type: typeScale(s), space: spacingScale(s), radius: radiusScale(s), shadow: shadowScale(s),
  };
}

// --------------------------------------------------------- systems ⇄ designs

/** The tokens of a design become a system (no model needed). */
export function systemFromDesign(design: Design, name?: string): DesignSystem {
  return validateSystem({
    name: (name ?? `${design.name} system`).slice(0, 60),
    description: `Tokens taken from the “${design.name}” design.`,
    colors: { ...design.theme },
    typography: { heading: design.typography.heading, body: design.typography.body, scale: design.typography.scale },
    shape: { ...design.style }, layout: { spacing: design.layout.spacing, max_width: design.layout.max_width },
  });
}

/** A design restyled with a system's tokens (content and structure untouched). The caller validates the result. */
export function applySystemToDesign(design: Design, s: DesignSystem): Design {
  const copy = structuredClone(design);
  copy.theme = Object.fromEntries(ROLE_KEYS.map((k) => [k, s.colors[k]])) as Design["theme"];
  copy.typography = { heading: s.typography.heading, body: s.typography.body, scale: s.typography.scale };
  copy.style = { ...s.shape };
  copy.layout = { ...copy.layout, spacing: s.layout.spacing, max_width: s.layout.max_width };
  return copy;
}

/** What the design agent is told when a design follows a system. */
export function systemBrief(s: DesignSystem): string {
  const c = s.colors;
  return [
    `Follow the design system "${s.name}"${s.description ? ` (${s.description})` : ""}.`,
    `Colours: background ${c.background}, surface ${c.surface}, primary ${c.primary}, secondary ${c.secondary}, accent ${c.accent}, text ${c.text}.`,
    `Fonts: ${s.typography.heading} for headings, ${s.typography.body} for body (${s.typography.scale} scale). Corners: ${s.shape.radius}; shadows: ${s.shape.shadow}; spacing: ${s.layout.spacing}.`,
    s.voice.tone ? `Voice: ${s.voice.tone}.` : "",
    s.voice.principles.length ? `Writing principles: ${s.voice.principles.join("; ")}.` : "",
    s.guidelines.length ? `Guidelines: ${s.guidelines.map((g) => `${g.title}: do ${g.do}${g.dont ? `; don't ${g.dont}` : ""}`).join(" | ")}.` : "",
  ].filter(Boolean).join(" ");
}

// -------------------------------------------------------- evidence from sources

export interface ColorHit { hex: string; count: number; names: string[] }
export interface Evidence {
  colors: ColorHit[];
  fonts: Array<{ family: string; count: number }>;
  radii: number[];
  themeColor?: string;
  title?: string;
  description?: string;
  host?: string;
  /** Free text the user added (screenshot notes). */
  notes?: string;
}

const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000" };
const GENERIC_FONTS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "inherit", "initial", "unset", "-apple-system", "blinkmacsystemfont", "segoe ui", "roboto", "helvetica", "helvetica neue", "arial", "apple color emoji", "segoe ui emoji", "noto color emoji", "emoji", "math"]);

function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Any CSS colour literal we understand → #rrggbb, with its alpha (0–1). */
export function parseCssColor(raw: string): { hex: string; alpha: number } | null {
  const v = raw.trim().toLowerCase();
  if (NAMED[v]) return { hex: NAMED[v], alpha: 1 };
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let d = m[1];
    if (d.length === 3 || d.length === 4) d = [...d].map((x) => x + x).join("");
    if (d.length !== 6 && d.length !== 8) return null;
    return { hex: "#" + d.slice(0, 6), alpha: d.length === 8 ? parseInt(d.slice(6), 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)%?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const ch = [m[1], m[2], m[3]].map(Number) as RGB;
    const alpha = m[4] ? (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : Number(m[4])) : 1;
    return ch.every((x) => x >= 0 && x <= 255) ? { hex: rgbToHex(ch), alpha } : null;
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const alpha = m[4] ? (m[4].endsWith("%") ? parseFloat(m[4]) / 100 : Number(m[4])) : 1;
    return { hex: rgbToHex(hslToRgb(Number(m[1]) % 360, Math.min(1, Number(m[2]) / 100), Math.min(1, Number(m[3]) / 100))), alpha };
  }
  return null;
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^()]{5,60}\)|hsla?\([^()]{5,60}\)/g;

export function emptyEvidence(): Evidence { return { colors: [], fonts: [], radii: [] }; }

function addColor(ev: Evidence, raw: string, weight = 1, name?: string) {
  const c = parseCssColor(raw);
  if (!c || c.alpha < 0.5) return;
  let hit = ev.colors.find((x) => x.hex === c.hex);
  if (!hit) { hit = { hex: c.hex, count: 0, names: [] }; ev.colors.push(hit); }
  hit.count += weight;
  if (name && !hit.names.includes(name) && hit.names.length < 6) hit.names.push(name);
}

/** Collect colours (with the custom-property names that hold them), font families and corner radii from CSS. */
export function analyzeCss(css: string, ev: Evidence): Evidence {
  const text = css.slice(0, 1_500_000).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of text.matchAll(/--([\w-]{1,60})\s*:\s*([^;{}]{1,120})/g)) {
    const name = m[1].toLowerCase();
    for (const c of m[2].match(COLOR_RE) ?? []) addColor(ev, c, 3, name);
    const bare = /^\s*(white|black)\s*$/.exec(m[2]);
    if (bare) addColor(ev, bare[1], 3, name);
  }
  for (const m of text.matchAll(/(?:^|[;{\s])(color|background(?:-color)?|border(?:-color)?|fill|stroke|outline-color)\s*:\s*([^;{}]{1,200})/g)) {
    const weight = m[1].startsWith("background") ? 2 : 1;
    for (const c of m[2].match(COLOR_RE) ?? []) addColor(ev, c, weight);
  }
  for (const m of text.matchAll(/font-family\s*:\s*([^;{}]{1,200})/g)) {
    const first = m[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).find((x) => x && !x.startsWith("var(") && !GENERIC_FONTS.has(x.toLowerCase()));
    if (!first) continue;
    const hit = ev.fonts.find((f) => f.family.toLowerCase() === first.toLowerCase());
    if (hit) hit.count++; else if (ev.fonts.length < 30) ev.fonts.push({ family: first.slice(0, 60), count: 1 });
  }
  for (const m of text.matchAll(/border-radius\s*:\s*([\d.]+)(px|rem)/g)) {
    const px = m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
    if (px < 200 && ev.radii.length < 400) ev.radii.push(px);
  }
  return ev;
}

const attr = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(2, 4).find((x) => x !== undefined);

/** Title, description, theme colour, inline styles, Google Fonts and the stylesheet URLs to fetch next. */
export function analyzeHtml(html: string, base: URL, ev: Evidence): { stylesheets: string[] } {
  const h = html.slice(0, 2_000_000);
  ev.host = base.hostname;
  ev.title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(h)?.[1]?.replace(/\s+/g, " ").trim();
  const stylesheets: string[] = [];
  for (const m of h.matchAll(/<meta\b[^>]*>/gi)) {
    const name = (attr(m[0], "name") ?? attr(m[0], "property") ?? "").toLowerCase();
    const content = attr(m[0], "content");
    if (!content) continue;
    if (name === "theme-color") { const c = parseCssColor(content); if (c) { ev.themeColor = c.hex; addColor(ev, content, 6, "theme-color"); } }
    if ((name === "description" || name === "og:description") && !ev.description) ev.description = content.replace(/\s+/g, " ").trim().slice(0, 300);
  }
  for (const m of h.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], "rel") ?? "").toLowerCase();
    const href = attr(m[0], "href");
    if (!href || !rel.includes("stylesheet")) continue;
    try {
      const u = new URL(href.replace(/&amp;/g, "&"), base);
      if (u.hostname === "fonts.googleapis.com") {
        for (const fam of u.searchParams.getAll("family")) {
          const family = fam.split(":")[0].replace(/\+/g, " ").trim();
          if (family) ev.fonts.push({ family, count: 5 });
        }
      } else if ((u.protocol === "https:" || u.protocol === "http:") && stylesheets.length < 6) stylesheets.push(u.toString());
    } catch { /* bad href */ }
  }
  for (const m of h.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) analyzeCss(m[1], ev);
  let inline = 0;
  for (const m of h.matchAll(/\sstyle\s*=\s*"([^"]{1,400})"/gi)) { if (++inline > 400) break; analyzeCss(`x{${m[1]}}`, ev); }
  return { stylesheets };
}

// ----------------------------------------------------- evidence → a system

const hueOf = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((x) => x / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const hueGap = (a: string, b: string) => { const d = Math.abs(hueOf(a) - hueOf(b)) % 360; return Math.min(d, 360 - d); };
const named = (ev: Evidence, re: RegExp) => ev.colors.filter((c) => c.names.some((n) => re.test(n))).sort((a, b) => b.count - a.count)[0]?.hex;

const SERIF_HINT = /serif|garamond|georgia|times|playfair|merriweather|lora|fraunces|caslon|baskerville|tiempos|freight|canela|libre/i;
const MONO_HINT = /mono|code|consol|courier|menlo/i;
const DISPLAY_HINT = /display|grotesk|syne|orbitron|clash|cabinet|satoshi|general sans|space/i;

/** The closest font we're allowed to use for a site's font. */
export function closestFont(family: string | undefined, role: "heading" | "body"): string {
  if (!family) return role === "heading" ? "Plus Jakarta Sans" : "Inter";
  const hit = FONT_NAMES.find((f) => f.toLowerCase() === family.toLowerCase());
  if (hit) return hit;
  if (MONO_HINT.test(family)) return "JetBrains Mono";
  if (SERIF_HINT.test(family)) return role === "heading" ? "Playfair Display" : "Source Serif 4";
  if (/grotesk/i.test(family)) return "Space Grotesk";
  if (DISPLAY_HINT.test(family) && role === "heading") return "Sora";
  if (/geist|helvetica|neue|sf pro|-apple-system|system/i.test(family)) return "Inter";
  return role === "heading" ? "Plus Jakarta Sans" : "Inter";
}

/** A sensible system from evidence alone: used when no model is available or its answer doesn't validate. */
export function systemFromEvidence(ev: Evidence, name?: string): DesignSystem {
  const colors = [...ev.colors].sort((a, b) => b.count - a.count);
  // HSL saturation explodes near white and black, so "neutral" is judged by chroma (max − min channel) instead.
  const chromaOf = (hex: string) => { const ch = hexToRgb(hex); return (Math.max(...ch) - Math.min(...ch)) / 255; };
  const neutrals = colors.filter((c) => chromaOf(c.hex) < 0.1 || relativeLuminance(c.hex) > 0.93 || relativeLuminance(c.hex) < 0.01);
  const chroma = colors.filter((c) => !neutrals.includes(c));
  const extreme = (c: ColorHit) => relativeLuminance(c.hex) > 0.8 || relativeLuminance(c.hex) < 0.03;
  const background = named(ev, /^(bg|background|color-bg|colors?-background|page|body-bg|base-100)$|(^|-)(bg|background)(-default|-primary|-page|-base)?$/) ?? neutrals.find(extreme)?.hex ?? "#ffffff";
  const textCands = neutrals.filter((c) => contrastRatio(c.hex, background) >= 4.5);
  const text = named(ev, /^(text|fg|foreground|color-text|body-color|text-primary|base-content)$|(^|-)(text|fg|foreground)(-default|-primary)?$/) ?? textCands[0]?.hex ?? onColor(background);
  const surfaceCand = neutrals.find((c) => c.hex !== background && contrastRatio(c.hex, background) < 1.35 && c.hex !== text);
  const surface = named(ev, /(^|-)(surface|card|panel|muted-bg|bg-subtle|bg-secondary)$/) ?? surfaceCand?.hex ?? mix(background, text, 0.04);
  const usable = (c: ColorHit) => contrastRatio(c.hex, background) >= 1.8;
  const primary = named(ev, /(^|-)(primary|brand|accent-primary|main)(-500|-600|-default)?$/) ?? (ev.themeColor && saturation(ev.themeColor) > 0.2 ? ev.themeColor : undefined) ?? chroma.find(usable)?.hex ?? "#4f46e5";
  const secondary = named(ev, /(^|-)(secondary)(-500|-default)?$/) ?? chroma.find((c) => usable(c) && hueGap(c.hex, primary) > 25)?.hex ?? mix(primary, text, 0.35);
  const accent = named(ev, /(^|-)(accent|highlight|tertiary)(-500|-default)?$/) ?? chroma.find((c) => usable(c) && hueGap(c.hex, primary) > 25 && hueGap(c.hex, secondary) > 25)?.hex ?? mix(primary, "#ffffff", 0.35);
  const fonts = [...ev.fonts].sort((a, b) => b.count - a.count);
  const radii = [...ev.radii].sort((a, b) => a - b);
  const median = radii.length ? radii[Math.floor(radii.length / 2)] : 8;
  const radius = median <= 0.5 ? "none" : median <= 5 ? "sm" : median <= 10 ? "md" : median <= 18 ? "lg" : "xl";
  const dark = relativeLuminance(background) < 0.2;
  const title = (name ?? ev.title ?? ev.host ?? "Imported").split(/[|–—:·-]/)[0].trim().slice(0, 48) || "Imported";
  return validateSystem({
    name: name ?? `${title} system`,
    description: (ev.description ?? (ev.host ? `Extracted from ${ev.host}.` : "Extracted from an image.")).slice(0, 300),
    colors: { background, surface, primary, secondary, accent, text },
    typography: { heading: closestFont(fonts[0]?.family, "heading"), body: closestFont(fonts[1]?.family ?? fonts[0]?.family, "body"), scale: "normal", ratio: "1.25" },
    shape: { radius, shadow: dark ? "strong" : "soft" },
    layout: { spacing: "comfortable", max_width: "1200px" },
  });
}

/** Compact, model-friendly summary of the evidence (the model never sees raw page text). */
export function evidenceSummary(ev: Evidence): string {
  const colors = [...ev.colors].sort((a, b) => b.count - a.count).slice(0, 24)
    .map((c) => `${c.hex} ×${Math.round(c.count)}${c.names.length ? ` (${c.names.join(", ")})` : ""} lum ${relativeLuminance(c.hex).toFixed(2)} sat ${saturation(c.hex).toFixed(2)}`);
  const fonts = [...ev.fonts].sort((a, b) => b.count - a.count).slice(0, 6).map((f) => `${f.family} ×${f.count}`);
  const radii = [...ev.radii].sort((a, b) => a - b);
  return [
    ev.host ? `Site: ${ev.host}` : "Source: an image's palette",
    ev.title ? `Title: ${ev.title}` : "",
    ev.description ? `Description: ${ev.description}` : "",
    ev.themeColor ? `theme-color: ${ev.themeColor}` : "",
    `Colours by usage:\n  ${colors.join("\n  ") || "(none found)"}`,
    fonts.length ? `Fonts by usage: ${fonts.join(", ")}` : "",
    radii.length ? `Corner radii (px): median ${radii[Math.floor(radii.length / 2)]}, range ${radii[0]}–${radii[radii.length - 1]}` : "",
    ev.notes ? `Notes from the user: ${ev.notes}` : "",
  ].filter(Boolean).join("\n");
}

// ------------------------------------------------------------ the model

const EXAMPLE = {
  name: "Harbor", description: "Calm, trustworthy fintech brand for freelancers.",
  colors: { background: "#f7f8fb", surface: "#ffffff", primary: "#2f5bea", secondary: "#0e9f9a", accent: "#f5a524", text: "#0f172a", success: "#16a34a", warning: "#d97706", danger: "#dc2626", info: "#2563eb" },
  typography: { heading: "Manrope", body: "Inter", mono: "JetBrains Mono", scale: "normal", ratio: "1.25" },
  shape: { radius: "lg", shadow: "soft" }, layout: { spacing: "comfortable", max_width: "1200px" },
  voice: { tone: "Clear, warm and precise; never salesy", principles: ["Lead with the benefit", "Use numbers, not adjectives", "Short sentences"] },
  guidelines: [{ title: "Primary actions", do: "Use one primary button per view", dont: "Put two primary buttons side by side" }],
};

const RULES = `- Reply with ONE JSON object and nothing else: {"summary": "<one sentence>", "system": {...}}. No markdown, no code fences.
- Colours are #rrggbb. "text" must be readable on both "background" and "surface" (aim for 7:1). primary/secondary/accent must be distinct and usable as button fills.
- success/warning/danger/info are semantic colours that fit the palette (green/amber/red/blue families).
- Fonts must come from this list: ${FONT_NAMES.join(", ")}. "mono" must be a monospace one (JetBrains Mono, IBM Plex Mono, Space Mono).
- Write the voice and guidelines for THIS brand: concrete, short, no filler.`;

function systemPrompt(task: string): string {
  return `You are Morphie's design-system designer. ${task}\n\n${RULES}\n\nSchema:\n${describeSystem()}\n\nExample reply:\n${JSON.stringify({ summary: "A calm, trustworthy fintech system.", system: EXAMPLE })}`;
}

export class SystemGenerationError extends Error {}

/** Ask the model for a system; repair once with the full list of problems; return notes from validation. */
export async function generateSystem(provider: Provider, task: string, user: string, opts: { signal?: AbortSignal; base?: DesignSystem } = {}): Promise<{ system: DesignSystem; summary: string; notes: string[] }> {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(task) }, { role: "user", content: user }];
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await provider.chat({ messages, signal: opts.signal, temperature: 0.4 });
    const text = r.content ?? "";
    try {
      const obj = extractJsonObject(text);
      const raw = (obj.system && typeof obj.system === "object" ? obj.system : obj) as Record<string, unknown>;
      // Fill what the model left out from the evidence-based draft, so a partial answer still helps.
      const merged = opts.base ? { ...opts.base, ...raw, colors: { ...opts.base.colors, ...(raw.colors as object ?? {}) }, typography: { ...opts.base.typography, ...(raw.typography as object ?? {}) } } : raw;
      const notes: string[] = [];
      const system = validateSystem(merged, notes);
      const summary = typeof obj.summary === "string" ? obj.summary.replace(/\s+/g, " ").trim().slice(0, 200) : `Created ${system.name}.`;
      return { system, summary, notes };
    } catch (e) {
      lastErrors = e instanceof DesignValidationError ? e.errors : [e instanceof Error ? e.message : "The reply wasn't valid JSON."];
      messages.push({ role: "assistant", content: text.slice(0, 20_000) }, { role: "user", content: `That didn't validate. Fix every problem and reply with the complete JSON again:\n- ${lastErrors.slice(0, 20).join("\n- ")}` });
    }
  }
  throw new SystemGenerationError(`The model couldn't produce a valid design system (${lastErrors.slice(0, 3).join("; ") || "no usable reply"}).`);
}

export const SYSTEM_TASKS = {
  prompt: "Create a complete design system from the user's description of a brand or product.",
  evidence: "Create a design system that faithfully captures the brand in this evidence (colours and fonts measured from a real website or an image). Assign the measured colours to the right roles; map fonts to the closest allowed ones; infer the voice from the title and description.",
};

export { shortRepr };
