import type { MessageView } from "@/lib/types";
import type { Provider } from "../providers/types";
import { BUILTIN_SKILLS } from "./builtin";
import { parseSkill, SKILL_TEMPLATE } from "./parse";

const GUIDE = BUILTIN_SKILLS.map((b) => parseSkill(b.markdown)).find((s) => s.name === "write-a-skill")?.body ?? "";

/** Distil a conversation into a reusable SKILL.md: the repeatable way of working, not the specifics of this task. */
export async function draftSkillFromConversation(provider: Provider, title: string, messages: MessageView[], signal?: AbortSignal): Promise<string> {
  const transcript = messages.map((m) => {
    const steps = m.meta?.timeline?.filter((t) => t.kind === "tool").map((t) => (t.kind === "tool" ? `  · ${t.step.name} ${JSON.stringify(t.step.args).slice(0, 160)}` : "")).join("\n");
    return `${m.role.toUpperCase()}: ${m.content.slice(0, 3000)}${steps ? `\n${steps}` : ""}`;
  }).join("\n\n").slice(-60_000);
  const r = await provider.chat({
    signal, temperature: 0.3, maxTokens: 3000,
    messages: [
      { role: "system", content: `You turn a conversation into a reusable skill for an AI agent. Capture the repeatable way of working the user wants (steps, rules, checks, preferences, commands), not the one-off details of this task. Reply with the complete SKILL.md only, no commentary.\n\nHow to write a skill:\n${GUIDE}` },
      { role: "user", content: `Conversation "${title}":\n\n${transcript}` },
    ],
  });
  let md = r.content.trim().replace(/^```(?:markdown|md)?\n/, "").replace(/\n```$/, "").trim();
  try { parseSkill(md); } catch { md = SKILL_TEMPLATE.replace("# My skill", `# ${title}\n\n${md}`); }
  return md + "\n";
}
