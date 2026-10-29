"use client";
import { ChevronRight, FileCode2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { parseDiff, type DiffFile } from "@/lib/diff";
import { cn } from "../ui";

/** +n −m, in the diff colours. */
export function DiffStat({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums", className)}>
      {added > 0 && <span className="text-ok">+{added}</span>}
      {removed > 0 && <span className="text-err">−{removed}</span>}
      {!added && !removed && <span className="text-faint">±0</span>}
    </span>
  );
}

function FileDiff({ file, defaultOpen, actions, compact }: { file: DiffFile; defaultOpen: boolean; actions?: ReactNode; compact?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const created = file.oldPath === null, deleted = file.newPath === null;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-sunken/70">
      <div className="flex items-center gap-2 border-b border-line/70 bg-panel/60 px-2.5 py-1.5">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="group flex min-w-0 flex-1 items-center gap-2 pointer-coarse:min-h-11 text-left">
          <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform duration-200 group-hover:text-fg", open && "rotate-90")} aria-hidden />
          <FileCode2 className="size-3.5 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 truncate font-mono text-xs" title={file.path}>{file.path}</span>
          {created && <span className="rounded bg-ok/12 px-1.5 text-[10px] font-medium text-ok">new</span>}
          {deleted && <span className="rounded bg-err/12 px-1.5 text-[10px] font-medium text-err">deleted</span>}
        </button>
        <DiffStat added={file.added} removed={file.removed} />
        {actions}
      </div>
      {open && (
        <div className={cn("overflow-auto font-mono text-[12px] leading-[1.55]", compact ? "max-h-72" : "max-h-[60dvh]")}>
          {file.binary && <p className="px-3 py-2 text-muted">Binary file changed.</p>}
          {file.hunks.map((h, i) => (
            <table key={i} className="w-full border-collapse">
              <tbody>
                <tr><td colSpan={3} className="sticky left-0 bg-accent/[0.06] px-3 py-0.5 text-[11px] text-accent/80">{h.header}</td></tr>
                {h.lines.map((l, j) => (
                  <tr key={j} className={cn(l.kind === "add" && "bg-ok/[0.09]", l.kind === "del" && "bg-err/[0.09]")}>
                    <td className="w-10 select-none border-r border-line/50 px-1.5 text-right align-top text-[10.5px] text-faint tabular-nums">{l.oldNo ?? ""}</td>
                    <td className="w-10 select-none border-r border-line/50 px-1.5 text-right align-top text-[10.5px] text-faint tabular-nums">{l.newNo ?? ""}</td>
                    <td className="whitespace-pre px-2 align-top">
                      <span className={cn("mr-2 inline-block w-2 select-none", l.kind === "add" ? "text-ok" : l.kind === "del" ? "text-err" : "text-faint")}>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                      <span className={cn(l.kind === "note" && "italic text-muted")}>{l.text || " "}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      )}
    </div>
  );
}

/** A unified diff, file by file, with line numbers. `actions(path)` adds buttons to each file's header. */
export function DiffView({ diff, defaultOpen = true, actions, compact, empty }: { diff: string; defaultOpen?: boolean; actions?: (path: string) => ReactNode; compact?: boolean; empty?: ReactNode }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  if (!files.length) return <>{empty ?? <p className="text-xs text-muted">No changes.</p>}</>;
  return (
    <div className="space-y-2">
      {files.map((f, i) => <FileDiff key={`${f.path}-${i}`} file={f} defaultOpen={defaultOpen && (files.length <= 6 || i < 3)} actions={actions?.(f.path)} compact={compact} />)}
    </div>
  );
}
