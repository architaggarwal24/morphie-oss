/** The starting point for a skill written in the app. */
export const SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when to use it. Name the situations and keywords that should trigger it.
scope: agent
---
# My skill

## When to use
- ...

## Steps
1. ...
2. ...

## Rules
- ...
`;

/** Split a SKILL.md into its front-matter lines and its body (for showing it). */
export function splitSkill(md: string): { meta: Array<[string, string]>; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return { meta: [], body: md };
  const meta: Array<[string, string]> = [];
  for (const line of m[1].split(/\r?\n/)) { const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line); if (kv && kv[2]) meta.push([kv[1], kv[2].replace(/^["']|["']$/g, "")]); }
  return { meta, body: md.slice(m[0].length) };
}
