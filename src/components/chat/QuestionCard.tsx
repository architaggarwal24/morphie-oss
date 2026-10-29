"use client";
import { Check, MessageCircleQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import type { PendingQuestion } from "@/lib/runState";
import { Button, Input, cn } from "../ui";

/** One answer as the agent reads it: the picked options (joined) and anything typed under "Other". */
export function answerText(picked: string[], other: string): string {
  return [...picked, other.trim()].filter(Boolean).join(", ");
}

/** The agent's multiple-choice questions (ask_user): pick, or type your own, then send. Skip lets it use defaults. */
export function QuestionCard({ pending }: { pending: PendingQuestion }) {
  const answer = useStore((s) => s.answerQuestion);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button[data-option]")?.focus({ preventScroll: true }); }, []);

  const toggle = (q: string, label: string, multi?: boolean) => setPicked((p) => {
    const cur = p[q] ?? [];
    if (!multi) return { ...p, [q]: cur[0] === label ? [] : [label] };
    return { ...p, [q]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
  });
  const answers = Object.fromEntries(pending.questions.map((q) => [q.question, answerText(picked[q.question] ?? [], other[q.question] ?? "")]));
  const answered = Object.values(answers).filter(Boolean).length;
  const send = async (a: Record<string, string> | null) => { setSending(true); await answer(pending.id, a); };

  return (
    <div ref={ref} className="mt-2 rounded-2xl border border-accent/40 bg-accent/[0.05] p-4 shadow-[0_0_0_4px_rgb(var(--accent)/0.06)] animate-rise" role="group" aria-label="Questions from the agent">
      <div className="flex items-center gap-2.5">
        <MessageCircleQuestion className="size-4 shrink-0 text-accent" aria-hidden />
        <p className="text-sm font-medium">{pending.questions.length === 1 ? "A quick question before I start" : `${pending.questions.length} quick questions before I start`}</p>
      </div>
      <div className="mt-3 space-y-4 pl-6">
        {pending.questions.map((q, qi) => {
          const sel = picked[q.question] ?? [];
          const id = `${pending.id}-${qi}`;
          return (
            <fieldset key={q.question} className="space-y-2">
              <legend className="mb-2 flex flex-wrap items-baseline gap-2 text-sm">
                {q.header && <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">{q.header}</span>}
                <span>{q.question}</span>
                {q.multiSelect && <span className="text-xs text-faint">Pick any</span>}
              </legend>
              <div className="grid gap-1.5 sm:grid-cols-2" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
                {q.options.map((o) => {
                  const on = sel.includes(o.label);
                  return (
                    <button
                      key={o.label} type="button" data-option
                      role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on}
                      onClick={() => toggle(q.question, o.label, q.multiSelect)}
                      className={cn(
                        "flex pointer-coarse:min-h-11 items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition duration-200 active:scale-[0.99]",
                        on ? "border-accent/60 bg-accent/10 shadow-[0_0_12px_-4px_rgb(var(--accent)/0.6)]" : "border-line bg-panel/60 hover:border-accent/30 hover:bg-fg/[0.03]",
                      )}
                    >
                      <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center border transition", q.multiSelect ? "rounded-[5px]" : "rounded-full", on ? "border-accent bg-accent text-white" : "border-line")}>
                        {on && <Check className="size-2.5" aria-hidden />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{o.label}</span>
                        {o.description && <span className="mt-0.5 block text-xs leading-snug text-muted">{o.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
              <Input
                id={`${id}-other`} aria-label={`Other answer: ${q.question}`} placeholder="Other… (type your own)"
                value={other[q.question] ?? ""} maxLength={500}
                onChange={(e) => setOther((p) => ({ ...p, [q.question]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter" && answered && !sending) { e.preventDefault(); void send(answers); } }}
                className="h-9 text-sm"
              />
            </fieldset>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 pl-6">
        <Button size="sm" variant="primary" disabled={!answered || sending} loading={sending} onClick={() => send(answers)}>Send answers</Button>
        <Button size="sm" variant="ghost" disabled={sending} onClick={() => send(null)}>Skip, use your judgment</Button>
        <span className="ml-auto text-xs tabular-nums text-faint">{answered}/{pending.questions.length} answered</span>
      </div>
    </div>
  );
}
