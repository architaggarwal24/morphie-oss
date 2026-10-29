import { fileDiff } from "../code/diff";
import { openPullRequest } from "../code/git";
import { ignoreScratch } from "../code/scratch";
import { cleanRel, EXEC_MAX_MS, SandboxError } from "../sandbox/types";
import { ToolError, str, type ToolContext, type ToolDef } from "./types";

/**
 * Tools for code projects, modelled on Claude Code's: bash, read/write/edit files, list, glob, grep, plus pull requests.
 * They only exist when the task belongs to a project (ctx.code), and paths are always relative to the project root.
 */

const MAX_READ_LINES = 2000;
/** Without an explicit limit a read returns this many lines: most answers are in the first few hundred. */
const DEFAULT_READ_LINES = 600;
/** Command output above this goes to a log file; the model sees the start and the end. */
const BASH_INLINE = 8000;
const MAX_LINE = 2000;
const MAX_WRITE = 1_000_000;

function code(ctx: ToolContext) {
  if (!ctx.code) throw new ToolError("This task isn't attached to a code project.");
  return ctx.code;
}

/** Sandbox errors are the model's to handle; anything else is a bug. */
async function sb<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof SandboxError) throw new ToolError(e.message); throw e; }
}

function path(args: Record<string, unknown>, key = "path"): string {
  try { return cleanRel(str(args, key, 400)); } catch (e) { if (e instanceof SandboxError) throw new ToolError(e.message); throw e; }
}
const pathArg = (a: Record<string, unknown>) => (typeof a.path === "string" ? a.path.replace(/^\.\/+/, "") : "");

function noteChange(ctx: ToolContext, p: string, kind: "created" | "modified" | "deleted") {
  const c = code(ctx);
  if (!c.changed.includes(p)) c.changed.push(p);
  ctx.emit({ type: "file_change", path: p, kind });
}

/** Apply an edit_file call to `text`. Throws a ToolError the model can act on. */
export function applyEdit(text: string, oldStr: string, newStr: string, replaceAll: boolean): string {
  if (oldStr === newStr) throw new ToolError("old_string and new_string are the same; there is nothing to change.");
  let find = oldStr, repl = newStr;
  if (!text.includes(find) && text.includes("\r\n") && find.includes("\n")) { find = find.replace(/\r?\n/g, "\r\n"); repl = repl.replace(/\r?\n/g, "\r\n"); }
  const count = find ? text.split(find).length - 1 : 0;
  if (!oldStr) throw new ToolError("old_string is empty. To create a file use write_file; to insert, include a nearby line in old_string.");
  if (count === 0) throw new ToolError("old_string was not found in the file. Read the file again and copy the exact text, including indentation and whitespace.");
  if (count > 1 && !replaceAll) throw new ToolError(`old_string appears ${count} times. Include more surrounding lines so it is unique, or set replace_all to true.`);
  return replaceAll ? text.split(find).join(repl) : text.replace(find, () => repl);
}

