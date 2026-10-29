import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_SETTINGS, type AgentEvent, type AgentSettings } from "@/lib/types";
import { runAgent } from "@/server/agent/loop";
import { loadProjectInfo } from "@/server/code/project";
import { createConversation } from "@/server/conversations";
import { insertProject } from "@/server/data/projects";
import { DesignAgent } from "@/server/design/agent";
import { validateDesign } from "@/server/design/schema";
import { THEMES } from "@/server/design/themes";
import { COMPONENTS } from "@/server/design/components";
import { _rewriteUrlForTests } from "@/server/net";
import { LocalSandbox } from "@/server/sandbox/local";
import {
  createSkill, deleteSkill, designGuidance, editSkill, getSkillView, installFromGitHub, installFromLibrary, installFromUpload, library, listSkills, skillRuntime, updateFromGitHub,
} from "@/server/skills";
import { BUILTIN_SKILLS } from "@/server/skills/builtin";
import { parseGitHubUrl } from "@/server/skills/github";
import { LIBRARY } from "@/server/skills/library";
import { frontMatter, parseSkill } from "@/server/skills/parse";
import { testActor } from "./helpers/actor";
import { json, startMock, type Mock } from "./helpers/mock";
import { call, Scripted } from "./helpers/scripted";

let n = 0;
const actor = () => testActor(`skills_${++n}_abcdefghijklmnop`);
const settings = (over: Partial<AgentSettings> = {}): AgentSettings => ({ ...DEFAULT_AGENT_SETTINGS, memory: false, approval: "never", ...over });

describe("SKILL.md", () => {
  it("reads front-matter the way skills in the wild write it", () => {
    const { fields, body } = frontMatter(`---\nname: "frontend-design"\ndescription: >\n  Build distinctive\n  interfaces.\nlicense: Complete terms in LICENSE.txt\nmetadata:\n  version: 2\n---\n# Body\nText`);
    expect(fields).toMatchObject({ name: "frontend-design", description: "Build distinctive interfaces.", license: "Complete terms in LICENSE.txt" });
    expect(body).toBe("# Body\nText");
    const p = parseSkill(`---\nname: My Cool Skill\ndescription: Does a UI design thing\ndisable-model-invocation: true\n---\nSteps`);
    expect(p).toMatchObject({ name: "my-cool-skill", scope: "both", manual: true, body: "Steps" });
    expect(() => parseSkill("---\nname: x\n---\nbody")).toThrow(/description/);
    expect(() => parseSkill("no front matter at all")).toThrow(/name/);
  });

  it("every built-in skill is valid and named uniquely", () => {
    const names = BUILTIN_SKILLS.map((b) => parseSkill(b.markdown).name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["clarify-first", "plan-and-track", "verify-before-done", "frontend-aesthetics"]));
    expect(new Set(LIBRARY.map((l) => l.name)).size).toBe(LIBRARY.length);
  });

  it("understands the ways people paste GitHub links", () => {
    expect(parseGitHubUrl("anthropics/skills")).toEqual({ owner: "anthropics", repo: "skills", ref: undefined, path: "" });
    expect(parseGitHubUrl("https://github.com/anthropics/skills/tree/main/skills/frontend-design")).toEqual({ owner: "anthropics", repo: "skills", ref: "main", path: "skills/frontend-design" });
    expect(parseGitHubUrl("https://github.com/o/r/blob/dev/x/SKILL.md")).toEqual({ owner: "o", repo: "r", ref: "dev", path: "x" });
    expect(() => parseGitHubUrl("https://gitlab.com/o/r")).toThrow(/github\.com/);
    expect(() => parseGitHubUrl("o/r/../../etc")).toThrow();
  });
});

