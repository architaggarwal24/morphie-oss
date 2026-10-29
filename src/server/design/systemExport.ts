/**
 * Design system exports: CSS custom properties, Tailwind (v4 @theme and a v3 config), W3C Design Tokens JSON,
 * and a small React component kit. Values come from a validated system, so they are plain hex colours, allowlisted
 * font stacks and computed numbers: nothing here can inject code.
 */
import type { ExportFile } from "./renderer";
import { slugify } from "./schema";
import { derive, ROLE_KEYS, SEMANTIC_KEYS, type DesignSystem } from "./system";
import { fontStack, googleFontsUrl } from "./themes";

export const SYSTEM_EXPORTS = ["css", "tailwind", "tokens", "react"] as const;
export type SystemExport = (typeof SYSTEM_EXPORTS)[number];

/** Every token as [css-variable-name-without-dashes, value], in a stable order. */
export function flatTokens(s: DesignSystem): Array<[string, string]> {
  const d = derive(s);
  const out: Array<[string, string]> = [];
  for (const k of [...ROLE_KEYS, ...SEMANTIC_KEYS]) out.push([`color-${k}`, s.colors[k]]);
  out.push(["color-on-primary", d.onPrimary], ["color-on-secondary", d.onSecondary], ["color-on-accent", d.onAccent], ["color-muted", d.muted], ["color-border", d.border], ["color-border-strong", d.borderStrong]);
  for (const [name, scale] of [["primary", d.primaryScale], ["secondary", d.secondaryScale], ["accent", d.accentScale], ["neutral", d.neutral]] as const) {
    for (const [k, v] of Object.entries(scale)) out.push([`color-${name}-${k}`, v]);
  }
  out.push(["font-heading", fontStack(s.typography.heading)], ["font-body", fontStack(s.typography.body)], ["font-mono", fontStack(s.typography.mono)]);
  for (const t of d.type) out.push([`text-${t.name}`, t.rem]);
  for (const t of d.type) out.push([`leading-${t.name}`, String(t.line)]);
  for (const x of d.space) out.push([`space-${x.name}`, `${x.px / 16}rem`]);
  for (const [k, v] of Object.entries(d.radius)) out.push([`radius-${k}`, v]);
  for (const [k, v] of Object.entries(d.shadow)) out.push([`shadow-${k}`, v]);
  out.push(["container-max", s.layout.max_width]);
  return out;
}

export function cssVariables(s: DesignSystem): string {
  const fonts = googleFontsUrl([s.typography.heading, s.typography.body, s.typography.mono]);
  return `/* ${s.name} design system, exported from Morphie. */\n${fonts ? `@import url("${fonts}");\n\n` : ""}:root {\n${flatTokens(s).map(([k, v]) => `  --${k}: ${v};`).join("\n")}\n}\n`;
}

/** Tailwind v4: tokens in @theme become utilities (bg-primary, text-2xl, rounded-lg, font-heading…). */
export function tailwindV4(s: DesignSystem): string {
  const t = flatTokens(s).filter(([k]) => !k.startsWith("space-") && !k.startsWith("leading-") && k !== "container-max");
  const fonts = googleFontsUrl([s.typography.heading, s.typography.body, s.typography.mono]);
  return `/* ${s.name} for Tailwind CSS v4. Import this after "tailwindcss". */\n${fonts ? `@import url("${fonts}");\n` : ""}@import "tailwindcss";\n\n@theme {\n${t.map(([k, v]) => `  --${k}: ${v};`).join("\n")}\n  --spacing: ${derive(s).space[1].px / 16}rem;\n  --container-site: ${s.layout.max_width};\n}\n`;
}

