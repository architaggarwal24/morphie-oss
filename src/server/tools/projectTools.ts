import { ignoreScratch } from "../code/scratch";
import { VERIFY_MARK, VERIFY_SCRIPT } from "../code/verifyScript";
import type { ImagePart } from "../providers/types";
import { SandboxError } from "../sandbox/types";
import { ToolError, str, type ToolDef } from "./types";

/**
 * create_project: an agent task that needs to run code gets a real project (folder + shell) mid-run.
 * verify_project: the "is it actually working?" check a run must pass before it delivers.
 */

export const createProjectTool: ToolDef = {
  name: "create_project",
  label: "Create project",
  description:
    "Create a code project for this task: a real folder with a shell where you can install packages, build, run and test. " +
    "Use it when the task needs code that has to be written AND run (an app, website, game, script, API), not for writing, research or answers. " +
    "After it's created you work with read_file, write_file, edit_file, bash and verify_project inside it.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short kebab-case folder name, e.g. friday-landing." },
      repo_url: { type: "string", description: "Optional: an https Git repository to clone instead of starting empty." },
    },
    required: ["name"],
  },
  risk: "confirm", modes: ["agent"],
  describeCall: (a) => `Create the project “${String(a.name ?? "project").slice(0, 60)}”`,
  async run(args, ctx) {
    if (!ctx.createProject) throw new ToolError(ctx.code ? "This task already has a project." : "Code projects aren't available here.");
    const name = str(args, "name", 80).trim();
    const repo = typeof args.repo_url === "string" && args.repo_url.trim() ? args.repo_url.trim() : undefined;
    const text = await ctx.createProject(name, repo);
    return { text, summary: name };
  },
};

