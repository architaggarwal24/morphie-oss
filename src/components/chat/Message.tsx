"use client";
import { AlertCircle, Brain, Check, ChevronRight, Copy, Download, FileText, Globe, History, Pencil, RotateCcw, Sparkles, FileDiff } from "lucide-react";
import { useState } from "react";
import type { RunState } from "@/lib/runState";
import type { MessageView, SourceRef } from "@/lib/types";
import { useStore } from "@/lib/store";
import { Orb } from "../fx";
import { Badge, Bone, Button, IconButton, Textarea, cn } from "../ui";
import { elapsed, tokens } from "@/lib/format";
import { ActivityLine } from "./ActivityLine";
import { Markdown } from "./Markdown";
import { BudgetMeter, ContinueBar, DeliverablesCard } from "./RunExtras";
import { PlanCard, Timeline } from "./Timeline";

function useCopy(text: string) {
  const [done, setDone] = useState(false);
  return [done, async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* blocked */ } }] as const;
}

function hostOf(url?: string) { try { return url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { return ""; } }

function Sources({ sources }: { sources: SourceRef[] }) {
  if (!sources.length) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Sources">
      {sources.map((s, i) => {
        const inner = (
          <>
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-sunken font-mono text-[10px] tabular-nums text-faint ring-1 ring-line transition group-hover/src:bg-accent group-hover/src:text-accent-fg group-hover/src:ring-accent">{i + 1}</span>
            {s.url ? <Globe className="size-3 shrink-0" aria-hidden /> : <FileText className="size-3 shrink-0" aria-hidden />}
            <span className="truncate">{s.document ?? (s.title || hostOf(s.url))}</span>
            {s.url && <span className="hidden text-faint sm:inline">{hostOf(s.url)}</span>}
          </>
        );
        const cls = "group/src flex max-w-[260px] pointer-coarse:min-h-11 items-center gap-1.5 rounded-full border border-line bg-raised/60 py-1 pl-1 pr-2.5 text-xs text-muted transition duration-200 hover:-translate-y-px hover:border-accent/40 hover:bg-accent/[0.06] hover:text-fg hover:shadow-[0_6px_16px_-10px_rgb(var(--accent)/0.7)]";
        return s.url ? <a key={i} href={s.url} target="_blank" rel="noopener noreferrer nofollow" className={cls} title={s.snippet}>{inner}</a> : <span key={i} className={cls} title={s.snippet}>{inner}</span>;
      })}
    </div>
  );
}

function Files({ files }: { files: string[] }) {
  return (
    <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Files created">
      {files.map((f) => (
        <a key={f} href={`/api/workspace/file?path=${encodeURIComponent(f)}&download=1`} className="group/file flex pointer-coarse:min-h-11 items-center gap-2 rounded-xl border border-accent/30 bg-accent/[0.06] py-1.5 pl-1.5 pr-3 font-mono text-xs text-fg transition duration-200 hover:-translate-y-px hover:border-accent/60 hover:bg-accent/10 hover:shadow-[0_8px_20px_-12px_rgb(var(--accent)/0.8)]">
          <span className="grid size-6 place-items-center rounded-lg bg-accent/15 text-accent transition group-hover/file:bg-accent group-hover/file:text-accent-fg"><Download className="size-3.5" aria-hidden /></span> {f}
        </a>
      ))}
    </div>
  );
}

/** The bubble a user message sits in; the skeleton uses the same one. */
function UserBubble({ children, actions }: { children: React.ReactNode; actions: React.ReactNode }) {
  return (
    <div className="flex flex-row-reverse items-start gap-2">
      <div className="user-bubble min-w-0 max-w-[85%] rounded-2xl rounded-br-md px-4 py-3">{children}</div>
      <div className="flex shrink-0 translate-x-1 gap-0.5 opacity-0 transition duration-200 group-hover:translate-x-0 group-hover:opacity-100 focus-within:translate-x-0 focus-within:opacity-100">{actions}</div>
    </div>
  );
}

/** The avatar + name line above every reply; the skeleton uses the same one. */
function AssistantHeader({ children, working }: { children?: React.ReactNode; working?: boolean }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Orb working={working} className="size-6" />
      <span className="text-[13px] font-semibold">Morphie</span>
      {children}
    </div>
  );
}

/** A conversation's history while it loads: one user bubble and one reply, drawn with the real frames. */
export function HistorySkeleton() {
  return (
    <>
      <div aria-hidden>
        <UserBubble actions={<><span className="size-8" /><span className="size-8" /></>}><p className="text-[15px] leading-relaxed"><Bone className="h-3.5 w-2/3" /></p></UserBubble>
      </div>
      <div aria-hidden>
        <AssistantHeader><Bone className="h-3 w-16" /></AssistantHeader>
        <div className="space-y-2.5 pl-8"><Bone className="block h-3.5 w-full" /><Bone className="block h-3.5 w-11/12" /><Bone className="block h-3.5 w-3/5" /></div>
      </div>
    </>
  );
}

