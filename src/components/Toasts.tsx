"use client";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useStore } from "@/lib/store";
import { cn } from "./ui";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const reduce = useReducedMotion();
  return (
    <div className="pointer-events-none fixed bottom-[calc(5rem_+_var(--safe-bottom))] right-[calc(1rem_+_var(--safe-right))] z-[60] flex w-[min(92vw,380px)] flex-col gap-2 md:bottom-[calc(1rem_+_var(--safe-bottom))]" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.kind === "error" ? AlertCircle : t.kind === "ok" ? CheckCircle2 : Info;
        return (
          // Springs in from the right; an Undo toast shows how long is left before it acts.
          <motion.div key={t.id} layout={!reduce} role={t.kind === "error" ? "alert" : "status"}
            initial={reduce ? false : { opacity: 0, x: 40, scale: 0.96 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className={cn("dialog-surface pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-2xl p-3 pr-2", t.kind === "error" ? "ring-1 ring-err/40" : t.kind === "ok" ? "ring-1 ring-ok/25" : "")}>
            <span aria-hidden className={cn("pointer-events-none absolute -left-8 -top-8 size-24 rounded-full blur-2xl", t.kind === "error" ? "bg-err/25" : t.kind === "ok" ? "bg-ok/20" : "bg-info/20")} />
            <span className={cn("relative grid size-7 shrink-0 place-items-center rounded-lg ring-1 ring-inset", t.kind === "error" ? "bg-err/15 text-err ring-err/30" : t.kind === "ok" ? "bg-ok/15 text-ok ring-ok/30" : "bg-info/15 text-info ring-info/30")}><Icon className="size-4" aria-hidden /></span>
            <p className="relative flex-1 pt-1 text-sm leading-snug">{t.text}</p>
            {t.action && <button onClick={t.action.run} className="-my-1 rounded-lg px-2.5 py-1 text-sm font-semibold text-accent transition hover:bg-accent/12 active:scale-95 pointer-coarse:min-h-11">{t.action.label}</button>}
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="relative grid size-6 place-items-center rounded-md text-faint transition hover:rotate-90 hover:bg-fg/[0.07] hover:text-fg pointer-coarse:size-11 pointer-coarse:-my-2.5 pointer-coarse:-mr-1"><X className="size-3.5" /></button>
            {t.duration && <span aria-hidden className="toast-timer absolute inset-x-0 bottom-0 h-0.5 origin-left bg-linear-to-r/oklch from-accent to-accent-2" style={{ animationDuration: `${t.duration}ms` }} />}
          </motion.div>
        );
      })}
    </div>
  );
}
