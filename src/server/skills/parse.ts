import type { SkillScope } from "@/lib/types";

/** A SKILL.md, read: its front-matter fields and the instructions below it. */
export interface ParsedSkill {
  name: string;
  description: string;
  scope: SkillScope;
  /** `disable-model-invocation: true`: only used when the user asks for it. */
  manual: boolean;
  license?: string;
  body: string;
}

export class SkillFormatError extends Error {}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_SKILL_MD = 200_000;

/** "Frontend Design!" → "frontend-design". */
export function skillSlug(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
}

/** The YAML subset skills use: `key: value`, quoted strings, and `>` / `|` blocks. Nested maps are skipped. */
export function frontMatter(text: string): { fields: Record<string, string>; body: string } {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { fields: {}, body: src };
  const fields: Record<string, string> = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded = value.startsWith(">");
      const block: string[] = [];
      while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i].trim());
      value = (folded ? block.join(" ") : block.join("\n")).replace(/\s+$/, "");
    } else if (/^".*"$/.test(value)) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    if (!(key in fields)) fields[key] = value;
  }
  return { fields, body: src.slice(m[0].length) };
}

export function parseSkill(markdown: string, fallbackName?: string): ParsedSkill {
  if (markdown.length > MAX_SKILL_MD) throw new SkillFormatError(`SKILL.md is too long (max ${MAX_SKILL_MD.toLocaleString("en-US")} characters).`);
  const { fields, body } = frontMatter(markdown);
  const rawName = fields.name || fallbackName || (/^#\s+(.+)$/m.exec(body)?.[1] ?? "");
  const name = skillSlug(rawName);
  if (!name || !SKILL_NAME.test(name)) throw new SkillFormatError("The skill needs a name: add `name: my-skill` to its front-matter.");
  let description = (fields.description ?? "").replace(/\s+/g, " ").trim();
  // A plain Markdown file with no front-matter at all: its first paragraph line stands in for the description.
  if (!description && !Object.keys(fields).length) description = (body.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "").trim();
  if (!description) throw new SkillFormatError("The skill needs a description that says when to use it: add `description: ...` to its front-matter.");
  const scopeRaw = (fields.scope ?? fields["morphie-scope"] ?? "").toLowerCase();
  const scope: SkillScope = scopeRaw === "design" || scopeRaw === "both" ? scopeRaw : scopeRaw === "agent" ? "agent" : guessScope(name, description);
  const manual = /^(true|yes)$/i.test(fields["disable-model-invocation"] ?? "");
  if (!body.trim()) throw new SkillFormatError("The skill has no instructions below its front-matter.");
  return { name, description: description.slice(0, 1024), scope, manual, license: fields.license?.slice(0, 120) || undefined, body: body.trim() };
}

/** Skills written for other tools don't say where they belong: design-ish ones also help the Design agent. */
function guessScope(name: string, description: string): SkillScope {
  return /\b(design|ui|ux|visual|brand|theme|colou?r|typograph|layout|aesthetic|poster|art|canvas|landing page)\b/i.test(`${name} ${description}`) ? "both" : "agent";
}

export { SKILL_TEMPLATE } from "@/lib/skillTemplate";
