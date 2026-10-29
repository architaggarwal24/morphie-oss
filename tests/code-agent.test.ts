import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_SETTINGS, type AgentEvent, type AgentSettings } from "@/lib/types";
import { decide } from "@/server/agent/approvals";
import { runAgent } from "@/server/agent/loop";
import { fileDiff } from "@/server/code/diff";
import { acceptChange, commitAll, getChanges, githubRepo, rejectChange } from "@/server/code/git";
import { evaluate, isValidRule, splitCommand, suggestRule } from "@/server/code/permissions";
import { expandCommand, listCommands, loadProjectInfo, parseCommandFile, type CodeContext } from "@/server/code/project";
import { createConversation, getMessages } from "@/server/conversations";
import { insertProject } from "@/server/data/projects";
import { CloudflareSandbox } from "@/server/sandbox/cloudflare";
import { needsGitHubToken } from "@/server/sandbox/gitToken";
import { LocalSandbox } from "@/server/sandbox/local";
import { globToRegExp, SandboxError } from "@/server/sandbox/types";
import { applyEdit } from "@/server/tools/code";
import { toolsFor } from "@/server/tools";
import { testActor } from "./helpers/actor";
import { call, Scripted, type Step } from "./helpers/scripted";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } });

let n = 0;
async function project(files: Record<string, string> = {}, opts: { git?: boolean } = {}) {
  const userId = `code_${++n}_abcdefghijklmnop`;
  const actor = testActor(userId);
  const p = await insertProject(actor, { name: "demo", repoUrl: null, branch: null });
  const sb = new LocalSandbox(userId, p.id, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" });
  for (const [f, c] of Object.entries(files)) await sb.writeFile(f, c);
  if (opts.git) { git(sb.root, "init", "-q", "-b", "main"); git(sb.root, "add", "-A"); git(sb.root, "commit", "-qm", "init"); }
  return { userId, actor, p, sb };
}

async function runIn(proj: Awaited<ReturnType<typeof project>>, script: Step[], opts: { settings?: Partial<AgentSettings>; planMode?: boolean; approve?: boolean | ((e: Extract<AgentEvent, { type: "approval" }>) => boolean); prompt?: string; deny?: string[] } = {}) {
  const conv = await createConversation(proj.actor, "agent", "New conversation", proj.p.id);
  const provider = new Scripted(script);
  const events: AgentEvent[] = [];
  const info = await loadProjectInfo(proj.sb);
  const ctx: CodeContext = { project: proj.p, sandbox: proj.sb, read: new Set(), projectDeny: opts.deny ?? info.deny, changed: [] };
  await runAgent({
    actor: proj.actor, conversationId: conv.id, mode: "agent", message: "do the thing", prompt: opts.prompt, provider, signal: new AbortController().signal, planMode: opts.planMode,
    settings: { ...DEFAULT_AGENT_SETTINGS, memory: false, ...opts.settings },
    code: { ctx, info: { ...info, shell: proj.sb.shell, sandbox: "local", github: false, project: "demo", repoUrl: null } },
    emit: (e) => {
      events.push(e);
      if (e.type === "approval") {
        const ok = typeof opts.approve === "function" ? opts.approve(e) : opts.approve ?? true;
        setTimeout(() => void decide(proj.userId, e.id, { approved: ok }), 2);
      }
    },
  });
  return { events, provider, messages: await getMessages(proj.actor, conv.id), ctx, convId: conv.id };
}
const ofType = <T extends AgentEvent["type"]>(events: AgentEvent[], t: T) => events.filter((e) => e.type === t) as Extract<AgentEvent, { type: T }>[];

describe("permission rules", () => {
  const R = (allow: string[], deny: string[] = []) => ({ allow, deny });
  it("validates rule syntax", () => {
    for (const ok of ["Bash", "Bash(npm test)", "Bash(npm run *)", "Edit(src/**)", "Read", "WebFetch(domain:github.com)", "PullRequest", "Write(docs/*.md)"]) expect(isValidRule(ok), ok).toBe(true);
    for (const bad of ["bash", "Bash()", "Rm(x)", "WebFetch(github.com)", "WebSearch(x)", "Edit(src", ""]) expect(isValidRule(bad), bad).toBe(false);
  });
  it("splits compound commands outside quotes, keeping redirections whole", () => {
    expect(splitCommand(`npm test && git status; echo "a && b" | wc -l`)).toEqual(["npm test", "git status", `echo "a && b"`, "wc -l"]);
    expect(splitCommand("npm test 2>&1")).toEqual(["npm test 2>&1"]);
  });
  it("allows a command only when every part is allowed; deny wins; substitution always asks", () => {
    expect(evaluate(R(["Bash(npm test *)"]), { tool: "Bash", value: "npm test" }).decision).toBe("allow");
    expect(evaluate(R(["Bash(npm test *)"]), { tool: "Bash", value: "npm test -- --watch=false" }).decision).toBe("allow");
    expect(evaluate(R(["Bash(npm test *)"]), { tool: "Bash", value: "npm test && rm -rf src" }).decision).toBe("ask");
    expect(evaluate(R(["Bash(npm test *)", "Bash(git status)"]), { tool: "Bash", value: "npm test && git status" }).decision).toBe("allow");
    expect(evaluate(R(["Bash"], ["Bash(rm *)"]), { tool: "Bash", value: "ls && rm -rf /" })).toMatchObject({ decision: "deny", rule: "Bash(rm *)" });
    expect(evaluate(R(["Bash(echo *)"]), { tool: "Bash", value: "echo $(cat ~/.ssh/id_rsa)" }).decision).toBe("ask");
    expect(evaluate(R(["Bash(echo *)"]), { tool: "Bash", value: "echo hi > out.txt" }).decision).toBe("ask");
    expect(evaluate(R(["Bash(npm test *)"]), { tool: "Bash", value: "npm test > /dev/null 2>&1" }).decision).toBe("allow");
    expect(evaluate(R(["Bash(npm run test:*)"]), { tool: "Bash", value: "npm run test" }).decision).toBe("allow");
  });
  it("matches paths with globs, Edit rules cover Write, and domains include subdomains", () => {
    expect(evaluate(R(["Edit(src/**)"]), { tool: "Write", value: "src/a/b.ts" }).decision).toBe("allow");
    expect(evaluate(R(["Write(src/**)"]), { tool: "Edit", value: "src/a.ts" }).decision).toBe("ask");
    expect(evaluate(R([], ["Read(**/.env)"]), { tool: "Read", value: "config/.env" }).decision).toBe("deny");
    expect(evaluate(R(["WebFetch(domain:github.com)"]), { tool: "WebFetch", value: "https://api.github.com/x" }).decision).toBe("allow");
    expect(evaluate(R(["WebFetch(domain:github.com)"]), { tool: "WebFetch", value: "https://github.com.evil.io/" }).decision).toBe("ask");
  });
  it("suggests a sensible 'always allow' rule", () => {
    expect(suggestRule({ tool: "Bash", value: "npm test -- -t foo" })).toBe("Bash(npm test *)");
    expect(suggestRule({ tool: "Bash", value: "ls -la src" })).toBe("Bash(ls *)");
    expect(suggestRule({ tool: "Bash", value: "NODE_ENV=test git status" })).toBe("Bash(git status *)");
    expect(suggestRule({ tool: "Bash", value: "npm --version" })).toBe("Bash(npm --version)");
    expect(suggestRule({ tool: "Edit", value: "a.ts" })).toBe("Edit");
  });
});

describe("edits and diffs", () => {
  it("replaces a unique string, refuses ambiguous or missing ones, handles CRLF", () => {
    expect(applyEdit("a\nb\nc\n", "b", "B", false)).toBe("a\nB\nc\n");
    expect(() => applyEdit("x x", "x", "y", false)).toThrow(/appears 2 times/);
    expect(applyEdit("x x", "x", "y", true)).toBe("y y");
    expect(() => applyEdit("abc", "zzz", "y", false)).toThrow(/not found/);
    expect(applyEdit("a\r\nb\r\n", "a\nb", "A\nB", false)).toBe("A\r\nB\r\n");
    expect(applyEdit("cost $1", "$1", "$&2", false)).toBe("cost $&2"); // no replacement-pattern surprises
  });
  it("produces a git-style diff with counts", () => {
    const d = fileDiff("src/x.ts", "a\nb\n", "a\nB\nc\n");
    expect(d.diff).toContain("--- a/src/x.ts");
    expect(d.diff).toContain("+B");
    expect([d.added, d.removed]).toEqual([2, 1]);
    expect(fileDiff("new.md", null, "hi\n").diff).toContain("--- /dev/null");
  });
});

describe("LocalSandbox", () => {
  it("runs commands in the project, reads and writes files, and refuses paths outside it", async () => {
    const { sb } = await project({ "src/a.ts": "export const a = 1;\n", "README.md": "# Demo\n" });
    const r = await sb.exec("pwd && ls src");
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("a.ts");
    expect(await sb.readFile("src/a.ts")).toContain("a = 1");
    expect(await sb.readFile("nope.txt")).toBeNull();
    await expect(sb.readFile("../../etc/passwd")).rejects.toBeInstanceOf(SandboxError);
    await expect(sb.writeFile("/tmp/x", "y")).rejects.toBeInstanceOf(SandboxError);
    // A link to a folder outside the project. Windows makes it a junction, which (unlike a symlink) needs no admin rights.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "morphie-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope\n");
    fs.symlinkSync(outside, path.join(sb.root, "escape"), "junction");
    await expect(sb.readFile("escape/secret.txt")).rejects.toThrow(/outside/);
    expect((await sb.exec("exit 3")).exitCode).toBe(3);
    const slow = await sb.exec("sleep 5", { timeoutMs: 1000 });
    expect(slow.timedOut).toBe(true);
  });
  it("keeps Morphie's own secrets out of commands", async () => {
    process.env.ENCRYPTION_KEY_TEST_LEAK = "leak";
    const { sb } = await project();
    expect((await sb.exec("env")).output).not.toContain("ENCRYPTION_KEY_TEST_LEAK");
  });
  it("lists, globs and greps", async () => {
    const { sb } = await project({ "src/a.ts": "const needle = 1;\n", "src/b.tsx": "x\n", "node_modules/z/index.js": "needle\n", "docs/n.md": "Needle\n" });
    expect((await sb.list("", 1)).map((e) => e.path)).toEqual(expect.arrayContaining(["src", "docs", "node_modules"]));
    expect((await sb.glob("**/*.ts")).sort()).toEqual(["src/a.ts"]);
    expect((await sb.glob("src/*.{ts,tsx}")).sort()).toEqual(["src/a.ts", "src/b.tsx"]);
    const g = await sb.grep("needle", { ignoreCase: true });
    expect(g).toContain("src/a.ts:1:const needle = 1;");
    expect(g).toContain("docs/n.md:1:Needle");
    expect(g).not.toContain("node_modules");
    await expect(sb.grep("(")).rejects.toThrow(/regular expression/);
  });
  it("clones a repository into an empty project", async () => {
    const src = await project({ "hello.txt": "hi\n" }, { git: true });
    const { sb } = await project();
    const r = await sb.clone(`file://${src.sb.root}`);
    expect(r.exitCode, r.output).toBe(0);
    expect(await sb.readFile("hello.txt")).toBe("hi\n");
    await expect(sb.clone(`file://${src.sb.root}`)).rejects.toThrow(/isn't empty/);
  });
});

describe("the GitHub token", () => {
  it("goes only to git and gh network commands that can't run anything else or print it", () => {
    for (const ok of ["git push -u origin HEAD 2>&1", "git pull", "git fetch origin main", "git clone --depth 50 -- \"https://github.com/a/b\" .",
      "git ls-remote origin", "git submodule update --init", "gh pr list", "gh api repos/a/b/pulls", "cd sub && git push", "git fetch >/dev/null 2>&1 || true"]) {
      expect(needsGitHubToken(ok), ok).toBe(true);
    }
    for (const no of ["ls", "env", "printenv GITHUB_TOKEN", "npm install", "git status", "git commit -m x", "git log",
      "git push && env", "git push; curl https://x.io", "git push | tee out", "echo $GITHUB_TOKEN", "git push $(cat x)", "git push `id`", "git push ${X}",
      "GIT_SSH_COMMAND=sh git fetch", "git -c core.sshCommand=sh fetch", "git fetch --upload-pack=sh", "git push --exec=sh", "git fetch ext::sh",
      "git submodule foreach env", "git credential fill", "gh auth token", "gh auth status -t", "gh alias set x env", "gh extension install a/b",
      "gh api --hostname evil.io /x", "gh api https://evil.io/x", "gh", "git push <(cat x)"]) {
      expect(needsGitHubToken(no), no).toBe(false);
    }
  });
  it("is not in the environment of other commands in a local sandbox", async () => {
    const { userId, p } = await project();
    const sb = new LocalSandbox(userId, p.id, {}, { GITHUB_TOKEN: "ghp_secret_value", GH_TOKEN: "ghp_secret_value" });
    const r = await sb.exec("env");
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("ghp_secret_value");
  });
});

describe("CloudflareSandbox client", () => {
  it("checks paths before calling the Durable Object and filters globs itself", async () => {
    const calls: unknown[][] = [];
    const stub = new Proxy({}, { get: (_t, m) => async (...args: unknown[]) => { calls.push([m, ...args]); return m === "files_" ? ["src/a.ts", "src/b.js", "README.md"] : null; } });
    const ns = { idFromName: (n: string) => n, get: (id: unknown) => { calls.push(["get", id]); return stub as never; } };
    const sb = new CloudflareSandbox(ns, "user1", "proj1", "ghp_x");
    expect(calls[0]).toEqual(["get", "user1:proj1"]);
    expect(await sb.glob("**/*.ts")).toEqual(["src/a.ts"]);
    await expect(sb.readFile("../x")).rejects.toBeInstanceOf(SandboxError);
    await sb.readFile("./src/a.ts");
    expect(calls.at(-1)).toEqual(["readFile", "src/a.ts"]);
    await sb.exec("ls", { cwd: "src" });
    // The GitHub token goes along only with git / gh network commands.
    expect(calls.at(-1)).toEqual(["exec", "ls", { cwd: "src", timeoutMs: undefined, githubToken: undefined }]);
    await sb.exec("git push -u origin HEAD 2>&1");
    expect(calls.at(-1)).toEqual(["exec", "git push -u origin HEAD 2>&1", { cwd: "", timeoutMs: undefined, githubToken: "ghp_x" }]);
  });
});

describe("git changes", () => {
  it("reports changes, accepts (stages) and rejects (reverts) them, and commits", async () => {
    const { sb } = await project({ "a.txt": "one\n", "b.txt": "bee\n" }, { git: true });
    await sb.writeFile("a.txt", "one\ntwo\n");
    await sb.writeFile("new.txt", "fresh\n");
    await sb.remove("b.txt");
    let ch = await getChanges(sb);
    expect(ch.git).toBe(true);
    expect(ch.branch).toBe("main");
    const by = Object.fromEntries(ch.files.map((f) => [f.path, f]));
    expect(by["a.txt"]).toMatchObject({ status: "M", added: 1, removed: 0, staged: false });
    expect(by["new.txt"]).toMatchObject({ status: "?", added: 1 });
    expect(by["b.txt"]).toMatchObject({ status: "D" });
    expect(ch.diff).toContain("+two");
    expect(ch.diff).toContain("+fresh");

    await acceptChange(sb, "a.txt");
    ch = await getChanges(sb);
    expect(ch.files.find((f) => f.path === "a.txt")!.staged).toBe(true);

    await rejectChange(sb, "new.txt");
    await rejectChange(sb, "b.txt");
    expect(await sb.readFile("new.txt")).toBeNull();
    expect(await sb.readFile("b.txt")).toBe("bee\n");

    const c = await commitAll(sb, "Add a second line");
    expect(c).toMatch(/Add a second line/);
    expect((await getChanges(sb)).files).toEqual([]);
  });
  it("reverts everything at once, and says when a folder isn't a repository", async () => {
    const { sb } = await project({ "a.txt": "one\n" }, { git: true });
    await sb.writeFile("a.txt", "changed\n");
    await sb.writeFile("junk/x.txt", "x\n");
    await rejectChange(sb);
    expect(await sb.readFile("a.txt")).toBe("one\n");
    expect(await sb.readFile("junk/x.txt")).toBeNull();
    const plain = await project({ "a.txt": "x" });
    expect((await getChanges(plain.sb)).git).toBe(false);
  });
  it("keeps line endings as they are even when the user's git config converts them (core.autocrlf, the Windows default)", async () => {
    const src = await project({ "a.txt": "one\n" }, { git: true });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "morphie-home-"));
    fs.writeFileSync(path.join(home, ".gitconfig"), "[core]\n\tautocrlf = true\n");
    const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
    process.env.HOME = home;
    delete process.env.GIT_CONFIG_GLOBAL;
    try {
      // Without the sandbox's settings, this git would write CRLF.
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), "morphie-plain-"));
      git(plain, "clone", "-q", src.sb.root, "c");
      expect(fs.readFileSync(path.join(plain, "c", "a.txt"), "utf8")).toBe("one\r\n");

      const { sb } = await project();
      expect((await sb.clone(`file://${src.sb.root}`)).exitCode).toBe(0);
      expect(await sb.readFile("a.txt")).toBe("one\n");
      await sb.writeFile("a.txt", "changed\n");
      await rejectChange(sb, "a.txt");
      expect(await sb.readFile("a.txt")).toBe("one\n");
      // Git for the GitHub token keeps working alongside it.
      const withToken = new LocalSandbox(src.userId, src.p.id, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "morphie.test", GIT_CONFIG_VALUE_0: "yes" });
      expect((await withToken.exec("git config core.autocrlf && git config morphie.test")).output.trim().split(/\s+/)).toEqual(["false", "yes"]);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  it("recognises GitHub remotes", () => {
    expect(githubRepo("https://github.com/acme/app.git")).toEqual({ owner: "acme", repo: "app" });
    expect(githubRepo("git@github.com:acme/app.git")).toEqual({ owner: "acme", repo: "app" });
    expect(githubRepo("https://gitlab.com/acme/app")).toBeNull();
  });
});

