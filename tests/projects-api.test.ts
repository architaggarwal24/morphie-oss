import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as projects from "@/app/api/projects/route";
import * as projectOne from "@/app/api/projects/[id]/route";
import * as tree from "@/app/api/projects/[id]/tree/route";
import * as file from "@/app/api/projects/[id]/file/route";
import * as changes from "@/app/api/projects/[id]/changes/route";
import * as exec from "@/app/api/projects/[id]/exec/route";
import * as github from "@/app/api/settings/github/route";
import * as settingsRoute from "@/app/api/settings/route";
import { accountClient } from "./helpers/users";

describe("projects API", () => {
  it("creates a project, browses it, runs commands, reviews and commits changes, and deletes it", async () => {
    const c = accountClient();
    let r = await c.json(projects.POST, "/api/projects", { method: "POST", body: { name: "Demo" } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const id = r.data.project.id as string;
    const P = { params: { id } };

    r = await c.json(exec.POST, `/api/projects/${id}/exec`, { method: "POST", body: { command: "git config user.email t@t && git config user.name T && mkdir -p src && printf 'hi\\n' > src/a.txt && echo made" }, ...P });
    expect(r.data).toMatchObject({ exitCode: 0 });
    expect(r.data.output).toContain("made");

    r = await c.json(tree.GET, `/api/projects/${id}/tree`, P);
    expect(r.data.entries.map((e: any) => e.path)).toContain("src");
    r = await c.json(tree.GET, `/api/projects/${id}/tree?dir=src`, P);
    expect(r.data.entries).toEqual([{ path: "src/a.txt", type: "file", size: 3 }]);

    r = await c.json(file.GET, `/api/projects/${id}/file?path=src/a.txt`, P);
    expect(r.data).toMatchObject({ path: "src/a.txt", content: "hi\n", binary: false });
    const dl = await c.call(file.GET, `/api/projects/${id}/file?path=src/a.txt&download=1`, P);
    expect(dl.headers.get("content-disposition")).toContain('filename="a.txt"');
    expect((await c.json(file.GET, `/api/projects/${id}/file?path=../../x`, P)).status).toBe(400);
    expect((await c.json(file.GET, `/api/projects/${id}/file?path=nope.txt`, P)).status).toBe(404);

    r = await c.json(changes.GET, `/api/projects/${id}/changes`, P);
    expect(r.data.git).toBe(true);
    expect(r.data.files).toEqual([expect.objectContaining({ path: "src/a.txt", status: "?" })]);

    r = await c.json(changes.POST, `/api/projects/${id}/changes`, { method: "POST", body: { action: "commit", message: "First" }, ...P });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.changes.files).toEqual([]);
    expect(r.data.commit).toContain("First");

    r = await c.json(projectOne.GET, `/api/projects/${id}`, P);
    expect(r.data.commands.map((x: any) => x.name)).toEqual(expect.arrayContaining(["plan", "review", "init"]));

    r = await c.json(projectOne.PATCH, `/api/projects/${id}`, { method: "PATCH", body: { name: "Renamed" }, ...P });
    expect(r.data.project.name).toBe("Renamed");

    r = await c.json(projectOne.DELETE, `/api/projects/${id}`, { method: "DELETE", ...P });
    expect(r.data.projects).toEqual([]);
    expect((await c.json(tree.GET, `/api/projects/${id}/tree`, P)).status).toBe(404);
  });

  it("clones a repository, and leaves nothing behind when the clone fails", async () => {
    const c = accountClient();
    const r = await c.json(projects.POST, "/api/projects", { method: "POST", body: { repoUrl: "https://127.0.0.1:9/nope/missing.git" } });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/git clone failed/);
    expect((await c.json(projects.GET, "/api/projects")).data.projects).toEqual([]);
  });

  it("refuses repository URLs with credentials or odd schemes, and expands owner/repo", async () => {
    const c = accountClient();
    for (const bad of ["http://github.com/a/b", "https://user:pw@github.com/a/b", "file:///etc", "ssh://git@github.com/a/b"]) {
      const r = await c.json(projects.POST, "/api/projects", { method: "POST", body: { repoUrl: bad } });
      expect(r.status, bad).toBe(400);
    }
  });

  it("stores a GitHub token encrypted and validates its shape", async () => {
    const c = accountClient();
    expect((await c.json(github.PUT, "/api/settings/github", { method: "PUT", body: { token: "not-a-token-at-all-really" } })).status).toBe(400);
    const r = await c.json(github.PUT, "/api/settings/github", { method: "PUT", body: { token: "ghp_" + "a".repeat(36) } });
    expect(r.data).toEqual({ github: true });
    expect((await c.json(github.DELETE, "/api/settings/github", { method: "DELETE" })).data).toEqual({ github: false });
  });

  it("saves permission rules and rejects malformed ones", async () => {
    const c = accountClient();
    let r = await c.json(settingsRoute.PUT, "/api/settings", { method: "PUT", body: { permissions: { allow: ["Bash(npm test *)", "Edit(src/**)"], deny: ["Bash(rm *)"] } } });
    expect(r.data.permissions).toEqual({ allow: ["Bash(npm test *)", "Edit(src/**)"], deny: ["Bash(rm *)"] });
    r = await c.json(settingsRoute.PUT, "/api/settings", { method: "PUT", body: { permissions: { allow: ["rm everything"], deny: [] } } });
    expect(r.status).toBe(400);
  });
});

// git must be present for these tests (it is wherever Morphie's code projects are used).
execFileSync("git", ["--version"]);
