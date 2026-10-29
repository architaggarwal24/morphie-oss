"use client";
import { ChevronRight, Download, FileText, Package, Play, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { tokens } from "@/lib/format";
import type { Deliverables, StopReason } from "@/lib/types";
import { Badge, Button, cn } from "../ui";

/** "84k / 500k tokens" with a thin bar: how much of its budget a run has used. */
export function BudgetMeter({ used, limit, className }: { used: number; limit: number; className?: string }) {
  const pct = Math.min(100, (used / Math.max(1, limit)) * 100);
  const tone = pct >= 90 ? "bg-err" : pct >= 75 ? "bg-warn" : "bg-linear-to-r/oklch from-accent to-accent-2";
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full border border-line bg-raised/60 py-0.5 pl-2.5 pr-2 font-mono text-[11px] tabular-nums text-muted", className)}
      title="Tokens this run has used (every model call, including sub-agents and summaries; cached prompt tokens count a tenth) out of its budget">
      {tokens(used)} / {tokens(limit)}
      <span className="h-1 w-12 overflow-hidden rounded-full bg-fg/10" aria-hidden><span className={cn("block h-full rounded-full transition-[width] duration-500", tone)} style={{ width: `${pct}%` }} /></span>
      <span className="sr-only">tokens used of this task's budget</span>
    </span>
  );
}

const fileHref = (d: Deliverables, path: string) =>
  d.kind === "project" ? `/api/projects/${d.projectId}/file?path=${encodeURIComponent(path)}&download=1` : `/api/workspace/file?path=${encodeURIComponent(path)}&download=1`;

function zipHref(d: Deliverables): string {
  if (d.kind === "project") return `/api/projects/${d.projectId}/zip`;
  const tops = new Set(d.files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  const folder = tops.size === 1 ? [...tops][0] : "";
  const q = new URLSearchParams({ zip: "1", name: d.slug });
  if (d.total <= 10) q.set("paths", d.files.map((f) => f.path).join(","));
  else if (folder) q.set("prefix", folder);
  return `/api/workspace?${q}`;
}

/** What a run produced. Up to 10 files: each one to download, plus the zip. More: the zip first, the list on request. */
export function DeliverablesCard({ d }: { d: Deliverables }) {
  const many = d.total > 10;
  const [open, setOpen] = useState(!many);
  return (
    <section aria-label="Deliverables" className="card-surface overflow-hidden rounded-2xl">
      <div className="flex flex-wrap items-center gap-3 p-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent ring-1 ring-accent/25"><Package className="size-[18px]" aria-hidden /></span>
        <div className="min-w-[11rem] flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-sm font-semibold">{d.slug}</span>
            {d.verified === true && <Badge tone="ok"><ShieldCheck className="mr-1 size-3" aria-hidden />Verified</Badge>}
            {d.verified === false && <Badge tone="warn"><ShieldAlert className="mr-1 size-3" aria-hidden />Checks failed</Badge>}
          </div>
          <p className="truncate text-xs text-muted">{d.total} file{d.total === 1 ? "" : "s"}{d.checks ? ` · ${d.checks}` : d.kind === "project" ? " · not verified" : ""}</p>
        </div>
        <a href={zipHref(d)} download className="shrink-0 max-sm:w-full"><Button variant={many ? "primary" : "secondary"} size="sm" className="max-sm:w-full"><Download className="size-3.5" aria-hidden /> {d.slug}.zip</Button></a>
      </div>
      {many && (
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-1.5 border-t border-line/70 px-3.5 py-2 pointer-coarse:min-h-11 text-xs text-muted hover:text-fg">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden /> {open ? "Hide files" : `Show the first ${d.files.length} files`}
        </button>
      )}
      {open && (
        <ul className="border-t border-line/70 px-2 py-1.5">
          {d.files.map((f) => (
            <li key={f.path}>
              <a href={fileHref(d, f.path)} className="group flex pointer-coarse:min-h-11 items-center gap-2 rounded-lg px-1.5 py-1 font-mono text-xs hover:bg-raised">
                <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={f.path}>{f.path}</span>
                <Download className="size-3 shrink-0 text-faint group-hover:text-accent" aria-hidden />
              </a>
            </li>
          ))}
          {many && <li className="px-1.5 py-1 text-xs text-faint">…and {d.total - d.files.length} more in the zip</li>}
        </ul>
      )}
    </section>
  );
}

const WHY: Record<StopReason, string> = {
  complete: "",
  budget: "Paused: it used this task's token budget.",
  max_steps: "Paused at the safety limit on steps.",
  error: "Stopped by an error.",
  aborted: "You stopped it.",
  approval_timeout: "Paused while waiting for your approval.",
  interrupted: "Interrupted before it finished (the server restarted).",
  credits: "Paused: your plan's credits for this model ran out.",
};

/** The end of a reply that didn't finish: why, and a Continue button that picks it up where it stopped. */
export function ContinueBar({ reason, onContinue, disabled }: { reason?: StopReason; onContinue: () => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent/[0.05] px-3.5 py-2.5">
      <p className="min-w-0 flex-1 text-[13px] text-muted">{WHY[reason ?? "interrupted"] || "It didn't finish."} Continue picks up where it left off, with a fresh budget.</p>
      <Button variant="primary" size="sm" onClick={onContinue} disabled={disabled}><Play className="size-3.5" aria-hidden /> Continue</Button>
    </div>
  );
}
