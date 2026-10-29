import type { HostedModel, PlanDef, PlanId, PlanLimits } from "./plans";
// Types shared by the browser and the server. Keep this file free of server-only imports.

/** Which sign-in methods this server offers (the same flow signs people in and signs new ones up). */
export interface LoginMethods { email: boolean; google: boolean; github: boolean; password?: boolean }

/** The signed-in session as /api/bootstrap reports it. Anonymous visitors get `session: null` instead. */
export interface SessionView {
  user: { email: string | null; displayName: string | null };
  expiresAt: number;
  idleExpiresAt: number;
}

export type ProviderKind =
  | "openai" | "anthropic" | "gemini" | "mistral" | "ollama" | "openrouter" | "groq"
  | "deepseek" | "xai" | "together" | "fireworks" | "cerebras" | "perplexity"
  | "apmixai" | "lmstudio" | "custom";

export type AuthStyle = "bearer" | "x-api-key" | "api-key" | "header" | "none";

/** Everything the "OpenAI-compatible" form can configure. All fields are optional on the wire. */
export interface ProviderOptions {
  authStyle?: AuthStyle;
  /** Header name when authStyle is "header". */
  authHeaderName?: string;
  extraHeaders?: Record<string, string>;
  queryParams?: Record<string, string>;
  chatPath?: string;
  modelsPath?: string;
  streaming?: boolean;
  /** false → Morphie falls back to prompt-based tool calling. */
  nativeTools?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** "max_completion_tokens" for newer OpenAI-style APIs; defaults to "max_tokens". */
  tokenParam?: "max_tokens" | "max_completion_tokens";
  systemPrompt?: string;
  timeoutSec?: number;
  /** The model accepts images (screenshots the agent takes are shown to it). */
  vision?: boolean;
  /** Tokens the model can read at once; long tasks are summarised before they reach it. */
  contextWindow?: number;
  /** Tokens one agent task may spend with this model before it pauses (max 1,000,000). Overrides the general setting. */
  taskTokenBudget?: number;
}

export interface ProfileView {
  id: string;
  kind: ProviderKind;
  label: string;
  model: string;
  baseUrl?: string;
  hasKey: boolean;
  keyHint?: string;
  options: ProviderOptions;
  updatedAt: number;
  /** Morphie AI: a model the server provides with your plan (id `morphie:<model>`). Not editable or deletable. */
  hosted?: { tier: PlanId; locked: boolean; free: boolean; multiplier: number; blurb: string; available: boolean };
  /** Your own key, paused because your plan doesn't include your own keys. */
  paused?: boolean;
}

export interface ProviderSpecView {
  kind: ProviderKind;
  label: string;
  blurb: string;
  baseUrl: string;
  requiresKey: boolean;
  defaultModel: string;
  exampleModels: string[];
  nativeTools: boolean;
  canListModels: boolean;
  editableBaseUrl: boolean;
  keyUrl?: string;
  group: "hosted" | "gateway" | "local" | "custom";
}

export interface ModelInfo { id: string; label?: string }

export type Mode = "chat" | "agent";

export interface ConversationView {
  id: string;
  title: string;
  mode: Mode;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Agent tasks can belong to a code project (null = the general agent with its private workspace). */
  projectId?: string | null;
}

export interface ProjectView {
  id: string;
  name: string;
  repoUrl: string | null;
  branch: string | null;
  /** Where it runs: "" (this server's sandbox), "lite" (files only) or "runner:<id>" (a Morphie Runner). */
  sandbox: string;
  createdAt: number;
  updatedAt: number;
}

/** Where code projects run on this server. */
export type SandboxKind = "cloudflare" | "local" | "none";

export interface ProjectEntry { path: string; type: "file" | "dir"; size?: number }

/** One changed file in a project's working tree (git status). */
export interface ChangedFile {
  path: string;
  /** M modified · A added · D deleted · R renamed · ? untracked */
  status: "M" | "A" | "D" | "R" | "?";
  /** Already staged (accepted). */
  staged: boolean;
  added: number;
  removed: number;
}

export interface ProjectChanges {
  git: boolean;
  branch: string | null;
  /** Commits not yet pushed (null when there's no upstream). */
  ahead: number | null;
  files: ChangedFile[];
  /** Unified diff of every change (staged and not), capped. */
  diff: string;
  truncated: boolean;
}

