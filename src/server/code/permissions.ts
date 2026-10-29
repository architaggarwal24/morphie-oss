import type { PermissionRules } from "@/lib/types";
import { globToRegExp } from "../sandbox/types";

/**
 * Permission rules in the Claude Code style:
 *   Bash                     every command
 *   Bash(npm test)           exactly that command
 *   Bash(npm run *)          a prefix (`*` matches anything; a trailing " *" also matches the bare command)
 *   Edit(src/**)             file edits (and writes) under src/
 *   Write(docs/*.md)         file writes only
 *   Read(**\/*.env)          reading files (read_file, grep, glob, list_files)
 *   WebFetch(domain:github.com)   fetching pages on that domain or its subdomains
 *   WebSearch, PullRequest, Verify (verify_project: install, build, test and start the app)
 * Deny rules win over allow rules; anything not covered falls back to the approval setting.
 */
export const RULE_TOOLS = ["Bash", "Edit", "Write", "Read", "WebFetch", "WebSearch", "PullRequest", "Verify"] as const;
export type RuleTool = (typeof RULE_TOOLS)[number];
export interface PermTarget { tool: RuleTool; value?: string }

const RULE_RE = new RegExp(`^(${RULE_TOOLS.join("|")})(?:\\((.{1,200})\\))?$`);

export function parseRule(rule: string): { tool: RuleTool; spec?: string } | null {
  const m = RULE_RE.exec(rule.trim());
  if (!m) return null;
  const spec = m[2]?.trim();
  if (m[2] !== undefined && !spec) return null;
  if (m[1] === "WebFetch" && spec && !/^domain:[a-z0-9.-]+$/i.test(spec)) return null;
  if ((m[1] === "WebSearch" || m[1] === "PullRequest" || m[1] === "Verify") && spec) return null;
  return { tool: m[1] as RuleTool, spec };
}

export const isValidRule = (r: string): boolean => !!parseRule(r);

export function normalizeRules(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const r of v) if (typeof r === "string" && isValidRule(r) && !out.includes(r.trim())) out.push(r.trim());
  return out.slice(0, 100);
}

/** Split a shell command into the commands it runs (on && || ; | and newlines, outside quotes). */
export function splitCommand(cmd: string): string[] {
  const parts: string[] = [];
  let cur = "", q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q && cmd[i - 1] !== "\\") q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") { parts.push(cur); cur = ""; i++; continue; }
    const redirect = c === "&" && (cmd[i - 1] === ">" || cmd[i - 1] === "<" || cmd[i + 1] === ">");
    if (c === ";" || c === "|" || c === "\n" || (c === "&" && !redirect)) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** Command substitution, process substitution, redirections to files: never allowed by a rule, always asked. */
const UNSAFE = /\$\(|`|<\(|>\(|>{1,2}\s*[^&\s]/;
const unsafe = (cmd: string) => UNSAFE.test(cmd.replace(/\d*>&\d/g, "").replace(/\d*>{1,2}\s*\/dev\/null/g, ""));

function wildcard(spec: string): RegExp {
  let s = spec.replace(/:\*$/, " *"); // Claude Code's legacy "npm run test:*" prefix form
  const optionalTail = s.endsWith(" *");
  if (optionalTail) s = s.slice(0, -2);
  const body = s.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${optionalTail ? "(?: .*)?" : ""}$`, "s");
}

function matches(rule: { tool: RuleTool; spec?: string }, t: PermTarget): boolean {
  const sameTool = rule.tool === t.tool || (rule.tool === "Edit" && t.tool === "Write");
  if (!sameTool) return false;
  if (!rule.spec) return true;
  const v = t.value ?? "";
  switch (rule.tool) {
    case "Bash": return wildcard(rule.spec).test(v);
    case "Edit": case "Write": case "Read": return globToRegExp(rule.spec).test(v.replace(/^\.\//, ""));
    case "WebFetch": {
      const want = rule.spec.slice("domain:".length).toLowerCase();
      let host = "";
      try { host = new URL(v).hostname.toLowerCase(); } catch { return false; }
      return host === want || host.endsWith("." + want);
    }
    default: return false;
  }
}

/** allow = run without asking · deny = refuse · ask = the normal approval setting decides. */
export function evaluate(rules: PermissionRules, t: PermTarget): { decision: "allow" | "deny" | "ask"; rule?: string } {
  const deny = rules.deny.map((r) => [r, parseRule(r)] as const);
  const allow = rules.allow.map((r) => [r, parseRule(r)] as const);
  if (t.tool === "Bash") {
    const cmds = splitCommand(t.value ?? "");
    for (const [r, p] of deny) if (p && (cmds.some((c) => matches(p, { tool: "Bash", value: c })) || matches(p, t))) return { decision: "deny", rule: r };
    if (unsafe(t.value ?? "") || !cmds.length) return { decision: "ask" };
    let used: string | undefined;
    const all = cmds.every((c) => { const hit = allow.find(([, p]) => p && matches(p, { tool: "Bash", value: c })); if (hit) used ??= hit[0]; return !!hit; });
    return all ? { decision: "allow", rule: used } : { decision: "ask" };
  }
  for (const [r, p] of deny) if (p && matches(p, t)) return { decision: "deny", rule: r };
  for (const [r, p] of allow) if (p && matches(p, t)) return { decision: "allow", rule: r };
  return { decision: "ask" };
}

/** Tools whose first word is followed by a subcommand that matters ("npm test", "git status"). */
const TWO_WORD = new Set(["npm", "pnpm", "yarn", "bun", "npx", "git", "cargo", "go", "pip", "pip3", "python", "python3", "uv", "poetry", "make", "docker", "dotnet", "deno", "gh", "kubectl"]);

/** The rule "Always allow" adds for this call: a command prefix, or every edit in the project. */
export function suggestRule(t: PermTarget): string {
  if (t.tool === "Bash") {
    const first = splitCommand(t.value ?? "")[0] ?? "";
    const words = first.split(" ").filter((w) => !/^[A-Z_]+=/.test(w));
    if (!words.length) return "Bash";
    // "npm --version": a two-word tool used with only a flag gets an exact rule, never "npm *".
    if (TWO_WORD.has(words[0]) && (!words[1] || words[1].startsWith("-"))) return `Bash(${words.join(" ").replace(/[()]/g, "")})`;
    const n = TWO_WORD.has(words[0]) ? 2 : 1;
    return `Bash(${words.slice(0, n).join(" ").replace(/[()]/g, "")} *)`;
  }
  if (t.tool === "Edit" || t.tool === "Write") return "Edit";
  if (t.tool === "Read") return "Read";
  if (t.tool === "WebFetch") { try { return `WebFetch(domain:${new URL(t.value ?? "").hostname})`; } catch { return "WebFetch"; } }
  return t.tool;
}