interface Step { name: string; command: string; ok: boolean; warnOnly?: boolean; exitCode: number | null; ms: number; timedOut: boolean; log: string; tail: string }
interface Page { path: string; status: number; type: string; bytes: number; title: string; ok: boolean; overlay?: boolean; blank?: boolean; renderedChars?: number; renderedText?: string }
interface Report {
  kind: string; steps: Step[]; pages: Page[]; screenshots: string[]; notes: string[]; noTests: boolean;
  serve?: { command: string; port: number; ok?: boolean; ms?: number; tail?: string }; serverTail?: string;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

/** The report the model reads: every check, and for each failure the end of its log. */
export function formatReport(r: Report, opts: { testsNagged: boolean }): { text: string; passed: boolean; problems: string[]; checks: string } {
  const lines: string[] = [];
  const problems: string[] = [];
  for (const s of r.steps) {
    if (s.ok) lines.push(`✓ ${s.name} (${secs(s.ms)})`);
    else {
      const what = s.timedOut ? `timed out after ${secs(s.ms)}` : `exit code ${s.exitCode}`;
      lines.push(`${s.warnOnly ? "⚠" : "✗"} ${s.name}: ${what} — $ ${s.command}\n${s.tail.trim().split("\n").map((l) => "    " + l).join("\n")}\n    (full log: ${s.log})`);
      if (!s.warnOnly) problems.push(`${s.name} failed`);
    }
  }
  if (r.noTests) {
    lines.push(opts.testsNagged ? "– tests: none (noted)" : "✗ tests: the project has no tests. Add a few basic ones for the core logic (e.g. vitest for a JS/TS project, with a \"test\": \"vitest run\" script), then run verify_project again.");
    if (!opts.testsNagged) problems.push("no tests");
  }
  if (r.serve) {
    if (r.serve.ok) lines.push(`✓ app started: ${r.serve.command} (ready in ${secs(r.serve.ms ?? 0)})`);
    else { lines.push(`✗ the app didn't start or never answered: ${r.serve.command}\n${(r.serve.tail ?? "").split("\n").map((l) => "    " + l).join("\n")}`); problems.push("app didn't start"); }
  }
  for (const p of r.pages) {
    const label = `GET ${p.path} → ${p.status || "no answer"}${p.title ? ` “${p.title}”` : ""}`;
    if (p.ok) lines.push(`✓ ${label}${p.renderedChars != null ? ` · renders ${p.renderedChars} characters of text` : ""}`);
    else {
      const why = p.blank ? "the page renders blank in a browser (likely a JavaScript error at startup; check the browser console code paths and the build output)" : p.overlay ? "the page shows an error overlay / error page" : p.status >= 400 ? `HTTP ${p.status}` : "no response";
      lines.push(`✗ ${label}: ${why}`);
      problems.push(`${p.path} broken`);
    }
  }
  if (r.serve?.ok && r.pages.some((p) => !p.ok) && r.serverTail) lines.push(`App output (end):\n${r.serverTail.split("\n").map((l) => "    " + l).join("\n")}`);
  if (r.screenshots.length) lines.push(`Screenshots: ${r.screenshots.join(", ")}`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  const passed = problems.length === 0;
  const head = passed ? "verify_project: PASSED — everything that could be checked works." : `verify_project: FAILED — ${problems.length} problem${problems.length === 1 ? "" : "s"} (${problems.join(", ")}). Fix them and run verify_project again.`;
  const ran = r.steps.filter((s) => s.ok).map((s) => s.name);
  if (r.serve?.ok) ran.push(`loaded ${r.pages.filter((p) => p.ok).length} page${r.pages.length === 1 ? "" : "s"}`);
  if (r.screenshots.length) ran.push("screenshot");
  return { text: [head, ...lines].join("\n"), passed, problems, checks: ran.join(" · ") };
}

export const verifyProjectTool: ToolDef = {
  name: "verify_project",
  label: "Verify",
  description:
    "Check that the project really works: installs dependencies, type-checks, lints, builds and runs the tests, then starts the app, loads its pages " +
    "and renders/screenshots them in a headless browser when one is available. Returns every problem with the end of its log. " +
    "Run it when the work is complete, fix what it reports, and run it again until it passes. It starts and stops the app itself.",
  parameters: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: 'Pages to load, e.g. ["/", "/about"] (default ["/"]).' },
      skip: { type: "array", items: { type: "string", enum: ["install", "typecheck", "lint", "build", "test", "serve", "screenshot"] }, description: "Checks to leave out (only when one can't apply)." },
    },
  },
  risk: "confirm", modes: ["agent"], code: true,
  permission: () => ({ tool: "Verify" }),
  describeCall: () => "Install, build, test and start the project to check it works",
  async preview() { return { command: "node .morphie/verify.mjs   # install · type-check · build · test · start the app · load pages · screenshot" }; },
  async run(args, ctx) {
    const c = ctx.code;
    if (!c) throw new ToolError("This task isn't attached to a code project.");
    const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && /^\/[^\s]{0,200}$/.test(p)).slice(0, 8) : [];
    const skip = Array.isArray(args.skip) ? args.skip.filter((s): s is string => typeof s === "string").slice(0, 7) : [];
    const progress = (text: string) => { if (ctx.stepId) ctx.emit({ type: "tool_progress", stepId: ctx.stepId, text }); };
    try {
      progress("Preparing the checks…");
      const node = await c.sandbox.exec("node --version", { timeoutMs: 20_000, signal: ctx.signal });
      if (node.exitCode !== 0) throw new ToolError("Node.js isn't available in this project's environment, so verify_project can't run. Verify with bash instead (build and test commands).");
      await c.sandbox.writeFile(".morphie/verify.mjs", VERIFY_SCRIPT);
      await c.sandbox.writeFile(".morphie/verify.json", JSON.stringify({ paths, skip }));
      await ignoreScratch(c.sandbox);
      progress("Installing, building and testing…");
      const r = await c.sandbox.exec("node .morphie/verify.mjs", { timeoutMs: 600_000, signal: ctx.signal });
      const at = r.output.lastIndexOf(VERIFY_MARK);
      if (at < 0) throw new ToolError(`The checks didn't finish${r.timedOut ? " (timed out after 10 minutes)" : ""}. Output:\n${r.output.slice(-4000)}`);
      const report = JSON.parse(r.output.slice(at + VERIFY_MARK.length).trim().split("\n")[0]) as Report;
      const out = formatReport(report, { testsNagged: !!ctx.flags.testsNagged });
      if (report.noTests) ctx.flags.testsNagged = true;
      ctx.emit({ type: "terminal", stepId: ctx.stepId ?? "", command: "verify_project", output: out.text, exitCode: out.passed ? 0 : 1, ms: r.ms });
      ctx.emit({ type: "file_change", path: "*", kind: "modified" });
      const images: ImagePart[] = [];
      for (const s of report.screenshots.slice(0, 2)) {
        const b64 = await c.sandbox.readBytes(s, 3_000_000).catch(() => null);
        if (b64) images.push({ mime: "image/png", data: b64 });
      }
      return {
        text: out.text + (images.length ? `\n${images.length} screenshot${images.length === 1 ? " is" : "s are"} attached below: check the page looks right.` : ""),
        summary: out.passed ? `passed · ${out.checks}` : `${out.problems.length} problem${out.problems.length === 1 ? "" : "s"}`,
        images, verify: { passed: out.passed, checks: out.checks },
      };
    } catch (e) {
      if (e instanceof SandboxError) throw new ToolError(e.message);
      if (e instanceof SyntaxError) throw new ToolError("The checks finished but their report couldn't be read.");
      throw e;
    }
  },
};

