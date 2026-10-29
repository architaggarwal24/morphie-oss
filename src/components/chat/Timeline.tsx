"use client";
import { AlertTriangle, Bot, Brain, Calculator, Check, ChevronRight, Clock, FileCode2, FilePen, FilePlus2, FileSearch, FileText, FolderOpen, FolderPlus, FolderTree, GitPullRequest, Globe, ListChecks, Loader2, Map as MapIcon, MessageCircleQuestion, Palette, Search, ShieldCheck, ShieldQuestion, Sparkles, SquareTerminal, TextSearch, Trash2, Wrench, X } from "lucide-react";
import { DiffStat, DiffView } from "../code/DiffView";
import { parseDiff } from "@/lib/diff";
import { useState } from "react";
import type { PendingApproval, PendingQuestion } from "@/lib/runState";
import { argSummary, elapsed, ms, toolLabel } from "@/lib/format";
import type { PlanItem, StepStatus, TimelineItem, ToolStep } from "@/lib/types";
import { cn } from "../ui";
import { ApprovalCard } from "./Approval";
import { QuestionCard } from "./QuestionCard";

const ICONS: Record<string, typeof Wrench> = {
  calculator: Calculator, get_current_time: Clock, web_search: Search, fetch_url: Globe, search_documents: FileSearch, update_plan: ListChecks,
  workspace_list: FolderOpen, workspace_read: FileText, workspace_write: FilePen, workspace_delete: Trash2, save_memory: Brain, design_website: Palette,
  bash: SquareTerminal, read_file: FileCode2, edit_file: FilePen, write_file: FilePlus2, list_files: FolderTree, glob: Search, grep: TextSearch,
  task: Bot, create_pull_request: GitPullRequest, exit_plan_mode: MapIcon, verify_project: ShieldCheck, create_project: FolderPlus,
  ask_user: MessageCircleQuestion, use_skill: Sparkles, read_skill_file: Sparkles,
};
const LABELS: Record<string, string> = { bash: "Run", read_file: "Read", edit_file: "Edit", write_file: "Write", list_files: "List", glob: "Find", grep: "Search", task: "Sub-agent", create_pull_request: "Pull request", exit_plan_mode: "Plan", verify_project: "Verify", create_project: "New project", ask_user: "Question", use_skill: "Skill", read_skill_file: "Skill file" };

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === "running") return <Loader2 className="size-3.5 animate-spin text-accent" aria-label="Running" />;
  if (status === "waiting") return <ShieldQuestion className="size-3.5 animate-pulse-dot text-warn" aria-label="Waiting for you" />;
  if (status === "done") return <Check className="size-3.5 text-ok" aria-label="Done" />;
  if (status === "denied") return <X className="size-3.5 text-muted" aria-label="Denied" />;
  return <AlertTriangle className="size-3.5 text-err" aria-label="Failed" />;
}

