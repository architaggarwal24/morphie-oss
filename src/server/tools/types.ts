import type { AgentEvent, AgentSettings, ApprovalPreview, Mode, SourceRef } from "@/lib/types";
import type { Actor } from "../auth/actor";
import type { CodeContext } from "../code/project";
import type { PermTarget } from "../code/permissions";
import type { SkillRuntime } from "../skills";
import type { ImagePart, Provider } from "../providers/types";

export interface ToolContext {
  actor: Actor;
  conversationId: string;
  mode: Mode;
  signal: AbortSignal;
  settings: AgentSettings;
  provider: Provider;
  emit: (e: AgentEvent) => void;
  /** Set when the task belongs to a code project. */
  code?: CodeContext;
  /** Per-run switches tools may flip: plan mode ends when the user approves a plan. */
  flags: { planMode: boolean; /** verify_project already asked for tests once. */ testsNagged?: boolean };
  /** The id of the timeline step running this tool (for progress and terminal events). */
  stepId?: string;
  /** The tools a `task` sub-agent may use (the read-only ones of this run). */
  subagentTools?: ToolDef[];
  /** A cheaper model for sub-agents and summaries (Settings → Agent). Falls back to `provider`. */
  helper?: Provider;
  /** Ask the user multiple-choice questions and wait (ask_user). null: they skipped. */
  ask?: (questions: import("@/lib/types").AskQuestion[]) => Promise<Record<string, string> | null>;
  /** The skills this run can load (use_skill). */
  skills?: SkillRuntime;
  /** Agent mode without a project: make one for this task and switch to it (create_project). Returns the text for the model. */
  createProject?: (name: string, repoUrl?: string) => Promise<string>;
}

export interface ToolResult {
  text: string;
  sources?: SourceRef[];
  files?: string[];
  /** One-line human summary for the timeline. */
  summary?: string;
  /** A file edit, as a unified diff (shown in the timeline). */
  diff?: string;
  /** Pictures for the model (screenshots), sent only to models that accept images. */
  images?: ImagePart[];
  /** verify_project's verdict, for the run's done-check and deliverables. */
  verify?: { passed: boolean; checks: string };
}

export interface ToolDef {
  name: string;
  label: string;
  /** Shown to the model. */
  description: string;
  parameters: Record<string, unknown>;
  /** "confirm" tools pause for approval unless the user chose to allow them. */
  risk: "safe" | "confirm";
  modes: Mode[];
  /** Output comes from outside (web, documents): wrap it as untrusted data. */
  untrusted?: boolean;
  needsKey?: string;
  /** Plain-language description of what this call will do (shown in approval prompts). */
  describeCall?: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolResult>;
  /** Only offered in code projects (and the general workspace tools are hidden there). */
  code?: boolean;
  /** Changes nothing: allowed in plan mode and in sub-agents. */
  readOnly?: boolean;
  /** Several calls in one step may run at the same time. */
  parallel?: boolean;
  /** Always ask, whatever the approval setting (exit_plan_mode). */
  alwaysAsk?: boolean;
  /** What permission rules see for this call ("Bash" + the command, "Edit" + the path). */
  permission?: (args: Record<string, unknown>) => PermTarget;
  /** Extra detail for the approval card: the diff an edit would make, the command, the plan. */
  preview?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ApprovalPreview | undefined>;
}

export function str(args: Record<string, unknown>, key: string, max = 4000): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`"${key}" is required and must be text.`);
  if (v.length > max) throw new ToolError(`"${key}" is too long (max ${max} characters).`);
  return v;
}

export class ToolError extends Error {}
