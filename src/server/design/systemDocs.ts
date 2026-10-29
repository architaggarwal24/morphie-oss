/**
 * The living documentation page of a design system: colour roles and ramps with contrast scores, type specimens and
 * scale, spacing, radii, elevation, core components, the page patterns (rendered with Morphie's own component
 * library in the system's tokens), voice and guidelines. A self-contained HTML document with a strict CSP and no
 * scripts, shown in the same sandboxed iframe as design previews.
 */
import { COMPONENTS } from "./components";
import { ConcreteCtx, escapeHtml, toHtml } from "./nodes";
import { renderCss } from "./renderer";
import { validateDesign, type Design } from "./schema";
import { applySystemToDesign, derive, ROLE_KEYS, SEMANTIC_KEYS, type DesignSystem } from "./system";
import { contrastRatio, googleFontsUrl, fontStack, mix, onColor } from "./themes";

const e = (s: string) => escapeHtml(s, false);
const a = (s: string) => escapeHtml(s);

/** A small sample site in the system's tokens, used for the "Patterns" section. */
function sampleDesign(s: DesignSystem): Design {
  const brand = s.name.replace(/\s*(design\s*)?system$/i, "").trim() || "Acme";
  const base = {
    name: s.name, theme: {}, typography: {}, style: {}, layout: {}, responsive: { tablet_columns: 2, mobile_columns: 1, mobile_nav: "collapse" },
    sections: [
      { type: "navbar", brand, links: [{ label: "Features" }, { label: "Pricing" }, { label: "FAQ" }], cta: "Get started" },
      { type: "hero", badge: "New in 2026", title: `${brand}, designed with intent`, subtitle: s.description || "Every colour, font and corner on this page comes from the design system.", cta: "Get started", secondary_cta: "Learn more", layout: "split", size: "md" },
      { type: "features", title: "Built from the tokens", subtitle: "Components inherit colour, type, radius and elevation.", columns: 3, items: [
        { title: "Consistent", body: "One source of truth for every screen.", icon: "layers" },
        { title: "Accessible", body: "Text colours are checked for contrast.", icon: "shield" },
        { title: "Portable", body: "Export to CSS, Tailwind, tokens or React.", icon: "sparkles" }] },
      { type: "pricing", title: "Pricing", tiers: [
        { name: "Starter", price: "$0", period: "/month", features: ["1 project", "Community support"], cta: "Start free" },
        { name: "Pro", price: "$24", period: "/month", features: ["Unlimited projects", "Priority support"], cta: "Upgrade", highlighted: true }] },
      { type: "testimonials", title: "What people say", items: [{ quote: "Our product finally looks like one product.", name: "Maya Chen", role: "Design lead" }, { quote: "Shipping new pages takes hours, not weeks.", name: "Leo Park", role: "Engineer" }] },
      { type: "cta", title: "Ready when you are", subtitle: "Start with the system, ship with confidence.", cta: "Get started" },
      { type: "footer", brand, tagline: s.voice.tone || "Made with care.", columns: [{ title: "Product", links: ["Features", "Pricing"] }, { title: "Company", links: ["About", "Contact"] }], copyright: `© 2026 ${brand}` },
    ],
  };
  const d = applySystemToDesign(base as unknown as Design, s);
  return validateDesign(d);
}

function grade(ratio: number): string {
  return ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA large" : "Fail";
}

function swatch(role: string, hex: string, s: DesignSystem): string {
  const onBg = contrastRatio(hex, s.colors.background);
  const fg = onColor(hex);
  const inner = contrastRatio(fg, hex);
  return `<figure class="ds-swatch"><div class="ds-swatch__chip" style="background:${a(hex)};color:${fg}"><span>Aa</span><small>${grade(inner)} ${inner.toFixed(1)}</small></div>
<figcaption><b>${e(role)}</b><code>${e(hex)}</code><span class="ds-muted">${onBg.toFixed(1)}:1 on background</span></figcaption></figure>`;
}