describe("project memory and slash commands", () => {
  it("loads MORPHIE.md, project deny rules and custom commands in one go", async () => {
    const { sb } = await project({
      "MORPHIE.md": "Run tests with `npm test`.",
      ".morphie/settings.json": JSON.stringify({ permissions: { allow: ["Bash"], deny: ["Bash(rm *)", "nonsense"] } }),
      ".morphie/commands/ship.md": "---\ndescription: Ship it\nargument-hint: <version>\n---\nRelease version $ARGUMENTS after running $1 checks.",
      ".claude/commands/lint.md": "Run the linter and fix warnings.",
    });
    const info = await loadProjectInfo(sb);
    expect(info.memory).toEqual({ path: "MORPHIE.md", text: "Run tests with `npm test`." });
    expect(info.deny).toEqual(["Bash(rm *)"]); // allow rules from a repo are ignored; invalid ones dropped
    expect(info.commands.map((c) => c.name).sort()).toEqual(["lint", "ship"]);
    const cmds = listCommands(info.commands);
    expect(cmds.find((c) => c.name === "ship")).toMatchObject({ source: "project", description: "Ship it", argHint: "<version>" });
    expect(cmds.find((c) => c.name === "plan")).toMatchObject({ clientOnly: true });
    expect(expandCommand("/ship 2.1", info.commands)).toContain("Release version 2.1 after running 2.1 checks.");
    expect(expandCommand("/lint now", info.commands)).toContain("Arguments: now");
    expect(expandCommand("/review auth", [])).toMatch(/Review the uncommitted changes[\s\S]*Focus on: auth/);
    expect(expandCommand("/nope", info.commands)).toBeNull();
    expect(expandCommand("not a command", info.commands)).toBeNull();
  });
  it("won't let a project command shadow a built-in", () => {
    expect(parseCommandFile(".morphie/commands/review.md", "evil")).toBeNull();
    expect(parseCommandFile(".morphie/commands/Bad Name.md", "x")).toBeNull();
  });
});

