/** Pluggable sandboxes: Lite projects (files only, in storage) and Morphie Runners (the user's own computer). */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as projectsRoute from "@/app/api/projects/route";
import * as runnerJobs from "@/app/api/runner/jobs/route";
import * as runnersRoute from "@/app/api/runners/route";
import * as runnerRoute from "@/app/api/runners/[id]/route";
import { codeSystemPrompt } from "@/server/agent/prompts";
import { openCode } from "@/server/code/open";
import { _resetCoordinator } from "@/server/coordinator";
import { getProject } from "@/server/data/projects";
import { decodeSegment, encodeSegment, LiteSandbox, NO_SHELL } from "@/server/sandbox/lite";
import { RunnerSandbox, runnerShell, sandboxFor } from "@/server/sandbox";
import { _resetRateLimits } from "@/server/security";
import { toolsFor } from "@/server/tools";
import { DEFAULT_AGENT_SETTINGS } from "@/lib/types";
import { accountClient } from "./helpers/users";
import { actorOf } from "./helpers/ownership";

beforeEach(() => _resetRateLimits());

describe("Lite projects", () => {
  it("keep files in storage, with any file name, folders inferred, and no shell", async () => {
    const sb = new LiteSandbox("user_abcdef", "proj_abcdef");
    expect(decodeSegment(encodeSegment("my page (1).html"))).toBe("my page (1).html");
    expect(encodeSegment("_xtrick")).not.toBe("_xtrick");
    await sb.writeFile("index.html", "<h1>Hi</h1>");
    await sb.writeFile("css/site.css", "h1 { color: red }");
    await sb.writeFile("img/my logo.svg", "<svg/>");
    await sb.writeFile("node_modules/x/index.js", "x");
    expect(await sb.readFile("index.html")).toBe("<h1>Hi</h1>");
    expect(await sb.readFile("missing.html")).toBeNull();
    await expect(sb.readFile("css")).rejects.toThrow(/folder/);
    await expect(sb.writeFile("index.html/oops.txt", "x")).rejects.toThrow(/is a file/);
    expect(Buffer.from((await sb.readBytes("img/my logo.svg"))!, "base64").toString()).toBe("<svg/>");
    expect((await sb.list("", 2)).map((e) => `${e.type}:${e.path}`)).toEqual(["dir:css", "file:css/site.css", "dir:img", "file:img/my logo.svg", "dir:node_modules", "file:index.html"]);
    expect((await sb.list("", 1)).map((e) => e.path)).toEqual(["css", "img", "node_modules", "index.html"]);
    expect(await sb.glob("**/*.css")).toEqual(["css/site.css"]);
    expect(await sb.grep("color")).toBe("css/site.css:1:h1 { color: red }");
    expect(await sb.exec("ls")).toMatchObject({ exitCode: 127, output: NO_SHELL });
    await expect(sb.clone()).rejects.toThrow(/can't clone/);
    await sb.remove("css");
    expect(await sb.glob("**/*")).not.toContain("css/site.css");
    await sb.destroy();
    expect(await sb.list()).toEqual([]);
  });

  it("are what a server with no sandbox makes, without shell tools, and the prompt says so", async () => {
    const c = accountClient();
    const r = await c.json(projectsRoute.POST, "/api/projects", { method: "POST", body: { name: "Site", sandbox: "lite" } });
    expect(r.status).toBe(200);
    expect(r.data.project.sandbox).toBe("lite");
    expect((await c.json(projectsRoute.POST, "/api/projects", { method: "POST", body: { repoUrl: "vercel/next.js", sandbox: "lite" } })).data.error).toMatch(/can't clone/);
    const actor = await actorOf(c);
    const code = await openCode(actor, (await getProject(actor, r.data.project.id))!);
    expect(code.ctx.sandbox).toBeInstanceOf(LiteSandbox);
    const names = toolsFor("agent", DEFAULT_AGENT_SETTINGS, { hasDocuments: false, code: true, shell: false }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "write_file", "edit_file", "list_files"]));
    expect(names).not.toEqual(expect.arrayContaining(["bash"]));
    expect(names).not.toContain("verify_project");
    const prompt = codeSystemPrompt({ date: "today", maxSteps: 10, memoryBlock: "", planMode: false, info: code.info });
    expect(prompt.content).toContain("This is a Lite project: files only, no shell");
    expect(prompt.content).toMatch(/pin an exact version.*integrity=/);
  });
});

