"use client";
import { Check, FolderGit2, MessageSquareDashed, Palette, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { groupByRecency, timeAgo } from "@/lib/format";
import { useDesign } from "@/lib/designStore";
import { useRevalidate } from "@/lib/revalidate";
import { useStore } from "@/lib/store";
import type { DesignSummary, Mode } from "@/lib/types";
import { Bone, Button, IconButton, Input, Segmented, cn, useDelayedFlag } from "./ui";
import { SystemStrip } from "./design/SystemsView";

function Shell({ title, action, children, label }: { title: string; action: React.ReactNode; children: React.ReactNode; label: string }) {
  const open = useStore((s) => s.sidebarOpen);
  const toggle = useStore((s) => s.toggleSidebar);
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => toggle(false)} aria-hidden />}
      <aside aria-label={label} className={cn("glass z-40 flex-col border-r border-line", open ? "fixed inset-y-0 left-0 flex w-[min(86vw,300px)] shadow-pop max-md:pt-safe max-md:pb-safe max-md:pl-safe md:static md:shadow-none" : "hidden md:flex", "md:w-72 md:shrink-0")}>
        <div className="flex h-14 shrink-0 items-center justify-between px-4"><h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2><div className="flex items-center gap-1">{action}<IconButton label="Close" className="md:hidden" onClick={() => toggle(false)}><X className="size-4" /></IconButton></div></div>
        {children}
      </aside>
    </>
  );
}