function ramp(name: string, scale: Record<string, string>): string {
  return `<div class="ds-ramp"><div class="ds-ramp__label">${e(name)}</div><div class="ds-ramp__row">${Object.entries(scale).map(([k, v]) =>
    `<div class="ds-ramp__step" style="background:${a(v)};color:${onColor(v)}" title="${a(`${name}-${k} ${v}`)}"><span>${e(k)}</span><code>${e(v.slice(1))}</code></div>`).join("")}</div></div>`;
}

const DOCS_CSS = `
.ds{font-family:var(--mf-font-body);color:var(--mf-text);background:var(--mf-bg);-webkit-font-smoothing:antialiased;line-height:1.55}
.ds *{box-sizing:border-box}
.ds-wrap{max-width:1120px;margin:0 auto;padding:56px clamp(20px,4vw,48px) 80px}
.ds-hero{padding:64px 0 40px;border-bottom:1px solid var(--mf-border)}
.ds-kicker{display:inline-flex;gap:8px;align-items:center;font:600 12px/1 var(--ds-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--mf-primary)}
.ds-kicker i{width:8px;height:8px;border-radius:99px;background:var(--mf-primary);box-shadow:0 0 0 4px var(--mf-tint)}
.ds h1,.ds h2,.ds h3{font-family:var(--mf-font-heading);font-weight:var(--mf-heading-weight);letter-spacing:-.02em;margin:0;color:var(--mf-text)}
.ds-hero h1{font-size:clamp(40px,6vw,72px);line-height:1.02;margin-top:18px}
.ds-hero p{max-width:640px;margin:18px 0 0;font-size:18px;color:var(--mf-muted)}
.ds-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px}
.ds-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--mf-border);border-radius:999px;font-size:13px;background:var(--mf-surface)}
.ds-chip i{width:12px;height:12px;border-radius:99px;display:inline-block}
.ds-sec{padding:56px 0 8px}
.ds-sec>h2{font-size:28px}
.ds-sec>.ds-lead{margin:8px 0 28px;color:var(--mf-muted);max-width:640px}
.ds-num{font:500 12px/1 var(--ds-mono);color:var(--mf-muted);margin-right:10px}
.ds-muted{color:var(--mf-muted)}
.ds code{font-family:var(--ds-mono);font-size:12px}
.ds-grid{display:grid;gap:16px}
.ds-g3{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.ds-g2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.ds-card{background:var(--mf-surface);border:1px solid var(--mf-border);border-radius:var(--mf-radius);padding:20px;box-shadow:var(--ds-shadow-sm)}
.ds-swatch{margin:0;background:var(--mf-surface);border:1px solid var(--mf-border);border-radius:var(--mf-radius);overflow:hidden}
.ds-swatch__chip{height:92px;display:flex;align-items:flex-end;justify-content:space-between;padding:12px;font-family:var(--mf-font-heading);font-size:22px;font-weight:600}
.ds-swatch__chip small{font:600 11px/1 var(--ds-mono);opacity:.85}
.ds-swatch figcaption{display:grid;gap:2px;padding:10px 12px;font-size:13px}
.ds-swatch figcaption b{text-transform:capitalize}
.ds-ramp{margin-top:14px}
.ds-ramp__label{font:600 12px/1 var(--ds-mono);text-transform:uppercase;letter-spacing:.06em;color:var(--mf-muted);margin-bottom:8px}
.ds-ramp__row{display:grid;grid-template-columns:repeat(11,1fr);border-radius:var(--mf-radius-ctl);overflow:hidden;border:1px solid var(--mf-border)}
.ds-ramp__step{height:64px;padding:8px 6px;display:flex;flex-direction:column;justify-content:space-between;font:600 11px/1 var(--ds-mono)}
.ds-ramp__step code{font-size:9.5px;opacity:.8}
.ds-type-row{display:grid;grid-template-columns:120px 1fr;gap:20px;align-items:baseline;padding:14px 0;border-bottom:1px solid var(--mf-border)}
.ds-type-row:last-child{border-bottom:0}
.ds-type-meta{font:12px/1.4 var(--ds-mono);color:var(--mf-muted)}
.ds-specimen{font-size:56px;line-height:1.05}
.ds-specimen.ds-h{font-family:var(--mf-font-heading);font-weight:var(--mf-heading-weight);letter-spacing:-.02em}
.ds-specimen.ds-b{font-family:var(--mf-font-body)}
.ds-specimen.ds-m{font-family:var(--ds-mono);font-size:40px}
.ds-alpha{margin-top:10px;font-size:15px;color:var(--mf-muted);letter-spacing:.02em;word-break:break-all}
.ds-space{display:flex;align-items:center;gap:14px;padding:6px 0;font:12px var(--ds-mono);color:var(--mf-muted)}
.ds-space i{display:block;height:12px;background:var(--mf-primary);border-radius:3px;opacity:.85}
.ds-space b{width:40px;color:var(--mf-text)}
.ds-radius{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:14px}
.ds-radius div{height:84px;border:2px solid var(--mf-primary);background:var(--mf-tint);display:grid;place-items:end start;padding:8px;font:11px var(--ds-mono)}
.ds-elev{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:24px}
.ds-elev div{height:110px;background:var(--mf-surface);border:1px solid var(--mf-border);border-radius:var(--mf-radius);display:grid;place-items:center;font:12px var(--ds-mono);color:var(--mf-muted)}
.ds-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.ds-btn{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:var(--mf-radius-ctl);font:600 14px/1 var(--mf-font-body);border:1px solid transparent}
.ds-btn--primary{background:var(--mf-primary);color:var(--mf-on-primary);box-shadow:var(--ds-shadow-sm)}
.ds-btn--secondary{background:var(--mf-surface);color:var(--mf-text);border-color:var(--mf-border-strong)}
.ds-btn--ghost{background:transparent;color:var(--mf-primary)}
.ds-btn--danger{background:var(--ds-danger);color:var(--ds-on-danger)}
.ds-btn--sm{padding:8px 12px;font-size:13px}
.ds-btn--lg{padding:14px 24px;font-size:16px}
.ds-btn[disabled]{opacity:.45}
.ds-field{display:grid;gap:6px;font-size:13px;font-weight:600}
.ds-input{width:100%;padding:11px 14px;border-radius:var(--mf-radius-ctl);border:1px solid var(--mf-border-strong);background:var(--mf-bg);color:var(--mf-text);font:400 14px var(--mf-font-body)}
.ds-input--focus{border-color:var(--mf-primary);box-shadow:0 0 0 4px var(--mf-tint)}
.ds-input--error{border-color:var(--ds-danger)}
.ds-help{font-weight:400;font-size:12px;color:var(--mf-muted)}
.ds-help--error{color:var(--ds-danger)}
.ds-badge{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;font:600 12px/1 var(--mf-font-body)}
.ds-alert{display:grid;grid-template-columns:auto 1fr;gap:12px;padding:14px 16px;border-radius:var(--mf-radius-ctl);border:1px solid;font-size:14px}
.ds-alert b{display:block;margin-bottom:2px}
.ds-dot{width:10px;height:10px;border-radius:99px;margin-top:6px}
.ds-toggle{width:44px;height:26px;border-radius:99px;background:var(--mf-primary);position:relative;display:inline-block}
.ds-toggle::after{content:"";position:absolute;top:3px;right:3px;width:20px;height:20px;border-radius:99px;background:var(--mf-on-primary)}
.ds-toggle--off{background:var(--mf-border-strong)}
.ds-toggle--off::after{left:3px;right:auto;background:var(--mf-surface)}
.ds-tabs{display:inline-flex;gap:4px;padding:4px;border-radius:calc(var(--mf-radius-ctl) + 4px);background:var(--mf-tint)}
.ds-tabs span{padding:8px 14px;border-radius:var(--mf-radius-ctl);font-size:13px;font-weight:600;color:var(--mf-muted)}
.ds-tabs span.on{background:var(--mf-surface);color:var(--mf-text);box-shadow:var(--ds-shadow-sm)}
.ds-pattern{margin-top:22px;border:1px solid var(--mf-border);border-radius:calc(var(--mf-radius) + 6px);overflow:hidden;box-shadow:var(--ds-shadow-md)}
.ds-pattern__bar{display:flex;align-items:center;gap:6px;padding:10px 14px;border-bottom:1px solid var(--mf-border);background:var(--mf-surface);font:12px var(--ds-mono);color:var(--mf-muted)}
.ds-pattern__bar i{width:9px;height:9px;border-radius:99px;background:var(--mf-border-strong)}
.ds-pattern__bar span{margin-left:8px}
.ds-voice{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:16px}
.ds-voice li{list-style:none;padding:14px 16px;border-left:3px solid var(--mf-primary);background:var(--mf-surface);border-radius:0 var(--mf-radius-ctl) var(--mf-radius-ctl) 0}
.ds-voice{padding:0}
.ds-dd{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
.ds-do,.ds-dont{padding:12px 14px;border-radius:var(--mf-radius-ctl);font-size:14px}
.ds-do{background:color-mix(in srgb,var(--ds-success) 12%,transparent);border:1px solid color-mix(in srgb,var(--ds-success) 40%,transparent)}
.ds-dont{background:color-mix(in srgb,var(--ds-danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--ds-danger) 35%,transparent)}
.ds-do b{color:var(--ds-success)}.ds-dont b{color:var(--ds-danger)}
.ds-foot{margin-top:72px;padding-top:24px;border-top:1px solid var(--mf-border);font-size:13px;color:var(--mf-muted)}
@media (max-width:700px){.ds-type-row{grid-template-columns:1fr}.ds-ramp__row{grid-template-columns:repeat(6,1fr)}.ds-dd{grid-template-columns:1fr}.ds-specimen{font-size:40px}}
`;

