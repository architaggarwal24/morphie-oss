import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The stylesheet is part of the app's behaviour: Tailwind 4 changed several defaults that the UI silently relied on,
 * and the fixes live in src/app/globals.css. These tests compile that file exactly as Next does and check the fixes
 * are still there, so a tidy-up or an upgrade can't quietly shift layouts.
 */
let css = "";
beforeAll(async () => {
  const file = path.resolve("src/app/globals.css");
  css = (await postcss([tailwind()]).process(fs.readFileSync(file, "utf8"), { from: file })).css;
}, 60_000);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out); else if (/\.tsx$/.test(e.name)) out.push(f);
  }
  return out;
};
const components = walk("src/components");

describe("space-y-* keeps its Tailwind 3 behaviour", () => {
  it("is margin-top on every later sibling, with enough specificity to beat a child's own margin", async () => {
    expect(css).toMatch(/\.space-y-3 > :not\(\[hidden\]\) ~ :not\(\[hidden\]\) \{\s*margin-top: calc\(var\(--spacing\) \* 3\);\s*margin-bottom: 0;/);
  });

  it("every size the components use exists", async () => {
    const used = new Set(components.flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/\bspace-y-([\d.]+)/g)].map((m) => m[1])));
    expect(used.size).toBeGreaterThan(5);
    for (const n of used) expect(css, `space-y-${n}`).toContain(`.space-y-${n.replace(".", "\\.")} > :not([hidden]) ~ :not([hidden])`);
  });

  it("cancels Tailwind 4's own rule for the first child, and comes after it so it wins", async () => {
    const builtIn = css.indexOf(":where(.space-y-3 > :not(:last-child))");
    const cancel = css.indexOf(':where([class*="space-y-"] > :first-child:not(:last-child))');
    expect(builtIn, "Tailwind's built-in space-y rule moved or was removed: re-check the compat block in globals.css").toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(builtIn);
  });
});

