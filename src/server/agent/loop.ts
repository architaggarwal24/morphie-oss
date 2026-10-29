import type { Actor } from "../auth/actor";
import { TASK_BUDGET } from "@/lib/types";
import type { AgentEvent, AgentSettings, ApprovalPreview, AskQuestion, AssistantMeta, Deliverables, Mode, PlanItem, SourceRef, StopReason, TimelineItem, ToolStep } from "@/lib/types";
import { openCode, type RunCode } from "../code/open";
import { createProjectFor, fileSlug, projectFiles } from "../code/projects";
import { config, LIMITS } from "../config";
import { addMessage, getConversation, getMessages, setConversationProject, setTitle, titleFrom, updateMessageMeta } from "../conversations";
import { touchProject } from "../data/projects";
import { ApiError } from "../http";
import { formatMemoriesForPrompt, rememberFromTurn, searchMemories } from "../memory";
import { ProviderError, type ChatMessage, type ImagePart, type Provider, type ToolCall } from "../providers/types";
import { hasDocuments } from "../rag";
import { saveSettings } from "../settings";
import { allTools, decideApproval, toolsFor } from "../tools";
import { ToolError, type ToolContext, type ToolDef, type ToolResult } from "../tools/types";
import { pinnedBlock, type SkillRuntime } from "../skills";
import { metered } from "../usage";
import { createCheckpoint } from "../code/checkpoints";
import { throttledActivity } from "./activity";
import { requestApproval } from "./approvals";
import { clearOldToolResults, compact, needsCompaction } from "./context";
import {
  BUDGET_LAST_NOTICE, budgetLowNotice, codeSystemPrompt, continueNotice, CUT_OFF_NOTICE, LAST_STEP_NOTICE, systemPrompt, VERIFY_FAILED_GATE, VERIFY_GATE, wrapUntrusted,
  type SystemPrompt,
} from "./prompts";
import { deleteSnapshot, loadSnapshot, repairToolPairs, saveSnapshot, type RunSnapshot } from "./snapshot";

const allToolNames = () => new Set(allTools().map((t) => t.name));

export interface RunInput {
  actor: Actor;
  conversationId: string;
  mode: Mode;
  message: string;
  provider: Provider;
  settings: AgentSettings;
  signal: AbortSignal;
  emit: (e: AgentEvent) => void;
  /** Regenerate: the user message is already stored. */
  skipUserSave?: boolean;
  /** What the model gets instead of `message` (a slash command's expansion). `message` is what's stored and shown. */
  prompt?: string;
  /** Start in plan mode (read-only until a plan is approved). */
  planMode?: boolean;
  /** The task belongs to a code project. */
  code?: RunCode;
  /** A cheaper model for sub-agents, compaction and memory (Settings → Agent). Default: `provider`. */
  helper?: Provider;
  /** Tokens this run may use (agent mode). Default: settings.taskTokenBudget. */
  budget?: number;
  /** Pick up a paused run (the Continue button) instead of starting from a new message. */
  resume?: boolean;
  /** Workers Free: waits, when it's time, for a fresh invocation to carry the run on (agent/slices.ts). */
  slice?: (signal: AbortSignal) => Promise<void>;
  /** Agent mode without a project: the model may create one (create_project) when the task needs to run code. */
  canCreateProject?: boolean;
  /** The skills this run can use (agent mode). */
  skills?: SkillRuntime;
  /** Skills the user asked for with this message (/name), loaded in full up front. */
  pinSkills?: string[];
}

const HISTORY_CHAR_BUDGET = 24_000;
const MAX_REASONING = 6000;
const CHAT_MAX_STEPS = 6;
/** Most "done?" nudges per run: after that the model's answer stands. */
const MAX_GATES = 2;
/** Commands that change the project (anything else is treated as looking around). */
const WRITES = /(\binstall\b|\badd\b|\bcreate\b|\binit\b|>|\bsed\s+-i|\bmv\b|\brm\b|\bcp\b|\bmkdir\b|\btouch\b|\bgit\s+(checkout|apply|merge|pull|reset|restore|stash)|\bpatch\b|\bunzip\b|\btar\b|\bcurl\b.*-o)/;
const STOP_WHY: Record<StopReason, string> = {
  complete: "it finished", max_steps: "it reached the step limit", budget: "it used its token budget", aborted: "it was stopped",
  error: "an error interrupted it", approval_timeout: "an approval wasn't answered in time", interrupted: "the server restarted",
  credits: "the plan's credits for the model ran out",
};

