import { describe, expect, it } from "vitest";
import { DesignValidationError } from "@/server/design/fields";
import { applySystemToDesign, analyzeCss, analyzeHtml, closestFont, colorScale, derive, emptyEvidence, generateSystem, parseCssColor, systemFromDesign, systemFromEvidence, SYSTEM_TASKS, validateSystem, type DesignSystem } from "@/server/design/system";
import { renderSystemDocs } from "@/server/design/systemDocs";
import { exportSystem, flatTokens } from "@/server/design/systemExport";
import { createSystem, deleteSystem, exportSystemZip, getSystem, listSystems, siteEvidence, updateSystem } from "@/server/design/systems";
import * as svc from "@/server/design/service";
import { COMPONENTS } from "@/server/design/components";
import { THEMES, contrastRatio } from "@/server/design/themes";
import { validateDesign } from "@/server/design/schema";
import { unzipSync } from "fflate";
import { testActor } from "./helpers/actor";
import { Scripted } from "./helpers/scripted";

const SYSTEM = {
  name: "Harbor", description: "Calm fintech.",
  colors: { background: "#f7f8fb", surface: "#ffffff", primary: "#2f5bea", secondary: "#0e9f9a", accent: "#f5a524", text: "#0f172a" },
  typography: { heading: "Manrope", body: "Inter" },
  voice: { tone: "Clear and warm", principles: ["Lead with the benefit"] },
  guidelines: [{ title: "Primary actions", do: "One primary button per view", dont: "Two primary buttons side by side" }],
};
const t = THEMES["modern-saas"];
const design = () => validateDesign({ name: "Site", theme: { ...t.colors }, typography: { ...t.typography }, style: { ...t.style }, sections: [COMPONENTS.navbar.example, COMPONENTS.hero.example, COMPONENTS.features.example, COMPONENTS.footer.example] });
let n = 0;
const actor = () => testActor(`ds_${++n}_abcdefghijklmnop`);