export const readFileTool: ToolDef = {
  name: "read_file",
  label: "Read",
  description: `Read a file from the project. Returns numbered lines (cat -n style): the first ${DEFAULT_READ_LINES} lines by default, up to ${MAX_READ_LINES} with limit; use offset for the rest. Read a file before editing it.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root, e.g. src/index.ts" },
      offset: { type: "number", description: "First line to read (1-based). Optional." },
      limit: { type: "number", description: `How many lines (default ${DEFAULT_READ_LINES}, max ${MAX_READ_LINES}).` },
    },
    required: ["path"],
  },
  risk: "safe", modes: ["agent"], code: true, readOnly: true, parallel: true,
  permission: (a) => ({ tool: "Read", value: pathArg(a) }),
  describeCall: (a) => `Read ${pathArg(a)}`,
  async run(args, ctx) {
    const c = code(ctx);
    const p = path(args);
    const text = await sb(() => c.sandbox.readFile(p));
    if (text === null) throw new ToolError(`${p} doesn't exist. Use glob or list_files to find the right path.`);
    c.read.add(p);
    if (text.includes("\u0000")) return { text: `${p} is a binary file (${text.length.toLocaleString()} bytes); it can't be shown as text.`, summary: "binary" };
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Math.floor(Number(args.offset) || 1));
    const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(Number(args.limit) || DEFAULT_READ_LINES)));
    const slice = lines.slice(start - 1, start - 1 + limit);
    if (!text) return { text: "(empty file)", summary: `${p} · empty` };
    const body = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + "…" : l}`).join("\n");
    const more = start - 1 + slice.length < lines.length ? `\n… ${lines.length - (start - 1 + slice.length)} more lines (use offset=${start + slice.length})` : "";
    return { text: body + more, summary: `${p} · ${lines.length} lines` };
  },
};

export const writeFileTool: ToolDef = {
  name: "write_file",
  label: "Write",
  description: "Create a file, or replace a whole file, in the project. For changes to an existing file prefer edit_file. Overwriting an existing file requires reading it first.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to the project root." }, content: { type: "string", description: "The complete file content." } },
    required: ["path", "content"],
  },
  risk: "confirm", modes: ["agent"], code: true,
  permission: (a) => ({ tool: "Write", value: pathArg(a) }),
  describeCall: (a) => `Write ${pathArg(a) || "a file"}`,
  async preview(args, ctx) {
    const p = path(args);
    const before = await sb(() => code(ctx).sandbox.readFile(p));
    return { path: p, diff: fileDiff(p, before, typeof args.content === "string" ? args.content : "").diff };
  },
  async run(args, ctx) {
    const c = code(ctx);
    const p = path(args);
    const content = typeof args.content === "string" ? args.content : "";
    if (content.length > MAX_WRITE) throw new ToolError(`That's too large to write in one go (max ${MAX_WRITE.toLocaleString()} characters).`);
    const before = await sb(() => c.sandbox.readFile(p));
    if (before !== null && !c.read.has(p)) throw new ToolError(`${p} already exists. Read it with read_file first, or use edit_file for a targeted change.`);
    await sb(() => c.sandbox.writeFile(p, content));
    c.read.add(p);
    const d = fileDiff(p, before, content);
    noteChange(ctx, p, before === null ? "created" : "modified");
    return { text: `${before === null ? "Created" : "Wrote"} ${p} (+${d.added} −${d.removed}).`, summary: `${before === null ? "Created" : "Updated"} ${p} · +${d.added} −${d.removed}`, diff: d.diff };
  },
};

export const editFileTool: ToolDef = {
  name: "edit_file",
  label: "Edit",
  description: "Replace exact text in a file. old_string must match the file exactly (whitespace included) and be unique unless replace_all is true. Keep edits small; make several calls for separate changes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project root." },
      old_string: { type: "string", description: "The exact text to replace." },
      new_string: { type: "string", description: "The replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "old_string", "new_string"],
  },
  risk: "confirm", modes: ["agent"], code: true,
  permission: (a) => ({ tool: "Edit", value: pathArg(a) }),
  describeCall: (a) => `Edit ${pathArg(a) || "a file"}`,
  async preview(args, ctx) {
    const p = path(args);
    const before = await sb(() => code(ctx).sandbox.readFile(p));
    if (before === null) return { path: p };
    try { return { path: p, diff: fileDiff(p, before, applyEdit(before, String(args.old_string ?? ""), String(args.new_string ?? ""), args.replace_all === true)).diff }; }
    catch { return { path: p }; } // the run will report the problem
  },
  async run(args, ctx) {
    const c = code(ctx);
    const p = path(args);
    const before = await sb(() => c.sandbox.readFile(p));
    if (before === null) throw new ToolError(`${p} doesn't exist. To create it, use write_file.`);
    const after = applyEdit(before, typeof args.old_string === "string" ? args.old_string : "", typeof args.new_string === "string" ? args.new_string : "", args.replace_all === true);
    await sb(() => c.sandbox.writeFile(p, after));
    c.read.add(p);
    const d = fileDiff(p, before, after);
    noteChange(ctx, p, "modified");
    return { text: `Edited ${p} (+${d.added} −${d.removed}).`, summary: `${p} · +${d.added} −${d.removed}`, diff: d.diff };
  },
};

