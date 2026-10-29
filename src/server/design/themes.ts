/**
 * Colour maths, font allowlist and theme presets. Pure data + pure functions:
 * colours are plain #rrggbb, fonts come from a fixed list, every other visual
 * knob is an enum in layouts.ts. That is what makes model-generated designs safe to render.
 */

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const c = value.trim();
  if (!HEX_RE.test(c)) return null;
  let d = c.slice(1).toLowerCase();
  if (d.length === 3) d = [...d].map((ch) => ch + ch).join("");
  return "#" + d;
}

export type RGB = [number, number, number];
export const hexToRgb = (c: string): RGB => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
export const rgbToHex = (rgb: RGB): string => "#" + rgb.map((ch) => Math.max(0, Math.min(255, Math.round(ch))).toString(16).padStart(2, "0")).join("");

export function relativeLuminance(color: string): number {
  const ch = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = hexToRgb(color).map(ch);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function mix(a: string, b: string, weightB: number): string {
  const ra = hexToRgb(a), rb = hexToRgb(b);
  const w = Math.max(0, Math.min(1, weightB));
  return rgbToHex([0, 1, 2].map((i) => ra[i] * (1 - w) + rb[i] * w) as RGB);
}

export function rgba(color: string, alpha: number): string {
  const [r, g, b] = hexToRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toPrecision(6))})`;
}

export function onColor(background: string): string {
  return contrastRatio("#ffffff", background) >= contrastRatio("#000000", background) ? "#ffffff" : "#000000";
}

/** The closest readable relative of `color` on every background (smallest change that passes). */
export function ensureReadable(color: string, backgrounds: string[], minimum = 4.5): string {
  const worst = (c: string) => Math.min(...backgrounds.map((bg) => contrastRatio(c, bg)));
  if (worst(color) >= minimum) return color;
  let bestPassing: [number, string] | null = null;
  let bestEffort: [number, string] = [worst(color), color];
  for (const target of ["#ffffff", "#000000"]) {
    for (let step = 1; step <= 20; step++) {
      const weight = step / 20;
      const cand = mix(color, target, weight);
      const score = worst(cand);
      if (score > bestEffort[0]) bestEffort = [score, cand];
      if (score >= minimum) {
        if (!bestPassing || weight < bestPassing[0]) bestPassing = [weight, cand];
        break;
      }
    }
  }
  return bestPassing ? bestPassing[1] : bestEffort[1];
}

export function saturation(color: string): number {
  const [r, g, b] = hexToRgb(color).map((c) => c / 255);
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
  if (hi === lo) return 0;
  const l = (hi + lo) / 2;
  return (hi - lo) / (1 - Math.abs(2 * l - 1));
}

export function glowSource(colors: { primary: string; secondary: string; accent: string }): string {
  return [colors.primary, colors.secondary, colors.accent].reduce((best, c) => (saturation(c) > saturation(best) ? c : best));
}

export function mutedColor(text: string, background: string): string {
  for (const w of [0.38, 0.3, 0.22, 0.14, 0.06, 0]) {
    const c = mix(text, background, w);
    if (contrastRatio(c, background) >= 4.5) return c;
  }
  return text;
}

// ------------------------------------------------------------------ fonts

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const FALLBACKS: Record<string, string> = { sans: SANS, display: SANS, serif: SERIF, mono: MONO };

export interface FontInfo { family: string; category: "sans" | "serif" | "mono" | "display"; google: string | null; headingWeight: number }

const W = ":wght@400;500;600;700";
const f = (family: string, category: FontInfo["category"], google: string | null, headingWeight = 700): FontInfo => ({ family, category, google, headingWeight });

export const FONT_TABLE: FontInfo[] = [
  f("System UI", "sans", null), f("Inter", "sans", "Inter" + W), f("DM Sans", "sans", "DM Sans" + W), f("Manrope", "sans", "Manrope" + W),
  f("Plus Jakarta Sans", "sans", "Plus Jakarta Sans" + W), f("Space Grotesk", "sans", "Space Grotesk" + W), f("Sora", "sans", "Sora" + W, 600),
  f("Outfit", "sans", "Outfit" + W, 600), f("Work Sans", "sans", "Work Sans" + W, 600), f("Syne", "display", "Syne" + W), f("Orbitron", "display", "Orbitron" + W),
  f("Playfair Display", "serif", "Playfair Display" + W, 600), f("Fraunces", "serif", "Fraunces" + W, 600), f("Lora", "serif", "Lora" + W, 600),
  f("Source Serif 4", "serif", "Source Serif 4" + W, 600), f("DM Serif Display", "serif", "DM Serif Display", 400),
  f("JetBrains Mono", "mono", "JetBrains Mono" + W), f("IBM Plex Mono", "mono", "IBM Plex Mono" + W, 600), f("Space Mono", "mono", "Space Mono:wght@400;700"),
];
export const FONTS: Record<string, FontInfo> = Object.fromEntries(FONT_TABLE.map((x) => [x.family, x]));
export const FONT_NAMES = FONT_TABLE.map((x) => x.family);

export function fontStack(family: string): string {
  const info = FONTS[family];
  const fb = FALLBACKS[info.category];
  return info.google ? `"${info.family}", ${fb}` : fb;
}

/** Google Fonts stylesheet URL built only from allowlisted names. */
export function googleFontsUrl(families: string[]): string | null {
  const specs: string[] = [];
  for (const fam of families) {
    const g = FONTS[fam]?.google;
    if (g && !specs.includes(g)) specs.push(g);
  }
  if (!specs.length) return null;
  return `https://fonts.googleapis.com/css2?${specs.map((s) => "family=" + s.replace(/ /g, "+")).join("&")}&display=swap`;
}

