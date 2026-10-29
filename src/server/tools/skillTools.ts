import { ignoreScratch } from "../code/scratch";
import { ToolError, str, type ToolDef } from "./types";

/** Files that are text (readable by the model and writable into a project); the rest are left out. */
function asText(bytes: Uint8Array): string | null {
  if (bytes.byteLength > 400_000) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.includes("\u0000") || /�{3,}/.test(text) ? null : text;
}

export const useSkillTool: ToolDef = {
  name: "use_skill",
  label: "Skill",
  description:
    "Load a skill: a tested playbook for a kind of task (listed under Skills in your instructions). Call it when the task matches a skill's description, " +
    "before doing that part of the work, then follow what it says. Returns the skill's instructions and the files that come with it.",
  parameters: { type: "object", properties: { name: { type: "string", description: "The skill's name, exactly as listed." } }, required: ["name"] },
  risk: "safe", modes: ["agent"], readOnly: true, parallel: true,
  describeCall: (a) => `Use the ${String(a.name ?? "")} skill`,
  async run(args, ctx) {
    const name = str(args, "name", 80).trim().toLowerCase();
    const skill = ctx.skills ? await ctx.skills.load(name) : null;
    if (!skill) {
      const known = ctx.skills?.available.map((s) => s.name).join(", ");
      throw new ToolError(`There's no skill called "${name}".${known ? ` Available: ${known}.` : ""}`);
    }
    ctx.emit({ type: "skill", name, stepId: ctx.stepId });
    let where = "";
    if (skill.files.length) {
      if (skill.projectDir) where = `Its files are in the project at ${skill.projectDir}/.`;
      else if (ctx.code) {
        // Scripts must be runnable: copy the skill's text files into the project (kept out of git).
        const dir = `.morphie/skill-files/${name}`;
        let copied = 0;
        for (const f of skill.files.slice(0, 200)) {
          const bytes = await skill.read(f).catch(() => null);
          const text = bytes ? asText(bytes) : null;
          if (text === null) continue;
          await ctx.code.sandbox.writeFile(`${dir}/${f}`, text).then(() => copied++, () => {});
        }
        await ignoreScratch(ctx.code.sandbox);
        where = copied ? `Its files are copied into the project at ${dir}/ (run its scripts from there, e.g. python3 ${dir}/scripts/...).` : "";
      }
    }
    const list = skill.files.length ? `\n\nFiles in this skill: ${skill.files.slice(0, 60).join(", ")}${skill.files.length > 60 ? ", …" : ""}. Read one with read_skill_file when the instructions point to it. ${where}` : "";
    return { text: `<skill name="${name}">\n${skill.body.slice(0, 40_000)}\n</skill>${list}`, summary: `${name}${skill.source === "builtin" ? "" : ` · ${skill.source}`}` };
  },
};

export const readSkillFileTool: ToolDef = {
  name: "read_skill_file",
  label: "Skill file",
  description: "Read one of a skill's extra files (references, examples, scripts) by its path inside the skill, after use_skill listed it.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "The skill's name." }, path: { type: "string", description: "The file's path inside the skill, e.g. references/colors.md" } },
    required: ["name", "path"],
  },
  risk: "safe", modes: ["agent"], readOnly: true, parallel: true,
  describeCall: (a) => `Read ${String(a.path ?? "")} from the ${String(a.name ?? "")} skill`,
  async run(args, ctx) {
    const name = str(args, "name", 80).trim().toLowerCase();
    const path = str(args, "path", 400).trim().replace(/^\.?\/+/, "");
    const skill = ctx.skills ? await ctx.skills.load(name) : null;
    if (!skill) throw new ToolError(`There's no skill called "${name}".`);
    if (!skill.files.includes(path)) throw new ToolError(`The ${name} skill has no file ${path}. Its files: ${skill.files.slice(0, 60).join(", ") || "none"}.`);
    const bytes = await skill.read(path);
    const text = bytes ? asText(bytes) : null;
    if (text === null) throw new ToolError(`${path} isn't a text file${bytes && bytes.byteLength > 400_000 ? " small enough to read" : ""}.`);
    return { text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n…[truncated]` : text, summary: `${name}/${path}` };
  },
};