/** Tailwind v3: the same tokens as a config object. */
export function tailwindV3(s: DesignSystem): string {
  const d = derive(s);
  const colors: Record<string, unknown> = {};
  for (const k of [...ROLE_KEYS, ...SEMANTIC_KEYS]) colors[k] = s.colors[k];
  colors.primary = { DEFAULT: s.colors.primary, ...d.primaryScale };
  colors.secondary = { DEFAULT: s.colors.secondary, ...d.secondaryScale };
  colors.accent = { DEFAULT: s.colors.accent, ...d.accentScale };
  colors.neutral = d.neutral;
  Object.assign(colors, { muted: d.muted, border: d.border, "on-primary": d.onPrimary });
  const config = {
    theme: {
      extend: {
        colors,
        fontFamily: { heading: fontStack(s.typography.heading).split(", ").map((x) => x.replace(/"/g, "")), body: fontStack(s.typography.body).split(", ").map((x) => x.replace(/"/g, "")), mono: fontStack(s.typography.mono).split(", ").map((x) => x.replace(/"/g, "")) },
        fontSize: Object.fromEntries(d.type.map((t) => [t.name, [t.rem, { lineHeight: String(t.line) }]])),
        borderRadius: d.radius,
        boxShadow: d.shadow,
        maxWidth: { site: s.layout.max_width },
      },
    },
  };
  return `/** ${s.name} for Tailwind CSS v3: merge into your tailwind.config.js. */\n/** @type {import('tailwindcss').Config} */\nexport default ${JSON.stringify(config, null, 2)};\n`;
}

/** W3C Design Tokens Community Group format. */
export function tokensJson(s: DesignSystem): string {
  const d = derive(s);
  const color = (v: string, desc?: string) => ({ $type: "color", $value: v, ...(desc ? { $description: desc } : {}) });
  const tokens = {
    $description: `${s.name} design system${s.description ? `: ${s.description}` : ""}`,
    color: {
      ...Object.fromEntries([...ROLE_KEYS, ...SEMANTIC_KEYS].map((k) => [k, color(s.colors[k])])),
      "on-primary": color(d.onPrimary), muted: color(d.muted), border: color(d.border),
      scale: Object.fromEntries((["primary", "secondary", "accent", "neutral"] as const).map((n) => [n, Object.fromEntries(Object.entries(n === "neutral" ? d.neutral : d[`${n}Scale`]).map(([k, v]) => [k, color(v)]))])),
    },
    font: {
      family: { heading: { $type: "fontFamily", $value: fontStack(s.typography.heading).split(", ").map((x) => x.replace(/"/g, "")) }, body: { $type: "fontFamily", $value: fontStack(s.typography.body).split(", ").map((x) => x.replace(/"/g, "")) }, mono: { $type: "fontFamily", $value: fontStack(s.typography.mono).split(", ").map((x) => x.replace(/"/g, "")) } },
      size: Object.fromEntries(d.type.map((t) => [t.name, { $type: "dimension", $value: t.rem }])),
      lineHeight: Object.fromEntries(d.type.map((t) => [t.name, { $type: "number", $value: t.line }])),
    },
    space: Object.fromEntries(d.space.map((x) => [x.name, { $type: "dimension", $value: `${x.px}px` }])),
    radius: Object.fromEntries(Object.entries(d.radius).map(([k, v]) => [k, { $type: "dimension", $value: v }])),
    shadow: Object.fromEntries(Object.entries(d.shadow).map(([k, v]) => [k, { $type: "shadow", $value: v }])),
    $extensions: { "app.morphie": { voice: s.voice, guidelines: s.guidelines, typography: { scale: s.typography.scale, ratio: s.typography.ratio }, shape: s.shape, layout: s.layout } },
  };
  return JSON.stringify(tokens, null, 2) + "\n";
}

// ----------------------------------------------------------------- React kit

const KIT_CSS = `
.ds-root{font-family:var(--font-body);color:var(--color-text);background:var(--color-background);line-height:1.55;-webkit-font-smoothing:antialiased}
.ds-root h1,.ds-root h2,.ds-root h3{font-family:var(--font-heading);letter-spacing:-.015em;line-height:1.15}
.ds-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;padding:.7rem 1.15rem;border:1px solid transparent;border-radius:var(--radius-md);font:600 var(--text-sm)/1 var(--font-body);cursor:pointer;transition:transform .15s ease,background-color .15s ease,box-shadow .15s ease;text-decoration:none}
.ds-btn:hover{transform:translateY(-1px)}
.ds-btn:active{transform:translateY(0) scale(.98)}
.ds-btn:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
.ds-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.ds-btn--primary{background:var(--color-primary);color:var(--color-on-primary);box-shadow:var(--shadow-sm)}
.ds-btn--primary:hover{background:var(--color-primary-600)}
.ds-btn--secondary{background:var(--color-surface);color:var(--color-text);border-color:var(--color-border-strong)}
.ds-btn--secondary:hover{background:var(--color-neutral-100)}
.ds-btn--ghost{background:transparent;color:var(--color-primary)}
.ds-btn--ghost:hover{background:var(--color-primary-50)}
.ds-btn--danger{background:var(--color-danger);color:#fff}
.ds-btn--sm{padding:.5rem .8rem;font-size:var(--text-xs)}
.ds-btn--lg{padding:.9rem 1.5rem;font-size:var(--text-base)}
.ds-field{display:grid;gap:.375rem;font-size:var(--text-sm);font-weight:600}
.ds-input{width:100%;padding:.7rem .9rem;border-radius:var(--radius-md);border:1px solid var(--color-border-strong);background:var(--color-background);color:var(--color-text);font:400 var(--text-sm) var(--font-body);transition:border-color .15s ease,box-shadow .15s ease}
.ds-input:focus{outline:none;border-color:var(--color-primary);box-shadow:0 0 0 4px var(--color-primary-100)}
.ds-input[aria-invalid="true"]{border-color:var(--color-danger)}
.ds-hint{font-weight:400;font-size:var(--text-xs);color:var(--color-muted)}
.ds-hint--error{color:var(--color-danger)}
.ds-card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:var(--space-6);box-shadow:var(--shadow-sm)}
.ds-card h3{margin:0 0 .4rem;font-size:var(--text-lg)}
.ds-badge{display:inline-flex;align-items:center;padding:.25rem .65rem;border-radius:var(--radius-full);font:600 var(--text-xs)/1 var(--font-body);background:var(--color-primary-100);color:var(--color-primary-700)}
.ds-badge--success{background:color-mix(in srgb,var(--color-success) 15%,transparent);color:var(--color-success)}
.ds-badge--warning{background:color-mix(in srgb,var(--color-warning) 15%,transparent);color:var(--color-warning)}
.ds-badge--danger{background:color-mix(in srgb,var(--color-danger) 15%,transparent);color:var(--color-danger)}
.ds-badge--info{background:color-mix(in srgb,var(--color-info) 15%,transparent);color:var(--color-info)}
.ds-alert{display:grid;grid-template-columns:auto 1fr;gap:.75rem;padding:.9rem 1rem;border-radius:var(--radius-md);border:1px solid;font-size:var(--text-sm)}
.ds-alert__dot{width:.6rem;height:.6rem;border-radius:999px;margin-top:.4rem}
.ds-alert strong{display:block;margin-bottom:.1rem}
${SEMANTIC_KEYS.map((k) => `.ds-alert--${k}{background:color-mix(in srgb,var(--color-${k}) 8%,var(--color-background));border-color:color-mix(in srgb,var(--color-${k}) 40%,transparent)}.ds-alert--${k} .ds-alert__dot{background:var(--color-${k})}`).join("\n")}
`;

const KIT_COMPONENTS: ExportFile[] = [
  { path: "src/components/Button.jsx", content: `export function Button({ variant = "primary", size = "md", className = "", ...props }) {\n  const cls = ["ds-btn", \`ds-btn--\${variant}\`, size !== "md" && \`ds-btn--\${size}\`, className].filter(Boolean).join(" ");\n  return <button className={cls} {...props} />;\n}\n` },
  { path: "src/components/Input.jsx", content: `import { useId } from "react";\n\nexport function Input({ label, hint, error, id, ...props }) {\n  const auto = useId();\n  const inputId = id ?? auto;\n  return (\n    <label className="ds-field" htmlFor={inputId}>\n      {label}\n      <input id={inputId} className="ds-input" aria-invalid={error ? "true" : undefined} aria-describedby={hint || error ? \`\${inputId}-hint\` : undefined} {...props} />\n      {(hint || error) && <span id={\`\${inputId}-hint\`} className={error ? "ds-hint ds-hint--error" : "ds-hint"}>{error || hint}</span>}\n    </label>\n  );\n}\n` },
  { path: "src/components/Card.jsx", content: `export function Card({ title, children, className = "", ...props }) {\n  return (\n    <section className={\`ds-card \${className}\`.trim()} {...props}>\n      {title && <h3>{title}</h3>}\n      {children}\n    </section>\n  );\n}\n` },
  { path: "src/components/Badge.jsx", content: `export function Badge({ tone, children }) {\n  return <span className={tone ? \`ds-badge ds-badge--\${tone}\` : "ds-badge"}>{children}</span>;\n}\n` },
  { path: "src/components/Alert.jsx", content: `export function Alert({ tone = "info", title, children }) {\n  return (\n    <div className={\`ds-alert ds-alert--\${tone}\`} role={tone === "danger" ? "alert" : "status"}>\n      <span className="ds-alert__dot" aria-hidden="true" />\n      <div>{title && <strong>{title}</strong>}{children}</div>\n    </div>\n  );\n}\n` },
  { path: "src/index.js", content: `import "./tokens.css";\nimport "./components.css";\n\nexport { Alert } from "./components/Alert.jsx";\nexport { Badge } from "./components/Badge.jsx";\nexport { Button } from "./components/Button.jsx";\nexport { Card } from "./components/Card.jsx";\nexport { Input } from "./components/Input.jsx";\n` },
];

function reactKit(s: DesignSystem): ExportFile[] {
  const slug = slugify(s.name, "design-system");
  const demo = `import { createRoot } from "react-dom/client";\nimport { Alert, Badge, Button, Card, Input } from "./index.js";\n\nfunction Demo() {\n  return (\n    <main className="ds-root" style={{ maxWidth: "var(--container-max)", margin: "0 auto", padding: "var(--space-12) var(--space-6)", display: "grid", gap: "var(--space-6)" }}>\n      <h1 style={{ fontSize: "var(--text-4xl)", margin: 0 }}>${JSON.stringify(s.name).slice(1, -1)}</h1>\n      <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>\n        <Button>Primary</Button>\n        <Button variant="secondary">Secondary</Button>\n        <Button variant="ghost">Ghost</Button>\n        <Button variant="danger">Delete</Button>\n      </div>\n      <Card title="Sign up">\n        <div style={{ display: "grid", gap: "var(--space-4)" }}>\n          <Input label="Email" type="email" placeholder="ada@example.com" hint="We never share it." />\n          <Button size="lg">Create account</Button>\n        </div>\n      </Card>\n      <div style={{ display: "flex", gap: "var(--space-2)" }}><Badge>New</Badge><Badge tone="success">Live</Badge><Badge tone="warning">Beta</Badge><Badge tone="danger">Down</Badge></div>\n      <Alert tone="success" title="Saved">Your changes are live.</Alert>\n    </main>\n  );\n}\n\ncreateRoot(document.getElementById("root")).render(<Demo />);\n`;
  return [
    { path: "package.json", content: JSON.stringify({ name: `${slug}-kit`, private: true, version: "0.1.0", type: "module", scripts: { dev: "vite", build: "vite build" }, dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" }, devDependencies: { "@vitejs/plugin-react": "^4.3.1", vite: "^5.4.0" } }, null, 2) + "\n" },
    { path: "vite.config.js", content: `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [react()] });\n` },
    { path: "index.html", content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${s.name.replace(/[<>&"]/g, "")}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/demo.jsx"></script>\n  </body>\n</html>\n` },
    { path: "README.md", content: `# ${s.name} React kit\n\n${s.description}\n\n\`\`\`bash\nnpm install\nnpm run dev   # opens a demo of every component\n\`\`\`\n\nUse in your app: copy \`src/\` in, then\n\n\`\`\`jsx\nimport { Button, Card, Input, Badge, Alert } from "./design-system";\n\`\`\`\n\nAll styles come from CSS variables in \`src/tokens.css\` (change a token, every component follows). Wrap your app in an element with the \`ds-root\` class for the base typography.\n` },
    { path: "src/tokens.css", content: cssVariables(s) },
    { path: "src/components.css", content: KIT_CSS.trim() + "\n" },
    { path: "src/demo.jsx", content: demo },
    ...KIT_COMPONENTS,
  ];
}

export function exportSystem(s: DesignSystem, format: SystemExport): ExportFile[] {
  switch (format) {
    case "css": return [{ path: "tokens.css", content: cssVariables(s) }];
    case "tailwind": return [{ path: "tailwind.css", content: tailwindV4(s) }, { path: "tailwind.config.js", content: tailwindV3(s) }];
    case "tokens": return [{ path: "tokens.json", content: tokensJson(s) }];
    case "react": return reactKit(s);
  }
}

