import type { ProjectView, SlashCommand } from "@/lib/types";
import { randomId } from "../crypto";
import type { Sandbox } from "../sandbox/types";
import type { ProjectSkill } from "../skills";
import { frontMatter, skillSlug } from "../skills/parse";
import { normalizeRules } from "./permissions";

/** What a run in a code project carries around (ToolContext.code). */
export interface CodeContext {
  project: ProjectView;
  sandbox: Sandbox;
  /** Files read this run; write_file refuses to overwrite a file it hasn't read (like Claude Code). */
  read: Set<string>;
  githubToken?: string;
  /** Deny rules from the project's own .morphie/settings.json (allow rules there are ignored: a cloned repo can't grant itself permissions). */
  projectDeny: string[];
  /** Files this run created, changed or deleted. */
  changed: string[];
}

export interface CustomCommand { name: string; description: string; argHint?: string; body: string; file: string }
export interface ProjectInfo {
  memory: { path: string; text: string } | null;
  deny: string[];
  commands: CustomCommand[];
  git: string;
  top: string[];
  /** Skills that live in the project (.morphie/skills/*, .claude/skills/*). */
  skills: ProjectSkill[];
}

const MEMORY_FILES = ["MORPHIE.md", "CLAUDE.md", "AGENTS.md", ".morphie/MORPHIE.md", ".claude/CLAUDE.md"];

/** One round trip: the memory file, project settings, custom commands, git state and the top-level listing. */
export async function loadProjectInfo(sb: Sandbox): Promise<ProjectInfo> {
  const mark = `@@M${randomId(6)}`;
  const script = `
for f in ${MEMORY_FILES.map((f) => `"${f}"`).join(" ")}; do if [ -f "$f" ]; then echo "${mark} FILE $f"; head -c 12000 "$f"; echo; break; fi; done
for f in .morphie/settings.json .claude/settings.json; do if [ -f "$f" ]; then echo "${mark} SETTINGS $f"; head -c 20000 "$f"; echo; fi; done
for f in .morphie/skills/*/SKILL.md .claude/skills/*/SKILL.md; do if [ -f "$f" ]; then echo "${mark} SKILL $f"; head -c 3000 "$f"; echo; fi; done 2>/dev/null
for f in .morphie/commands/*.md .claude/commands/*.md; do if [ -f "$f" ]; then echo "${mark} CMD $f"; head -c 8000 "$f"; echo; fi; done 2>/dev/null
echo "${mark} GIT"; if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "branch: $(git branch --show-current)"; git status --short 2>/dev/null | head -n 20; echo "recent commits:"; git log --oneline -5 2>/dev/null; else echo "(not a git repository)"; fi
echo "${mark} TOP"; ls -1Ap 2>/dev/null | head -n 80
`;
  const out = (await sb.exec(script, { timeoutMs: 30_000 }).catch(() => ({ output: "" }))).output;
  const info: ProjectInfo = { memory: null, deny: [], commands: [], git: "", top: [], skills: [] };
  const parts = out.split(`${mark} `).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    const body = nl < 0 ? "" : part.slice(nl + 1).replace(/\n$/, "");
    const [kind, ...rest] = head.split(" ");
    const file = rest.join(" ");
    if (kind === "FILE" && body.trim()) info.memory = { path: file, text: body.trim() };
    else if (kind === "SETTINGS") {
      try { info.deny.push(...normalizeRules(JSON.parse(body)?.permissions?.deny)); } catch { /* not JSON: ignored */ }
    } else if (kind === "CMD") {
      const cmd = parseCommandFile(file, body);
      if (cmd && !info.commands.some((c) => c.name === cmd.name)) info.commands.push(cmd);
    } else if (kind === "SKILL") {
      const { fields } = frontMatter(body);
      const dir = file.slice(0, file.lastIndexOf("/"));
      const name = skillSlug(fields.name || dir.split("/").pop() || "");
      const description = (fields.description ?? "").replace(/\s+/g, " ").trim().slice(0, 1024);
      if (name && description && !info.skills.some((s) => s.name === name)) {
        const sc = (fields.scope ?? "").toLowerCase();
        info.skills.push({ name, description, dir, scope: sc === "design" || sc === "both" ? sc : "agent", manual: /^(true|yes)$/i.test(fields["disable-model-invocation"] ?? "") });
      }
    } else if (kind === "GIT") info.git = body.trim();
    else if (kind === "TOP") info.top = body.split("\n").filter(Boolean);
  }
  return info;
}

