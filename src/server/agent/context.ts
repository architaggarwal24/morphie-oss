/**
 * Keeping a long run inside the model's context window, cheaply:
 *  1. clearOldToolResults: old tool output (file reads, command logs) is replaced by a one-line stub once there's a lot
 *     of it. It happens in one go, not a little every step, so the cached prompt prefix stays valid in between.
 *  2. compact: when the conversation nears the window, the middle of the run is summarised (by the helper model) into
 *     a progress note; the task, the system prompt and the latest steps stay verbatim.
 */
import type { ChatMessage, Provider, ToolSpec } from "../providers/types";
import { estimateMessages } from "../usage";

export const CLEARED = "[Earlier tool output cleared to save context";
const KEEP_RECENT_RESULTS = 6;
const CLEAR_TRIGGER_CHARS = 48_000;

/** Returns how many results were cleared. Mutates `messages`. */
export function clearOldToolResults(messages: ChatMessage[], opts: { keep?: number; triggerChars?: number } = {}): number {
  const keep = opts.keep ?? KEEP_RECENT_RESULTS;
  const tools = messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role === "tool" && !m.content.startsWith(CLEARED));
  const live = tools.reduce((n, { m }) => n + m.content.length, 0);
  if (live <= (opts.triggerChars ?? CLEAR_TRIGGER_CHARS) || tools.length <= keep) return 0;
  let cleared = 0;
  for (const { m, i } of tools.slice(0, tools.length - keep)) {
    if (m.content.length < 400) continue;
    const first = m.content.split("\n").find((l) => l.trim())?.trim().slice(0, 140) ?? "";
    messages[i] = { ...m, content: `${CLEARED}: ${m.name ?? "tool"} returned ${m.content.length.toLocaleString("en-US")} characters starting “${first}”. Run it again if you need the details.]` };
    cleared++;
  }
  return cleared;
}

/** The context window to plan for: the model's own when known, otherwise a conservative 64k. */
export function windowOf(p: Provider): number {
  return p.contextWindow && p.contextWindow > 4000 ? p.contextWindow : 64_000;
}

export function needsCompaction(messages: ChatMessage[], tools: ToolSpec[] | undefined, provider: Provider): boolean {
  return estimateMessages(messages, tools) > windowOf(provider) * 0.6;
}

const SUMMARY_PROMPT = [
  "You are compacting the working notes of a coding/research agent so it can keep going with less context.",
  "Write a dense progress note (at most ~500 words) that lets the agent continue without the earlier steps. Include:",
  "- the goal and any requirements or decisions the user gave;",
  "- what has been done: files created/changed (paths) and what each contains, commands run and their outcome;",
  "- the current state: what works, what fails (exact error messages), what was verified;",
  "- what remains, in order.",
  "Facts only, no pleasantries. Don't invent anything that isn't in the transcript.",
].join("\n");

function transcript(messages: ChatMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.content.trim()) out.push(`AGENT: ${m.content.trim().slice(0, 1200)}`);
      for (const c of m.toolCalls ?? []) out.push(`CALL ${c.name} ${JSON.stringify(c.arguments).slice(0, 600)}`);
    } else if (m.role === "tool") out.push(`RESULT ${m.name ?? ""}: ${m.content.slice(0, 1000)}`);
    else if (m.role === "user") out.push(`USER: ${m.content.slice(0, 1500)}`);
  }
  return out.join("\n");
}

/** A summary that needs no model: the calls made and the notes in between. */
function mechanicalSummary(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.content.trim()) lines.push(`- ${m.content.trim().split("\n")[0].slice(0, 200)}`);
      for (const c of m.toolCalls ?? []) lines.push(`  · ${c.name}(${JSON.stringify(c.arguments).slice(0, 120)})`);
    }
  }
  return lines.slice(-80).join("\n");
}

/**
 * Summarise the middle of the run. `taskIndex` is the user message that started the task (kept verbatim, with the
 * summary appended to it so roles still alternate). Returns false when there was nothing worth compacting.
 */
export async function compact(messages: ChatMessage[], taskIndex: number, helper: Provider, signal: AbortSignal, extra = ""): Promise<boolean> {
  // The newest ~4 rounds stay as they are; the cut must land on an assistant turn so tool calls keep their results.
  let cut = messages.length;
  let rounds = 0;
  for (let i = messages.length - 1; i > taskIndex; i--) {
    if (messages[i].role === "assistant") { rounds++; cut = i; if (rounds >= 4) break; }
  }
  const middle = messages.slice(taskIndex + 1, cut);
  if (middle.length < 6) return false;
  let summary = "";
  try {
    const r = await helper.chat({ messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: transcript(middle).slice(-120_000) }], signal, temperature: 0.2, maxTokens: 1500 });
    summary = r.content.trim();
  } catch (e) {
    if (signal.aborted) throw e;
  }
  if (!summary) summary = `Steps taken so far (automatic summary):\n${mechanicalSummary(middle)}`;
  const task = messages[taskIndex];
  const note = `\n\n---\n[Progress so far — earlier steps of this task were summarised to save context]\n${summary}${extra ? `\n${extra}` : ""}`;
  messages.splice(taskIndex, cut - taskIndex, { ...task, content: task.content.split("\n\n---\n[Progress so far")[0] + note });
  return true;
}