/** A slash command the composer offers. */
export interface SlashCommand { name: string; description: string; source: "builtin" | "project" | "skill"; argHint?: string; clientOnly?: boolean }

/** What an approval card shows besides the reason: the edit as a diff, the command, or the plan. */
export interface ApprovalPreview { diff?: string; command?: string; plan?: string; path?: string; rule?: string }

/** Allow/deny rules, Claude Code style: "Bash(npm test *)", "Edit(src/**)", "Read", "WebFetch(domain:github.com)". */
export interface PermissionRules { allow: string[]; deny: string[] }

// ------------------------------------------------------------ agent events

export type StepStatus = "running" | "done" | "error" | "denied" | "waiting";

export interface PlanItem { text: string; status: "pending" | "active" | "done" }

export interface SourceRef { title: string; url?: string; snippet?: string; document?: string }

/** One tool invocation as shown in the timeline. */
export interface ToolStep {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: StepStatus;
  output?: string;
  error?: string;
  ms?: number;
  needsApproval?: boolean;
  summary?: string;
  /** File edits: the change as a unified diff (capped). */
  diff?: string;
  /** Sub-agents: what they are doing right now. */
  progress?: string;
}

/** One row in the agent timeline: either a short note from the model or a tool call. */
export type TimelineItem =
  | { kind: "note"; text: string }
  | { kind: "tool"; step: ToolStep };

export type AgentEvent =
  | { type: "start"; conversationId: string; mode: Mode; provider: string; model: string }
  | { type: "step"; n: number; max: number }
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  /** The text streamed so far this step was commentary, not the answer: move it to the timeline. */
  | { type: "note"; text: string }
  | { type: "plan"; items: PlanItem[] }
  | { type: "tool_start"; step: ToolStep }
  | { type: "approval"; id: string; stepId: string; tool: string; args: Record<string, unknown>; reason: string; preview?: ApprovalPreview }
  | { type: "tool_progress"; stepId: string; text: string }
  /** A project file changed (the Changes panel refreshes). */
  | { type: "file_change"; path: string; kind: "created" | "modified" | "deleted" }
  /** A command ran in the project (the Terminal panel shows it). */
  | { type: "terminal"; stepId: string; command: string; output: string; exitCode: number; ms: number }
  | { type: "plan_mode"; active: boolean }
  | { type: "tool_end"; stepId: string; status: StepStatus; output?: string; error?: string; ms: number; summary?: string; diff?: string }
  | { type: "sources"; sources: SourceRef[] }
  | { type: "memory"; saved: string[] }
  | { type: "title"; title: string }
  | { type: "usage"; input: number; output: number; cached?: number }
  /** Tokens this run has used so far (every model call, sub-agents and compaction included) against its budget. */
  | { type: "budget"; used: number; budget: number }
  /** The agent created a code project for this task and switched to it. */
  | { type: "project"; project: ProjectView }
  /** What the run produced, ready to download. */
  | { type: "deliverables"; deliverables: Deliverables }
  | { type: "notice"; text: string }
  /** What the agent is doing right now (the live activity line): thinking, or writing a tool call as it streams. */
  | { type: "activity"; text: string; chars?: number }
  /** The agent asks the user multiple-choice questions (ask_user) and waits for the answers. */
  | { type: "question"; id: string; stepId: string; questions: AskQuestion[] }
  /** The agent loaded a skill (shown on the step). */
  | { type: "skill"; name: string; stepId?: string }
  | { type: "error"; message: string; code?: string }
  | { type: "done"; stopped?: boolean; reason?: StopReason; continuable?: boolean };

/** One question of an ask_user card. */
export interface AskQuestion { question: string; header?: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }

/** Why a run ended. Everything but "complete" can be continued from where it stopped. */
export type StopReason = "complete" | "max_steps" | "budget" | "aborted" | "error" | "approval_timeout" | "interrupted" | "credits";

/** The files a run produced: a whole project (downloaded as one zip) or files in the agent workspace. */
export interface Deliverables {
  kind: "project" | "workspace";
  /** Shown on the card ("friday-landing"). */
  name: string;
  /** The zip's file name, without .zip. */
  slug: string;
  projectId?: string;
  /** Up to 10 files; when `total` is larger the card offers the zip first. */
  files: Array<{ path: string; size?: number }>;
  total: number;
  /** The last verification passed (install, build, tests, the app loads). */
  verified?: boolean;
  /** One line on how it was checked. */
  checks?: string;
}

