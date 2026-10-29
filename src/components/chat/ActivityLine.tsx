"use client";
import { useEffect, useRef, useState } from "react";
import { cn } from "../ui";

const fmtChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/**
 * What the agent is doing right now, between the steps you can see: "Thinking", "Writing src/app/page.tsx",
 * with how long it's been at it and how much it has written. Keeps the run feeling alive while the model works.
 */
export function ActivityLine({ text, chars, className }: { text: string; chars?: number; className?: string }) {
  const since = useRef({ text, at: Date.now() });
  if (since.current.text !== text) since.current = { text, at: Date.now() };
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const secs = Math.floor((Date.now() - since.current.at) / 1000);
  const meta = [secs >= 2 ? `${secs}s` : "", chars && chars > 40 ? `${fmtChars(chars)} chars` : ""].filter(Boolean).join(" · ");
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5 px-2 py-1 text-[13px]", className)} role="status" aria-live="polite" data-testid="activity-line">
      <span className="relative grid size-4 shrink-0 place-items-center" aria-hidden>
        <span className="absolute size-3 animate-ping rounded-full bg-accent/30" />
        <span className="size-1.5 rounded-full bg-accent shadow-[0_0_8px_rgb(var(--accent)/0.8)]" />
      </span>
      <span className="text-shine min-w-0 truncate font-medium">{text}…</span>
      {meta && <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">{meta}</span>}
    </div>
  );
}