function Step({ step, approval, question, defaultOpen }: { step: ToolStep; approval?: PendingApproval; question?: PendingQuestion; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const Icon = ICONS[step.name] ?? Wrench;
  const isEdit = (step.name === "edit_file" || step.name === "write_file") && !!step.diff;
  const stat = isEdit ? parseDiff(step.diff!)[0] : undefined;
  const path = typeof step.args.path === "string" ? step.args.path : undefined;
  // A running sub-agent says what it's doing; file tools show the path; otherwise the summary.
  const detail = (step.status === "running" && step.progress) || (path && (step.name === "read_file" || isEdit || step.name === "edit_file" || step.name === "write_file") ? path : "") || step.summary || step.error || argSummary(step.args);
  const hasBody = step.output || step.error || step.diff || Object.keys(step.args).length > 0;
  const command = step.name === "bash" && typeof step.args.command === "string" ? step.args.command : undefined;
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!hasBody} className={cn("group flex w-full pointer-coarse:min-h-11 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition duration-200", hasBody && "hover:bg-fg/[0.04] active:scale-[0.995]", open && "bg-fg/[0.03]")}>
        <span className={cn("grid size-6 shrink-0 place-items-center rounded-md border text-muted transition", step.status === "running" ? "border-accent/50 bg-accent/10 text-accent shadow-[0_0_12px_-2px_rgb(var(--accent)/0.6)]" : step.status === "error" ? "border-err/40 bg-err/10 text-err" : "border-line bg-sunken group-hover:text-fg")}><Icon className="size-3.5" aria-hidden /></span>
        <span className="text-sm font-medium">{LABELS[step.name] ?? toolLabel(step.name)}</span>
        {detail && <span className={cn("min-w-0 flex-1 truncate text-[13px]", step.status === "error" ? "text-err" : "text-muted", (path || command) && "font-mono text-[12px]")}>{command ? (typeof step.args.description === "string" && step.args.description.trim() ? step.args.description : command) : detail}</span>}
        {command && (step.status === "done" || step.status === "error") && step.summary && <span className={cn("shrink-0 font-mono text-[11px]", /^exit|timed/.test(step.summary) ? "text-err" : "text-faint")}>{step.summary.replace(/ · .*/, "")}</span>}
        {stat && <DiffStat added={stat.added} removed={stat.removed} />}
        {!detail && <span className="flex-1" />}
        {step.ms != null && step.status !== "running" && <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">{ms(step.ms)}</span>}
        <StatusIcon status={step.status} />
        {hasBody && <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform duration-300 group-hover:text-fg", open && "rotate-90")} aria-hidden />}
      </button>
      {open && !(approval && step.status === "waiting" && (approval.preview?.diff || approval.preview?.command || approval.preview?.plan)) && (
        <div className="animate-rise ml-[34px] mt-1 space-y-2 pb-1 text-xs">
          {step.diff ? <DiffView diff={step.diff} compact />
            : command ? <pre className="max-h-24 overflow-auto rounded-lg border border-line bg-[#0b0d12] p-2.5 font-mono leading-relaxed text-[#cfd6e4]"><span className="select-none text-emerald-400">$ </span>{command}</pre>
            : Object.keys(step.args).length > 0 && <pre className="max-h-44 overflow-auto rounded-lg border border-line bg-sunken p-2.5 font-mono leading-relaxed text-muted">{JSON.stringify(step.args, null, 2)}</pre>}
          {step.output && !step.diff && <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-sunken p-2.5 font-mono leading-relaxed">{step.output}</pre>}
          {step.error && <p className="rounded-lg border border-err/30 bg-err/5 p-2.5 text-err">{step.error}</p>}
        </div>
      )}
      {approval && step.status === "waiting" && <div className="ml-[34px]"><ApprovalCard approval={approval} /></div>}
      {question && step.status === "waiting" && <div className="ml-[34px]"><QuestionCard key={question.id} pending={question} /></div>}
    </div>
  );
}

export function PlanCard({ plan }: { plan: PlanItem[] }) {
  const done = plan.filter((p) => p.status === "done").length;
  return (
    <div className="card-surface rounded-xl p-3.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13px] font-medium"><ListChecks className="size-4 text-accent" aria-hidden /> Plan</span>
        <span className="font-mono text-[11px] tabular-nums text-muted">{done}/{plan.length}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-fg/10" aria-hidden><div className="h-full rounded-full bg-linear-to-r/oklch from-accent via-accent-3 to-accent-2 shadow-[0_0_10px_rgb(var(--accent)/0.6)] transition-[width] duration-700 ease-out" style={{ width: `${(done / plan.length) * 100}%` }} /></div>
      <ol className="mt-3 space-y-1.5">
        {plan.map((p, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            <span className={cn("mt-[3px] grid size-4 shrink-0 place-items-center rounded-full border", p.status === "done" ? "check-pop border-ok bg-ok text-white" : p.status === "active" ? "border-accent shadow-[0_0_10px_-1px_rgb(var(--accent)/0.7)]" : "border-line")}>
              {p.status === "done" ? <Check className="size-2.5" aria-hidden /> : p.status === "active" ? <span className="size-1.5 animate-pulse-dot rounded-full bg-accent" /> : null}
            </span>
            <span className={cn(p.status === "done" && "text-muted line-through decoration-faint/60", p.status === "active" && "font-medium")}>{p.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Timeline({ items, approvals, questions, live, collapsible, wallMs }: { items: TimelineItem[]; approvals?: Record<string, PendingApproval>; questions?: Record<string, PendingQuestion>; live?: boolean; collapsible?: boolean; /** How long the run took, start to finish. */ wallMs?: number }) {
  const tools = items.filter((i) => i.kind === "tool") as Array<{ kind: "tool"; step: ToolStep }>;
  const [open, setOpen] = useState(!collapsible);
  if (!items.length) return null;
  const byStep = Object.fromEntries(Object.values(approvals ?? {}).map((a) => [a.stepId, a]));
  const askByStep = Object.fromEntries(Object.values(questions ?? {}).map((q) => [q.stepId, q]));
  const failed = tools.filter((t) => t.step.status === "error").length;
  // Wall-clock time when it's known (tool time alone leaves out the model's thinking and writing).
  const total = wallMs ?? 0;
  return (
    <div>
      {collapsible && (
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="group mb-1 inline-flex pointer-coarse:min-h-11 items-center gap-1.5 rounded-full border border-line bg-raised/50 py-1 pl-2 pr-3 text-[12.5px] font-medium tabular-nums text-muted transition hover:border-accent/40 hover:text-fg active:scale-[0.97]">
          <ChevronRight className={cn("size-3.5 transition-transform duration-300", open && "rotate-90 text-accent")} aria-hidden />
          {tools.length} step{tools.length === 1 ? "" : "s"}{total ? ` · ${elapsed(total)}` : ""}{failed ? ` · ${failed} failed` : ""}
        </button>
      )}
      {open && (
        <div className="relative space-y-0.5 border-l-2 border-line/80 pl-3">
          {items.map((it, i) =>
            it.kind === "note" ? (
              <p key={i} className="px-2 py-1 text-[13px] italic leading-relaxed text-muted">{it.text}</p>
            ) : (
              <Step key={it.step.id} step={it.step} approval={byStep[it.step.id]} question={askByStep[it.step.id]} defaultOpen={live && it.step.status === "waiting" && !askByStep[it.step.id]} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