describe("the agent in a code project", () => {
  it("offers code tools instead of the private workspace; plan mode offers only read-only ones", () => {
    const names = (s: Parameters<typeof toolsFor>[2]) => toolsFor("agent", DEFAULT_AGENT_SETTINGS, s).map((t) => t.name);
    const code = names({ hasDocuments: false, code: true });
    expect(code).toEqual(expect.arrayContaining(["bash", "read_file", "edit_file", "write_file", "grep", "glob", "task", "create_pull_request"]));
    expect(code).not.toContain("workspace_write");
    expect(code).not.toContain("exit_plan_mode");
    expect(names({ hasDocuments: false })).not.toContain("bash");
    const plan = names({ hasDocuments: false, code: true, planMode: true });
    expect(plan).toEqual(expect.arrayContaining(["read_file", "grep", "exit_plan_mode", "update_plan", "task"]));
    expect(plan).not.toContain("edit_file");
    expect(plan).not.toContain("bash");
  });

  it("reads, edits with an approval that shows the diff, and records the change", async () => {
    const proj = await project({ "src/app.ts": "export const greet = () => 'hello';\n" }, { git: true });
    const r = await runIn(proj, [
      { toolCalls: [call("read_file", { path: "src/app.ts" })] },
      { toolCalls: [call("edit_file", { path: "src/app.ts", old_string: "'hello'", new_string: "'hello, world'" })] },
      { content: "Changed the greeting." },
    ]);
    const ap = ofType(r.events, "approval")[0];
    expect(ap.tool).toBe("edit_file");
    expect(ap.preview?.diff).toContain("+export const greet = () => 'hello, world';");
    expect(ap.preview?.rule).toBe("Edit");
    expect(await proj.sb.readFile("src/app.ts")).toContain("hello, world");
    expect(ofType(r.events, "file_change")).toEqual([{ type: "file_change", path: "src/app.ts", kind: "modified" }]);
    const read = r.provider.requests[1].messages.at(-1)!.content;
    expect(read).toMatch(/^\s+1\texport const greet/);
    const meta = r.messages.at(-1)!.meta!;
    expect(meta.changed).toEqual(["src/app.ts"]);
    const step = meta.timeline!.find((t) => t.kind === "tool" && t.step.name === "edit_file");
    expect(step?.kind === "tool" && step.step.diff).toContain("+export const greet");
  });

  it("won't overwrite a file it hasn't read, and reports a bad edit to the model", async () => {
    const proj = await project({ "a.txt": "keep me\n" });
    const r = await runIn(proj, [
      { toolCalls: [call("write_file", { path: "a.txt", content: "clobbered" })] },
      { toolCalls: [call("edit_file", { path: "a.txt", old_string: "missing", new_string: "x" })] },
      { content: "ok" },
    ], { settings: { approval: "never" } });
    expect(await proj.sb.readFile("a.txt")).toBe("keep me\n");
    const msgs = r.provider.requests[1].messages;
    expect(msgs.at(-1)!.content).toMatch(/Read it with read_file first/);
    expect(r.provider.requests[2].messages.at(-1)!.content).toMatch(/not found/);
  });

  it("runs allowed commands without asking, blocks denied ones, and streams them to the terminal", async () => {
    const proj = await project({ "package.json": "{}" });
    const r = await runIn(proj, [
      { toolCalls: [call("bash", { command: "echo built && ls", description: "Build it" })] },
      { toolCalls: [call("bash", { command: "rm -rf package.json" })] },
      { content: "done" },
    ], { settings: { permissions: { allow: ["Bash(echo *)", "Bash(ls *)"], deny: [] } }, deny: ["Bash(rm *)"] });
    expect(ofType(r.events, "approval")).toHaveLength(0);
    const term = ofType(r.events, "terminal");
    expect(term).toHaveLength(1);
    expect(term[0]).toMatchObject({ command: "echo built && ls", exitCode: 0 });
    expect(term[0].output).toContain("built");
    expect(await proj.sb.readFile("package.json")).toBe("{}");
    const ends = ofType(r.events, "tool_end");
    expect(ends[1]).toMatchObject({ status: "denied", error: expect.stringContaining("Bash(rm *)") });
    expect(r.provider.requests[1].messages.at(-1)!.content).toContain("[exit code 0]");
  });

  it("'always allow' on a command saves a permission rule, not a blanket tool allowance", async () => {
    const proj = await project();
    const conv = await createConversation(proj.actor, "agent", "x", proj.p.id);
    const info = await loadProjectInfo(proj.sb);
    let asked = 0;
    const settings = { ...DEFAULT_AGENT_SETTINGS, memory: false };
    await runAgent({
      actor: proj.actor, conversationId: conv.id, mode: "agent", message: "go", provider: new Scripted([{ toolCalls: [call("bash", { command: "npm --version" })] }, { content: "ok" }]),
      signal: new AbortController().signal, settings,
      code: { ctx: { project: proj.p, sandbox: proj.sb, read: new Set(), projectDeny: [], changed: [] }, info: { ...info, shell: "bash", sandbox: "local", github: false, project: "demo", repoUrl: null } },
      emit: (e) => { if (e.type === "approval") { asked++; void decide(proj.userId, e.id, { approved: true, always: true }); } },
    });
    expect(asked).toBe(1);
    const { getSettings } = await import("@/server/settings");
    const saved = await getSettings(proj.actor);
    expect(saved.permissions.allow).toEqual(["Bash(npm --version)"]);
    expect(saved.alwaysAllow).not.toContain("bash");
  });

  it("plan mode: read-only until the plan is approved, then the edit tools appear", async () => {
    const proj = await project({ "x.ts": "let v = 1;\n" });
    const r = await runIn(proj, [
      (req) => { expect(req.tools!.map((t) => t.name)).not.toContain("edit_file"); return { toolCalls: [call("edit_file", { path: "x.ts", old_string: "1", new_string: "2" })] }; },
      { toolCalls: [call("exit_plan_mode", { plan: "1. Change v to 2" })] },
      (req) => { expect(req.tools!.map((t) => t.name)).toContain("edit_file"); return { toolCalls: [call("edit_file", { path: "x.ts", old_string: "1", new_string: "2" })] }; },
      { content: "Done." },
    ], { planMode: true, settings: { approval: "never" } });
    expect(r.provider.requests[1].messages.at(-1)!.content).toMatch(/Plan mode is on/);
    const ap = ofType(r.events, "approval");
    expect(ap).toHaveLength(1); // exit_plan_mode always asks, even with approval "never"
    expect(ap[0].preview?.plan).toBe("1. Change v to 2");
    expect(ofType(r.events, "plan_mode")).toEqual([{ type: "plan_mode", active: false }]);
    expect(await proj.sb.readFile("x.ts")).toBe("let v = 2;\n");
    expect(r.provider.requests[0].messages[0].content).toContain("Plan mode is ON");
  });

  it("a rejected plan keeps plan mode on", async () => {
    const proj = await project();
    const r = await runIn(proj, [{ toolCalls: [call("exit_plan_mode", { plan: "do it" })] }, (req) => { expect(req.tools!.map((t) => t.name)).not.toContain("bash"); return { content: "What should change?" }; }], { planMode: true, approve: false });
    expect(r.provider.requests[1].messages.at(-1)!.content).toMatch(/didn't approve the plan/);
  });

  it("runs sub-agents in parallel with read-only tools and returns their reports", async () => {
    const proj = await project({ "src/auth.ts": "export function login() {}\n", "src/db.ts": "export const pool = 1;\n" });
    let inFlight = 0, maxInFlight = 0;
    const provider = new Scripted([]);
    const script: Step[] = [
      { toolCalls: [call("task", { description: "Find auth", prompt: "Where is login?" }, "t1"), call("task", { description: "Find db", prompt: "Where is the pool?" }, "t2")] },
    ];
    // Both sub-agents ask the provider at once: answer each by its prompt.
    provider.chat = async (req) => {
      provider.requests.push(req);
      const sys = String(req.messages[0].content);
      if (sys.includes("research sub-agent")) {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        const asked = String(req.messages[1].content);
        if (req.messages.length === 2) {
          expect(req.tools!.map((t) => t.name).sort()).toEqual(expect.not.arrayContaining(["bash", "edit_file", "write_file", "task"]));
          return { content: "", toolCalls: [call("grep", { pattern: asked.includes("login") ? "login" : "pool" })] };
        }
        return { content: asked.includes("login") ? "login is in src/auth.ts:1" : "pool is in src/db.ts:1", toolCalls: [] };
      }
      const next = script.shift();
      return { content: "", toolCalls: [], ...(next ? (typeof next === "function" ? next(req) : next) : { content: "Summary done." }) } as never;
    };
    const conv = await createConversation(proj.actor, "agent", "x", proj.p.id);
    const info = await loadProjectInfo(proj.sb);
    const events: AgentEvent[] = [];
    await runAgent({
      actor: proj.actor, conversationId: conv.id, mode: "agent", message: "map it", provider, signal: new AbortController().signal, settings: { ...DEFAULT_AGENT_SETTINGS, memory: false },
      code: { ctx: { project: proj.p, sandbox: proj.sb, read: new Set(), projectDeny: [], changed: [] }, info: { ...info, shell: "bash", sandbox: "local", github: false, project: "demo", repoUrl: null } },
      emit: (e) => events.push(e),
    });
    expect(maxInFlight).toBe(2);
    const ends = ofType(events, "tool_end").filter((e) => e.stepId.startsWith("s1_"));
    expect(ends.map((e) => e.output).sort()).toEqual(["login is in src/auth.ts:1", "pool is in src/db.ts:1"]);
    expect(ofType(events, "tool_progress").length).toBeGreaterThanOrEqual(2);
  });

  it("sends a slash command's expansion to the model but stores what the user typed", async () => {
    const proj = await project();
    const r = await runIn(proj, [{ content: "Reviewed." }], { prompt: "EXPANDED PROMPT" });
    expect(r.provider.requests[0].messages.at(-1)!.content).toBe("EXPANDED PROMPT");
    expect(r.messages[0].content).toBe("do the thing");
  });

  it("puts the project's instructions and git state in the system prompt", async () => {
    const proj = await project({ "MORPHIE.md": "Always use tabs.", "index.js": "" }, { git: true });
    const r = await runIn(proj, [{ content: "ok" }]);
    const sys = String(r.provider.requests[0].messages[0].content);
    expect(sys).toContain("<project_instructions>\nAlways use tabs.\n</project_instructions>");
    expect(sys).toContain("branch: main");
    expect(sys).toContain("index.js");
  });
});

describe("glob patterns", () => {
  it("matches like ripgrep globs", () => {
    expect(globToRegExp("*.ts").test("deep/x.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/x.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/x.ts")).toBe(false);
  });
});

describe("checkpoints and rewind", () => {
  it("snapshots the files without touching HEAD or the index, and restores them (removing files made since)", async () => {
    const { createCheckpoint, restoreCheckpoint } = await import("@/server/code/checkpoints");
    const proj = await project({ "a.txt": "one\n", "keep.txt": "same\n" }, { git: true });
    await proj.sb.writeFile("a.txt", "two\n"); // an uncommitted edit is part of the checkpoint
    const head = git(proj.sb.root, "rev-parse", "HEAD").trim();
    const cp = (await createCheckpoint(proj.sb, "build me a thing"))!;
    expect(cp).toMatch(/^[0-9a-f]{40}$/);
    expect(git(proj.sb.root, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(proj.sb.root, "status", "--porcelain")).toBe(" M a.txt\n");
    expect(git(proj.sb.root, "log", "--oneline")).not.toContain("checkpoint");

    await proj.sb.writeFile("a.txt", "three\n");
    await proj.sb.writeFile("src/new.ts", "export {}\n");
    await proj.sb.remove("keep.txt");
    const r = await restoreCheckpoint(proj.sb, cp);
    expect(r).toMatchObject({ restored: true, removed: 1 });
    expect(fs.readFileSync(path.join(proj.sb.root, "a.txt"), "utf8")).toBe("two\n");
    expect(fs.readFileSync(path.join(proj.sb.root, "keep.txt"), "utf8")).toBe("same\n");
    expect(fs.existsSync(path.join(proj.sb.root, "src/new.ts"))).toBe(false);
    expect(git(proj.sb.root, "rev-parse", "HEAD").trim()).toBe(head);

    // The rewind saved where things were, so it can be undone.
    await restoreCheckpoint(proj.sb, r.undo!);
    expect(fs.readFileSync(path.join(proj.sb.root, "a.txt"), "utf8")).toBe("three\n");
    expect(fs.existsSync(path.join(proj.sb.root, "src/new.ts"))).toBe(true);
    expect(await restoreCheckpoint(proj.sb, "0".repeat(40))).toMatchObject({ restored: false });
  });

  it("works in a project with no commits yet, and is a no-op without git", async () => {
    const { createCheckpoint, restoreCheckpoint } = await import("@/server/code/checkpoints");
    const fresh = await project({ "index.html": "<h1>v1</h1>" });
    git(fresh.sb.root, "init", "-q");
    const cp = (await createCheckpoint(fresh.sb, "first"))!;
    await fresh.sb.writeFile("index.html", "<h1>v2</h1>");
    expect((await restoreCheckpoint(fresh.sb, cp)).restored).toBe(true);
    expect(fs.readFileSync(path.join(fresh.sb.root, "index.html"), "utf8")).toBe("<h1>v1</h1>");
    const nogit = await project({ "x.txt": "x" });
    expect(await createCheckpoint(nogit.sb, "x")).toBeNull();
  });

  it("each run in a project records the checkpoint from before it", async () => {
    const proj = await project({ "a.txt": "before\n" }, { git: true });
    const r = await runIn(proj, [{ toolCalls: [call("write_file", { path: "b.txt", content: "new\n" })] }, { content: "Added it." }], { settings: { approval: "never" } });
    expect(fs.existsSync(path.join(proj.sb.root, "b.txt"))).toBe(true);
    const sha = r.messages.at(-1)!.meta?.checkpoint;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(proj.sb.root, "show", `${sha}:a.txt`)).toBe("before\n");
  });

  it("POST /api/conversations/[id]/rewind puts the files and the conversation back", async () => {
    const { POST } = await import("@/app/api/conversations/[id]/rewind/route");
    const { Client } = await import("./helpers/client");
    const { signIn } = await import("./helpers/users");
    const proj = await project({ "a.txt": "before\n" }, { git: true });
    const r = await runIn(proj, [{ toolCalls: [call("write_file", { path: "b.txt", content: "new\n" })] }, { content: "Added it." }], { settings: { approval: "never" } });
    await proj.sb.writeFile("a.txt", "after\n"); // a later edit too
    const convId = r.convId;
    const userMsg = r.messages.find((m) => m.role === "user")!;
    const client = new Client();
    signIn(client, proj.userId);
    const res = await client.json(POST, `/api/conversations/${convId}/rewind`, { method: "POST", params: { id: convId }, body: { messageId: userMsg.id } });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ code: true, conversation: true, prompt: "do the thing" });
    expect(fs.readFileSync(path.join(proj.sb.root, "a.txt"), "utf8")).toBe("before\n");
    expect(fs.existsSync(path.join(proj.sb.root, "b.txt"))).toBe(false);
    expect(await getMessages(proj.actor, convId)).toEqual([]);
    const undo = await client.json(POST, `/api/conversations/${convId}/rewind`, { method: "POST", params: { id: convId }, body: { undo: res.data.undo } });
    expect(undo.status).toBe(200);
    expect(fs.readFileSync(path.join(proj.sb.root, "a.txt"), "utf8")).toBe("after\n");
    expect(fs.readFileSync(path.join(proj.sb.root, "b.txt"), "utf8")).toBe("new\n");
    // Only your own messages; and no checkpoint means no code rewind.
    const bad = await client.json(POST, `/api/conversations/${convId}/rewind`, { method: "POST", params: { id: convId }, body: { messageId: 999999 } });
    expect(bad.status).toBe(400);
  });
});

