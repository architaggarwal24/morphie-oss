"use client";
import { FileCode2, History, MessagesSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import type { Mode } from "@/lib/types";
import { Button, Dialog, cn } from "../ui";

type What = "both" | "conversation" | "code";

/**
 * Rewind to before a message, like Claude Code's /rewind: the files the agent changed since (from the checkpoint taken
 * when that message started), the conversation (that message and everything after it), or both.
 */
export function RewindDialog({ target, onClose, convId, mode, hasCheckpoint }: {
  target: { id: number; content: string } | null; onClose: () => void; convId: string | null; mode: Mode; hasCheckpoint: boolean;
}) {
  const rewind = useStore((s) => s.rewind);
  const [what, setWhat] = useState<What>("both");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (target) setWhat(hasCheckpoint ? "both" : "conversation"); }, [target, hasCheckpoint]);
  const options: Array<{ v: What; icon: typeof History; title: string; body: string; needsCode?: boolean }> = [
    { v: "both", icon: History, title: "Code and conversation", body: "Put the files back the way they were, and remove this message and everything after it.", needsCode: true },
    { v: "conversation", icon: MessagesSquare, title: "Conversation only", body: "Remove this message and everything after it. The files stay as they are." },
    { v: "code", icon: FileCode2, title: "Code only", body: "Put the files back the way they were before this message. The conversation stays.", needsCode: true },
  ];
  const go = async () => {
    if (!target || !convId) return;
    setBusy(true);
    const ok = await rewind(convId, mode, target.id, { code: what !== "conversation", conversation: what !== "code" });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog open={!!target} onClose={onClose} title="Rewind to before this message" icon={<History className="size-4" />}
      description={target ? `“${target.content.length > 120 ? `${target.content.slice(0, 120)}…` : target.content}”` : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={go}>Rewind</Button></>}>
      <div className="space-y-2" role="radiogroup" aria-label="What to rewind">
        {options.map((o) => {
          const disabled = o.needsCode && !hasCheckpoint;
          const on = what === o.v;
          return (
            <button key={o.v} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => setWhat(o.v)}
              className={cn("flex w-full items-start gap-3 rounded-xl border p-3 text-left transition", on ? "border-accent/60 bg-accent/[0.07]" : "border-line hover:border-accent/30", disabled && "cursor-not-allowed opacity-50")}>
              <o.icon className={cn("mt-0.5 size-4 shrink-0", on ? "text-accent" : "text-muted")} aria-hidden />
              <span><span className="block text-sm font-medium">{o.title}</span><span className="mt-0.5 block text-xs leading-relaxed text-muted">{o.body}</span></span>
            </button>
          );
        })}
        {!hasCheckpoint && <p className="text-xs text-muted">There's no checkpoint of the files for this message (it didn't run in a project, or ran before checkpoints existed), so only the conversation can be rewound.</p>}
        <p className="text-xs text-faint">Rewinding the files saves how they are now first, so you can undo it from the message that appears.</p>
      </div>
    </Dialog>
  );
}
