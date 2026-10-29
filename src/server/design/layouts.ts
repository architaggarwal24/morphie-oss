import { rgba } from "./themes";

export const SECTION_TYPES = ["navbar", "hero", "features", "cards", "testimonials", "pricing", "faq", "cta", "footer"] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export const SPACING: Record<string, { section_y: number; gap: number }> = {
  compact: { section_y: 3.5, gap: 1.0 }, comfortable: { section_y: 5.5, gap: 1.5 }, spacious: { section_y: 8.0, gap: 2.0 },
};
export const RADIUS: Record<string, { card: number; control: number }> = {
  none: { card: 0, control: 0 }, sm: { card: 6, control: 4 }, md: { card: 12, control: 8 }, lg: { card: 18, control: 12 }, xl: { card: 28, control: 999 },
};
export const SHADOWS = ["none", "soft", "strong", "glow"] as const;

export function shadowCss(name: string, primary: string): string {
  const table: Record<string, string> = {
    none: "none",
    soft: "0 10px 30px -12px rgba(0, 0, 0, 0.35)",
    strong: "0 24px 60px -20px rgba(0, 0, 0, 0.6)",
    glow: `0 0 28px -4px ${rgba(primary, 0.55)}, 0 0 0 1px ${rgba(primary, 0.35)}`,
  };
  return table[name];
}

export const TYPE_SCALE: Record<string, { base: number; line: number }> = {
  compact: { base: 15, line: 1.55 }, normal: { base: 16, line: 1.6 }, large: { base: 18, line: 1.65 },
};
export const HERO_SIZES: Record<string, { h1_min: number; h1_vw: number; h1_max: number; pad_y: number }> = {
  md: { h1_min: 2.0, h1_vw: 5.0, h1_max: 3.0, pad_y: 4.5 },
  lg: { h1_min: 2.4, h1_vw: 6.5, h1_max: 4.2, pad_y: 6.5 },
  xl: { h1_min: 2.8, h1_vw: 9.0, h1_max: 5.8, pad_y: 8.5 },
};
export const HERO_LAYOUTS = ["centered", "split"] as const;
export const MAX_WIDTH_RANGE: [number, number] = [640, 1600];
export const DEFAULT_LAYOUT = { max_width: "1200px", spacing: "comfortable" };
export const DEFAULT_STYLE = { radius: "lg", shadow: "soft" };
export const TABLET_MAX = 1023;
export const MOBILE_MAX = 639;
export const DEVICE_WIDTHS = { desktop: 1280, tablet: 768, mobile: 390 } as const;
export const TABLET_COLUMNS = [1, 2, 3];
export const MOBILE_COLUMNS = [1, 2];
export const MOBILE_NAV = ["collapse", "stack"] as const;
export const DEFAULT_RESPONSIVE = { tablet_columns: 2, mobile_columns: 1, mobile_nav: "collapse" };

export const ARCHETYPES: Record<string, { description: string; sections: SectionType[] }> = {
  landing: { description: "Single-purpose marketing page for one product, event, or idea.", sections: ["navbar", "hero", "features", "testimonials", "cta", "footer"] },
  saas: { description: "Full SaaS marketing site with pricing and answers to common questions.", sections: ["navbar", "hero", "features", "testimonials", "pricing", "faq", "cta", "footer"] },
  portfolio: { description: "Personal or studio portfolio: projects as cards, kind words, a way to get in touch.", sections: ["navbar", "hero", "cards", "testimonials", "cta", "footer"] },
  dashboard: { description: "Product or analytics overview approximated with the available components: metric tiles are cards with a `stat`, modules are feature items.", sections: ["navbar", "hero", "cards", "features", "footer"] },
};