describe("design system schema", () => {
  it("fills defaults, keeps text readable and refuses unknown fonts", () => {
    const notes: string[] = [];
    const s = validateSystem({ ...SYSTEM, colors: { ...SYSTEM.colors, text: "#e5e7eb" } }, notes);
    expect(s.colors.success).toBe("#16a34a");
    expect(s.typography).toMatchObject({ mono: "JetBrains Mono", scale: "normal", ratio: "1.25" });
    expect(s.shape).toEqual({ radius: "md", shadow: "soft" });
    expect(contrastRatio(s.colors.text, s.colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(notes.some((x) => x.includes("colors.text"))).toBe(true);
    expect(() => validateSystem({ ...SYSTEM, typography: { heading: "Comic Sans", body: "Inter" } })).toThrow(DesignValidationError);
    expect(validateSystem({ ...SYSTEM, typography: { heading: "Inter", body: "Inter", mono: "Inter" } }).typography.mono).toBe("JetBrains Mono");
  });

  it("derives ramps, a modular type scale, spacing, radii and shadows", () => {
    const s = validateSystem(SYSTEM);
    const d = derive(s);
    expect(Object.keys(colorScale("#2f5bea"))).toHaveLength(11);
    expect(d.primaryScale["500"]).toBe("#2f5bea");
    expect(d.type.find((x) => x.name === "base")!.px).toBe(16);
    expect(d.type.find((x) => x.name === "lg")!.px).toBe(20);
    expect(d.radius).toMatchObject({ md: "8px", lg: "12px", full: "9999px" });
    expect(d.shadow.md).toContain("rgba");
  });

  it("round-trips with designs", () => {
    const d = design();
    const s = systemFromDesign(d);
    expect(s.colors.primary).toBe(d.theme.primary);
    const restyled = validateDesign(applySystemToDesign(d, validateSystem(SYSTEM)));
    expect(restyled.theme.primary).toBe("#2f5bea");
    expect(restyled.typography.heading).toBe("Manrope");
    expect(restyled.sections).toEqual(d.sections);
  });
});

describe("reading a brand from a site or an image", () => {
  it("parses CSS colours", () => {
    expect(parseCssColor("#abc")).toEqual({ hex: "#aabbcc", alpha: 1 });
    expect(parseCssColor("rgb(255 0 0 / 50%)")).toEqual({ hex: "#ff0000", alpha: 0.5 });
    expect(parseCssColor("hsl(0, 100%, 50%)")?.hex).toBe("#ff0000");
    expect(parseCssColor("rgba(0,0,0,.1)")?.alpha).toBeCloseTo(0.1);
    expect(parseCssColor("not a colour")).toBeNull();
  });

  it("assigns roles from custom properties, fonts and radii", () => {
    const ev = emptyEvidence();
    const { stylesheets } = analyzeHtml(`<html><head><title>Ember — Grill house</title><meta name="description" content="Wood-fired food in Leeds."><meta name="theme-color" content="#ff5a1f">
<link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600&family=Inter&display=swap"></head><body style="color:#f5f5f5"></body></html>`, new URL("https://ember.example/"), ev);
    expect(stylesheets).toEqual(["https://ember.example/app.css"]);
    analyzeCss(":root{--background:#0b0b0f;--surface:#16161c;--text:#f5f5f5;--brand:#ff5a1f;--secondary:#2dd4bf} .card{border-radius:12px;background:#16161c} .btn{background:#ff5a1f;border-radius:10px}", ev);
    const s = systemFromEvidence(ev);
    expect(s.colors).toMatchObject({ background: "#0b0b0f", surface: "#16161c", text: "#f5f5f5", primary: "#ff5a1f", secondary: "#2dd4bf" });
    expect(s.typography.heading).toBe("Playfair Display");
    expect(s.typography.body).toBe("Inter");
    expect(s.shape.radius).toBe("lg");
    expect(s.name).toBe("Ember system");
  });

  it("maps unknown fonts to the closest allowed ones", () => {
    expect(closestFont("Tiempos Headline", "heading")).toBe("Playfair Display");
    expect(closestFont("Söhne Mono", "body")).toBe("JetBrains Mono");
    expect(closestFont("Inter", "body")).toBe("Inter");
    expect(closestFont("Geist", "body")).toBe("Inter");
  });

  it("fetches a site and its stylesheets through the guarded fetcher", async () => {
    const pages: Record<string, string> = {
      "https://shop.example/": `<title>Shop</title><link rel="stylesheet" href="/s.css">`,
      "https://shop.example/s.css": ":root{--primary:#7c3aed;--bg:#ffffff;--fg:#111111}",
    };
    const fetchPage = async (u: string) => ({ url: new URL(u).toString(), status: 200, contentType: "text/html", body: pages[new URL(u).toString()] ?? "", truncated: false });
    const ev = await siteEvidence("shop.example", undefined, fetchPage as never);
    expect(ev.colors.map((c) => c.hex)).toEqual(expect.arrayContaining(["#7c3aed", "#ffffff", "#111111"]));
    await expect(siteEvidence("empty.example", undefined, (async (u: string) => ({ url: u, status: 200, contentType: "text/html", body: "<p>hi</p>", truncated: false })) as never)).rejects.toThrow(/didn't expose/);
  });
});

describe("generation with a model", () => {
  it("repairs an invalid answer once and returns a valid system", async () => {
    const p = new Scripted([{ content: JSON.stringify({ system: { ...SYSTEM, typography: { heading: "Papyrus", body: "Inter" } } }) }, { content: "```json\n" + JSON.stringify({ summary: "Harbor.", system: SYSTEM }) + "\n```" }]);
    const r = await generateSystem(p as never, SYSTEM_TASKS.prompt, "A calm fintech brand");
    expect(r.system.typography.heading).toBe("Manrope");
    expect(r.summary).toBe("Harbor.");
    expect(String(p.requests[1].messages.at(-1)!.content)).toMatch(/typography.heading/);
  });
});

describe("design systems service", () => {
  it("creates from a palette (no model needed), docs and exports it, edits and deletes it", async () => {
    const a = actor();
    const out = await createSystem(a, { from: "image", palette: [{ hex: "#101114", weight: 0.6 }, { hex: "#f4f1ea", weight: 0.2 }, { hex: "#e4572e", weight: 0.12 }, { hex: "#29335c", weight: 0.08 }], fileName: "shot.png", name: "Rust" }, null);
    expect(out.notes[0]).toMatch(/No AI provider/);
    const v = await getSystem(a, out.id);
    expect(v.name).toBe("Rust");
    expect(v.system.colors.primary).toBe("#e4572e");
    expect(v.docsHtml).toContain("Content-Security-Policy");
    expect(v.docsHtml).not.toMatch(/<script/i);
    expect(v.docsHtml).toContain("mf-hero"); // the patterns are rendered with the design components
    expect((await listSystems(a)).map((x) => x.id)).toEqual([out.id]);

    const updated = await updateSystem(a, out.id, { ...v.system, name: "Rust 2", colors: { ...v.system.colors, accent: "#ffd166" } });
    expect(updated.name).toBe("Rust 2");
    await expect(updateSystem(a, out.id, { ...v.system, colors: { ...v.system.colors, primary: "red" } })).rejects.toThrow(/hex/);

    const zip = unzipSync((await exportSystemZip(a, out.id, "react")).bytes);
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(["rust-2-react/src/tokens.css", "rust-2-react/src/components/Button.jsx", "rust-2-react/package.json"]));
    await expect(exportSystemZip(a, out.id, "sketch")).rejects.toThrow(/Unknown export/);

    // Someone else's system is a 404.
    await expect(getSystem(actor(), out.id)).rejects.toThrow(/no longer exists/);
    await deleteSystem(a, out.id);
    expect(await listSystems(a)).toEqual([]);
  });

  it("exports CSS variables, Tailwind and W3C tokens", () => {
    const s = validateSystem(SYSTEM) as DesignSystem;
    const [css] = exportSystem(s, "css");
    expect(css.content).toContain("--color-primary: #2f5bea;");
    expect(css.content).toContain("--color-primary-50:");
    expect(css.content).toContain('@import url("https://fonts.googleapis.com/css2?');
    const tw = exportSystem(s, "tailwind");
    expect(tw.map((f) => f.path)).toEqual(["tailwind.css", "tailwind.config.js"]);
    expect(tw[0].content).toContain("@theme {");
    expect(tw[1].content).toContain('"primary": {');
    const tokens = JSON.parse(exportSystem(s, "tokens")[0].content);
    expect(tokens.color.primary).toEqual({ $type: "color", $value: "#2f5bea" });
    expect(tokens.font.size.base.$value).toBe("1rem");
    expect(flatTokens(s).every(([k, v]) => /^[a-z0-9-]+$/.test(k) && !/[;{}<]/.test(v))).toBe(true);
  });

  it("applies a system to a design as an undoable version, and new designs can start from one", async () => {
    const a = actor();
    const sys = await createSystem(a, { from: "manual", system: SYSTEM }, null);
    const created = await svc.handleMessage(a, null, "make a page", new Scripted([{ content: JSON.stringify(design()) }]) as never);
    const id = created.state.id;
    const applied = await svc.applySystem(a, id, sys.id);
    expect(applied.changed).toBe(true);
    expect(applied.state.systemId).toBe(sys.id);
    expect(applied.state.design.theme.primary).toBe("#2f5bea");
    const back = await svc.undo(a, id);
    expect(back.design.theme.primary).toBe(t.colors.primary);
    expect((await getSystem(a, sys.id)).usedBy).toEqual([{ id, name: "Site" }]);

    const p = new Scripted([{ content: JSON.stringify({ summary: "A page.", design: design() }) }]);
    const fresh = await svc.handleMessage(a, null, "a landing page for a bakery", p as never, { systemId: sys.id });
    expect(fresh.state.systemId).toBe(sys.id);
    expect(fresh.state.design.typography.heading).toBe("Manrope");
    expect(String(p.requests[0].messages.at(-1)!.content)).toContain('Follow the design system "Harbor"');

    await deleteSystem(a, sys.id);
    expect((await svc.getDesign(a, id)).systemId).toBeNull();
  });
});

describe("visual editing", () => {
  it("edits text in place, moves, duplicates and removes sections, and changes colours", async () => {
    const a = actor();
    const created = await svc.handleMessage(a, null, "make a page", new Scripted([{ content: JSON.stringify(design()) }]) as never);
    const id = created.state.id;
    const hero = created.state.design.sections.find((s) => s.type === "hero")!.id;
    const feats = created.state.design.sections.find((s) => s.type === "features")!.id;
    let r = await svc.patchDesign(a, id, [{ op: "set_text", section: hero, path: "title", value: "Hello there" }, { op: "set_text", section: feats, path: "items.0.title", value: "Speedy" }]);
    expect(r.state.design.sections.find((s) => s.id === hero)!.title).toBe("Hello there");
    expect((r.state.design.sections.find((s) => s.id === feats)!.items as any[])[0].title).toBe("Speedy");
    expect(r.summary).toBe("Made 2 visual edits.");
    r = await svc.patchDesign(a, id, [{ op: "move", section: feats, direction: "up" }]);
    expect(r.state.design.sections.map((s) => s.type)).toEqual(["navbar", "features", "hero", "footer"]);
    r = await svc.patchDesign(a, id, [{ op: "duplicate", section: feats }]);
    expect(r.state.design.sections.filter((s) => s.type === "features")).toHaveLength(2);
    r = await svc.patchDesign(a, id, [{ op: "remove", section: hero }, { op: "set_color", key: "primary", value: "#ff0066" }]);
    expect(r.state.design.sections.some((s) => s.type === "hero")).toBe(false);
    expect(r.state.design.theme.primary).toBe("#ff0066");
    await expect(svc.patchDesign(a, id, [{ op: "set_text", section: feats, path: "type", value: "hero" }])).rejects.toThrow(/can't be edited/);
    await expect(svc.patchDesign(a, id, [{ op: "set_text", section: feats, path: "title", value: "x".repeat(300) }])).rejects.toThrow(/doesn't fit/);
    await expect(svc.patchDesign(a, id, [{ op: "duplicate", section: created.state.design.sections[0].id }])).rejects.toThrow(/only have one navbar/);
    const html = await svc.editorHtml(a, id, 40);
    expect(html.replace(/&#x27;/g, "'")).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
    expect(html).toContain('data-mf-edit="items.0.title"');
    expect(html).toContain('data-scroll="40"');
  });
});