/** What is stored in messages.meta for assistant messages. */
export interface AssistantMeta {
  timeline?: TimelineItem[];
  plan?: PlanItem[];
  sources?: SourceRef[];
  memory?: string[];
  reasoning?: string;
  provider?: string;
  model?: string;
  usage?: { input: number; output: number; cached?: number };
  stopped?: boolean;
  error?: string;
  files?: string[];
  /** Code projects: files this turn changed. */
  changed?: string[];
  /** Why the run ended, and whether "Continue" picks it up again. */
  reason?: StopReason;
  continuable?: boolean;
  /** Wall-clock time of the run. */
  ms?: number;
  /** Tokens used by the whole run (sub-agents and compaction included) and its budget. */
  budget?: { used: number; limit: number };
  deliverables?: Deliverables;
  /** The project this run created or worked in. */
  projectId?: string;
  /** This reply continues the one before it. */
  continued?: boolean;
  /** A run lost to a server restart moments ago: the page continues it by itself. */
  autoResume?: boolean;
  /** Code projects: the checkpoint of the files from just before this run (rewind goes back to it). */
  checkpoint?: string;
}

export interface MessageView {
  id: number;
  role: "user" | "assistant";
  content: string;
  meta?: AssistantMeta;
  createdAt: number;
}

export interface AgentSettings {
  /** Morphie AI: when a premium model's credits run out, carry on with the plan's free model instead of stopping. */
  planFallback: boolean;
  /**
   * Not a user setting: the agent decides how many steps a task takes, and the server keeps a safety cap
   * (MORPHIE_MAX_AGENT_STEPS) against a model that loops. Only tests set this, to exercise the cap.
   */
  maxSteps?: number;
  /** Tokens one agent run may use before it pauses with "Continue" (a provider can override it). Max 1,000,000. */
  taskTokenBudget: number;
  /** A cheaper model (one of your saved providers) for sub-agents, summaries and memory. null = the active model. */
  helperProfileId: string | null;
  /** Skills by name: turned off, or always loaded ("always on"). Everything else is available for the agent to pick. */
  skills: { disabled: string[]; pinned: string[] };
  /** ask = confirm risky tools; always = confirm every tool; never = auto-approve everything. */
  approval: "ask" | "always" | "never";
  /** Tool names the user has chosen to always allow. */
  alwaysAllow: string[];
  /** Tool names turned off entirely. */
  disabledTools: string[];
  memory: boolean;
  temperature?: number;
  /** Code projects: rules that allow without asking, or refuse outright. Deny wins. */
  permissions: PermissionRules;
}

export const TASK_BUDGET = { min: 20_000, max: 1_000_000, default: 500_000 } as const;

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  planFallback: true,
  taskTokenBudget: TASK_BUDGET.default,
  helperProfileId: null,
  skills: { disabled: [], pinned: [] },
  approval: "ask",
  alwaysAllow: [],
  disabledTools: [],
  memory: true,
  permissions: { allow: [], deny: [] },
};

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  risk: "safe" | "confirm";
  modes: Mode[];
  needsKey?: string;
  /** Only offered when the task belongs to a code project. */
  code?: boolean;
}

export interface MemoryView { id: string; content: string; category: string; source: string; createdAt: number; updatedAt: number }

export interface DocumentView { id: string; name: string; kind: string; size: number; chunkCount: number; createdAt: number }

export interface DesignSummary { id: string; name: string; updatedAt: number; version: number; versions: number }

// ------------------------------------------------------------------ design

export interface DesignHistoryState { version: number; position: number; total: number; canUndo: boolean; canRedo: boolean; revision: number }
export interface DesignVersionView { version: number; summary: string; prompt: string; createdAt: number; current: boolean }
export interface DesignSection { id: string; type: string; [key: string]: unknown }
export interface DesignJson {
  name: string;
  theme: Record<string, string>;
  typography: { heading: string; body: string; scale: string };
  layout: { max_width: string; spacing: string };
  style: { radius: string; shadow: string };
  responsive: { tablet_columns: number; mobile_columns: number; mobile_nav: string };
  sections: DesignSection[];
}
export interface DesignState {
  id: string;
  name: string;
  /** The design system this design follows, if any. */
  systemId?: string | null;
  design: DesignJson;
  previewHtml: string;
  history: DesignHistoryState;
  versions: DesignVersionView[];
  updatedAt: number;
}
export interface DesignThemeView { id: string; name: string; description: string; colors: Record<string, string> }
export type DesignEvent =
  | { type: "stage"; stage: "drafting" | "validating" | "repairing"; attempt: number }
  | { type: "result"; state: DesignState; changed: boolean; kind: "create" | "edit" | "theme"; summary: string; notes: string[]; /** Design skills that guided it. */ skills?: string[] }
  | { type: "clarify"; message: string }
  | { type: "error"; message: string };

