"use client";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { tokens } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { UsageSummary, UsageTotals } from "@/lib/types";
import { Bone, IconButton, Segmented, cn } from "../ui";

const FEATURES: Record<string, string> = {
  chat: "Chat", agent: "Agent", code: "Code projects", subagent: "Sub-agents", compaction: "Summaries", memory: "Memory",
  design: "Design", design_system: "Design systems", verify: "Verification", other: "Other",
};
const sum = (t: UsageTotals) => t.input + t.output;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card-surface rounded-2xl p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

/** Tokens per day, input (with its cached part) and output stacked. */
function DayChart({ days }: { days: UsageSummary["byDay"] }) {
  const max = Math.max(1, ...days.map(sum));
  const [hover, setHover] = useState<number | null>(null);
  const h = hover != null ? days[hover] : null;
  return (
    <div className="card-surface rounded-2xl p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">Tokens per day</span>
        <span className="font-mono text-xs tabular-nums text-muted">{h ? `${h.day}: ${tokens(h.input)} in · ${tokens(h.output)} out · ${h.calls} calls` : "Hover a day"}</span>
      </div>
      <div className="flex h-36 items-end gap-[2px]" role="img" aria-label={`Tokens per day over the last ${days.length} days, highest ${tokens(max)}`} onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => {
          const total = sum(d);
          const fresh = Math.max(0, d.input - d.cached);
          return (
            <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
              <div className={cn("flex w-full flex-col-reverse overflow-hidden rounded-t-[3px] transition-opacity", hover != null && hover !== i && "opacity-50")} style={{ height: `${(total / max) * 100}%`, minHeight: total ? 2 : 0 }}>
                <span className="block w-full bg-accent/35" style={{ height: `${(d.cached / Math.max(1, total)) * 100}%` }} />
                <span className="block w-full bg-accent" style={{ height: `${(fresh / Math.max(1, total)) * 100}%` }} />
                <span className="block w-full bg-accent-2" style={{ height: `${(d.output / Math.max(1, total)) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-accent" />Input</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-accent/35" />Input from cache</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-accent-2" />Output</span>
      </div>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: Array<{ key: string; label: string; t: UsageTotals }> }) {
  const max = Math.max(1, ...rows.map((r) => sum(r.t)));
  return (
    <div className="card-surface rounded-2xl p-4">
      <div className="mb-2 text-sm font-medium">{title}</div>
      {rows.length === 0 ? <p className="text-xs text-muted">Nothing yet.</p> : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate" title={r.label}>{r.label}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted">{tokens(sum(r.t))}{r.t.estimated ? <span title={`${r.t.estimated} of ${r.t.calls} calls estimated (the provider didn't report usage)`}>*</span> : null}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-fg/10"><div className="h-full rounded-full bg-linear-to-r/oklch from-accent to-accent-2" style={{ width: `${(sum(r.t) / max) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Settings → Usage: where tokens went, by day, feature, model, conversation and design. */
export function UsageSection() {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openConversation = useStore((s) => s.openConversation);
  const setTab = useStore((s) => s.setTab);
  const conversations = useStore((s) => s.conversations);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await api<UsageSummary>(`/api/usage?days=${days}`)); } catch (e) { setError((e as Error).message); }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  const t = data?.total;
  const cachedPct = t && t.input ? Math.round((t.cached / t.input) * 100) : 0;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-tight">Usage</h2>
          <p className="mt-1 text-sm text-muted">Tokens sent to and received from your AI providers. Your provider's bill is the source of truth; calls marked * were estimated.</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented size="sm" label="Period" value={days} onChange={(v) => setDays(v)} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />
          <IconButton label="Refresh" onClick={() => void load()}><RefreshCw className="size-4" /></IconButton>
        </div>
      </div>
      {error && <p className="text-sm text-err" role="alert">{error}</p>}
      {!data && !error && <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <Bone key={i} className="h-24 rounded-2xl" />)}</div>}
      {data && t && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Total tokens" value={tokens(sum(t))} hint={`${t.calls.toLocaleString()} model calls`} />
            <Stat label="Input" value={tokens(t.input)} hint={t.cached ? `${cachedPct}% from the prompt cache` : "no cache hits reported"} />
            <Stat label="Output" value={tokens(t.output)} />
          </div>
          <DayChart days={data.byDay} />
          <div className="grid gap-3 md:grid-cols-2">
            <Breakdown title="By feature" rows={data.byFeature.map((r) => ({ key: r.key, label: FEATURES[r.key] ?? r.key, t: r }))} />
            <Breakdown title="By model" rows={data.byModel.map((r) => ({ key: r.key, label: r.key, t: r }))} />
          </div>
          <div className="card-surface rounded-2xl p-4">
            <div className="mb-2 text-sm font-medium">Conversations that used the most</div>
            {data.conversations.length === 0 ? <p className="text-xs text-muted">Nothing yet.</p> : (
              <ul className="divide-y divide-line/60">
                {data.conversations.map((c) => {
                  const conv = conversations.find((x) => x.id === c.id);
                  return (
                    <li key={c.id} className="flex items-center gap-3 py-2 text-[13px]">
                      {conv ? <button className="min-w-0 flex-1 truncate text-left hover:text-accent" onClick={() => { setTab(conv.mode); void openConversation(conv.mode, conv.id); }}>{c.title}</button> : <span className="min-w-0 flex-1 truncate text-muted">{c.title}</span>}
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted">{tokens(sum(c))} · {c.calls} calls</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {data.designs.length > 0 && (
            <Breakdown title="Designs" rows={data.designs.map((d) => ({ key: d.id, label: d.title, t: d }))} />
          )}
        </>
      )}
    </div>
  );
}