describe("base defaults keep the look the app had on Tailwind 3", () => {
  it("text sizes carry absolute line-heights, so nested smaller text keeps its line height", async () => {
    // Tailwind only emits the sizes the components use, so check exactly those against Tailwind 3's values.
    const v3 = { xs: "1rem", sm: "1.25rem", base: "1.5rem", lg: "1.75rem", xl: "1.75rem", "2xl": "2rem", "3xl": "2.25rem", "4xl": "2.5rem" } as Record<string, string>;
    const used = new Set(components.flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl)\b/g)].map((m) => m[1])));
    expect(used.size).toBeGreaterThan(4);
    for (const name of used) expect(css, `--text-${name}--line-height`).toContain(`--text-${name}--line-height: ${v3[name]};`);
  });

  it("buttons show the pointer cursor, borders default to grey, placeholders to grey-400", async () => {
    expect(css).toMatch(/button:not\(:disabled\), \[role="button"\]:not\(:disabled\) \{\s*cursor: pointer;/);
    expect(css).toMatch(/border-color: var\(--color-gray-200, currentcolor\);/);
    expect(css).toMatch(/input::placeholder, textarea::placeholder \{\s*color: var\(--color-gray-400\);/);
  });

  it("the design tokens that used to live in tailwind.config.ts are all present", async () => {
    for (const c of ["bg", "panel", "raised", "sunken", "line", "fg", "muted", "faint", "accent", "accent-fg", "ok", "warn", "err", "info"]) {
      expect(css, `colour ${c}`).toMatch(new RegExp(`\\.(?:bg|text|border)-${c}\\b`));
    }
    expect(css).toContain("--radius-xl: 14px");
    expect(css).toContain("--radius-2xl: 20px");
    expect(css).toMatch(/\.shadow-pop \{\s*--tw-shadow: 0 12px 40px -12px var\(--tw-shadow-color, rgb\(0 0 0 \/ 0\.35\)\), 0 0 0 1px var\(--tw-shadow-color, rgb\(var\(--line\)\)\);/);
    expect(css).toContain("@keyframes rise");
    expect(css).toMatch(/\.animate-rise \{\s*animation: var\(--animate-rise\)/);
    expect(fs.existsSync("tailwind.config.ts")).toBe(false);
  });
});

describe("renamed utilities mean what the old names meant", () => {
  const rule = (sel: string) => new RegExp(`${sel.replace(/[.\\/]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  it("shadow-xs is Tailwind 3's shadow-sm, shadow-sm is Tailwind 3's shadow", async () => {
    if (components.some((f) => /\bshadow-xs\b/.test(fs.readFileSync(f, "utf8")))) expect(rule(".shadow-xs")).toContain("0 1px 2px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.05))");
    // Tailwind only emits utilities that are used; check shadow-sm's meaning only while some component still uses it.
    if (components.some((f) => /\bshadow-sm\b/.test(fs.readFileSync(f, "utf8")))) expect(rule(".shadow-sm")).toContain("0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1))");
  });
  it("backdrop-blur-sm is 8px, as backdrop-blur was", async () => {
    // Only meaningful while some component still uses it (Tailwind emits used utilities only).
    if (!components.some((f) => /\bbackdrop-blur-sm\b/.test(fs.readFileSync(f, "utf8")))) return;
    expect(css).toContain("--blur-sm: 8px;");
    expect(rule(".backdrop-blur-sm")).toContain("--tw-backdrop-blur: blur(var(--blur-sm))");
  });
  it("gradients still interpolate in sRGB, as they did in Tailwind 3", async () => {
    expect(rule(".bg-linear-to-r\\/srgb")).toContain("to right in srgb");
  });
  it("components use none of the old names", async () => {
    const src = components.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(src).not.toMatch(/outline-none|bg-gradient-to-/);
  });
});

describe("a caller's override can never lose to a component's default", () => {
  // Input/Select/Textarea apply their defaults (h-10, text-sm) and then the caller's className, with no class merging. Which of
  // two conflicting utilities wins is then decided by stylesheet order, which differs between Tailwind versions. So callers
  // that change the height must say so with an important modifier, and must not pass a size the default already beats.
  const calls = components.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").map((line, i) => ({ f, i: i + 1, line })))
    .filter(({ line }) => /<(Input|Select|Textarea)\b/.test(line) && /className="/.test(line));
  it("finds the call sites", async () => expect(calls.length).toBeGreaterThan(10));
  it("a height override is important (h-9!)", async () => {
    for (const { f, i, line } of calls) for (const m of line.matchAll(/className="([^"]*)"/g)) for (const t of m[1].split(/\s+/)) if (/^h-\d/.test(t)) expect(t, `${f}:${i}`).toMatch(/!$/);
  });
  it("nobody passes a text size that the default would silently beat", async () => {
    for (const { f, i, line } of calls) expect(line, `${f}:${i}`).not.toMatch(/className="[^"]*\btext-\[\d+px\]/);
  });
});

describe("UX polish in the stylesheet", () => {
  it("numbers that change in place (tables, counters) use tabular figures", async () => {
    expect(css).toMatch(/\.md table \{\s*font-variant-numeric: tabular-nums;/);
    expect(css).toMatch(/\.tabular-nums \{[^}]*tabular-nums/);
  });
});

describe("text wrapping", () => {
  it("headings balance and paragraphs wrap prettily, in the base layer so truncate still wins", async () => {
    expect(css).toMatch(/h1, h2, h3, h4, h5, h6, \[role="heading"\] \{\s*text-wrap: balance;/);
    expect(css).toMatch(/p, li, dd, blockquote, figcaption \{\s*text-wrap: pretty;/);
    // Cascade layers rank by declaration order (theme, base, components, utilities), so a base rule always loses to `truncate`.
    expect(css).toMatch(/@layer theme, base, components, utilities;/);
    const at = css.indexOf("h1, h2, h3, h4, h5, h6, [role=\"heading\"]");
    const layer = css.lastIndexOf("@layer ", at);
    expect(css.slice(layer, layer + 12)).toBe("@layer base ");
  });
});

describe("continuous corners", () => {
  it("rounded surfaces get corner-shape: squircle next to their radius, and pills stay round", async () => {
    expect(css).toMatch(/:where\(\.rounded-md, \.rounded-lg, \.rounded-xl, \.rounded-2xl\) \{\s*corner-shape: squircle;/);
    expect(css).not.toMatch(/rounded-full[^{]*\{[^}]*corner-shape/);
  });
});

describe("safe areas", () => {
  it("exposes the insets and the *-safe utilities the edge-pinned UI uses", async () => {
    expect(css).toMatch(/--safe-bottom: env\(safe-area-inset-bottom, 0px\)/);
    expect(css).toMatch(/\.pt-safe \{\s*padding-top: var\(--safe-top\);/);
    expect(css).toMatch(/\.pb-safe \{\s*padding-bottom: var\(--safe-bottom\);/);
    expect(css).toMatch(/\.h-\\\[calc\\\(4rem_\\\+_var\\\(--safe-bottom\\\)\\\)\\\] \{\s*height: calc\(4rem \+ var\(--safe-bottom\)\);/);
  });
  it("the page opts into edge-to-edge drawing", async () => {
    expect(fs.readFileSync("src/app/layout.tsx", "utf8")).toContain('viewportFit: "cover"');
  });
});

describe("touch targets", () => {
  it("on touch screens (pointer: coarse) controls grow to at least 44px", async () => {
    const at = css.indexOf(".pointer-coarse\\:min-h-11 {");
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(css.lastIndexOf("@media", at), at)).toContain("@media (pointer: coarse)");
    expect(css.slice(at, at + 80)).toContain("min-height: calc(var(--spacing) * 11)");
  });

  it("every button or link drawn smaller than 44px (size-6 to size-9) also grows on touch screens", async () => {
    const offenders: string[] = [];
    for (const f of components) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/<(button|a)\b[^>]*?className=(?:\{cn\()?"([^"]*)"/g)) {
        const cls = m[2];
        if (/(?:^|\s)size-[6-9](?:\s|$)/.test(cls) && !/pointer-coarse:(?:size|min-h)-11/.test(cls)) offenders.push(`${path.basename(f)}: ${cls}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("interruptible motion", () => {
  it("menus, toasts and dialogs animate with transitions that can reverse mid-way, not keyframes", async () => {
    expect(css).toMatch(/\.pop \{\s*transition: opacity 140ms var\(--ease-out\), translate 240ms var\(--ease-spring\), scale 240ms var\(--ease-spring\), display 240ms allow-discrete;/);
    expect(css).toMatch(/@starting-style \{\s*\.pop \{/);
    expect(css).toMatch(/\.pop\[hidden\] \{\s*opacity: 0;/);
    for (const f of ["src/components/ui.tsx", "src/components/Toasts.tsx", "src/components/chat/ProviderChip.tsx"]) {
      expect(fs.readFileSync(f, "utf8"), f).not.toContain("animate-rise\", width"); // dialog panel
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/(shadow-pop animate-rise|bg-black\/50 animate-rise)/);
    }
    const menus = fs.readFileSync("src/components/design/DesignView.tsx", "utf8");
    expect(menus.match(/hidden=\{!open\} inert=\{!open\} className="pop/g)).toHaveLength(5); // theme, version, system menus, the new-design system chip and the skills chip stay mounted
  });
  it("reduced motion still cuts every transition", async () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration: 0\.01ms !important/);
  });
});

describe("view transitions", () => {
  it("are under 300ms, click-through, and off with reduced motion", async () => {
    expect(css).toMatch(/::view-transition \{\s*pointer-events: none;/);
    expect(css).toMatch(/::view-transition-new\(\*\) \{\s*animation-duration: 180ms;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*::view-transition-group\(\*\), ::view-transition-old\(\*\), ::view-transition-new\(\*\) \{\s*animation: none !important;/);
  });
});