// ---------------------------------------------------------------- presets

export const COLOR_KEYS = ["background", "surface", "primary", "secondary", "accent", "text"] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];
export type Colors = Record<ColorKey, string>;

export interface ThemePreset {
  id: string; name: string; description: string; colors: Colors;
  typography: { heading: string; body: string; scale: string };
  style: { radius: string; shadow: string };
}

const preset = (id: string, name: string, description: string, c: string[], heading: string, body: string, scale: string, radius: string, shadow: string): ThemePreset => ({
  id, name, description, colors: Object.fromEntries(COLOR_KEYS.map((k, i) => [k, c[i]])) as Colors,
  typography: { heading, body, scale }, style: { radius, shadow },
});

export const THEME_LIST: ThemePreset[] = [
  preset("minimal", "Minimal", "White space, black type, one blue accent. Flat and quiet.", ["#ffffff", "#f4f4f5", "#18181b", "#52525b", "#2563eb", "#18181b"], "Inter", "Inter", "normal", "sm", "none"),
  preset("modern-saas", "Modern SaaS", "Cool slate page, indigo actions, soft rounded cards.", ["#f8fafc", "#ffffff", "#4f46e5", "#0ea5e9", "#10b981", "#0f172a"], "Plus Jakarta Sans", "Inter", "normal", "lg", "soft"),
  preset("premium", "Premium", "Near-black with champagne gold and a high-contrast serif.", ["#0b0b0f", "#15151c", "#c9a86a", "#8e8e9c", "#e9d8b0", "#f5f2ea"], "Playfair Display", "Inter", "large", "sm", "strong"),
  preset("cyberpunk", "Cyberpunk", "Neon pink and cyan on deep violet. Sharp corners, glowing edges.", ["#0a0612", "#150d26", "#ff2a6d", "#05d9e8", "#f9f871", "#e8f0ff"], "Orbitron", "Space Grotesk", "normal", "none", "glow"),
  preset("editorial", "Editorial", "Magazine feel: large serif type, ink-black actions, no rounding.", ["#ffffff", "#f1eee8", "#141414", "#5a5a5a", "#0f766e", "#141414"], "Fraunces", "Source Serif 4", "large", "none", "none"),
  preset("soft", "Soft", "Pastel lavender and pink, very round shapes, gentle shadows.", ["#fbf8ff", "#ffffff", "#8b5cf6", "#f472b6", "#2dd4bf", "#3b3355"], "Outfit", "DM Sans", "normal", "xl", "soft"),
  preset("dark", "Dark", "Graphite interface with an indigo primary and a green accent.", ["#0f1117", "#181b24", "#6d5ef0", "#38bdf8", "#22c55e", "#e6e8ee"], "Inter", "Inter", "normal", "md", "soft"),
];
export const THEMES: Record<string, ThemePreset> = Object.fromEntries(THEME_LIST.map((t) => [t.id, t]));

export function getTheme(name: unknown): ThemePreset | null {
  if (typeof name !== "string") return null;
  let key = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (key === "saas") key = "modern-saas";
  return THEMES[key] ?? null;
}

export function applyTheme<T extends { theme: unknown; typography: unknown; style?: unknown }>(design: T, themeId: string): T {
  const p = getTheme(themeId);
  if (!p) throw new Error(`Unknown theme '${themeId}'.`);
  const copy = structuredClone(design);
  copy.theme = { ...p.colors };
  copy.typography = { ...p.typography };
  copy.style = { ...p.style };
  return copy;
}

const FILLER = new Set("please the a an use apply switch to change go with try set theme preset style look it my now and then this using on".split(" "));
const NAME_TOKENS: Record<string, string[]> = {
  minimal: ["minimal"], "modern-saas": ["modern", "saas"], premium: ["premium"], cyberpunk: ["cyberpunk"], editorial: ["editorial"], soft: ["soft"], dark: ["dark"],
};

/** "Use the Premium theme." → "premium"; anything with extra intent → null (left to the design agent). */
export function matchThemeRequest(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const remaining = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !FILLER.has(t));
  if (!remaining.length) return null;
  for (const [id, toks] of Object.entries(NAME_TOKENS)) {
    if (remaining.length === toks.length && remaining.every((t, i) => t === toks[i])) return id;
  }
  return null;
}