/** A real HTTP server around the route handlers, so the actual runner script can talk to it. */
function serve(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = `http://${req.headers.host}${req.url}`;
    const handler = req.method === "POST" ? runnerJobs.POST : runnerJobs.GET;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r: Response = await handler(new Request(url, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }), { params: Promise.resolve({}) });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const a = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${a.port}`, close: () => { server.closeAllConnections(); server.close(); } });
  }));
}

describe("Morphie Runner", () => {
  it("names the runner's system for the agent (\"darwin\" is macOS, not Windows)", () => {
    expect(runnerShell("darwin arm64 · bash")).toMatch(/^bash on macOS/);
    expect(runnerShell("win32 x64 · cmd.exe")).toMatch(/^cmd\.exe on Windows/);
    expect(runnerShell("linux x64 · sh")).toMatch(/^sh on Linux/);
  });

  let srv: Awaited<ReturnType<typeof serve>>;
  let child: ChildProcess | undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morphie-runner-"));
  beforeAll(async () => { _resetCoordinator(); srv = await serve(); });
  afterAll(() => { child?.kill("SIGKILL"); srv.close(); });

  it("adds a runner with a one-time token, refuses bad tokens, and someone else can't remove it", async () => {
    const c = accountClient();
    const r = await c.json(runnersRoute.POST, "/api/runners", { method: "POST", body: { name: "Laptop" } });
    expect(r.data.token).toMatch(/^mr_[A-Za-z0-9]+\.[A-Za-z0-9_-]+$/);
    expect(r.data.runner).toMatchObject({ name: "Laptop", online: false, platform: "" });
    const bad = await fetch(`${srv.url}/api/runner/jobs?wait=0`, { headers: { authorization: `Bearer ${r.data.token.replace(/.$/, "x")}` } });
    expect(bad.status).toBe(401);
    expect((await accountClient().json(runnerRoute.DELETE, `/api/runners/${r.data.runner.id}`, { method: "DELETE", params: { id: r.data.runner.id } })).status).toBe(404);
    expect((await c.json(runnerRoute.DELETE, `/api/runners/${r.data.runner.id}`, { method: "DELETE", params: { id: r.data.runner.id } })).data.runners).toEqual([]);
    expect((await fetch(`${srv.url}/api/runner/jobs?wait=0`, { headers: { authorization: `Bearer ${r.data.token}` } })).status).toBe(401);
  });

  it("runs a project on the runner: the real runner script executes commands and file operations", async () => {
    const c = accountClient();
    const actor = await actorOf(c);
    const r = await c.json(runnersRoute.POST, "/api/runners", { method: "POST", body: { name: "Box" } });
    // Offline: creating a project on it fails clearly (and leaves nothing behind).
    const offline = await c.json(projectsRoute.POST, "/api/projects", { method: "POST", body: { name: "App", sandbox: `runner:${r.data.runner.id}` } });
    expect(offline.data.error).toMatch(/Runner isn't connected/);
    child = spawn(process.execPath, ["public/morphie-runner.mjs", "--server", srv.url, "--token", r.data.token, "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout!.on("data", (b) => { log += b; });
    child.stderr!.on("data", (b) => { log += b; });
    for (let i = 0; i < 100 && !(await c.json(runnersRoute.GET, "/api/runners")).data.runners[0]?.online; i++) await new Promise((res) => setTimeout(res, 100));
    const listed = (await c.json(runnersRoute.GET, "/api/runners")).data.runners[0];
    expect(listed, log).toMatchObject({ online: true, platform: expect.stringMatching(new RegExp(`^${process.platform} ${process.arch} · (bash|sh|cmd\\.exe)$`)) });

    const made = await c.json(projectsRoute.POST, "/api/projects", { method: "POST", body: { name: "App", sandbox: `runner:${r.data.runner.id}` } });
    expect(made.status, JSON.stringify(made.data)).toBe(200);
    const id = made.data.project.id;
    const sb = await sandboxFor(actor, id);
    expect(sb).toBeInstanceOf(RunnerSandbox);
    expect(sb.shell).toMatch(new RegExp(`on ${process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux"} \\(the user's own computer`));
    await sb.writeFile("src/hello.txt", "hello from morphie");
    expect(fs.readFileSync(path.join(dir, id, "src/hello.txt"), "utf8")).toBe("hello from morphie");
    expect(await sb.readFile("src/hello.txt")).toBe("hello from morphie");
    const ex = await sb.exec("cat src/hello.txt && echo $MORPHIE_RUNNER_TOKEN && pwd");
    expect(ex.exitCode).toBe(0);
    expect(ex.output).toContain("hello from morphie");
    expect(ex.output).not.toContain("mr_");
    expect(ex.output).toContain(id); // Git Bash prints /c/Users/… rather than C:\Users\…
    expect((await sb.list("", 2)).map((e) => e.path)).toEqual(expect.arrayContaining([".git", "src", "src/hello.txt"]));
    expect(await sb.glob("**/*.txt")).toEqual(["src/hello.txt"]);
    expect(await sb.grep("morphie")).toBe("src/hello.txt:1:hello from morphie");
    await expect(sb.readFile("../../etc/passwd")).rejects.toThrow(/above the project root/);
    await sb.remove("src");
    expect(fs.existsSync(path.join(dir, id, "src"))).toBe(false);
    await sb.destroy();
    expect(fs.existsSync(path.join(dir, id))).toBe(false);
  }, 30_000);
});