describe("live preview", () => {
  it("signs preview links to one user's project folder, and they expire", async () => {
    const { previewToken, readPreviewToken, PREVIEW_TTL_MS } = await import("@/server/code/preview");
    const t = previewToken("user_abcdef", "proj_abcdef", "dist", 1000);
    expect(readPreviewToken(t, 2000)).toEqual({ userId: "user_abcdef", projectId: "proj_abcdef", root: "dist" });
    expect(readPreviewToken(t, 1000 + PREVIEW_TTL_MS + 1)).toBeNull();
    const [payload, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "someone_else", p: "proj_abcdef", r: ".", e: 9e15 })).toString("base64url");
    expect(readPreviewToken(`${forged}.${sig}`, 2000)).toBeNull();
    expect(readPreviewToken(`${payload}.${sig.replace(/.$/, (c) => (c === "a" ? "b" : "a"))}`, 2000)).toBeNull();
    expect(readPreviewToken("garbage", 2000)).toBeNull();
  });

  it("picks the dev command and the file a path means", async () => {
    const { candidates, devCommand, rewriteHtml } = await import("@/server/code/preview");
    expect(devCommand({ dependencies: { next: "16" } }, 4000)).toBe("npx --no-install next dev -p 4000 -H 127.0.0.1");
    expect(devCommand({ devDependencies: { vite: "7" } }, 4000)).toContain("vite --port 4000 --strictPort");
    expect(devCommand({ scripts: { dev: "node server.js" } }, 4000)).toBe("npm run dev");
    expect(devCommand({}, 4000)).toBeNull();
    expect(candidates("dist", "")).toEqual(["dist/index.html"]);
    expect(candidates(".", "about")).toEqual(["about", "about.html", "about/index.html"]);
    expect(candidates(".", "css/site.css")).toEqual(["css/site.css"]);
    expect(rewriteHtml('<html><head><title>x</title></head><script src="/assets/a.js"></script><a href="//cdn.example/x">', "/api/preview/T/", "blog"))
      .toBe('<html><head><base href="/api/preview/T/blog/"><title>x</title></head><script src="/api/preview/T/assets/a.js"></script><a href="//cdn.example/x">');
  });

  it("serves the project's static site sandboxed, and the status route links to it", async () => {
    const { GET: status } = await import("@/app/api/projects/[id]/preview/route");
    const { GET: serve } = await import("@/app/api/preview/[token]/[[...path]]/route");
    const { Client } = await import("./helpers/client");
    const { signIn } = await import("./helpers/users");
    const proj = await project({ "index.html": "<html><head></head><body><link href=\"/style.css\" rel=stylesheet>Hi</body></html>", "style.css": "body{color:red}", "img/dot.png": "PNG" });
    fs.mkdirSync(path.join(proj.sb.root, ".morphie/shots"), { recursive: true });
    fs.writeFileSync(path.join(proj.sb.root, ".morphie/shots/home.png"), Buffer.from([137, 80, 78, 71]));
    const client = new Client();
    signIn(client, proj.userId);
    const st = await client.json(status, `/api/projects/${proj.p.id}/preview`, { params: { id: proj.p.id } });
    expect(st.status).toBe(200);
    expect(st.data).toMatchObject({ sandbox: "local", staticRoot: ".", dev: { available: false }, server: null });
    expect(st.data.shots).toEqual([{ name: "home.png", url: expect.stringMatching(/^\/api\/preview\/[^/]+\/home\.png$/) }]);

    // No cookies: the token is the key.
    const anon = new Client();
    const token = st.data.staticUrl.split("/")[3];
    const page = await anon.call(serve, st.data.staticUrl, { params: { token, path: ["index.html"] } as never });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts/);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain(`<base href="/api/preview/${token}/">`);
    expect(html).toContain(`href="/api/preview/${token}/style.css"`);
    const css = await anon.call(serve, `/api/preview/${token}/style.css`, { params: { token, path: ["style.css"] } as never });
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("body{color:red}");
    const shotToken = st.data.shots[0].url.split("/")[3];
    const shot = await anon.call(serve, st.data.shots[0].url, { params: { token: shotToken, path: ["home.png"] } as never });
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await shot.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    // Nothing outside the folder, and nothing for a bad token.
    expect((await anon.call(serve, `/api/preview/${token}/x`, { params: { token, path: ["..", "..", "etc", "passwd"] } as never })).status).toBe(404);
    expect((await anon.call(serve, `/api/preview/${token}/x`, { params: { token, path: [".git", "config"] } as never })).status).toBe(404);
    expect((await anon.call(serve, "/api/preview/bad/index.html", { params: { token: "bad", path: ["index.html"] } as never })).status).toBe(403);
  });

  it("runs the dev server in the background and stops it", async () => {
    const { POST } = await import("@/app/api/projects/[id]/preview/route");
    const { devServer, stopDevServer } = await import("@/server/code/preview");
    const { Client } = await import("./helpers/client");
    const { signIn } = await import("./helpers/users");
    const server = "require('http').createServer((q,s)=>s.end('live')).listen(process.env.PORT,'127.0.0.1')";
    const proj = await project({ "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }), "server.js": server });
    fs.mkdirSync(path.join(proj.sb.root, "node_modules")); // nothing to install
    const client = new Client();
    signIn(client, proj.userId);
    const started = await client.json(POST, `/api/projects/${proj.p.id}/preview`, { method: "POST", params: { id: proj.p.id }, body: { action: "start" } });
    expect(started.status).toBe(200);
    expect(started.data.server).toMatchObject({ status: "starting", command: "npm run dev" });
    const port = started.data.server.port as number;
    for (let i = 0; i < 40 && devServer(proj.userId, proj.p.id)?.status !== "ready"; i++) await new Promise((r) => setTimeout(r, 250));
    expect(devServer(proj.userId, proj.p.id)?.status).toBe("ready");
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("live");
    const stopped = await client.json(POST, `/api/projects/${proj.p.id}/preview`, { method: "POST", params: { id: proj.p.id }, body: { action: "stop" } });
    expect(stopped.data.server).toBeNull();
    stopDevServer(proj.userId, proj.p.id);
  }, 20_000);
});