export function parseCommandFile(file: string, text: string): CustomCommand | null {
  const name = file.split("/").pop()!.replace(/\.md$/i, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name) || BUILTIN_NAMES.has(name)) return null;
  let body = text.replace(/\r\n/g, "\n");
  const meta: Record<string, string> = {};
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (fm) {
    for (const line of fm[1].split("\n")) { const m = /^([a-z-]+):\s*(.*)$/i.exec(line); if (m) meta[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "").trim(); }
    body = body.slice(fm[0].length);
  }
  body = body.trim();
  if (!body) return null;
  const description = (meta.description || body.split("\n").find((l) => l.trim())!.replace(/^#+\s*/, "")).slice(0, 120);
  return { name, description, argHint: meta["argument-hint"]?.slice(0, 60), body: body.slice(0, 8000), file };
}

// ------------------------------------------------------------------ slash commands

interface Builtin { name: string; description: string; argHint?: string; clientOnly?: boolean; prompt?: (args: string) => string }

export const BUILTINS: Builtin[] = [
  { name: "plan", description: "Toggle plan mode: research and propose a plan before changing anything", clientOnly: true },
  { name: "clear", description: "Start a new task (clears the conversation)", clientOnly: true },
  { name: "help", description: "Show what the agent can do and the available commands", clientOnly: true },
  {
    name: "init", description: "Study the codebase and write a MORPHIE.md with build commands and conventions",
    prompt: () => "Analyze this codebase and create a MORPHIE.md file at the project root to help future tasks here. Include: the commands to install, build, lint, test (and run a single test); a short overview of the architecture and where the important code lives; and code style and conventions you can infer. Keep it concise (under ~80 lines), specific to this repository, and don't invent anything you didn't verify. If MORPHIE.md, CLAUDE.md or AGENTS.md already exists, improve it instead of starting over.",
  },
  {
    name: "review", description: "Review the uncommitted changes for bugs and risks", argHint: "[focus]",
    prompt: (a) => `Review the uncommitted changes in this repository (run \`git status\` and \`git diff HEAD\`). Look for bugs, edge cases, security problems, missing tests and anything that doesn't match the codebase's conventions. Report findings ordered by severity with file:line references and a concrete fix for each. Do NOT edit any files.${a ? `\n\nFocus on: ${a}` : ""}`,
  },
  {
    name: "commit", description: "Commit the current changes with a good message", argHint: "[message hint]",
    prompt: (a) => `Commit the current changes. First run \`git status\` and \`git diff HEAD\`, and look at \`git log --oneline -10\` to match the repository's commit style. Don't commit files that look like secrets (.env, keys). Write a concise message that explains why, not just what, then commit with git.${a ? `\n\nHint for the message: ${a}` : ""}`,
  },
  {
    name: "pr", description: "Put the changes on a branch and open a GitHub pull request", argHint: "[title]",
    prompt: (a) => `Open a pull request for the current changes. Check \`git status\`, \`git diff HEAD\` and the recent log. Make sure the work is complete (run the tests if there are any). Then call create_pull_request with a clear title${a ? ` (suggested: "${a}")` : ""} and a body with a short summary and a test plan. It creates a branch if needed, commits and pushes.`,
  },
  { name: "test", description: "Run the test suite and fix what fails", argHint: "[filter]", prompt: (a) => `Find how this project runs its tests (package.json scripts, Makefile, pytest, cargo…), run them${a ? ` (only: ${a})` : ""}, and fix any failures. Fix the code, not the tests, unless a test is clearly wrong; say so if you change one. Re-run until they pass or you've explained what's blocking.` },
  { name: "explain", description: "Explain how a part of the code works", argHint: "<file or topic>", prompt: (a) => `Explain how ${a || "this codebase"} works: the main pieces, how data flows through them, and anything surprising. Read the relevant code first and cite file:line. Don't change anything.` },
  { name: "fix", description: "Find and fix a bug", argHint: "<what's wrong>", prompt: (a) => `Fix this problem: ${a || "(describe the bug)"}\n\nReproduce or locate it first, make the smallest correct fix, and verify it (tests, build, or a quick run).` },
];
const BUILTIN_NAMES = new Set(BUILTINS.map((b) => b.name));

export function listCommands(custom: CustomCommand[]): SlashCommand[] {
  return [
    ...BUILTINS.map((b) => ({ name: b.name, description: b.description, source: "builtin" as const, argHint: b.argHint, clientOnly: b.clientOnly })),
    ...custom.map((c) => ({ name: c.name, description: c.description, source: "project" as const, argHint: c.argHint })),
  ];
}

/** "/review auth" → the prompt the model gets. null when the message isn't a known command. */
export function expandCommand(message: string, custom: CustomCommand[]): string | null {
  const m = /^\/([a-z0-9][a-z0-9_-]{0,39})(?:\s+([\s\S]*))?$/i.exec(message.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const args = (m[2] ?? "").trim();
  const builtin = BUILTINS.find((b) => b.name === name);
  if (builtin?.prompt) return builtin.prompt(args);
  const c = custom.find((x) => x.name === name);
  if (!c) return null;
  const words = args.split(/\s+/).filter(Boolean);
  let body = c.body.replace(/\$ARGUMENTS/g, args).replace(/\$(\d)/g, (_, d) => words[Number(d) - 1] ?? "");
  if (args && !/\$ARGUMENTS|\$\d/.test(c.body)) body += `\n\nArguments: ${args}`;
  return `(Project command /${c.name} from ${c.file})\n\n${body}`;
}
