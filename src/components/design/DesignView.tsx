"use client";
import { ArrowUp, Check, ChevronDown, Copy, Download, History, Layers, Link2Off, Menu, Monitor, MousePointerClick, Palette, PanelRight, Pencil, Plus, Redo2, Smartphone, Sparkles, Square, Tablet, Undo2, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DEVICE_WIDTHS, useDesign, type Device } from "@/lib/designStore";
import { timeAgo } from "@/lib/format";
import { motion } from "motion/react";
import { isTypingTarget, matches, SHORTCUTS } from "@/lib/shortcuts";
import { Magnetic } from "../fx";
import { useStore } from "@/lib/store";
import { prefersReducedMotion } from "@/lib/viewTransition";
import type { DesignState } from "@/lib/types";
import { Badge, Button, IconButton, Input, KeyCombo, cn, useDismiss } from "../ui";
import { ExportDialog } from "./ExportDialog";
import { EditablePreview, Preview } from "./Preview";
import { SystemStrip, SystemsView } from "./SystemsView";

const NEW_IDEAS = [
  "A dark landing page for a fintech startup that helps freelancers get paid faster",
  "A portfolio site for a wedding photographer with a warm, editorial feel",
  "A SaaS marketing site with pricing and FAQ for a project-management tool",
  "A dashboard-style overview page for a logistics company",
];
const EDIT_IDEAS = ["Make it darker", "Add an FAQ section", "Make the hero bigger", "Use purple accents", "Use the Premium theme", "Make the cards more rounded"];
const STAGE: Record<string, string> = { drafting: "Designing…", validating: "Checking the result…", repairing: "Fixing a few issues…" };
const DEVICES: Array<{ d: Device; icon: typeof Monitor; label: string }> = [{ d: "desktop", icon: Monitor, label: "Desktop" }, { d: "tablet", icon: Tablet, label: "Tablet" }, { d: "mobile", icon: Smartphone, label: "Mobile" }];