export const listFilesTool: ToolDef = {
  name: "list_files",
  label: "List",
  description: "List files and folders in the project (default: the root, 2 levels deep). node_modules, .git and build folders are shown but not entered.",
  parameters: { type: "object", properties: { path: { type: "string", description: "Folder relative to the project root (optional)." }, depth: { type: "number", description: "Levels to descend, 1–5 (default 2)." } } },
  risk: "safe", modes: ["agent"], code: true, readOnly: true, parallel: true,
  permission: (a) => ({ tool: "Read", value: pathArg(a) || "." }),
  describeCall: (a) => `List ${pathArg(a) || "the project"}`,
  async run(args, ctx) {
    const c = code(ctx);
    const dir = typeof args.path === "string" && args.path.trim() ? path(args) : "";
    const depth = Math.min(5, Math.max(1, Math.floor(Number(args.depth) || 2)));
    const entries = await sb(() => c.sandbox.list(dir, depth));
    if (!entries.length) return { text: dir ? `${dir} is empty or doesn't exist.` : "The project is empty.", summary: "empty" };
    const shown = entries.slice(0, 500);
    const text = shown.map((e) => (e.type === "dir" ? `${e.path}/` : `${e.path}${e.size != null ? ` (${e.size} B)` : ""}`)).join("\n") + (entries.length > shown.length ? `\n… ${entries.length - shown.length} more` : "");
    return { text, summary: `${entries.length} entries` };
  },
};

export const globTool: ToolDef = {
  name: "glob",
  label: "Find files",
  description: 'Find files by name pattern, e.g. "**/*.test.ts" or "src/**/{index,main}.{js,ts}". Most recently modified first.',
  parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  risk: "safe", modes: ["agent"], code: true, readOnly: true, parallel: true,
  permission: (a) => ({ tool: "Read", value: String(a.pattern ?? "") }),
  describeCall: (a) => `Find ${String(a.pattern ?? "")}`,
  async run(args, ctx) {
    const pattern = str(args, "pattern", 300);
    const hits = await sb(() => code(ctx).sandbox.glob(pattern, 250));
    return { text: hits.length ? hits.join("\n") : "No files match.", summary: `${hits.length} file${hits.length === 1 ? "" : "s"}` };
  },
};

export const grepTool: ToolDef = {
  name: "grep",
  label: "Search",
  description: "Search file contents with a regular expression (ripgrep syntax). Returns path:line:text. Narrow it with path (a folder or file) or glob (e.g. *.ts).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression." },
      path: { type: "string", description: "Folder or file to search (optional)." },
      glob: { type: "string", description: 'Only files matching this, e.g. "*.tsx" (optional).' },
      ignore_case: { type: "boolean" },
      context: { type: "number", description: "Lines of context around each match, 0–5." },
    },
    required: ["pattern"],
  },
  risk: "safe", modes: ["agent"], code: true, readOnly: true, parallel: true,
  permission: (a) => ({ tool: "Read", value: pathArg(a) || "." }),
  describeCall: (a) => `Search for ${String(a.pattern ?? "")}`,
  async run(args, ctx) {
    const pattern = str(args, "pattern", 500);
    const out = await sb(() => code(ctx).sandbox.grep(pattern, {
      path: typeof args.path === "string" && args.path.trim() ? path(args) : undefined,
      glob: typeof args.glob === "string" && args.glob.trim() ? args.glob.trim().slice(0, 200) : undefined,
      ignoreCase: args.ignore_case === true, context: Number(args.context) || 0, maxResults: 80,
    }));
    const n = out ? out.split("\n").filter((l) => /^[^:]+:\d+:/.test(l)).length : 0;
    return { text: out || "No matches.", summary: `${n} match${n === 1 ? "" : "es"}` };
  },
};

