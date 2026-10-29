"use client";
import { Brain, Code2, FolderKanban, Plus, Search, Shapes, SlidersHorizontal, Trash2, UserRound, Workflow, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, newIdempotencyKey } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useRevalidate } from "@/lib/revalidate";
import { useStore } from "@/lib/store";
import { spotlight } from "../fx";
import type { MemoryView as Memory } from "@/lib/types";
import { Badge, Bone, Button, ConfirmDialog, EmptyState, IconButton, Input, Select, Switch, useDelayedFlag } from "../ui";

const CATEGORIES = ["preference", "profile", "project", "workflow", "technical", "other"] as const;
const TONE: Record<string, "accent" | "info" | "ok" | "warn" | "neutral"> = { preference: "accent", profile: "info", project: "ok", workflow: "warn", technical: "neutral", other: "neutral" };
const CAT: Record<(typeof CATEGORIES)[number], { label: string; icon: LucideIcon; hint: string }> = {
  preference: { label: "Preference", icon: SlidersHorizontal, hint: "How you like answers and work done" },
  profile: { label: "Profile", icon: UserRound, hint: "Who you are, your role, your context" },
  project: { label: "Project", icon: FolderKanban, hint: "Something you're building or tracking" },
  workflow: { label: "Workflow", icon: Workflow, hint: "Steps and habits you repeat" },
  technical: { label: "Technical", icon: Code2, hint: "Stack, tools, versions, conventions" },
  other: { label: "Other", icon: Shapes, hint: "Anything else worth keeping" },
};

/** One memory. Without `m` it draws the same row as gray blocks. */
function MemoryRow({ m, onForget }: { m?: Memory; onForget?: (id: string) => void }) {
  return (
    <li onPointerMove={spotlight} className="spotlight group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-raised/40">
      {(() => { const Icon = (m && CAT[m.category as keyof typeof CAT]?.icon) || Brain; return <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-linear-to-b/oklch from-accent/20 to-accent/5 text-accent ring-1 ring-inset ring-accent/25 transition duration-300 group-hover:shadow-[0_0_18px_-4px_rgb(var(--accent)/0.6)]"><Icon className="size-4" aria-hidden /></span>; })()}
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed">{m ? m.content : <Bone className="h-3.5 w-3/4" />}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {m ? <><Badge tone={TONE[m.category] ?? "neutral"}>{m.category}</Badge>{m.source !== "auto" && <Badge>{m.source}</Badge>}<span className="text-[11px] tabular-nums text-faint">{timeAgo(m.updatedAt)}</span></> : <><Bone className="h-[18px] w-16 rounded-full" /><Bone className="h-3 w-12" /></>}
        </div>
      </div>
      {m ? <IconButton label="Forget this" className="hover:text-err" onClick={() => onForget?.(m.id)}><Trash2 className="size-4" /></IconButton> : <span className="size-8 shrink-0 pointer-coarse:size-11" aria-hidden />}
    </li>
  );
}

export function MemoryView() {
  const { settings, setSettings, toast } = useStore();
  // Cached in the store: a revisit shows the last list at once while it refetches in the background.
  const items = useStore((s) => s.memories);
  const setItems = useStore((s) => s.setMemories);
  const [q, setQ] = useState("");
  const [text, setText] = useState("");
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]>("preference");
  const [adding, setAdding] = useState(false);
  const [clear, setClear] = useState(false);
  const slow = useDelayedFlag(items === null);

  const load = useCallback(async () => { try { setItems((await api<{ memories: Memory[] }>("/api/memory")).memories); } catch (e) { if (useStore.getState().memories === null) { toast("error", (e as Error).message); setItems([]); } } }, [toast, setItems]);
  useEffect(() => { void load(); }, [load]);
  useRevalidate(load);

  const hidden = useStore((s) => s.hidden);
  const kept = useMemo(() => (items ?? []).filter((m) => !hidden[`mem:${m.id}`]), [items, hidden]);
  const shown = useMemo(() => kept.filter((m) => !q.trim() || `${m.content} ${m.category}`.toLowerCase().includes(q.toLowerCase())), [kept, q]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try { setItems((await api<{ memories: Memory[] }>("/api/memory", { method: "POST", body: { content: text, category: cat }, idempotencyKey: newIdempotencyKey() })).memories); setText(""); }
    catch (err) { toast("error", (err as Error).message); } finally { setAdding(false); }
  }
  const undoable = useStore((s) => s.undoable);
  const remove = (id: string) => undoable({
    key: `mem:${id}`, text: "Memory forgotten.",
    commit: async ({ keepalive }) => setItems((await api<{ memories: Memory[] }>(`/api/memory/${id}`, { method: "DELETE", keepalive })).memories),
  });
  const clearAll = async () => { try { setItems((await api<{ memories: Memory[] }>("/api/memory", { method: "DELETE" })).memories); } catch (e) { toast("error", (e as Error).message); } };

  return (
    <div className="h-full flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 pb-24 md:px-8 md:py-10 md:pb-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl"><h1 className="font-display text-4xl font-semibold tracking-[-0.03em]">Memory</h1><p className="mt-1.5 text-sm leading-relaxed text-muted">Short facts Morphie carries between conversations. It saves them only from what <em>you</em> say, never stores secrets or instructions, and you can edit this list any time.</p></div>
          <label className="glass flex cursor-pointer items-center gap-3 rounded-2xl border border-line px-4 py-3 text-sm font-medium shadow-card transition hover:border-accent/40"><span>Remember things</span><Switch checked={settings.memory} onChange={(v) => setSettings({ memory: v })} label="Remember things" /></label>
        </header>

        <form onSubmit={add} className="glass flex flex-col gap-2 rounded-2xl border border-line p-2.5 shadow-card transition duration-300 focus-within:border-accent/50 focus-within:shadow-glow hover:border-faint/50 sm:flex-row">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add something to remember, e.g. “I prefer concise answers”" aria-label="New memory" maxLength={300} className="flex-1" />
          <Select value={cat} onValueChange={setCat} aria-label="Category" className="sm:w-44"
            options={CATEGORIES.map((c) => { const C = CAT[c]; return { value: c, label: C.label, textValue: C.label, icon: <C.icon className="size-4" />, hint: C.hint }; })} />
          <Button type="submit" variant="primary" loading={adding} disabled={text.trim().length < 3}><Plus className="size-4" aria-hidden /> Add</Button>
        </form>

        {items === null ? (
          <div aria-busy="true">{slow && <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel/70 backdrop-blur" aria-label="Loading memories">{[0, 1, 2].map((i) => <MemoryRow key={i} />)}</ul>}</div>
        ) : kept.length === 0 ? (
          <EmptyState icon={<Brain className="size-5" />} title="No memories yet">As you chat, Morphie will note lasting preferences and facts here. Or add one yourself above.</EmptyState>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter memories" aria-label="Filter memories" className="h-9! pl-8" /></div>
              <span className="text-xs tabular-nums text-muted">{kept.length} saved</span>
              <Button size="sm" variant="ghost" className="hover:text-err" onClick={() => setClear(true)}>Clear all</Button>
            </div>
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel/70 backdrop-blur">
              {shown.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted">No memories match.</li>}
              {shown.map((m) => <MemoryRow key={m.id} m={m} onForget={remove} />)}
            </ul>
          </>
        )}
      </div>
      <ConfirmDialog open={clear} title="Forget everything?" confirm="Clear all" body="All saved memories will be permanently deleted." onConfirm={() => void clearAll()} onClose={() => setClear(false)} />
    </div>
  );
}