function ThemePicker({ state }: { state: DesignState }) {
  const { themes, applyTheme, busy } = useDesign();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const keys = ["background", "surface", "primary", "secondary", "accent"];
  return (
    <div className="relative" ref={ref}>
      <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!!busy}><Palette className="size-4" aria-hidden /> Theme</Button>
      {(
        <div hidden={!open} inert={!open} className="pop pop-up absolute right-0 top-full z-30 mt-2 w-[min(88vw,340px)] origin-top-right rounded-2xl border border-line bg-panel/95 p-2 shadow-pop backdrop-blur-xl">
          <p className="px-2 pb-1.5 pt-1 text-[11px] text-muted">Applies colours, fonts, corners and shadow in one step. Undo restores your previous look.</p>
          <ul className="max-h-80 space-y-1 overflow-auto">
            {themes.map((t) => {
              const current = keys.every((k) => state.design.theme[k] === t.colors[k]);
              return (
                <li key={t.id}>
                  <button onClick={() => { setOpen(false); void applyTheme(t.id); }} className={cn("group flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-accent/[0.08] active:scale-[0.99]", current && "bg-accent/[0.08] ring-1 ring-inset ring-accent/30")}>
                    <span className="flex shrink-0 overflow-hidden rounded-lg border border-line shadow-card transition duration-300 group-hover:scale-105" aria-hidden>{keys.map((k) => <span key={k} className="h-9 w-4" style={{ background: t.colors[k] }} />)}</span>
                    <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5 text-sm font-medium">{t.name}{current && <Check className="size-3.5 text-accent" aria-hidden />}</span><span className="block truncate text-[11px] text-muted">{t.description}</span></span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Which design system this design follows: apply one, unlink, or turn this design into a system. */
function SystemMenu({ state }: { state: DesignState }) {
  const { systems, applySystem, busy, createSystem, openSystem } = useDesign();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const linked = systems.find((x) => x.id === state.systemId);
  return (
    <div className="relative" ref={ref}>
      <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!!busy} title={linked ? `Follows ${linked.name}` : "Design system"}>
        {linked ? <SystemStrip colors={linked.colors} className="h-4 w-6" /> : <Layers className="size-4" aria-hidden />}<span className="hidden max-w-[120px] truncate lg:inline">{linked ? linked.name : "System"}</span><ChevronDown className="size-3.5" aria-hidden />
      </Button>
      <div hidden={!open} inert={!open} className="pop pop-up absolute right-0 top-full z-30 mt-2 w-[min(88vw,320px)] origin-top-right rounded-2xl border border-line bg-panel/95 p-2 shadow-pop backdrop-blur-xl">
        <p className="px-2 pb-1.5 pt-1 text-[11px] text-muted">Restyle this design with a design system's colours, fonts, corners and spacing. Undo restores the previous look.</p>
        <ul className="max-h-64 space-y-1 overflow-auto">
          {systems.map((x) => (
            <li key={x.id}>
              <button onClick={() => { setOpen(false); void applySystem(x.id); }} className={cn("flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-accent/[0.08]", x.id === state.systemId && "bg-accent/[0.08] ring-1 ring-inset ring-accent/30")}>
                <SystemStrip colors={x.colors} className="h-8 w-12 shrink-0" />
                <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5 truncate text-sm font-medium">{x.name}{x.id === state.systemId && <Check className="size-3.5 text-accent" aria-hidden />}</span><span className="block truncate text-[11px] text-muted">{x.fonts.heading} / {x.fonts.body}</span></span>
              </button>
            </li>
          ))}
          {!systems.length && <li className="px-2 py-3 text-xs text-muted">No design systems yet.</li>}
        </ul>
        <div className="mt-1 space-y-0.5 border-t border-line pt-1">
          {linked && <button onClick={() => { setOpen(false); void openSystem(linked.id); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted transition hover:bg-fg/[0.06] hover:text-fg"><Layers className="size-4" aria-hidden /> Open {linked.name}</button>}
          {linked && <button onClick={() => { setOpen(false); void applySystem(null); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted transition hover:bg-fg/[0.06] hover:text-fg"><Link2Off className="size-4" aria-hidden /> Unlink (keep the look)</button>}
          <button onClick={() => { setOpen(false); void createSystem({ from: "design", designId: state.id, name: `${state.name} system` }); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-accent transition hover:bg-accent/10"><Plus className="size-4" aria-hidden /> Make a system from this design</button>
        </div>
      </div>
    </div>
  );
}

/** For a NEW design: start from one of your design systems. */
function SystemChip() {
  const { systems, newDesignSystemId, setNewDesignSystem, busy } = useDesign();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const cur = systems.find((x) => x.id === newDesignSystemId);
  if (!systems.length) return null;
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} disabled={!!busy} aria-haspopup="listbox" aria-expanded={open}
        className={cn("flex items-center gap-1.5 rounded-lg border px-2 py-1 pointer-coarse:min-h-11 text-xs transition active:scale-[0.97]", cur ? "border-accent/40 bg-accent/[0.07] text-fg" : "border-line text-muted hover:text-fg")}>
        {cur ? <SystemStrip colors={cur.colors} className="h-3.5 w-5" /> : <Layers className="size-3.5" aria-hidden />}{cur ? cur.name : "No design system"}<ChevronDown className="size-3" aria-hidden />
      </button>
      <ul role="listbox" aria-label="Design system for the new design" hidden={!open} inert={!open} className="pop absolute bottom-full left-0 z-30 mb-2 w-64 rounded-xl border border-line bg-panel/95 p-1 shadow-pop backdrop-blur-xl">
        <li role="option" aria-selected={!cur}><button onClick={() => { setNewDesignSystem(null); setOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent/10"><Layers className="size-3.5 text-muted" aria-hidden /> No design system{!cur && <Check className="ml-auto size-3.5 text-accent" aria-hidden />}</button></li>
        {systems.map((x) => (
          <li key={x.id} role="option" aria-selected={x.id === cur?.id}><button onClick={() => { setNewDesignSystem(x.id); setOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent/10"><SystemStrip colors={x.colors} className="h-4 w-6" /><span className="min-w-0 flex-1 truncate">{x.name}</span>{x.id === cur?.id && <Check className="size-3.5 text-accent" aria-hidden />}</button></li>
        ))}
      </ul>
    </div>
  );
}

/** Pick design skills for the next requests (relevant ones are applied automatically anyway). */
function SkillsChip() {
  const { pickedSkills, togglePickedSkill, busy } = useDesign();
  const skills = useStore((s) => s.skills);
  const loadSkills = useStore((s) => s.loadSkills);
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  useEffect(() => { if (skills === null) void loadSkills(); }, [skills, loadSkills]);
  const design = (skills ?? []).filter((s) => s.enabled && s.scope !== "agent");
  if (!design.length) return null;
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} disabled={!!busy} aria-haspopup="listbox" aria-expanded={open}
        className={cn("flex items-center gap-1.5 rounded-lg border px-2 py-1 pointer-coarse:min-h-11 text-xs transition active:scale-[0.97]", pickedSkills.length ? "border-accent/40 bg-accent/[0.07] text-fg" : "border-line text-muted hover:text-fg")}>
        <WandSparkles className="size-3.5" aria-hidden />{pickedSkills.length ? `Skills · ${pickedSkills.length}` : "Skills: auto"}<ChevronDown className="size-3" aria-hidden />
      </button>
      <ul role="listbox" aria-multiselectable="true" aria-label="Design skills" hidden={!open} inert={!open} className="pop absolute bottom-full left-0 z-30 mb-2 max-h-80 w-80 overflow-auto rounded-xl border border-line bg-panel/95 p-1 shadow-pop backdrop-blur-xl">
        <li className="px-2 py-1.5 text-[11px] text-faint">Relevant skills are applied automatically; pick any to always use them here.</li>
        {design.map((x) => {
          const on = pickedSkills.includes(x.name);
          return (
            <li key={x.id} role="option" aria-selected={on}>
              <button onClick={() => togglePickedSkill(x.name)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent/10">
                <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded border", on ? "border-accent bg-accent text-accent-fg" : "border-line")}>{on && <Check className="size-3" aria-hidden />}</span>
                <span className="min-w-0"><span className="block font-mono text-xs font-medium">{x.name}{x.pinned && <span className="ml-1.5 text-[10px] text-accent">always on</span>}</span><span className="line-clamp-2 block text-[11px] text-muted">{x.description}</span></span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function VersionMenu({ state }: { state: DesignState }) {
  const restore = useDesign((d) => d.restore);
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="relative" ref={ref}>
      <IconButton label="Version history" onClick={() => setOpen((o) => !o)} active={open}><History className="size-4" /></IconButton>
      {(
        <div hidden={!open} inert={!open} className="pop pop-up absolute right-0 top-full z-30 mt-2 w-[min(88vw,320px)] origin-top-right rounded-2xl border border-line bg-panel/95 p-2 shadow-pop backdrop-blur-xl">
          <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">History · last {state.versions.length}</p>
          <ul className="max-h-80 overflow-auto">
            {state.versions.map((v) => (
              <li key={v.version}>
                <button disabled={v.current} onClick={() => { setOpen(false); void restore(v.version); }} className={cn("flex w-full items-start gap-2.5 rounded-xl p-2 text-left transition hover:bg-accent/[0.08] active:scale-[0.99] disabled:cursor-default disabled:hover:bg-transparent", v.current && "bg-accent/[0.08] ring-1 ring-inset ring-accent/30")}>
                  <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-md font-mono text-[10px] tabular-nums", v.current ? "bg-accent text-accent-fg" : "border border-line text-muted")}>v{v.version}</span>
                  <span className="min-w-0 flex-1"><span className="line-clamp-2 text-[13px] leading-snug">{v.summary || v.prompt}</span><span className="text-[11px] text-faint">{timeAgo(v.createdAt)}{v.current ? " · current" : ""}</span></span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A palette colour: click to copy its value; the pencil changes it (a new, undoable version). */
function Swatch({ name, value }: { name: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const patch = useDesign((d) => d.patch);
  const busy = useDesign((d) => !!d.busy);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const change = (v: string) => { clearTimeout(timer.current); timer.current = setTimeout(() => void patch([{ op: "set_color", key: name as "primary", value: v }]), 450); };
  return (
    <div className="group/sw relative">
    {!busy && (
      <label className="absolute -right-1 -top-1 z-10 grid size-5 pointer-coarse:size-9 cursor-pointer place-items-center rounded-full border border-line bg-panel text-muted opacity-0 shadow-card transition group-hover/sw:opacity-100 hover:text-fg focus-within:opacity-100" title={`Change ${name}`}>
        <Pencil className="size-2.5" aria-hidden />
        <input type="color" defaultValue={value} key={value} onChange={(e) => change(e.target.value)} className="absolute inset-0 size-full cursor-pointer opacity-0" aria-label={`Change ${name} colour`} />
      </label>
    )}
    <button type="button" aria-label={`Copy ${name} ${value}`} title={`Copy ${value}`}
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); }}
      className="group w-full text-center">
      <span className="relative grid h-10 place-items-center rounded-lg border border-line shadow-card transition duration-200 group-hover:-translate-y-0.5 group-hover:scale-105 group-active:scale-95" style={{ background: value }}>
        <span className={cn("grid size-5 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition", copied ? "scale-100 opacity-100" : "scale-50 opacity-0 group-hover:scale-100 group-hover:opacity-100")}>{copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}</span>
      </span>
      <span className="mt-1 block truncate text-[10px] text-muted">{name}</span><span className="block font-mono text-[10px] text-faint">{copied ? "copied" : value}</span>
    </button>
    </div>
  );
}

function Inspector({ state }: { state: DesignState }) {
  const d = state.design;
  return (
    <aside aria-label="Design details" className="glass hidden w-64 shrink-0 overflow-y-auto border-l border-line xl:block">
      <section className="border-b border-line p-4">
        <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Palette</h3>
        <ul className="grid grid-cols-3 gap-2">
          {Object.entries(d.theme).map(([k, v]) => (
            <li key={k} className="text-center"><Swatch name={k} value={v} /></li>
          ))}
        </ul>
      </section>
      <section className="border-b border-line p-4 text-sm">
        <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Type & shape</h3>
        <dl className="space-y-1.5 text-[13px]">
          {[["Headings", d.typography.heading], ["Body", d.typography.body], ["Scale", d.typography.scale], ["Corners", d.style.radius], ["Shadow", d.style.shadow], ["Spacing", d.layout.spacing], ["Max width", d.layout.max_width]].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2"><dt className="text-muted">{k}</dt><dd className="truncate font-medium">{v}</dd></div>
          ))}
        </dl>
      </section>
      <section className="p-4">
        <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Sections · {d.sections.length}</h3>
        <ol className="space-y-1">
          {d.sections.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2 rounded-lg border border-line bg-sunken px-2.5 py-1.5 text-[13px] transition hover:translate-x-0.5 hover:border-accent/40"><span className="font-mono text-[10px] text-faint">{i + 1}</span><span className="font-medium capitalize">{s.type}</span><span className="ml-auto truncate font-mono text-[10px] text-faint">#{s.id}</span></li>
          ))}
        </ol>
      </section>
    </aside>
  );
}

export function DesignView() {
  const mode = useDesign((d) => d.mode);
  if (mode === "systems") return <SystemsView />;
  return <DesignWorkspace />;
}

function DesignWorkspace() {
  const { state, turns, busy, send, stop, device, setDevice, act, rename, loaded, load, editMode, setEditMode, editorHtml, patch, setEditorScroll } = useDesign();
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const [text, setText] = useState("");
  const [exporting, setExporting] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [inspector, setInspector] = useState(true);
  const feed = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" }); }, [turns, busy]);
  useEffect(() => { const el = ta.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(160, el.scrollHeight) + "px"; } }, [text]);

  // ⌘Z / ⌘⇧Z (Ctrl elsewhere, plus Ctrl+Y) undo and redo the design, but never while typing in a field, where they
  // belong to the text box, and never while a dialog (export, command palette, login) is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || document.querySelector('[role="dialog"]')) return;
      const d = useDesign.getState();
      if (!d.state || d.busy) return;
      const redo = matches(e, SHORTCUTS.redo) || (!e.metaKey && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "y");
      if (matches(e, SHORTCUTS.undo) && d.state.history.canUndo) { e.preventDefault(); void d.act("undo"); }
      else if (redo && d.state.history.canRedo) { e.preventDefault(); void d.act("redo"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (t = text) => { const v = t.trim(); if (!v || busy) return; setText(""); void send(v); };
  const ideas = state ? EDIT_IDEAS : NEW_IDEAS;
  const hist = state?.history;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col lg:flex-row">
      {/* ---- left: conversation ---- */}
      <section className="glass flex max-h-[46%] min-h-0 shrink-0 flex-col border-b border-line lg:max-h-none lg:w-[380px] lg:border-b-0 lg:border-r" aria-label="Design assistant">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 md:px-4">
          <IconButton label="Open projects" className="md:hidden" onClick={() => toggleSidebar(true)}><Menu className="size-[18px]" /></IconButton>
          {editingName && state ? (
            <form className="flex flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void rename(name.trim()); setEditingName(false); }}>
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditingName(false)} maxLength={60} aria-label="Design name" className="h-8! text-sm" />
              <IconButton label="Save name" type="submit"><Check className="size-4" /></IconButton>
            </form>
          ) : (
            <>
              <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{state?.name ?? "New design"}</h1>
              {state && <IconButton label="Rename" onClick={() => { setName(state.name); setEditingName(true); }}><Pencil className="size-3.5" /></IconButton>}
            </>
          )}
          {hist && <Badge>v{hist.version}</Badge>}
        </header>

        <div ref={feed} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {turns.length === 0 && !busy && (
            <div className="animate-rise space-y-4 py-2">
              <h2 className="font-display text-3xl font-semibold leading-tight tracking-[-0.03em]">{state ? <>What should<br /><span className="text-gradient">change?</span></> : <>Describe a site.<br /><span className="text-gradient">I'll build it.</span></>}</h2>
              <p className="text-[13px] leading-relaxed text-muted">{state ? "Ask for tweaks in plain language. Each change is a small, reversible edit." : "Mood, audience and sections help. Everything is generated as validated, exportable code."}</p>
              {!state && (
                <ul className="space-y-2 pt-1" aria-label="Ideas">
                  {NEW_IDEAS.map((s, i) => (
                    <li key={s} className="animate-rise" style={{ animationDelay: `${120 + i * 60}ms` }}>
                      <button onClick={() => submit(s)} className="group flex w-full items-start gap-3 rounded-xl border border-line bg-panel/60 p-3 text-left text-[13px] leading-snug text-muted transition duration-200 hover:-translate-y-0.5 hover:border-accent/45 hover:bg-accent/[0.05] hover:text-fg hover:shadow-[0_10px_24px_-16px_rgb(var(--accent)/0.9)] active:translate-y-0 active:scale-[0.99]">
                        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent ring-1 ring-inset ring-accent/25 transition group-hover:bg-accent group-hover:text-accent-fg"><WandSparkles className="size-3.5" aria-hidden /></span>
                        <span className="pt-1">{s}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {turns.map((t) => (
            <div key={t.id} className="space-y-2 animate-rise">
              <p className="user-bubble ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-md px-3.5 py-2.5 text-sm leading-relaxed">{t.prompt}</p>
              {t.reply ? (
                <div className="flex gap-2.5">
                  <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg", t.error ? "bg-err/15 text-err" : "btn-glow text-accent-fg")}><Sparkles className="size-3.5" aria-hidden /></span>
                  <div className="min-w-0 flex-1 text-sm leading-relaxed">
                    <p className={t.error ? "text-err" : undefined}>{t.reply}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {t.kind && !t.error && <Badge tone={t.kind === "clarify" ? "warn" : "accent"}>{t.kind === "create" ? "Created" : t.kind === "edit" ? "Edited" : t.kind === "theme" ? "Theme" : "Needs info"}</Badge>}
                      {t.changed === false && <Badge>No change</Badge>}
                    </div>
                    {t.skills && t.skills.length > 0 && <p className="mt-1 flex items-center gap-1 text-[11px] text-faint"><WandSparkles className="size-3" aria-hidden /> Guided by {t.skills.join(", ")}</p>}
                    {t.notes && t.notes.length > 0 && <details className="mt-1.5 text-xs text-muted"><summary className="cursor-pointer">{t.notes.length} automatic adjustment{t.notes.length === 1 ? "" : "s"}</summary><ul className="mt-1 list-disc space-y-0.5 pl-4">{t.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></details>}
                  </div>
                </div>
              ) : busy && t === turns[turns.length - 1] ? (
                <div className="flex items-center gap-2.5 text-sm text-muted"><span className="grid size-6 place-items-center rounded-lg bg-accent text-accent-fg"><Sparkles className="size-3.5 animate-pulse-dot" aria-hidden /></span>{STAGE[busy.stage] ?? "Working…"}{busy.attempt > 0 && <span className="font-mono text-[11px] text-faint">attempt {busy.attempt + 1}</span>}</div>
              ) : null}
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-line p-3">
          <div hidden={!state} className="mb-2 flex gap-1.5 overflow-x-auto pb-1 [mask-image:linear-gradient(90deg,#000_85%,transparent)]" aria-label="Suggestions">
            {ideas.slice(0, state ? 6 : 4).map((s) => <button key={s} disabled={!!busy} onClick={() => submit(s)} className="group inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-panel/70 px-3 py-1 text-xs font-medium text-muted transition duration-200 hover:-translate-y-0.5 hover:border-accent/50 hover:bg-accent/[0.06] hover:text-fg active:scale-95 disabled:opacity-50 pointer-coarse:min-h-11"><Sparkles className="size-3 text-accent/70 transition group-hover:rotate-12 group-hover:text-accent" aria-hidden />{s.length > 44 ? s.slice(0, 43) + "…" : s}</button>)}
          </div>
          <div className="mb-2 flex flex-wrap gap-1.5">{!state && <SystemChip />}<SkillsChip /></div>
          <div className={cn("relative flex items-end gap-2 rounded-2xl border border-line bg-panel/80 p-2 transition focus-within:border-accent/50 focus-within:shadow-glow", busy && "border-beam")}>
            <textarea ref={ta} value={text} rows={1} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} placeholder={state ? "Describe a change…" : "Describe the site you want…"} aria-label="Design instruction" maxLength={4000} className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-hidden placeholder:text-faint" />
            {busy ? <Magnetic onClick={stop} aria-label="Stop" className="grid size-9 pointer-coarse:size-11 shrink-0 place-items-center rounded-xl bg-fg text-bg"><Square className="size-3.5 fill-current" /></Magnetic>
              : <Magnetic onClick={() => submit()} disabled={!text.trim()} aria-label="Send" className="btn-glow grid size-9 pointer-coarse:size-11 shrink-0 place-items-center rounded-xl text-accent-fg disabled:opacity-30 disabled:saturate-50"><ArrowUp className="size-[18px]" /></Magnetic>}
          </div>
          <p className="mt-1.5 hidden items-center justify-center gap-1 text-[11px] text-faint sm:flex"><KeyCombo shortcut={SHORTCUTS.send} /> to send</p>
        </div>
      </section>

      {/* ---- center: preview ---- */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Preview">
        <div className="glass flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 md:px-4">
          <div className="inline-flex rounded-xl border border-line bg-sunken/70 p-0.5" role="radiogroup" aria-label="Preview device">
            {DEVICES.map(({ d, icon: Icon, label }) => (
              <button key={d} role="radio" aria-checked={device === d} aria-label={`${label} (${DEVICE_WIDTHS[d]}px)`} title={`${label} · ${DEVICE_WIDTHS[d]}px`} onClick={() => setDevice(d)} className={cn("relative z-0 grid size-8 pointer-coarse:size-11 place-items-center rounded-lg transition-colors", device === d ? "text-accent" : "text-muted hover:text-fg")}>
                {device === d && <motion.span layoutId="device-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} className="absolute inset-0 -z-10 rounded-lg bg-panel shadow-card ring-1 ring-line" />}
                <Icon className="size-4" />
              </button>
            ))}
          </div>
          <span className="hidden font-mono text-[11px] tabular-nums text-faint sm:block">{DEVICE_WIDTHS[device]}px</span>
          <div className="ml-auto flex items-center gap-1">
            <IconButton label="Undo" shortcut={SHORTCUTS.undo} disabled={!hist?.canUndo || !!busy} onClick={() => void act("undo")}><Undo2 className="size-4" /></IconButton>
            <IconButton label="Redo" shortcut={SHORTCUTS.redo} disabled={!hist?.canRedo || !!busy} onClick={() => void act("redo")}><Redo2 className="size-4" /></IconButton>
            {state && <IconButton label={editMode ? "Stop editing visually" : "Edit visually"} active={editMode} disabled={!!busy} onClick={() => setEditMode(!editMode)}><MousePointerClick className="size-4" /></IconButton>}
            {state && <VersionMenu state={state} />}
            {state && <SystemMenu state={state} />}
            {state && <ThemePicker state={state} />}
            {state && <Button size="sm" variant="primary" onClick={() => setExporting(true)}><Download className="size-4" aria-hidden /> <span className="hidden sm:inline">Export</span></Button>}
            {state && <IconButton label={inspector ? "Hide details" : "Show details"} active={inspector} className="max-xl:hidden xl:grid" onClick={() => setInspector((i) => !i)}><PanelRight className="size-4" /></IconButton>}
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          {state && editMode && editorHtml ? (
            <EditablePreview html={editorHtml} device={device} busy={!!busy} sections={state.design.sections.map((x) => ({ id: x.id, type: x.type }))}
              onEdit={(section, path, value) => void patch([{ op: "set_text", section, path, value }])}
              onSection={(action, section) => void patch([action === "up" || action === "down" ? { op: "move", section, direction: action } : action === "duplicate" ? { op: "duplicate", section } : { op: "remove", section }])}
              onScroll={setEditorScroll} />
          ) : state ? <Preview html={state.previewHtml} device={device} busy={!!busy} /> : (
            <div className="dotgrid grid flex-1 place-items-center bg-sunken/50 p-6">
              <div className="max-w-sm text-center animate-rise"><div className="relative mx-auto mb-5 grid size-16 place-items-center rounded-2xl border border-line bg-panel text-accent shadow-glow"><span className="absolute inset-0 -z-10 rounded-2xl bg-accent/25 blur-xl" aria-hidden /><WandSparkles className="size-7" aria-hidden /></div><h2 className="font-display text-2xl">Your preview appears here</h2><p className="mt-2 text-sm leading-relaxed text-muted">Landing pages, SaaS sites, portfolios and dashboards: live, responsive, and exportable to HTML or React.</p></div>
            </div>
          )}
          {state && inspector && <Inspector state={state} />}
        </div>
      </section>
      {state && <ExportDialog open={exporting} onClose={() => setExporting(false)} designId={state.id} />}
    </div>
  );
}