/** Ends the run early but cleanly, as a paused (continuable) reply. */
/** How long an ask_user card waits before the run pauses (Continue picks it up again). */
export const QUESTION_TIMEOUT_MS = 30 * 60_000;

class PauseRun extends Error { constructor(public reason: StopReason, message: string) { super(message); } }

async function historyFor(actor: Actor, conversationId: string): Promise<ChatMessage[]> {
  const rows = await getMessages(actor, conversationId, LIMITS.maxHistoryMessages);
  const out: ChatMessage[] = [];
  let budget = HISTORY_CHAR_BUDGET;
  for (let i = rows.length - 1; i >= 0 && budget > 0; i--) {
    const r = rows[i];
    let content = r.content;
    if (r.role === "assistant" && r.meta?.files?.length) content += `\n\n[Files written in that turn: ${r.meta.files.join(", ")}]`;
    if (!content.trim()) continue;
    if (content.length > budget) {
      if (out.length) break;
      content = content.slice(0, budget);
    }
    out.unshift({ role: r.role, content });
    budget -= content.length;
  }
  return out;
}

function stepId(n: number, i: number): string {
  return `s${n}_${i}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + `\n…[truncated ${text.length - max} characters]` : text;
}

function normalize(res: string | ToolResult): ToolResult {
  return typeof res === "string" ? { text: res } : res;
}

const asSystem = (p: SystemPrompt): ChatMessage => ({ role: "system", content: p.content, cacheSplit: p.cacheSplit });

export async function runAgent(input: RunInput): Promise<void> {
  const started = Date.now();
  const { actor, conversationId, mode, signal, emit } = input;
  const settings = input.settings;
  // The agent decides how many steps a task needs; the server's cap only stops a model that loops.
  const maxSteps = Math.max(2, mode === "agent" ? Math.min(config.maxAgentSteps, settings.maxSteps ?? Number.POSITIVE_INFINITY) : CHAT_MAX_STEPS);
  const conv = await getConversation(actor, conversationId);
  if (!conv) { emit({ type: "error", message: "That conversation no longer exists.", code: "not_found" }); return; }

  // ---------------------------------------------------------------- accounting
  // Every model call of this run counts: the main model, sub-agents, compaction and memory. Prompt-cache hits count a
  // tenth (roughly what they cost), so a well-cached long run stretches its budget.
  const wanted = Number(input.budget ?? settings.taskTokenBudget);
  const budget = mode === "agent" ? Math.max(1000, Number.isFinite(wanted) && wanted > 0 ? wanted : TASK_BUDGET.default) : Number.POSITIVE_INFINITY;
  let used = 0;
  const totals = { input: 0, output: 0, cached: 0 };
  const onUsage = (u: { input: number; output: number; cached: number }) => {
    totals.input += u.input; totals.output += u.output; totals.cached += u.cached;
    used += Math.max(0, u.input - u.cached) + u.output + Math.round(u.cached / 10);
  };
  let code: RunCode | undefined = input.code;
  const featureOf = () => (code ? "code" : mode) as "code" | "agent" | "chat";
  const provider = metered(input.provider, { actor, feature: featureOf(), conversationId, onUsage });
  const helper = metered(input.helper ?? input.provider, { actor, feature: "subagent", conversationId, onUsage });

  // ---------------------------------------------------------------- the conversation so far
  const resume = !!input.resume;
  const snap = resume ? await loadSnapshot(actor, conversationId) : null;
  const priorRows = resume ? await getMessages(actor, conversationId, 5) : [];
  const prior = snap ? [] : await historyFor(actor, conversationId);
  if (!input.skipUserSave && !resume) await addMessage(actor, conversationId, "user", input.message);

  const docs = await hasDocuments(actor);
  const memoryQuery = resume ? snap?.message ?? input.message : input.message;
  const memories = settings.memory ? await searchMemories(actor, memoryQuery, 5) : [];
  const flags: ToolContext["flags"] = { planMode: !!input.planMode && mode === "agent" && !resume };
  const date = new Date().toLocaleDateString("en-GB", { dateStyle: "full" });
  const canCreate = mode === "agent" && !!input.canCreateProject;
  const buildSystem = (): ChatMessage => asSystem(code
    ? codeSystemPrompt({ date, maxSteps, memoryBlock: formatMemoriesForPrompt(memories), planMode: flags.planMode, info: code.info, budget: mode === "agent" ? budget : undefined, skills: input.skills?.available })
    : systemPrompt(mode, { date, maxSteps, memoryBlock: formatMemoriesForPrompt(memories), hasDocuments: docs, planMode: flags.planMode, budget: mode === "agent" ? budget : undefined, canCreateProject: canCreate && !code, skills: input.skills?.available }));

  let messages: ChatMessage[];
  let taskIndex: number;
  if (snap && snap.status !== "done" && snap.messages.length > 1) {
    messages = repairToolPairs(snap.messages);
    messages[0] = buildSystem();
    taskIndex = Math.max(1, messages.findIndex((m, i) => i > 0 && m.role === "user" && m.content.startsWith(snap.message.slice(0, 200))));
    if (taskIndex < 1) taskIndex = 1;
    messages.push({ role: "user", content: continueNotice(STOP_WHY[snap.reason ?? "interrupted"]) });
  } else {
    messages = [buildSystem(), ...prior, { role: "user", content: resume ? continueNotice("the previous reply was cut off") : input.prompt ?? input.message }];
    taskIndex = messages.length - 1;
    if (resume) taskIndex = Math.max(1, messages.map((m) => m.role).lastIndexOf("user", messages.length - 2));
  }
  // Skills the user pinned (always on, or /name with this message) come with the task, in full.
  const pinnedSkills: string[] = [];
  if (!resume && input.skills && mode === "agent") {
    const pin = await pinnedBlock(input.skills, [...(input.pinSkills ?? []), ...input.skills.pinned]);
    if (pin.text) { messages[taskIndex] = { ...messages[taskIndex], content: `${messages[taskIndex].content}\n\n${pin.text}` }; pinnedSkills.push(...pin.used); }
  }
  // The reply being continued loses its Continue button: this run picks it up.
  if (resume) {
    const prev = [...priorRows].reverse().find((m) => m.role === "assistant");
    if (prev?.meta?.continuable) await updateMessageMeta(actor, conversationId, prev.id, { ...prev.meta, continuable: false });
  }
  const projectDeny = () => code?.ctx.projectDeny ?? [];

  // Plan mode can end mid-run (exit_plan_mode approved) and a project can appear (create_project), so the tool set is
  // worked out again for every step.
  const hasSkills = !!input.skills && (input.skills.available.length > 0 || pinnedSkills.length > 0);
  const scope = () => ({ hasDocuments: docs, code: !!code, shell: code ? code.ctx.sandbox.canExec : undefined, planMode: flags.planMode, canCreateProject: canCreate && !code, skills: hasSkills });
  let tools = toolsFor(mode, settings, scope());
  let registry = new Map<string, ToolDef>(tools.map((t) => [t.name, t]));

  const timeline: TimelineItem[] = pinnedSkills.length ? [{ kind: "note", text: `Using ${pinnedSkills.length === 1 ? "the skill" : "the skills"} ${pinnedSkills.join(", ")}.` }] : [];
  const sources: SourceRef[] = [];
  const files: string[] = [];
  let plan: PlanItem[] | undefined = snap?.plan;
  let reasoning = "";
  let finalText = "";
  let stopped = false;
  let errorMessage: string | undefined;
  let reason: StopReason = "complete";
  const seen = new Map<string, number>();
  let projectCreated = !!snap?.projectCreated;
  let created = 0;
  let dirty = !!snap?.dirty;
  let verified: { passed: boolean; checks: string } | null = snap?.verified ?? null;
  let gates = 0;
  let lowWarned = false;
  /** Tool rounds since the plan was last updated (weaker models forget to tick it off). */
  let roundsSincePlan = 0;

  const ctxEmit = (e: AgentEvent) => {
    if (e.type === "plan") plan = e.items;
    if (e.type === "file_change" && e.kind === "created") created++;
    if (e.type === "tool_progress") {
      const item = timeline.find((t) => t.kind === "tool" && t.step.id === e.stepId);
      if (item?.kind === "tool") item.step.progress = e.text;
    }
    emit(e);
  };

  /** The checkpoint of the project's files from before this run (see createCheckpoint). */
  let rewindTo: string | null = null;
  const createProject = canCreate ? async (name: string, repoUrl?: string): Promise<string> => {
    if (code) throw new ToolError("This task already has a project.");
    let made;
    try { made = await createProjectFor(actor, { name, repoUrl }); }
    catch (e) { if (e instanceof ApiError) throw new ToolError(e.message); throw e; }
    await setConversationProject(actor, conversationId, made.project.id);
    try { code = await openCode(actor, made.project); }
    catch (e) { throw new ToolError(`The project was created but its sandbox couldn't start: ${e instanceof Error ? e.message : "error"}`); }
    ctx.code = code.ctx;
    projectCreated = true;
    // Rewinding this message's code goes back to the project as it was made (empty, or just cloned).
    if (!rewindTo) rewindTo = await createCheckpoint(code.ctx.sandbox, "new project");
    dirty = true;
    messages[0] = buildSystem();
    emit({ type: "project", project: made.project });
    return [
      `Created the project "${made.project.name}" and moved this task into it.${repoUrl ? ` It's a clone of ${repoUrl}.` : " It's empty."}`,
      `Shell: ${code.info.shell}. You now have read_file, write_file, edit_file, list_files, glob, grep, bash and verify_project (paths are relative to the project root).`,
      "Build the complete project here, then run verify_project and fix what it reports until it passes.",
    ].join("\n");
  } : undefined;

  const ctx: ToolContext = { actor, conversationId, mode, signal, settings, provider, helper, emit: ctxEmit, flags, code: code?.ctx, createProject, skills: input.skills };
  const pendingImages: ImagePart[] = [];

  /** Run one tool call (approval, permission rules, the tool itself) and return the message for the model. */
  const runCall = async (n: number, i: number, call: ToolCall): Promise<ChatMessage> => {
    const id = stepId(n, i);
    const tool = registry.get(call.name);
    const step: ToolStep = { id, name: call.name, args: call.arguments, status: "running" };
    const sig = `${call.name}:${JSON.stringify(call.arguments)}`;
    const t0 = Date.now();
    const finish = (status: ToolStep["status"], text: string, extra: { summary?: string; error?: string; diff?: string } = {}) => {
      step.status = status;
      step.ms = Date.now() - t0;
      step.output = status === "done" ? clip(text, 2000) : undefined;
      step.error = extra.error;
      step.summary = extra.summary ?? step.summary;
      step.diff = extra.diff ? clip(extra.diff, 8000) : undefined;
      step.progress = undefined;
      emit({ type: "tool_end", stepId: id, status, output: step.output, error: extra.error, ms: step.ms, summary: step.summary, diff: step.diff });
    };
    const reply = (text: string): ChatMessage => ({ role: "tool", toolCallId: call.id, name: call.name, content: text });

    timeline.push({ kind: "tool", step });
    if (!tool) {
      emit({ type: "tool_start", step });
      const known = [...registry.keys()];
      const hint = flags.planMode && allToolNames().has(call.name) ? " Plan mode is on: only read-only tools are available until exit_plan_mode is approved." : "";
      const msg = `Unknown tool "${call.name}".${hint} Available tools: ${known.join(", ") || "none"}.`;
      finish("error", msg, { error: msg }); return reply(`Error: ${msg}`);
    }
    if (call.error) {
      emit({ type: "tool_start", step });
      finish("error", call.error, { error: call.error }); return reply(`Error: ${call.error} Send valid JSON arguments.`);
    }
    const count = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, count);
    // verify_project is meant to be repeated (after each fix); everything else twice at most.
    if (count > 2 && tool.name !== "verify_project") {
      emit({ type: "tool_start", step });
      const msg = "You already made this exact call twice. Use the earlier result or take a different approach.";
      finish("error", msg, { error: msg }); return reply(`Error: ${msg}`);
    }

    const verdict = decideApproval(tool, call.arguments, ctx.settings, projectDeny());
    if (verdict.action === "deny") {
      emit({ type: "tool_start", step });
      const msg = `Blocked by the permission rule ${verdict.rule}.`;
      finish("denied", "", { error: msg });
      return reply(`${msg} Don't try to get around it; do the task another way or tell the user what you couldn't do.`);
    }
    step.needsApproval = verdict.action === "ask";
    step.summary = tool.describeCall?.(call.arguments);
    if (verdict.action === "ask") {
      step.status = "waiting";
      emit({ type: "tool_start", step });
      let preview: ApprovalPreview | undefined;
      try { preview = await tool.preview?.(call.arguments, ctx); } catch { preview = undefined; }
      if (verdict.suggest) preview = { ...preview, rule: verdict.suggest };
      const req = await requestApproval(actor.userId, signal);
      emit({ type: "approval", id: req.id, stepId: id, tool: tool.name, args: call.arguments, reason: tool.describeCall?.(call.arguments) ?? `Run ${tool.label}`, preview });
      const decision = await req.decision;
      if (signal.aborted) throw new ProviderError("Stopped.");
      if (decision.timedOut) {
        finish("error", "", { error: "Nobody answered this approval in time." });
        throw new PauseRun("approval_timeout", "Paused: an approval waited too long for an answer. Press Continue to pick the task up again.");
      }
      if (!decision.approved) {
        if (tool.name === "exit_plan_mode") {
          finish("denied", "", { error: "Not yet: keep planning." });
          return reply("The user didn't approve the plan yet. Stay in plan mode: ask what they'd like changed, or refine the plan and present it again.");
        }
        finish("denied", "", { error: "You declined this action." });
        return reply("The user denied this action. Do not try it again. Continue without it or explain what you couldn't do.");
      }
      if (decision.always && !tool.alwaysAsk) {
        if (verdict.suggest) {
          if (!ctx.settings.permissions.allow.includes(verdict.suggest)) {
            ctx.settings = await saveSettings(actor, { permissions: { ...ctx.settings.permissions, allow: [...ctx.settings.permissions.allow, verdict.suggest] } });
          }
        } else if (!ctx.settings.alwaysAllow.includes(tool.name)) {
          ctx.settings = await saveSettings(actor, { alwaysAllow: [...ctx.settings.alwaysAllow, tool.name] });
        }
        settings.alwaysAllow = ctx.settings.alwaysAllow;
        settings.permissions = ctx.settings.permissions;
      }
      step.status = "running";
      emit({ type: "tool_start", step });
    } else {
      emit({ type: "tool_start", step });
    }

    /** ask_user: show the question card and wait (the run pauses if nobody answers for a long time). */
    const ask = async (questions: AskQuestion[]): Promise<Record<string, string> | null> => {
      step.status = "waiting";
      const req = await requestApproval(actor.userId, signal, QUESTION_TIMEOUT_MS);
      emit({ type: "question", id: req.id, stepId: id, questions });
      const decision = await req.decision;
      if (signal.aborted) throw new ProviderError("Stopped.");
      step.status = "running";
      if (decision.timedOut) throw new PauseRun("approval_timeout", "Paused: the agent is waiting for your answers. Press Continue when you're back.");
      return decision.approved && decision.answers ? decision.answers : null;
    };

    try {
      const out = normalize(await tool.run(call.arguments, { ...ctx, stepId: id, subagentTools: tools.filter((t) => t.readOnly), ask }));
      if (out.sources) for (const s of out.sources) if (!sources.some((x) => x.url && x.url === s.url && x.title === s.title)) sources.push(s);
      if (out.files) for (const f of out.files) if (!files.includes(f)) files.push(f);
      if (tool.name === "write_file" || tool.name === "edit_file" || (tool.name === "bash" && WRITES.test(String(call.arguments.command ?? "")))) dirty = true;
      if (out.verify) { verified = out.verify; dirty = !out.verify.passed; }
      if (out.images?.length && provider.vision) pendingImages.push(...out.images.slice(0, 2));
      const text = clip(out.text, LIMITS.toolOutputChars);
      finish("done", out.text, { summary: out.summary, diff: out.diff });
      return reply(tool.untrusted ? wrapUntrusted(tool.name, text) : text);
    } catch (e) {
      if (signal.aborted) throw new ProviderError("Stopped.");
      if (e instanceof PauseRun) { finish("error", "", { error: "Nobody answered in time." }); throw e; }
      const msg = e instanceof ToolError ? e.message : "The tool failed unexpectedly.";
      if (!(e instanceof ToolError)) console.error(`[tool:${tool.name}]`, e);
      finish("error", msg, { error: msg });
      return reply(`Error: ${msg}`);
    }
  };

  const snapshot = (status: RunSnapshot["status"]): RunSnapshot => ({
    v: 1, status, reason, mode, startedAt: started, updatedAt: Date.now(), message: snap?.message ?? input.message, messages, timeline, plan, sources, files,
    changed: code?.ctx.changed ?? [], used, projectId: code?.ctx.project.id ?? null, projectCreated, dirty, verified,
  });
  const checkpoint = () => saveSnapshot(actor, conversationId, snapshot("running")).catch((e) => console.error("[run] snapshot", e));

  emit({ type: "start", conversationId, mode, provider: input.provider.label, model: input.provider.model });
  if (timeline[0]?.kind === "note") emit({ type: "note", text: timeline[0].text });
  // Named straight away, so a run that keeps going in the background is recognisable in the sidebar.
  if (conv.title === "New conversation" && !resume) {
    const title = titleFrom(input.message);
    await setTitle(actor, conversationId, title);
    emit({ type: "title", title });
  }
  if (mode === "agent") emit({ type: "budget", used: 0, budget });
  await checkpoint();
  // The project's files as they were before this message, so the user can rewind to here.
  if (code && !resume && mode === "agent") {
    emit({ type: "activity", text: "Saving a checkpoint" });
    rewindTo = await createCheckpoint(code.ctx.sandbox, titleFrom(input.message));
  }

  /** The model wants to stop: is the project actually verified? (Only for real builds; small edits aren't held up.) */
  const gate = (): string | null => {
    if (!code || flags.planMode || gates >= MAX_GATES || used > budget * 0.9 || !registry.has("verify_project")) return null;
    if (!(projectCreated || created >= 3)) return null;
    if (dirty) return VERIFY_GATE;
    if (verified && !verified.passed) return VERIFY_FAILED_GATE;
    return null;
  };

  try {
    for (let n = 1; ; n++) {
      if (signal.aborted) throw new ProviderError("Stopped.");
      // Workers Free: every few steps the run carries on in a fresh invocation (agent/slices.ts).
      if (n > 1 && input.slice) {
        await input.slice(signal);
        if (signal.aborted) throw new ProviderError("Stopped.");
      }
      emit({ type: "step", n, max: maxSteps });
      const atCap = n >= maxSteps && n > 1;
      const broke = mode === "agent" && n > 1 && used >= budget * 0.97;
      const last = atCap || broke;
      if (last) messages.push({ role: "user", content: atCap ? LAST_STEP_NOTICE : BUDGET_LAST_NOTICE });
      else if (mode === "agent" && !lowWarned && used >= budget * 0.8) { lowWarned = true; messages.push({ role: "user", content: budgetLowNotice(budget - used) }); }
      tools = toolsFor(mode, ctx.settings, scope());
      registry = new Map<string, ToolDef>(tools.map((t) => [t.name, t]));
      const specs = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

      // Keep the context small: old tool output becomes stubs, and near the window the middle is summarised.
      clearOldToolResults(messages);
      if (needsCompaction(messages, specs, provider)) {
        const changed = code?.ctx.changed.length ? `Files changed so far: ${code.ctx.changed.slice(0, 80).join(", ")}` : "";
        if (await compact(messages, taskIndex, metered(helper, { actor, feature: "compaction" }), signal, changed)) {
          emit({ type: "notice", text: "Summarised earlier steps to stay within the model's context window." });
        } else clearOldToolResults(messages, { keep: 2, triggerChars: 0 });
      }

      let streamed = "";
      emit({ type: "activity", text: n === 1 || last ? "Thinking" : "Reading the results" });
      const result = await provider.chat({
        messages, signal, temperature: settings.temperature,
        tools: last ? undefined : specs.length ? specs : undefined,
        onText: (d) => { streamed += d; emit({ type: "text", delta: d }); },
        onToolDelta: throttledActivity((text, chars) => emit({ type: "activity", text, chars })),
        onReasoning: (d) => {
          if (reasoning.length < MAX_REASONING) reasoning += d;
          emit({ type: "thinking", delta: d });
        },
      });
      if (mode === "agent") emit({ type: "budget", used, budget });
      if (result.reasoning && !reasoning) reasoning = result.reasoning.slice(0, MAX_REASONING);

      if (!result.toolCalls.length || last) {
        const text = result.content || streamed;
        const nudge = !last && text.trim() ? gate() : null;
        if (nudge) {
          // Not done yet: what it said becomes commentary, and it's asked to verify first.
          gates++;
          timeline.push({ kind: "note", text: text.trim() });
          emit({ type: "note", text: text.trim() });
          messages.push({ role: "assistant", content: text }, { role: "user", content: nudge });
          await checkpoint();
          continue;
        }
        finalText = text;
        if (!finalText.trim()) {
          finalText = "";
          errorMessage = "The model returned an empty reply. Try again, or pick a different model.";
          reason = "error";
        }
        if (atCap) reason = "max_steps";
        else if (broke) reason = "budget";
        break;
      }

      // The model is calling tools: whatever it said first is commentary, not the answer.
      const commentary = (result.content || streamed).trim();
      if (commentary) { timeline.push({ kind: "note", text: commentary }); emit({ type: "note", text: commentary }); }
      else emit({ type: "note", text: "" });
      messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });

      // Calls that change nothing and need no approval run together (parallel sub-agents, batches of searches);
      // everything else runs one at a time, in order.
      const prepared = result.toolCalls.map((call, i) => ({ call, i, tool: registry.get(call.name) }));
      let k = 0;
      try {
        while (k < prepared.length) {
          if (signal.aborted) throw new ProviderError("Stopped.");
          const canBatch = (p: (typeof prepared)[number]) => !!p.tool?.parallel && !p.call.error && decideApproval(p.tool, p.call.arguments, ctx.settings, projectDeny()).action === "run";
          if (canBatch(prepared[k])) {
            let j = k;
            while (j < prepared.length && canBatch(prepared[j])) j++;
            const group = prepared.slice(k, j);
            const replies = await Promise.all(group.map((p) => runCall(n, p.i, p.call)));
            for (const r of replies) messages.push(r);
            k = j;
          } else {
            messages.push(await runCall(n, prepared[k].i, prepared[k].call));
            k++;
          }
        }
      } finally {
        // Whatever happened, every call has an answer before anything else is said.
        messages = repairToolPairs(messages);
      }
      if (/length|max_tokens|MAX_TOKENS/i.test(result.finishReason ?? "") && result.toolCalls.some((c) => c.error)) messages.push({ role: "user", content: CUT_OFF_NOTICE });
      // Keep the checklist honest: after a few rounds without an update, show the model its own plan again.
      roundsSincePlan = result.toolCalls.some((c) => c.name === "update_plan") ? 0 : roundsSincePlan + 1;
      if (plan?.some((p) => p.status !== "done") && roundsSincePlan >= 4 && registry.has("update_plan")) {
        roundsSincePlan = 0;
        messages.push({ role: "user", content: planReminder(plan) });
      }
      if (pendingImages.length) {
        messages.push({ role: "user", content: "Screenshots of the app from verify_project (look for broken layout, missing content or error messages):", images: pendingImages.splice(0) });
      }
      await checkpoint();
    }
  } catch (e) {
    if (e instanceof PauseRun) { reason = e.reason; errorMessage = e.message; emit({ type: "notice", text: e.message }); }
    else if (e instanceof ProviderError && e.status === 402 && !signal.aborted) {
      // Out of plan credits (Morphie AI): pause like a spent budget, so Continue picks it up (on a free model, or later).
      reason = "credits"; errorMessage = e.message; emit({ type: "notice", text: e.message });
    }
    else if (signal.aborted) { stopped = true; reason = "aborted"; }
    else {
      reason = "error";
      errorMessage = e instanceof ProviderError ? e.message : "Something went wrong while running the model.";
      if (!(e instanceof ProviderError)) console.error("[agent]", e);
      emit({ type: "error", message: errorMessage });
    }
  }

  // If we were stopped mid-tool, mark any still-running steps.
  for (const item of timeline) if (item.kind === "tool" && (item.step.status === "running" || item.step.status === "waiting")) item.step.status = "error", item.step.error = "Stopped before finishing.";

  // The container's disk is temporary: save the project (no-op locally). Never fails the reply.
  if (code) {
    await code.ctx.sandbox.checkpoint().catch((e) => console.error("[sandbox] checkpoint", e));
    await touchProject(actor, code.ctx.project.id).catch(() => {});
  }

  const deliverables = flags.planMode ? undefined : await collectDeliverables({ code, projectCreated, files, verified, title: conv.title === "New conversation" ? titleFrom(snap?.message ?? input.message) : conv.title });
  if (deliverables) emit({ type: "deliverables", deliverables });

  const continuable = reason !== "complete" && !(reason === "error" && !timeline.length && !finalText);
  const meta: AssistantMeta = {
    timeline: timeline.length ? timeline : undefined,
    plan, sources: sources.length ? sources.slice(0, 12) : undefined, files: files.length ? files : undefined,
    changed: code?.ctx.changed.length ? code.ctx.changed.slice(0, 200) : undefined,
    reasoning: reasoning || undefined, provider: input.provider.label, model: input.provider.model,
    usage: totals.input || totals.output ? { input: totals.input, output: totals.output, cached: totals.cached || undefined } : undefined,
    stopped: stopped || undefined, error: errorMessage,
    reason, continuable: continuable || undefined, ms: Date.now() - started,
    budget: mode === "agent" ? { used, limit: budget } : undefined,
    deliverables, projectId: projectCreated ? code?.ctx.project.id : undefined, continued: resume || undefined,
    checkpoint: rewindTo ?? undefined,
  };
  const savedContent = finalText || (stopped ? "*Stopped.*" : errorMessage ? `*${errorMessage}*` : "");
  let messageId: number | null = null;
  if (savedContent || timeline.length) messageId = await addMessage(actor, conversationId, "assistant", savedContent, meta);

  // What Continue resumes from; a finished run needs none.
  if (reason === "complete") await deleteSnapshot(actor, conversationId);
  else await saveSnapshot(actor, conversationId, snapshot("paused")).catch((e) => console.error("[run] snapshot", e));

  if (sources.length) emit({ type: "sources", sources: sources.slice(0, 12) });
  if (totals.input || totals.output) emit({ type: "usage", input: totals.input, output: totals.output, cached: totals.cached || undefined });
  emit({ type: "done", stopped: stopped || undefined, reason, continuable: continuable || undefined });

  if (settings.memory && finalText && !stopped && reason === "complete" && !resume) {
    const saved = await rememberFromTurn(actor, metered(helper, { actor, feature: "memory" }), input.message, finalText, signal);
    if (saved.length) {
      emit({ type: "memory", saved });
      if (messageId) await updateMessageMeta(actor, conversationId, messageId, { ...meta, memory: saved });
    }
  }
}