export function renderSystemDocs(s: DesignSystem): string {
  const d = derive(s);
  const design = sampleDesign(s);
  const c = s.colors;
  const fontsUrl = googleFontsUrl([s.typography.heading, s.typography.body, s.typography.mono]);
  const csp = `default-src 'none'; style-src 'unsafe-inline'${fontsUrl ? " https://fonts.googleapis.com; font-src https://fonts.gstatic.com" : ""}; img-src data:; base-uri 'none'; form-action 'none'`;
  const vars = [
    `--ds-mono:${fontStack(s.typography.mono)}`, `--ds-shadow-sm:${d.shadow.sm}`, `--ds-shadow-md:${d.shadow.md}`, `--ds-shadow-lg:${d.shadow.lg}`,
    ...SEMANTIC_KEYS.map((k) => `--ds-${k}:${c[k]}`), `--ds-on-danger:${onColor(c.danger)}`,
  ].join(";");
  const sec = (n: number, id: string, title: string, lead: string, body: string) => `<section class="ds-sec" id="${id}"><h2><span class="ds-num">${String(n).padStart(2, "0")}</span>${e(title)}</h2><p class="ds-lead">${e(lead)}</p>${body}</section>`;

  const colorsHtml = `<div class="ds-grid ds-g3">${ROLE_KEYS.map((k) => swatch(k, c[k], s)).join("")}</div>
<h3 style="margin-top:28px;font-size:16px">Semantic</h3><div class="ds-grid ds-g3" style="margin-top:12px">${SEMANTIC_KEYS.map((k) => swatch(k, c[k], s)).join("")}</div>
${ramp("primary", d.primaryScale)}${ramp("secondary", d.secondaryScale)}${ramp("accent", d.accentScale)}${ramp("neutral", d.neutral)}`;

  const typeHtml = `<div class="ds-grid ds-g2">
<div class="ds-card"><div class="ds-type-meta">Headings · ${e(s.typography.heading)}</div><div class="ds-specimen ds-h">Aa Gg 123</div><div class="ds-alpha" style="font-family:var(--mf-font-heading)">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz</div></div>
<div class="ds-card"><div class="ds-type-meta">Body · ${e(s.typography.body)}</div><div class="ds-specimen ds-b">Aa Gg 123</div><div class="ds-alpha">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz</div></div>
<div class="ds-card"><div class="ds-type-meta">Code · ${e(s.typography.mono)}</div><div class="ds-specimen ds-m">{ a: 1 }</div><div class="ds-alpha" style="font-family:var(--ds-mono)">const ratio = ${e(s.typography.ratio)};</div></div>
</div>
<div class="ds-card" style="margin-top:16px">${[...d.type].reverse().map((t) =>
    `<div class="ds-type-row"><div class="ds-type-meta">${e(t.name)}<br>${t.px}px · ${e(t.rem)}</div><div style="font-size:${t.px}px;line-height:${t.line};${t.px >= 24 ? "font-family:var(--mf-font-heading);font-weight:var(--mf-heading-weight);letter-spacing:-.015em" : ""}">${t.px >= 24 ? "Design with intent" : "The quick brown fox jumps over the lazy dog."}</div></div>`).join("")}</div>`;

  const spaceHtml = `<div class="ds-grid ds-g2"><div class="ds-card">${d.space.filter((x) => x.px > 0).map((x) => `<div class="ds-space"><b>${e(x.name)}</b><i style="width:${x.px}px"></i>${x.px}px</div>`).join("")}</div>
<div><div class="ds-radius">${Object.entries(d.radius).map(([k, v]) => `<div style="border-radius:${a(v === "9999px" ? "999px" : v)}">${e(k)} · ${e(v)}</div>`).join("")}</div>
<div class="ds-elev" style="margin-top:24px">${Object.entries(d.shadow).map(([k, v]) => `<div style="box-shadow:${a(v)}">shadow-${e(k)}</div>`).join("")}</div></div></div>`;

  const badge = (k: string) => `<span class="ds-badge" style="background:${mix(c.background, c[k as keyof typeof c], 0.16)};color:${c[k as keyof typeof c]}">${e(k.charAt(0).toUpperCase() + k.slice(1))}</span>`;
  const alert = (k: (typeof SEMANTIC_KEYS)[number], title: string, body: string) =>
    `<div class="ds-alert" style="background:${mix(c.background, c[k], 0.08)};border-color:${mix(c.background, c[k], 0.4)}"><span class="ds-dot" style="background:${c[k]}"></span><div><b>${e(title)}</b><span class="ds-muted">${e(body)}</span></div></div>`;
  const compsHtml = `<div class="ds-grid ds-g2">
<div class="ds-card"><div class="ds-type-meta" style="margin-bottom:14px">Buttons</div>
<div class="ds-row"><span class="ds-btn ds-btn--primary">Primary</span><span class="ds-btn ds-btn--secondary">Secondary</span><span class="ds-btn ds-btn--ghost">Ghost</span><span class="ds-btn ds-btn--danger">Delete</span></div>
<div class="ds-row" style="margin-top:12px"><span class="ds-btn ds-btn--primary ds-btn--sm">Small</span><span class="ds-btn ds-btn--primary ds-btn--lg">Large</span><span class="ds-btn ds-btn--primary" disabled>Disabled</span></div></div>
<div class="ds-card"><div class="ds-type-meta" style="margin-bottom:14px">Inputs</div>
<div class="ds-grid" style="gap:12px"><label class="ds-field">Email<span class="ds-input">ada@example.com</span></label>
<label class="ds-field">Focused<span class="ds-input ds-input--focus">Typing…</span></label>
<label class="ds-field">With error<span class="ds-input ds-input--error">not-an-email</span><span class="ds-help ds-help--error">Enter a valid email address.</span></label></div></div>
<div class="ds-card"><div class="ds-type-meta" style="margin-bottom:14px">Badges, toggles &amp; tabs</div>
<div class="ds-row">${SEMANTIC_KEYS.map(badge).join("")}${badge("primary")}</div>
<div class="ds-row" style="margin-top:16px"><span class="ds-toggle"></span><span class="ds-toggle ds-toggle--off"></span><span class="ds-tabs"><span class="on">Overview</span><span>Activity</span><span>Settings</span></span></div></div>
<div class="ds-card"><div class="ds-type-meta" style="margin-bottom:14px">Alerts</div>
<div class="ds-grid" style="gap:10px">${alert("success", "Saved", "Your changes are live.")}${alert("warning", "Almost full", "You've used 90% of your storage.")}${alert("danger", "Payment failed", "Update your card to keep your plan.")}${alert("info", "Heads up", "A new version is available.")}</div></div>
</div>`;

  const pattern = (type: string, label: string) => {
    const section = design.sections.find((x) => x.type === type);
    if (!section) return "";
    return `<div class="ds-pattern"><div class="ds-pattern__bar"><i></i><i></i><i></i><span>${e(label)}</span></div><div class="mf-page mf-nav-collapse">${toHtml(COMPONENTS[type].build(new ConcreteCtx(section)))}</div></div>`;
  };
  const patternsHtml = [["navbar", "Navbar"], ["hero", "Hero"], ["features", "Feature grid"], ["pricing", "Pricing"], ["testimonials", "Testimonials"], ["cta", "Call to action"], ["footer", "Footer"]].map(([t, l]) => pattern(t, l)).join("");

  const voiceHtml = (s.voice.tone || s.voice.principles.length || s.guidelines.length) ? `${s.voice.tone ? `<p style="font-size:22px;font-family:var(--mf-font-heading);max-width:760px;margin:0">“${e(s.voice.tone)}”</p>` : ""}
${s.voice.principles.length ? `<ul class="ds-voice">${s.voice.principles.map((p, i) => `<li><span class="ds-num">${String(i + 1).padStart(2, "0")}</span>${e(p)}</li>`).join("")}</ul>` : ""}
${s.guidelines.map((g) => `<div class="ds-card" style="margin-top:16px"><h3 style="font-size:17px">${e(g.title)}</h3><div class="ds-dd"><div class="ds-do"><b>Do</b><br>${e(g.do)}</div>${g.dont ? `<div class="ds-dont"><b>Don't</b><br>${e(g.dont)}</div>` : ""}</div></div>`).join("")}` : `<p class="ds-muted">No voice or guidelines yet.</p>`;

  const head = [
    '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${a(csp)}">`, `<title>${e(s.name)}</title>`,
    fontsUrl ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${a(fontsUrl)}">` : "",
    `<style>\n${renderCss(design, true)}\n:root{${vars}}\n${DOCS_CSS}</style>`,
  ].filter(Boolean).join("\n");

  const body = `<div class="ds"><div class="ds-wrap">
<header class="ds-hero"><span class="ds-kicker"><i></i>Design system</span><h1>${e(s.name)}</h1>${s.description ? `<p>${e(s.description)}</p>` : ""}
<div class="ds-chips">${ROLE_KEYS.slice(2, 5).map((k) => `<span class="ds-chip"><i style="background:${c[k]}"></i>${e(k)}</span>`).join("")}<span class="ds-chip">${e(s.typography.heading)} / ${e(s.typography.body)}</span><span class="ds-chip">radius ${e(s.shape.radius)}</span><span class="ds-chip">${e(s.layout.spacing)}</span></div></header>
${sec(1, "color", "Color", "Six roles carry the brand; four semantic colours carry meaning. Ramps give hover, pressed and subtle states.", colorsHtml)}
${sec(2, "type", "Typography", `A ${s.typography.ratio} modular scale from a ${d.type.find((t) => t.name === "base")!.px}px base.`, typeHtml)}
${sec(3, "space", "Space, shape & elevation", "Spacing steps, corner radii and shadow levels.", spaceHtml)}
${sec(4, "components", "Components", "Core controls in the system's tokens.", compsHtml)}
${sec(5, "patterns", "Patterns", "Page sections from Morphie's component library, rendered with this system.", patternsHtml)}
${sec(6, "voice", "Voice & guidelines", "How the brand sounds, and rules for using the system.", voiceHtml)}
<footer class="ds-foot">${e(s.name)} · generated by Morphie · ${ROLE_KEYS.length + SEMANTIC_KEYS.length} colour roles · ${d.type.length} type steps</footer>
</div></div>`;
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n${head}\n</head>\n<body style="margin:0">\n${body}\n</body>\n</html>\n`;
}
