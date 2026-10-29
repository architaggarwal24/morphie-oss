import type { AgentEvent, ApprovalPreview, AskQuestion, Deliverables, Mode, PlanItem, ProjectView, SourceRef, StopReason, TimelineItem, ToolStep } from "./types";

export interface PendingApproval { id: string; stepId: string; tool: string; args: Record<string, unknown>; reason: string; preview?: ApprovalPreview }
/** An ask_user card waiting for answers. */
export interface PendingQuestion { id: string; stepId: string; questions: AskQuestion[] }
/** A command that ran in the project during this run (shown in the Terminal panel). */
export interface TerminalEntry { stepId: string; command: string; output: string; exitCode: number; ms: number; by: "agent" | "you"; at: number }

/** Everything the UI shows about a reply that is currently streaming. */
export interface RunState {
  convId: string | null;
  mode: Mode;
  userMessage: string;
  /** Persisted messages with id >= this are hidden while the run replaces them (edit / regenerate). */
  truncateFrom?: number;
  status: "connecting" | "running" | "waiting" | "done" | "error";
  provider?: string;
  model?: string;
  step?: { n: number; max: number };
  answer: string;
  reasoning: string;
  timeline: TimelineItem[];
  plan?: PlanItem[];
  sources: SourceRef[];
  approvals: Record<string, PendingApproval>;
  /** ask_user cards waiting for answers, by request id. */
  questions: Record<string, PendingQuestion>;
  /** What the agent is doing right now, between visible steps (the live activity line). */
  activity?: { text: string; chars?: number };
  memory: string[];
  notices: string[];
  error?: string;
  usage?: { input: number; output: number; cached?: number };
  /** Tokens the run has used against its budget (agent mode). */
  budget?: { used: number; limit: number };
  stopped?: boolean;
  reason?: StopReason;
  continuable?: boolean;
  deliverables?: Deliverables;
  /** A project the agent created during this run. */
  project?: ProjectView;
  /** The last event's sequence number (to re-attach after a dropped connection). */
  seq: number;
  /** Continuing a paused run (no new user message). */
  continued?: boolean;
  startedAt: number;
  /** Code projects: commands the agent ran, files it changed (a counter the Changes panel watches), plan mode. */
  terminal: TerminalEntry[];
  changes: number;
  changedFiles: string[];
  planMode?: boolean;
}

export function newRun(init: { convId: string | null; mode: Mode; userMessage: string; truncateFrom?: number; now?: number; planMode?: boolean; continued?: boolean }): RunState {
  return {
    convId: init.convId, mode: init.mode, userMessage: init.userMessage, truncateFrom: init.truncateFrom, status: "connecting",
    answer: "", reasoning: "", timeline: [], sources: [], approvals: {}, questions: {}, memory: [], notices: [], startedAt: init.now ?? Date.now(),
    terminal: [], changes: 0, changedFiles: [], planMode: init.planMode, seq: 0, continued: init.continued,
  };
}

const MAX_REASONING = 12_000;

function updateStep(timeline: TimelineItem[], id: string, patch: (s: ToolStep) => ToolStep): TimelineItem[] {
  return timeline.map((it) => (it.kind === "tool" && it.step.id === id ? { kind: "tool", step: patch(it.step) } : it));
}

/** Pure reducer: fold one server event into the run state. Events carry a `seq`; ones already applied are skipped. */
export function applyEvent(run: RunState, ev: AgentEvent): RunState {
  const seq = (ev as { seq?: number }).seq;
  if (typeof seq === "number") {
    if (seq <= run.seq) return run;
    run = { ...run, seq };
  }
  return reduce(run, ev);
}

function reduce(run: RunState, e: AgentEvent): RunState {
  switch (e.type) {
    case "start": return { ...run, convId: e.conversationId, provider: e.provider, model: e.model, status: "running" };
    case "step": return { ...run, step: { n: e.n, max: e.max } };
    case "thinking": return { ...run, reasoning: (run.reasoning + e.delta).slice(-MAX_REASONING) };
    case "text": return { ...run, answer: run.answer + e.delta, activity: undefined };
    case "note": return { ...run, answer: "", timeline: e.text ? [...run.timeline, { kind: "note", text: e.text }] : run.timeline };
    case "plan": return { ...run, plan: e.items };
    case "tool_start": {
      const exists = run.timeline.some((it) => it.kind === "tool" && it.step.id === e.step.id);
      const timeline = exists ? updateStep(run.timeline, e.step.id, () => e.step) : [...run.timeline, { kind: "tool" as const, step: e.step }];
      return { ...run, timeline, activity: undefined, status: e.step.status === "waiting" ? "waiting" : "running" };
    }
    case "activity": return { ...run, activity: { text: e.text, chars: e.chars } };
    case "question": {
      const questions = { ...run.questions, [e.id]: { id: e.id, stepId: e.stepId, questions: e.questions } };
      return { ...run, questions, status: "waiting", activity: undefined, timeline: updateStep(run.timeline, e.stepId, (s) => ({ ...s, status: "waiting" })) };
    }
    case "approval": {
      const approvals = { ...run.approvals, [e.id]: { id: e.id, stepId: e.stepId, tool: e.tool, args: e.args, reason: e.reason, preview: e.preview } };
      return { ...run, approvals, status: "waiting", timeline: updateStep(run.timeline, e.stepId, (s) => ({ ...s, status: "waiting", needsApproval: true, summary: e.reason })) };
    }
    case "tool_end": {
      const approvals = Object.fromEntries(Object.entries(run.approvals).filter(([, a]) => a.stepId !== e.stepId));
      const questions = Object.fromEntries(Object.entries(run.questions).filter(([, q]) => q.stepId !== e.stepId));
      return {
        ...run, approvals, questions, status: Object.keys(approvals).length || Object.keys(questions).length ? "waiting" : "running",
        timeline: updateStep(run.timeline, e.stepId, (s) => ({ ...s, status: e.status, output: e.output, error: e.error, ms: e.ms, summary: e.summary ?? s.summary, diff: e.diff, progress: undefined })),
      };
    }
    case "sources": return { ...run, sources: e.sources };
    case "memory": return { ...run, memory: e.saved };
    case "usage": return { ...run, usage: { input: e.input, output: e.output, cached: e.cached } };
    case "budget": return { ...run, budget: { used: e.used, limit: e.budget } };
    case "deliverables": return { ...run, deliverables: e.deliverables };
    case "project": return { ...run, project: e.project };
    case "notice": return { ...run, notices: [...run.notices, e.text] };
    case "error": return { ...run, error: e.message, status: "error" };
    case "done": return { ...run, status: run.status === "error" && !e.continuable ? "error" : "done", stopped: e.stopped, reason: e.reason, continuable: e.continuable, approvals: {}, questions: {}, activity: undefined };
    case "title": return run;
    case "tool_progress": return { ...run, timeline: updateStep(run.timeline, e.stepId, (s) => ({ ...s, progress: e.text })) };
    case "file_change": return { ...run, changes: run.changes + 1, changedFiles: e.path === "*" || run.changedFiles.includes(e.path) ? run.changedFiles : [...run.changedFiles, e.path] };
    case "terminal": return { ...run, terminal: [...run.terminal.slice(-49), { stepId: e.stepId, command: e.command, output: e.output, exitCode: e.exitCode, ms: e.ms, by: "agent", at: Date.now() }] };
    case "plan_mode": return { ...run, planMode: e.active };
    default: return run;
  }
}