describe("installing skills", () => {
  let gh: Mock;
  const files: Record<string, string> = {
    "skills/frontend-design/SKILL.md": "---\nname: frontend-design\ndescription: Create distinctive frontend interfaces with bold design.\nlicense: Apache-2.0\n---\n# Frontend design\nCommit to a bold aesthetic direction.",
    "skills/frontend-design/LICENSE.txt": "Apache License 2.0",
    "skills/webapp-testing/SKILL.md": "---\nname: webapp-testing\ndescription: Test web apps with Playwright.\n---\nRun scripts/with_server.py",
    "skills/webapp-testing/scripts/with_server.py": "print('hi')",
    "README.md": "# repo",
  };
  let version = 1;
  beforeAll(async () => {
    gh = await startMock((req, res) => {
      if (req.url === "/api/repos/acme/skills") return json(res, { default_branch: "main" });
      if (req.url === "/api/repos/acme/skills/git/trees/main?recursive=1") return json(res, { tree: Object.keys(files).map((p) => ({ path: p, type: "blob", size: files[p].length })) });
      if (req.url === "/api/repos/acme/missing") return json(res, { message: "Not Found" }, 404);
      const m = /^\/raw\/acme\/skills\/main\/(.+)$/.exec(req.url);
      if (m && files[decodeURIComponent(m[1])] !== undefined) {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(files[decodeURIComponent(m[1])].replace("bold aesthetic", version === 1 ? "bold aesthetic" : "bold, updated aesthetic"));
      }
      json(res, { message: "nope" }, 404);
    });
    _rewriteUrlForTests((u) => new URL((u.hostname === "api.github.com" ? "/api" : "/raw") + u.pathname + u.search, gh.url));
  });
  afterAll(async () => { _rewriteUrlForTests(undefined); await gh.close(); });

  it("installs one skill from a folder link, with its files, and updates it later", async () => {
    const a = actor();
    const r = await installFromGitHub(a, "https://github.com/acme/skills/tree/main/skills/webapp-testing");
    expect(r.installed).toEqual(["webapp-testing"]);
    const list = await listSkills(a, settings());
    const s = list.find((x) => x.name === "webapp-testing")!;
    expect(s).toMatchObject({ source: "github", files: 1, enabled: true, editable: false, sourceUrl: "https://github.com/acme/skills/tree/main/skills/webapp-testing" });
    const rt = await skillRuntime(a, settings(), "agent");
    const loaded = (await rt.load("webapp-testing"))!;
    expect(loaded.body).toBe("Run scripts/with_server.py");
    expect(new TextDecoder().decode((await loaded.read("scripts/with_server.py"))!)).toBe("print('hi')");

    const fd = await installFromGitHub(a, "acme/skills/skills/frontend-design");
    expect(fd.installed).toEqual(["frontend-design"]);
    version = 2;
    await updateFromGitHub(a, (await listSkills(a, settings())).find((x) => x.name === "frontend-design")!.id);
    expect((await (await skillRuntime(a, settings(), "agent")).load("frontend-design"))!.body).toContain("bold, updated aesthetic");
    version = 1;
  });

  it("offers a choice when a link holds several skills, then installs the picked ones", async () => {
    const a = actor();
    const r = await installFromGitHub(a, "acme/skills");
    expect(r.choices?.map((c) => [c.path, c.name])).toEqual([["skills/frontend-design", "frontend-design"], ["skills/webapp-testing", "webapp-testing"]]);
    expect(r.choices?.[0].description).toMatch(/distinctive frontend/);
    const done = await installFromGitHub(a, "acme/skills", { pick: ["skills/frontend-design"] });
    expect(done.installed).toEqual(["frontend-design"]);
    // Installing the same one again updates it rather than clashing.
    expect((await installFromGitHub(a, "acme/skills", { pick: ["skills/frontend-design"] })).installed).toEqual(["frontend-design"]);
    await expect(installFromGitHub(a, "acme/missing")).rejects.toThrow(/wasn't found/);
  });

  it("installs from the library by finding the folder by name", async () => {
    const a = actor();
    LIBRARY.push({ name: "webapp-testing-acme", repo: "acme/skills", path: "moved/elsewhere", summary: "", scope: "agent", license: "MIT", category: "Engineering" });
    try {
      await expect(installFromLibrary(a, "webapp-testing-acme")).rejects.toThrow(/No skill called/);
    } finally { LIBRARY.pop(); }
    LIBRARY.unshift({ name: "webapp-testing", repo: "acme/skills", path: "moved/elsewhere", summary: "", scope: "agent", license: "MIT", category: "Engineering" });
    try {
      expect((await installFromLibrary(a, "webapp-testing")).installed).toEqual(["webapp-testing"]);
      expect((await library(a)).find((l) => l.name === "webapp-testing")?.installed).toBe(true);
    } finally { LIBRARY.shift(); }
  });
});

describe("uploads and the editor", () => {
  it("installs a SKILL.md, a zip of several skill folders, and skills written in the app", async () => {
    const a = actor();
    expect((await installFromUpload(a, "SKILL.md", strToU8("---\nname: release-notes\ndescription: Write release notes from git log.\n---\nSteps"))).installed).toEqual(["release-notes"]);
    const zip = zipSync({
      "pack/one/SKILL.md": strToU8("---\nname: one\ndescription: First.\n---\nOne"),
      "pack/one/ref.md": strToU8("reference"),
      "pack/two/SKILL.md": strToU8("---\nname: two\ndescription: Second.\n---\nTwo"),
      "__MACOSX/pack/._one": strToU8("junk"),
    });
    expect((await installFromUpload(a, "pack.skill", zip)).installed.sort()).toEqual(["one", "two"]);
    const one = (await listSkills(a, settings())).find((s) => s.name === "one")!;
    expect(one).toMatchObject({ files: 1, editable: true, source: "upload" });
    await expect(installFromUpload(a, "notes.txt", strToU8("x"))).rejects.toThrow(/SKILL\.md/);

    const id = await createSkill(a, "---\nname: house-style\ndescription: Our code style.\n---\nUse tabs.");
    await editSkill(a, id, "---\nname: house-style\ndescription: Our code style.\n---\nUse two spaces.");
    expect((await getSkillView(a, settings(), id)).markdown).toContain("two spaces");
    await expect(createSkill(a, "---\nname: house-style\ndescription: dup\n---\nx")).rejects.toThrow(/already installed/);
    await deleteSkill(a, id);
    expect((await listSkills(a, settings())).some((s) => s.name === "house-style")).toBe(false);
  });

  it("turning a skill off hides it from the agent; always-on puts it in every task", async () => {
    const a = actor();
    const off = await skillRuntime(a, settings({ skills: { disabled: ["tdd-loop"], pinned: ["clarify-first"] } }), "agent");
    expect(off.available.some((s) => s.name === "tdd-loop")).toBe(false);
    expect(off.pinned).toEqual(["clarify-first"]);
    // Design-only skills aren't offered to the agent, and agent-only ones aren't offered to the Design agent.
    const design = await skillRuntime(a, settings(), "design");
    expect(design.available.some((s) => s.name === "frontend-aesthetics")).toBe(true);
    expect(design.available.some((s) => s.name === "tdd-loop")).toBe(false);
  });
});

describe("skills in a run", () => {
  it("lists skills in the prompt, loads one with use_skill, and pins /name skills in full", async () => {
    const a = actor();
    const conv = await createConversation(a, "agent");
    const rt = await skillRuntime(a, settings(), "agent");
    const provider = new Scripted([
      { toolCalls: [call("use_skill", { name: "debug-systematically" })] },
      { content: "Found it." },
    ]);
    const events: AgentEvent[] = [];
    await runAgent({ actor: a, conversationId: conv.id, mode: "agent", message: "/tdd-loop add parseDate", prompt: "add parseDate", provider, settings: settings(), signal: new AbortController().signal, emit: (e) => events.push(e), skills: rt, pinSkills: ["tdd-loop"] });
    const first = provider.requests[0];
    expect(String(first.messages[0].content)).toMatch(/# Skills[\s\S]*- debug-systematically: /);
    expect(first.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(["use_skill", "read_skill_file"]));
    expect(String(first.messages.at(-1)!.content)).toMatch(/^add parseDate\n\nThe user wants these skills applied[\s\S]*<skill name="tdd-loop">[\s\S]*Red, green, refactor/);
    const loaded = provider.requests[1].messages.find((m) => m.role === "tool")!.content;
    expect(loaded).toMatch(/^<skill name="debug-systematically">[\s\S]*Reproduce/);
    expect(events.some((e) => e.type === "skill" && e.name === "debug-systematically")).toBe(true);
    expect(events.find((e) => e.type === "note")).toMatchObject({ text: "Using the skill tdd-loop." });
  });

  it("finds skills inside a project and copies an installed skill's scripts into the project to run them", async () => {
    const a = actor();
    await installFromUpload(a, "kit.zip", zipSync({ "kit/SKILL.md": strToU8("---\nname: lint-kit\ndescription: Lint with our script.\n---\nRun scripts/lint.sh"), "kit/scripts/lint.sh": strToU8("echo linted") }));
    const p = await insertProject(a, { name: "proj", repoUrl: null, branch: null });
    const sb = new LocalSandbox(a.userId, p.id);
    await sb.writeFile(".claude/skills/deploy-notes/SKILL.md", "---\nname: deploy-notes\ndescription: How this repo deploys.\n---\nRun make deploy.");
    const info = await loadProjectInfo(sb);
    expect(info.skills).toEqual([{ name: "deploy-notes", description: "How this repo deploys.", dir: ".claude/skills/deploy-notes", scope: "agent", manual: false }]);
    const rt = await skillRuntime(a, settings(), "agent", { sandbox: sb, skills: info.skills });
    expect(rt.available.map((s) => s.name)).toEqual(expect.arrayContaining(["deploy-notes", "lint-kit"]));
    expect((await rt.load("deploy-notes"))!.body).toBe("Run make deploy.");
    const conv = await createConversation(a, "agent", "t", p.id);
    const provider = new Scripted([{ toolCalls: [call("use_skill", { name: "lint-kit" })] }, { content: "ok" }]);
    await runAgent({
      actor: a, conversationId: conv.id, mode: "agent", message: "lint it", provider, settings: settings(), signal: new AbortController().signal, emit: () => {}, skills: rt,
      code: { ctx: { project: p, sandbox: sb, read: new Set(), projectDeny: [], changed: [] }, info: { ...info, shell: "bash", sandbox: "local", github: false, project: "proj", repoUrl: null } },
    });
    expect(fs.readFileSync(path.join(sb.root, ".morphie/skill-files/lint-kit/scripts/lint.sh"), "utf8")).toBe("echo linted");
    expect(provider.requests[1].messages.find((m) => m.role === "tool")!.content).toMatch(/copied into the project at \.morphie\/skill-files\/lint-kit\//);
  });

  it("the Design agent follows the design skills that fit the request", async () => {
    const a = actor();
    const rt = await skillRuntime(a, settings(), "design");
    const g = await designGuidance(rt, "A premium landing page for a coffee roaster with great copy");
    expect(g.used).toEqual(expect.arrayContaining(["frontend-aesthetics", "landing-page-copy"]));
    const t = THEMES["modern-saas"];
    const cur = validateDesign({ name: "Acme", theme: { ...t.colors }, typography: { ...t.typography }, style: { ...t.style }, sections: [COMPONENTS.hero.example, COMPONENTS.footer.example] });
    const p = new Scripted([{ content: JSON.stringify({ summary: "ok", operations: [] }) }]);
    await new DesignAgent().respond("make the hero more premium", cur, p, { guidance: g.text });
    const sys = p.requests[0].messages[0];
    expect(sys.content).toMatch(/Design guidance from skills[\s\S]*<skill name="frontend-aesthetics">[\s\S]*Current design \(JSON\)/);
    expect(sys.content.slice(0, sys.cacheSplit)).not.toContain("<skill");
  });
});