export function ConversationSidebar({ mode }: { mode: Mode }) {
  const { conversations, activeConv, openConversation, newConversation, renameConversation, pinConversation, deleteConversation, refreshConversations, run } = useStore();
  const serverRunning = useStore((s) => s.running);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const hidden = useStore((s) => s.hidden);
  const projects = useStore((s) => s.projects);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const t = setTimeout(() => void refreshConversations(q.trim() || undefined), 250);
    return () => clearTimeout(t);
  }, [q, refreshConversations]);

  const items = conversations.filter((c) => c.mode === mode && !hidden[`conv:${c.id}`]);
  const groups = groupByRecency(items);
  const active = activeConv[mode];
  const noun = mode === "agent" ? "task" : "chat";

  return (
    <Shell title={mode === "agent" ? "Tasks" : "Chats"} label="Conversations" action={<Button size="sm" variant="soft" onClick={() => newConversation(mode)}><Plus className="size-4" aria-hidden /> New</Button>}>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${noun}s`} aria-label={`Search ${noun}s`} className="h-9! pl-8" />
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label={`${noun} history`}>
        {items.length === 0 && (
          <div className="grid place-items-center gap-3 px-4 py-10 text-center">
            <span className="grid size-11 place-items-center rounded-2xl bg-linear-to-b/oklch from-accent/20 to-accent/5 text-accent ring-1 ring-inset ring-accent/25">{q ? <Search className="size-5" aria-hidden /> : <MessageSquareDashed className="size-5" aria-hidden />}</span>
            <p className="text-[13px] leading-relaxed text-muted">{q ? "Nothing matches that search." : `No ${noun}s yet. Start one below.`}</p>
          </div>
        )}
        {groups.map(([label, list]) => (
          <div key={label} className="mb-3">
            <h3 className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{label}</h3>
            <ul>
              {list.map((c) => {
                const isActive = c.id === active;
                // Live in this tab, or working on the server with nobody watching.
                const running = (run?.convId === c.id && (run.status === "running" || run.status === "waiting" || run.status === "connecting")) || (!!serverRunning[c.id] && run?.convId !== c.id);
                return (
                  <li key={c.id} className="group relative">
                    {editing === c.id ? (
                      <form className="flex items-center gap-1 px-1 py-0.5" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void renameConversation(c.id, draft.trim()); setEditing(null); }}>
                        <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} className="h-8!" aria-label="Conversation title" maxLength={120} />
                        <IconButton label="Save title" type="submit"><Check className="size-4" /></IconButton>
                      </form>
                    ) : (
                      <>
                        <button onClick={() => void openConversation(mode, c.id)} aria-current={isActive ? "page" : undefined} className={cn("relative z-0 flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors active:scale-[0.99]", !isActive && "hover:bg-fg/[0.05]")}>
                          {isActive && <motion.span layoutId={`conv-pill-${mode}`} transition={{ type: "spring", stiffness: 500, damping: 40 }} className="absolute inset-0 -z-10 rounded-xl bg-raised ring-1 ring-line shadow-card before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-linear-to-b/oklch before:from-accent before:to-accent-2 before:content-['']" />}
                          {running && <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-ok shadow-[0_0_8px_rgb(var(--ok))]" aria-hidden />}
                          {c.pinned && <Pin className="size-3 shrink-0 text-accent" aria-label="Pinned" />}
                          <span className="min-w-0 flex-1"><span className={cn("block truncate text-[13px]", isActive && "font-medium")}>{c.title}</span><span className="flex min-w-0 items-center gap-1 text-[11px] tabular-nums text-faint">{running ? <span className="text-ok">Working…</span> : timeAgo(c.updatedAt)}{(() => { const p = c.projectId ? projects.find((x) => x.id === c.projectId) : undefined; return p ? <><span aria-hidden>·</span><FolderGit2 className="size-3 shrink-0" aria-hidden /><span className="truncate">{p.name}</span></> : null; })()}</span></span>
                        </button>
                        <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-lg bg-linear-to-r from-transparent via-raised to-raised pl-6 group-hover:flex group-focus-within:flex">
                          <IconButton label={c.pinned ? "Unpin" : "Pin"} className="size-6" onClick={() => void pinConversation(c.id, !c.pinned)}>{c.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}</IconButton>
                          <IconButton label="Rename" className="size-6" onClick={() => { setEditing(c.id); setDraft(c.title); }}><Pencil className="size-3" /></IconButton>
                          <IconButton label="Delete" className="size-6 hover:text-err" onClick={() => void deleteConversation(c.id)}><Trash2 className="size-3" /></IconButton>
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </Shell>
  );
}

/** One design in the list. Without `d` it is the same row drawn as gray blocks (while the list loads). */
function DesignRow({ d, active, onOpen, onDelete }: { d?: DesignSummary; active?: boolean; onOpen?: () => void; onDelete?: () => void }) {
  const Row = d ? "button" : "div";
  return (
    <li className="group relative">
      <Row {...(d ? { onClick: onOpen, "aria-current": active ? ("page" as const) : undefined } : { "aria-hidden": true })} className={cn("relative z-0 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors", !active && d && "hover:bg-fg/[0.05]")}>
        {active && <motion.span layoutId="design-pill" transition={{ type: "spring", stiffness: 500, damping: 40 }} className="absolute inset-0 -z-10 rounded-xl bg-raised ring-1 ring-line shadow-card" />}
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg font-display text-sm font-semibold", d ? "bg-linear-to-br/oklch from-accent/80 to-accent-2/70 text-white" : "border border-line bg-sunken")}>{d ? d.name.slice(0, 1).toUpperCase() : <Bone className="size-3.5" />}</span>
        <span className="min-w-0 flex-1"><span className={cn("block truncate text-[13px]", active && "font-medium")}>{d ? d.name : <Bone className="h-3 w-28" />}</span><span className="block text-[11px] tabular-nums text-faint">{d ? <>v{d.version} · {timeAgo(d.updatedAt)}</> : <Bone className="h-2.5 w-16" />}</span></span>
      </Row>
      {d && <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded-lg bg-raised group-hover:flex group-focus-within:flex"><IconButton label={`Delete ${d.name}`} className="size-6 hover:text-err" onClick={onDelete}><Trash2 className="size-3" /></IconButton></span>}
    </li>
  );
}

export function DesignSidebar() {
  const { designs, activeId, open, remove, loaded, load, busy, mode, setMode, systems, activeSystemId, openSystem, deleteSystem } = useDesign();
  const toggle = useStore((s) => s.toggleSidebar);
  const hidden = useStore((s) => s.hidden);
  const shown = designs.filter((d) => !hidden[`design:${d.id}`]);
  const shownSystems = systems.filter((x) => !hidden[`system:${x.id}`]);
  // The list is cached in the design store: show it at once on every visit and refetch it in the background.
  useEffect(() => { void load(); }, [load]);
  useRevalidate(load);
  const slow = useDelayedFlag(!loaded);
  return (
    <Shell title="Design" label="Design projects" action={<Button size="sm" variant="soft" disabled={!!busy} onClick={() => { if (mode === "systems") void openSystem(null); else void open(null); toggle(false); }}><Plus className="size-4" aria-hidden /> New</Button>}>
      <div className="px-3 pb-2">
        <Segmented<"designs" | "systems"> label="Show" kind="tab" size="sm" className="w-full [&>button]:flex-1" value={mode} onChange={(m) => { setMode(m); if (m === "systems" && !activeSystemId) void openSystem(null); }} options={[{ value: "designs", label: "Designs" }, { value: "systems", label: `Systems${systems.length ? ` · ${systems.length}` : ""}` }]} />
      </div>
      {mode === "systems" ? (
        <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="Design systems">
          {loaded && shownSystems.length === 0 && (
            <div className="grid place-items-center gap-3 px-4 py-10 text-center">
              <span className="grid size-11 place-items-center rounded-2xl bg-linear-to-b/oklch from-accent/20 to-accent/5 text-accent ring-1 ring-inset ring-accent/25"><Palette className="size-5" aria-hidden /></span>
              <p className="text-[13px] leading-relaxed text-muted">No systems yet. Describe a brand, point at a website or drop a screenshot.</p>
            </div>
          )}
          <ul>
            {shownSystems.map((x) => (
              <li key={x.id} className="group relative">
                <button onClick={() => { void openSystem(x.id); toggle(false); }} aria-current={x.id === activeSystemId ? "page" : undefined} className={cn("relative z-0 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors", x.id !== activeSystemId && "hover:bg-fg/[0.05]")}>
                  {x.id === activeSystemId && <motion.span layoutId="system-pill" transition={{ type: "spring", stiffness: 500, damping: 40 }} className="absolute inset-0 -z-10 rounded-xl bg-raised ring-1 ring-line shadow-card" />}
                  <SystemStrip colors={x.colors} className="h-8 w-8 shrink-0 flex-col [&>span]:w-full" />
                  <span className="min-w-0 flex-1"><span className={cn("block truncate text-[13px]", x.id === activeSystemId && "font-medium")}>{x.name}</span><span className="block truncate text-[11px] text-faint">{x.fonts.heading} · {timeAgo(x.updatedAt)}</span></span>
                </button>
                <span className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded-lg bg-raised group-hover:flex group-focus-within:flex"><IconButton label={`Delete ${x.name}`} className="size-6 hover:text-err" onClick={() => void deleteSystem(x.id)}><Trash2 className="size-3" /></IconButton></span>
              </li>
            ))}
          </ul>
        </nav>
      ) : (
      <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="Design projects">
        {!loaded && <ul aria-busy="true" aria-label="Loading designs">{slow && [0, 1, 2].map((i) => <DesignRow key={i} />)}</ul>}
        {loaded && shown.length === 0 && (
          <div className="grid place-items-center gap-3 px-4 py-10 text-center">
            <span className="grid size-11 place-items-center rounded-2xl bg-linear-to-b/oklch from-accent/20 to-accent/5 text-accent ring-1 ring-inset ring-accent/25"><Palette className="size-5" aria-hidden /></span>
            <p className="text-[13px] leading-relaxed text-muted">No designs yet. Describe a site and Morphie will build it.</p>
          </div>
        )}
        <ul>
          {shown.map((d) => <DesignRow key={d.id} d={d} active={d.id === activeId && mode === "designs"} onOpen={() => { void open(d.id); toggle(false); }} onDelete={() => void remove(d.id)} />)}
        </ul>
      </nav>
      )}
    </Shell>
  );
}