export function UserMessage({ m, canEdit, onEdit, onRewind }: { m: MessageView; canEdit: boolean; onEdit: (id: number, text: string) => void; /** Agent tasks: go back to before this message. */ onRewind?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [copied, copy] = useCopy(m.content);
  return (
    <div className="group animate-rise">
      {editing ? (
        <div className="space-y-2 rounded-2xl border border-accent/40 bg-raised p-3 shadow-glow">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(10, Math.max(2, draft.split("\n").length))} data-autofocus aria-label="Edit your message" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(m.content); }}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={() => { setEditing(false); onEdit(m.id, draft.trim()); }}>Save &amp; re-run</Button>
          </div>
        </div>
      ) : (
        <UserBubble actions={<>
          <IconButton label={copied ? "Copied" : "Copy message"} onClick={copy}>{copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}</IconButton>
          {canEdit && <IconButton label="Edit and re-run" onClick={() => setEditing(true)}><Pencil className="size-3.5" /></IconButton>}
          {canEdit && onRewind && <IconButton label="Rewind to before this" onClick={onRewind}><History className="size-3.5" /></IconButton>}
        </>}>
          <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{m.content}</p>
        </UserBubble>
      )}
    </div>
  );
}

export function AssistantMessage({ m, isLast, canRegenerate, onRegenerate, onContinue, canContinue }: { m: MessageView; isLast: boolean; canRegenerate: boolean; onRegenerate: () => void; onContinue?: () => void; canContinue?: boolean }) {
  const meta = m.meta;
  const [copied, copy] = useCopy(m.content);
  const hasSteps = !!meta?.timeline?.some((t) => t.kind === "tool");
  return (
    <div className="group animate-rise">
      <AssistantHeader>
        {meta?.model && <span className="truncate font-mono text-[11px] text-faint">{meta.model}</span>}
        {meta?.stopped && <Badge tone="warn">Stopped</Badge>}
        {meta?.continued && <Badge tone="info">Continued</Badge>}
      </AssistantHeader>
      <div className="space-y-3 pl-8">
        {meta?.plan && meta.plan.length > 0 && hasSteps && <PlanCard plan={meta.plan} />}
        {hasSteps && <Timeline items={meta!.timeline!} collapsible wallMs={meta?.ms} />}
        {m.content && !meta?.error && <Markdown text={m.content} />}
        {meta?.error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-err/30 bg-linear-to-r from-err/10 to-err/[0.03] p-3 text-sm text-err" role="alert"><span className="grid size-6 shrink-0 place-items-center rounded-lg bg-err/15"><AlertCircle className="size-3.5" aria-hidden /></span><span className="pt-0.5">{meta.error}</span></div>
        )}
        {meta?.deliverables ? <DeliverablesCard d={meta.deliverables} /> : meta?.files && <Files files={meta.files} />}
        {meta?.changed && meta.changed.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Files changed">
            <span className="flex items-center gap-1 text-muted"><FileDiff className="size-3.5 text-warn" aria-hidden /> Changed {meta.changed.length} file{meta.changed.length === 1 ? "" : "s"}:</span>
            {meta.changed.slice(0, 8).map((f) => <code key={f} className="rounded-md border border-line bg-raised/60 px-1.5 py-0.5 font-mono text-[11px]">{f}</code>)}
            {meta.changed.length > 8 && <span className="text-faint">+{meta.changed.length - 8} more</span>}
          </div>
        )}
        {meta?.sources && <Sources sources={meta.sources} />}
        {meta?.memory && meta.memory.length > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-muted"><Brain className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden /> Remembered: {meta.memory.join(" · ")}</p>
        )}
        {meta?.continuable && isLast && onContinue && <ContinueBar reason={meta.reason} onContinue={onContinue} disabled={!canContinue} />}
        <div className={cn("-ml-1.5 flex items-center gap-0.5 pt-1 transition duration-200", isLast ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100")}>
          <IconButton label={copied ? "Copied" : "Copy reply"} onClick={copy}>{copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}</IconButton>
          {canRegenerate && <IconButton label="Regenerate" onClick={onRegenerate}><RotateCcw className="size-3.5" /></IconButton>}
          {meta?.usage && (
            <span className="ml-2 font-mono text-[11px] tabular-nums text-faint" title={`${meta.usage.input.toLocaleString()} in${meta.usage.cached ? ` (${meta.usage.cached.toLocaleString()} from cache)` : ""} · ${meta.usage.output.toLocaleString()} out`}>
              {meta.ms ? `${elapsed(meta.ms)} · ` : ""}{tokens(meta.usage.input)} in · {tokens(meta.usage.output)} out{meta.usage.cached ? ` · ${Math.round((meta.usage.cached / Math.max(1, meta.usage.input)) * 100)}% cached` : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** The reply that is being streamed right now. */
export function LiveMessage({ run }: { run: RunState }) {
  const [showThought, setShowThought] = useState(false);
  const working = run.status === "connecting" || run.status === "running" || run.status === "waiting";
  const hasSteps = run.timeline.some((t) => t.kind === "tool");
  // The activity line fills the quiet stretches: while the model thinks or writes a tool call (a running step shows its own spinner).
  const stepRunning = run.timeline.some((t) => t.kind === "tool" && (t.step.status === "running" || t.step.status === "waiting"));
  const showActivity = run.status === "running" && !run.answer && !stepRunning && !!run.activity;
  return (
    <div className="animate-rise" aria-live="polite" aria-busy={working}>
      <div className="mb-2 flex items-center gap-2">
        <Orb working={working} className="size-6" />
        <span className={cn("text-[13px] font-semibold", working && "text-gradient")}>Morphie</span>
        {run.model && <span className="truncate font-mono text-[11px] text-faint">{run.model}</span>}
        {run.mode === "agent" && working && (run.budget ? <BudgetMeter used={run.budget.used} limit={run.budget.limit} /> : run.step && <Badge tone="accent">Step {run.step.n}/{run.step.max}</Badge>)}
        {run.status === "waiting" && (Object.keys(run.questions).length ? <Badge tone="accent">Waiting for your answers</Badge> : <Badge tone="warn">Needs your approval</Badge>)}
      </div>
      <div className="space-y-3 pl-8">
        {run.plan && run.plan.length > 0 && <PlanCard plan={run.plan} />}
        {hasSteps || run.timeline.length > 0 ? <Timeline items={run.timeline} approvals={run.approvals} questions={run.questions} live /> : null}
        {showActivity && run.activity && <ActivityLine text={run.activity.text} chars={run.activity.chars} className={run.timeline.length ? "ml-[14px]" : ""} />}
        {run.reasoning && (
          <div>
            <button onClick={() => setShowThought((s) => !s)} aria-expanded={showThought} className="group/think inline-flex pointer-coarse:min-h-11 items-center gap-1.5 rounded-full border border-line bg-raised/50 py-1 pl-2 pr-3 text-[12.5px] font-medium text-muted transition hover:border-accent/40 hover:text-fg active:scale-[0.97]">
              <Brain className={cn("size-3.5", working && !run.answer ? "animate-pulse-dot text-accent" : "text-faint")} aria-hidden />
              <span className={cn(working && !run.answer && "text-gradient")}>Thinking{working && !run.answer ? "…" : ""}</span>
              <ChevronRight className={cn("size-3.5 transition-transform duration-300", showThought && "rotate-90")} aria-hidden />
            </button>
            {showThought && <p className="animate-rise mt-2 max-h-48 overflow-auto whitespace-pre-wrap border-l-2 border-accent/30 pl-3 text-[13px] italic leading-relaxed text-muted">{run.reasoning}</p>}
          </div>
        )}
        {run.answer ? <Markdown text={run.answer} /> : working && run.timeline.length === 0 && !run.reasoning && !showActivity ? <TypingDots /> : null}
        {run.error && <div className="flex items-start gap-2.5 rounded-xl border border-err/30 bg-linear-to-r from-err/10 to-err/[0.03] p-3 text-sm text-err" role="alert"><span className="grid size-6 shrink-0 place-items-center rounded-lg bg-err/15"><AlertCircle className="size-3.5" aria-hidden /></span><span className="pt-0.5">{run.error}</span></div>}
        {run.memory.length > 0 && <p className="flex items-start gap-1.5 text-xs text-muted"><Brain className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden /> Remembered: {run.memory.join(" · ")}</p>}
        {run.sources.length > 0 && <Sources sources={run.sources} />}
        {run.deliverables && <DeliverablesCard d={run.deliverables} />}
      </div>
    </div>
  );
}

function TypingDots() {
  return <div className="flex h-6 items-center gap-1.5" aria-label="Thinking">{[0, 1, 2].map((i) => <span key={i} className="size-2 animate-pulse-dot rounded-full bg-linear-to-br/oklch from-accent to-accent-2" style={{ animationDelay: `${i * 0.18}s` }} />)}</div>;
}

export function useRunActions() {
  const send = useStore((s) => s.send);
  return { edit: (id: number, text: string) => send(text, { truncateFrom: id }) };
}