/** The files a run produced, ready to download: the whole project, or what it wrote to the workspace. */
async function collectDeliverables(o: { code?: RunCode; projectCreated: boolean; files: string[]; verified: { passed: boolean; checks: string } | null; title: string }): Promise<Deliverables | undefined> {
  if (o.code && (o.projectCreated || o.code.ctx.changed.length)) {
    const p = o.code.ctx.project;
    const all = await projectFiles(o.code.ctx.sandbox, 3000).catch(() => []);
    if (!all.length) return undefined;
    return { kind: "project", name: p.name, slug: fileSlug(p.name), projectId: p.id, files: all.slice(0, 10), total: all.length, verified: o.verified?.passed, checks: o.verified?.checks };
  }
  if (!o.code && o.files.length) {
    const tops = new Set(o.files.map((f) => (f.includes("/") ? f.split("/")[0] : "")));
    const common = tops.size === 1 ? [...tops][0] : "";
    const name = common || o.title;
    return { kind: "workspace", name, slug: fileSlug(name, "morphie-workspace"), files: o.files.slice(0, 10).map((path) => ({ path })), total: o.files.length };
  }
  return undefined;
}

/** The model's own checklist, shown back to it when it hasn't been updated for a while. */
export function planReminder(plan: PlanItem[]): string {
  const lines = plan.map((p, i) => `${i + 1}. [${p.status}] ${p.text}`).join("\n");
  return `Reminder (from Morphie, not the user): this is your plan as it stands. Call update_plan now with the full list: mark what you've finished "done" and what you're on "active", then carry on.\n${lines}`;
}
