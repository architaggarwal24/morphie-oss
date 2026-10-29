"use client";
import { BrandMark } from "../BrandMark";
import { Check, ChevronDown, Lock, Plug, Settings2 } from "lucide-react";
import { useState } from "react";
import { useStore } from "@/lib/store";
import type { ProfileView } from "@/lib/types";
import { cn, useDismiss } from "../ui";

/** Shows the active model and lets you hop between saved providers without opening Settings. */
export function ProviderChip({ disabled }: { disabled?: boolean }) {
  const { profiles, activeId, activateProvider, setTab, setSettingsSection } = useStore();
  const loggedIn = useStore((s) => !!s.session);
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const active = profiles.find((p) => p.id === activeId);

  const plan = useStore((s) => s.plan);
  const toast = useStore((s) => s.toast);
  const openPlans = useStore((s) => s.openPlans);
  const modelName = (p: ProfileView) => plan?.models.find((m) => m.id === p.model)?.label ?? p.model;
  const tierName = (id: string) => plan?.plans.find((x) => x.id === id)?.name ?? id;

  function pick(p: ProfileView) {
    setOpen(false);
    // Not on this plan: say which plan has it, with a way there.
    if (p.hosted?.locked) { toast("info", `${modelName(p)} is part of ${tierName(p.hosted.tier)} and up.`, { label: "See plans", run: openPlans }); return; }
    if (p.paused) { toast("info", "Using your own API keys isn't part of your plan.", { label: "See plans", run: openPlans }); return; }
    void activateProvider(p.id); // optimistic: the chip shows the new model straight away
  }

  if (!active) {
    return <button onClick={(e) => { setTab("settings", e.currentTarget); setSettingsSection("providers"); }} aria-haspopup={loggedIn ? undefined : "dialog"} className="flex items-center gap-1.5 rounded-lg border border-warn/40 bg-warn/5 px-2.5 py-1 text-xs text-warn transition hover:border-warn/70 hover:bg-warn/10 hover:shadow-[0_6px_18px_-8px_rgb(var(--warn)/0.6)] active:scale-95 pointer-coarse:min-h-11"><Plug className="size-3.5" aria-hidden /> Connect a provider</button>;
  }
  const row = (p: ProfileView) => {
    const name = modelName(p);
    const lockedBy = p.hosted?.locked ? tierName(p.hosted.tier) : p.paused ? "own keys" : null;
    return (
      <button key={p.id} role="option" aria-selected={p.id === activeId} aria-disabled={lockedBy ? true : undefined} onClick={() => pick(p)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-accent/10", p.id === activeId && "bg-accent/[0.08]", lockedBy && "opacity-60")}>
        <BrandMark kind={p.kind} label={p.label} size="sm" active={p.id === activeId} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-sm font-medium">{p.hosted ? name : p.label}{p.hosted?.free && <span className="rounded bg-ok/12 px-1 text-[10px] font-semibold uppercase text-ok">free</span>}</div>
          <div className="truncate font-mono text-[11px] text-muted">{p.hosted ? (p.hosted.free ? "Free daily credits" : `×${p.hosted.multiplier} credits`) : p.model}</div>
        </div>
        {p.id === activeId ? <Check className="size-4 text-accent" aria-hidden /> : lockedBy ? <span className="flex items-center gap-1 text-[11px] text-faint"><Lock className="size-3" aria-hidden />{lockedBy}</span> : null}
      </button>
    );
  };
  const hosted = profiles.filter((p) => p.hosted && p.hosted.available);
  const own = profiles.filter((p) => !p.hosted);

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} className="group flex max-w-[260px] items-center gap-1.5 rounded-lg px-1.5 py-1 pointer-coarse:min-h-11 text-xs text-muted transition hover:bg-fg/[0.06] hover:text-fg active:scale-[0.97] disabled:opacity-60">
        <BrandMark kind={active.kind} label={active.label} size="sm" className="size-5! rounded-md! [&>*]:size-3!" />
        <span className="truncate font-medium text-fg">{active.hosted ? modelName(active) : active.label}</span>
        <span className="truncate font-mono text-faint">{active.hosted ? "Morphie AI" : active.model}</span>
        <ChevronDown className={cn("size-3 shrink-0 transition-transform duration-300", open && "rotate-180")} aria-hidden />
      </button>
      {(
        <div role="listbox" aria-label="Switch provider" hidden={!open} inert={!open} className="pop absolute bottom-full left-0 z-30 mb-2 w-72 origin-bottom-left overflow-hidden rounded-xl border border-line bg-panel/95 p-1 shadow-pop backdrop-blur-xl">
          <div className="max-h-72 overflow-auto">
            {hosted.length > 0 && <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">Morphie AI</div>}
            {hosted.map(row)}
            {hosted.length > 0 && own.length > 0 && <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">Your keys</div>}
            {own.map(row)}
          </div>
          <button onClick={() => { setOpen(false); setTab("settings"); setSettingsSection("providers"); }} className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-line px-2.5 py-2 text-left text-sm text-muted transition hover:bg-fg/[0.06] hover:text-fg"><Settings2 className="size-4" aria-hidden /> Manage providers</button>
        </div>
      )}
    </div>
  );
}
