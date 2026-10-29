import fs from "node:fs";
import { expect, it } from "vitest";
import { validateDesign } from "@/server/design/schema";
import { exportHtml, exportReact, renderCss, renderPreview } from "@/server/design/renderer";
import { THEMES } from "@/server/design/themes";

const py = JSON.parse(fs.readFileSync("tests/fixtures/design-parity.json", "utf8"));
const norm = (s: string) => s.replace(/(\d)\.0(rem|px)/g, "$1$2");   // python prints 8.0rem, JS 8rem

it("matches the python design engine", async () => {
  const notes: string[] = [];
  const d = validateDesign(py.raw, notes);
  expect(notes).toEqual(py.notes);
  expect(d).toEqual(py.design);
  expect(norm(renderPreview(d))).toBe(norm(py.preview));
  expect(norm(renderCss(d))).toBe(norm(py.css));
  const react = exportReact(d);
  expect(react.map((f) => f.path)).toEqual(py.react.map((f: any) => f.path));
  for (const [i, f] of react.entries()) expect(norm(f.content), f.path).toBe(norm(py.react[i].content));
  const html = exportHtml(d);
  for (const [i, f] of html.entries()) expect(norm(f.content), f.path).toBe(norm(py.html[i].content));
  for (const [id, t] of Object.entries(THEMES)) {
    const dd = validateDesign({ ...py.raw, theme: t.colors, typography: t.typography, style: t.style, layout: { max_width: "1100", spacing: "spacious" } });
    expect(norm(renderCss(dd)), id).toBe(norm(py.themes[id]));
  }
});