// ------------------------------------------------------------ design systems

export type SystemSourceView = "prompt" | "url" | "image" | "design" | "manual";
export interface DesignSystemJson {
  name: string;
  description: string;
  colors: Record<"background" | "surface" | "primary" | "secondary" | "accent" | "text" | "success" | "warning" | "danger" | "info", string>;
  typography: { heading: string; body: string; mono: string; scale: string; ratio: string };
  shape: { radius: string; shadow: string };
  layout: { spacing: string; max_width: string };
  voice: { tone: string; principles: string[] };
  guidelines: Array<{ title: string; do: string; dont?: string }>;
}
export interface DesignSystemSummary {
  id: string;
  name: string;
  updatedAt: number;
  source: SystemSourceView;
  colors: Record<"background" | "surface" | "primary" | "secondary" | "accent" | "text", string>;
  fonts: { heading: string; body: string };
}
export interface DesignSystemView extends DesignSystemSummary {
  system: DesignSystemJson;
  sourceRef: string;
  /** The documentation page (self-contained HTML, rendered in a sandboxed iframe). */
  docsHtml: string;
  usedBy: Array<{ id: string; name: string }>;
}
/** Visual edits from the preview: a text change, or a section moved, duplicated or removed. */
export type DesignPatch =
  | { op: "set_text"; section: string; path: string; value: string }
  | { op: "move"; section: string; direction: "up" | "down" }
  | { op: "duplicate"; section: string }
  | { op: "remove"; section: string }
  | { op: "set_color"; key: "background" | "surface" | "primary" | "secondary" | "accent" | "text"; value: string };

/** One bucket of the Usage page. `input` includes `cached`. */
export interface UsageTotals { input: number; output: number; cached: number; calls: number; estimated: number }
export interface UsageSummary {
  days: number;
  total: UsageTotals;
  byDay: Array<UsageTotals & { day: string }>;
  byFeature: Array<UsageTotals & { key: string }>;
  byModel: Array<UsageTotals & { key: string }>;
  conversations: Array<UsageTotals & { id: string; title: string }>;
  designs: Array<UsageTotals & { id: string; title: string }>;
}

// ------------------------------------------------------------------ skills

export type SkillScope = "agent" | "design" | "both";
export type SkillSource = "builtin" | "github" | "upload" | "editor" | "project";

export interface SkillSummary {
  /** Stable id: "builtin:<name>", the stored id, or "project:<name>". */
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  source: SkillSource;
  /** Where it came from (a GitHub URL), when it came from somewhere. */
  sourceUrl?: string;
  license?: string;
  /** Only used when you ask for it (/name or "always on"), never picked by the agent itself. */
  manual: boolean;
  enabled: boolean;
  pinned: boolean;
  /** Files besides SKILL.md (references, scripts). */
  files: number;
  updatedAt?: number;
  /** Written in the app or uploaded: its SKILL.md can be edited here. */
  editable: boolean;
}

export interface SkillView extends SkillSummary {
  markdown: string;
  fileList: Array<{ path: string; size: number }>;
}

export interface SkillLibraryEntry {
  name: string;
  repo: string;
  summary: string;
  scope: SkillScope;
  license: string;
  category: string;
  installs?: string;
  installed: boolean;
}

/** Several skills were found where one was expected: pick which to install. */
export interface SkillChoice { path: string; name: string; description: string }

/** The Preview tab of a code project: what can be shown (GET /api/projects/[id]/preview). */
export interface PreviewStatus {
  sandbox: "local" | "cloudflare" | "lite" | "runner" | "none";
  /** The project's static site (its index.html), through a signed, expiring link. */
  staticUrl: string | null;
  staticRoot: string | null;
  dev: { available: boolean; command: string | null; reason?: string };
  /** The dev server, when one is running for this project (local sandbox). */
  server: { status: "starting" | "ready" | "exited"; port: number; command: string; log: string; startedAt: number; exitCode?: number | null } | null;
  /** verify_project's screenshots. */
  shots: Array<{ name: string; url: string }>;
}

