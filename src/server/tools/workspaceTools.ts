import { WorkspaceError, deleteFile, listFiles, readFile, writeFile } from "../workspace";
import { ToolError, str, type ToolDef } from "./types";

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) { if (e instanceof WorkspaceError) throw new ToolError(e.message); throw e; }
};

export const workspaceList: ToolDef = {
  name: "workspace_list",
  label: "List files",
  description: "List the files in your private workspace (a sandboxed folder for notes, drafts, data and generated documents).",
  parameters: { type: "object", properties: {} },
  risk: "safe",
  modes: ["agent"],
  readOnly: true,
  parallel: true,
  describeCall: () => "List workspace files",
  async run(_a, ctx) {
    const files = await wrap(() => listFiles(ctx.actor));
    if (!files.length) return { text: "The workspace is empty.", summary: "Empty" };
    return { text: files.map((f) => `${f.path} (${f.size} bytes)`).join("\n"), summary: `${files.length} file${files.length === 1 ? "" : "s"}` };
  },
};

export const workspaceRead: ToolDef = {
  name: "workspace_read",
  label: "Read file",
  description: "Read a text file from the workspace.",
  parameters: { type: "object", properties: { path: { type: "string", description: "Relative path, e.g. notes/plan.md" } }, required: ["path"] },
  risk: "safe",
  modes: ["agent"],
  readOnly: true,
  parallel: true,
  describeCall: (a) => `Read ${String(a.path ?? "")}`,
  async run(args, ctx) {
    const p = str(args, "path", 120);
    const text = await wrap(() => readFile(ctx.actor, p));
    return { text: text || "(empty file)", summary: `${p} · ${text.length} chars` };
  },
};

export const workspaceWrite: ToolDef = {
  name: "workspace_write",
  label: "Write file",
  description: "Create or overwrite a text file in the workspace (Markdown, code, CSV, JSON, HTML…). Max 200 KB. Use it to save deliverables the user asked for. The user must approve each write.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path, e.g. reports/summary.md. Letters, digits, dot, dash, underscore only." },
      content: { type: "string", description: "The full file content." },
    },
    required: ["path", "content"],
  },
  risk: "confirm",
  modes: ["agent"],
  describeCall: (a) => `Write ${String(a.path ?? "a file")} (${typeof a.content === "string" ? a.content.length.toLocaleString() : 0} characters)`,
  async run(args, ctx) {
    const p = str(args, "path", 120);
    const content = typeof args.content === "string" ? args.content : "";
    const r = await wrap(() => writeFile(ctx.actor, p, content));
    return { text: `${r.created ? "Created" : "Updated"} ${r.path} (${r.size} bytes).`, files: [r.path], summary: `${r.created ? "Created" : "Updated"} ${r.path}` };
  },
};

export const workspaceDelete: ToolDef = {
  name: "workspace_delete",
  label: "Delete file",
  description: "Delete a file from the workspace. The user must approve each deletion.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  risk: "confirm",
  modes: ["agent"],
  describeCall: (a) => `Delete ${String(a.path ?? "a file")}`,
  async run(args, ctx) {
    const p = str(args, "path", 120);
    await wrap(() => deleteFile(ctx.actor, p));
    return { text: `Deleted ${p}.`, summary: `Deleted ${p}` };
  },
};