export const bashTool: ToolDef = {
  name: "bash",
  label: "Run",
  description:
    "Run a shell command in the project folder (bash; the working directory is the project root and persists only for this command). " +
    "Use it for scaffolding, package managers, builds, tests and git. Prefer read_file/grep/glob over cat/grep/find for reading. Commands must not wait for input " +
    "(use --yes / non-interactive flags). Long output is saved to a log file and you see its start and end. Don't start dev servers here (they never return): " +
    `verify_project starts the app and checks it. Default timeout 2 minutes, up to ${EXEC_MAX_MS / 60_000} with timeout_ms.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      description: { type: "string", description: "5–10 words on what this does (shown to the user)." },
      timeout_ms: { type: "number" },
    },
    required: ["command"],
  },
  risk: "confirm", modes: ["agent"], code: true,
  permission: (a) => ({ tool: "Bash", value: String(a.command ?? "").trim() }),
  describeCall: (a) => (typeof a.description === "string" && a.description.trim() ? a.description.trim().slice(0, 120) : `Run ${String(a.command ?? "").slice(0, 120)}`),
  async preview(args) { return { command: String(args.command ?? "") }; },
  async run(args, ctx) {
    const c = code(ctx);
    const command = str(args, "command", 10_000);
    const r = await sb(() => c.sandbox.exec(command, { timeoutMs: Number(args.timeout_ms) || undefined, signal: ctx.signal }));
    ctx.emit({ type: "terminal", stepId: ctx.stepId ?? "", command, output: r.output, exitCode: r.exitCode, ms: r.ms });
    ctx.emit({ type: "file_change", path: "*", kind: "modified" });
    const status = r.timedOut ? `[timed out after ${Math.round(r.ms / 1000)}s]` : `[exit code ${r.exitCode}]`;
    let shown = r.output.trimEnd() || "(no output)";
    if (shown.length > BASH_INLINE) {
      // The model gets the start and the end (errors are usually there); the rest is a read_file/grep away.
      const log = `.morphie/logs/bash-${Date.now().toString(36)}.log`;
      const saved = await c.sandbox.writeFile(log, `$ ${command}\n\n${r.output}`).then(() => true, () => false);
      if (saved) await ignoreScratch(c.sandbox);
      shown = `${shown.slice(0, 1500)}\n…[${shown.length - 7500} characters${saved ? `; full output in ${log}` : ""}]…\n${shown.slice(-6000)}`;
    }
    return { text: `${shown}\n${status}`, summary: r.timedOut ? "timed out" : r.exitCode === 0 ? `ok · ${(r.ms / 1000).toFixed(1)}s` : `exit ${r.exitCode}` };
  },
};

export const pullRequestTool: ToolDef = {
  name: "create_pull_request",
  label: "Pull request",
  description: "Open a GitHub pull request with the current work: creates a branch if you're on the default branch, commits any uncommitted changes with the title as the message, pushes, and opens the PR. Only when the user asked for a PR.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      body: { type: "string", description: "Markdown: a summary and a test plan." },
      base: { type: "string", description: "Branch to merge into (default: the repository's default branch)." },
      branch: { type: "string", description: "Name for the new branch, if one is needed (optional)." },
    },
    required: ["title"],
  },
  risk: "confirm", modes: ["agent"], code: true,
  permission: () => ({ tool: "PullRequest" }),
  describeCall: (a) => `Open a pull request: ${String(a.title ?? "").slice(0, 100)}`,
  async preview(args) { return { plan: `**${String(args.title ?? "")}**\n\n${String(args.body ?? "").slice(0, 3000)}` }; },
  async run(args, ctx) {
    const c = code(ctx);
    const pr = await sb(() => openPullRequest(c.sandbox, { token: c.githubToken, repoUrl: c.project.repoUrl, title: str(args, "title", 250), body: typeof args.body === "string" ? args.body : "", base: typeof args.base === "string" ? args.base : undefined, branch: typeof args.branch === "string" ? args.branch : undefined }));
    ctx.emit({ type: "file_change", path: "*", kind: "modified" });
    return { text: `Opened pull request #${pr.number} from ${pr.branch}: ${pr.url}`, summary: `#${pr.number}`, sources: [{ title: `Pull request #${pr.number}`, url: pr.url }] };
  },
};

export const exitPlanMode: ToolDef = {
  name: "exit_plan_mode",
  label: "Plan ready",
  description: "In plan mode: present your implementation plan to the user for approval. Call it once you've researched enough to propose a concrete plan. If approved, you can start making changes.",
  parameters: { type: "object", properties: { plan: { type: "string", description: "The plan in Markdown: the steps, the files you'll change and how you'll verify it." } }, required: ["plan"] },
  risk: "confirm", modes: ["agent"], readOnly: true, alwaysAsk: true,
  describeCall: () => "Approve this plan and start making changes?",
  async preview(args) { return { plan: String(args.plan ?? "").slice(0, 12_000) }; },
  async run(_args, ctx) {
    ctx.flags.planMode = false;
    ctx.emit({ type: "plan_mode", active: false });
    return { text: "The user approved the plan. Plan mode is off: you can now edit files and run commands. Start with the first step, and keep update_plan current.", summary: "Approved" };
  },
};

export const CODE_TOOLS: ToolDef[] = [readFileTool, editFileTool, writeFileTool, listFilesTool, globTool, grepTool, bashTool, pullRequestTool];