// ------------------------------------------------------------------ plans (hosted edition)

export interface PlanUsage {
  /** Premium credits used this billing month and today; free-model credits used today. */
  month: number; today: number; freeToday: number;
  /** Bonus credits on top of the monthly allowance. */
  bonus: number;
}

/** GET /api/plan: your plan, what you've used, and every plan and Morphie AI model. */
export interface PlanStatus {
  enabled: boolean;
  plan: PlanId;
  unlimited: boolean;
  admin: boolean;
  /** Plans only apply to a verified email. */
  verified: boolean;
  /** This account's limits right now (an unverified account has a smaller free-model allowance than its plan). */
  limits?: PlanLimits;
  membership: { source: string; billing: string | null; startsAt: number; endsAt: number | null } | null;
  usage: PlanUsage;
  /** The billing month and the current day (credits reset at their ends). */
  period: { start: number; end: number };
  day: { start: number; end: number };
  plans: PlanDef[];
  models: Array<HostedModel & { multiplier: number; available: boolean }>;
  /** Morphie AI has at least one provider key configured. */
  hosted: boolean;
}

export interface MemberView {
  userId: string | null;
  email: string;
  verified: boolean;
  createdAt: number | null;
  lastSeenAt: number | null;
  plan: PlanId;
  unlimited: boolean;
  /** From MORPHIE_ADMIN_EMAILS. */
  admin: boolean;
  membership: { source: string; billing: string | null; startsAt: number; endsAt: number | null; note: string } | null;
  /** Morphie AI credits used in the last 30 days. */
  credits30: number;
}

export interface VendorSpend { vendor: "gemini" | "openai" | "anthropic"; usd: number; budget: number; calls: number; keyed: boolean; free?: { usd: number; calls: number } }

/** GET /api/admin: the plans setup, spend against budgets, and member counts. */
export interface AdminOverview {
  enabled: boolean;
  plans: PlanDef[];
  models: HostedModel[];
  budgets: Record<"gemini" | "openai" | "anthropic", number>;
  defaultModel: string;
  /** Free-model credits a day for accounts whose email isn't verified. */
  unverifiedFreeDaily: number;
  spend: VendorSpend[];
  monthStart: number;
  counts: { users: number; byPlan: Record<string, number> };
  keys: { openai: boolean; anthropic: boolean; gemini: boolean; geminiFree: boolean };
  admins: string[];
}

// ------------------------------------------------------------------ payments (hosted edition)

export type OrderStatus = "pending" | "submitted" | "paid" | "rejected" | "canceled" | "expired";

/** A plan order. `upi` is there while it can still be paid (the payment link and QR content). */
export interface OrderView {
  id: string;
  email?: string;
  plan: import("./plans").PlanId;
  period: import("./plans").Interval;
  currency: import("./plans").Currency;
  /** Minor units (paise / cents). */
  amount: number;
  method: "upi";
  status: OrderStatus;
  utr: string | null;
  createdAt: number;
  expiresAt: number;
  paidAt: number | null;
  reason: string | null;
  upi?: { uri: string; vpa: string; payee: string };
}

/** What checkout can offer on this server (GET /api/billing). */
export interface BillingInfo {
  upi: { enabled: boolean; payee: string; vpa: string };
  /** Payments are confirmed automatically from the bank's alert emails. */
  autoConfirm: boolean;
  usd: boolean;
  orders: OrderView[];
}

export interface PaymentSettings {
  upi: { enabled: boolean; vpa: string; payee: string };
  /** Confirm payments from bank alert emails (DKIM-verified, from these domains). */
  email: { enabled: boolean; domains: string[] };
}

export interface InboxRow { id: number; at: number; sender: string; dkim: string; subject: string; amount: number | null; utr: string | null; orderId: string | null; outcome: string; excerpt: string }

/** GET /api/admin/payments. */
export interface AdminPayments { settings: PaymentSettings; orders: OrderView[]; inbox: InboxRow[]; inboundReady: boolean }

/** A Morphie Runner: a program on the user's own computer that runs their code projects. */
export interface RunnerView { id: string; name: string; platform: string; createdAt: number; lastSeenAt: number | null; online: boolean }
