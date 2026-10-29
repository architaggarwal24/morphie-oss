"use client";
import { Map as MapIcon, ShieldQuestion, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import type { PendingApproval } from "@/lib/runState";
import { Button, Checkbox, cn } from "../ui";
import { DiffView } from "../code/DiffView";
import { Markdown } from "./Markdown";

function preview(a: PendingApproval): { title: string; body?: string } {
  const args = a.args as Record<string, unknown>;
  if (a.tool === "workspace_write") return { title: String(args.path ?? "file"), body: typeof args.content === "string" ? (args.content.length > 900 ? args.content.slice(0, 900) + "\n…" : args.content) : undefined };
  if (a.tool === "workspace_delete") return { title: String(args.path ?? "file") };
  if (a.tool === "save_memory") return { title: String(args.fact ?? "") };
  return { title: a.reason, body: JSON.stringify(args, null, 2).slice(0, 700) };
}

export function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const resolve = useStore((s) => s.resolveApproval);
  const [always, setAlways] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  const pv = approval.preview;
  const isPlan = approval.tool === "exit_plan_mode";
  const p = pv?.diff || pv?.command || pv?.plan ? null : preview(approval);
  const alwaysLabel = pv?.rule ? <>Always allow <code className="font-mono">{pv.rule}</code></> : <>Always allow <code className="font-mono">{approval.tool}</code></>;

  return (
    <div className={cn("mt-2 rounded-2xl border p-4 animate-rise", isPlan ? "border-accent/40 bg-accent/[0.06] shadow-[0_0_0_4px_rgb(var(--accent)/0.06)]" : "border-warn/40 bg-warn/8 shadow-[0_0_0_4px_rgb(var(--warn)/0.06)]")} role="group" aria-label={isPlan ? "Plan ready for review" : "Approval needed"}>
      <div className="flex items-start gap-2.5">
        {isPlan ? <MapIcon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden /> : pv?.command ? <SquareTerminal className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden /> : <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{isPlan ? "Here's the plan. Go ahead?" : pv?.command ? "Run this command?" : pv?.diff ? "Make this change?" : "Allow this action?"}</p>
          {!isPlan && <p className="mt-0.5 break-words text-sm text-muted">{approval.reason}</p>}
          {pv?.command && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-[#0b0d12] p-2.5 font-mono text-xs leading-relaxed text-[#d6deeb]"><span className="select-none text-emerald-400">$ </span>{pv.command}</pre>
          )}
          {pv?.diff && <div className="mt-2"><DiffView diff={pv.diff} compact /></div>}
          {pv?.plan && <div className="mt-2 max-h-[50dvh] overflow-auto rounded-xl border border-line bg-panel/70 p-3.5 text-sm"><Markdown text={pv.plan} /></div>}
          {p?.body && <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-line bg-sunken p-2.5 font-mono text-xs leading-relaxed">{p.body}</pre>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-6">
        <Button ref={ref} size="sm" variant="primary" onClick={() => resolve(approval.id, true, always)}>{isPlan ? "Approve plan" : "Allow"}</Button>
        <Button size="sm" variant="ghost" onClick={() => resolve(approval.id, false)}>{isPlan ? "Keep planning" : "Deny"}</Button>
        {!isPlan && (
          <label className="ml-auto flex pointer-coarse:min-h-11 cursor-pointer items-center gap-2 text-xs text-muted">
            <Checkbox checked={always} onChange={setAlways} />
            {alwaysLabel}
          </label>
        )}
      </div>
    </div>
  );
}
