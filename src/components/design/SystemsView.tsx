"use client";
import { ArrowRight, Check, ChevronDown, Download, Globe, ImageIcon, Layers, Menu, PenLine, Plus, Sparkles, Trash2, Upload, Wand2, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useDesign } from "@/lib/designStore";
import { timeAgo } from "@/lib/format";
import { paletteFromFile, type PaletteColor } from "@/lib/palette";
import { useStore } from "@/lib/store";
import type { DesignState, DesignSystemJson, DesignSystemSummary } from "@/lib/types";
import { Badge, Button, Field, IconButton, Input, Segmented, Select, Textarea, cn, useDismiss } from "../ui";
import { SystemExportDialog } from "./SystemExportDialog";

const SOURCE_LABEL: Record<string, string> = { prompt: "Described", url: "From a website", image: "From an image", design: "From a design", manual: "Manual" };
const ROLES = ["background", "surface", "primary", "secondary", "accent", "text"] as const;
const SEMANTIC = ["success", "warning", "danger", "info"] as const;
const PROMPT_IDEAS = [
  "A calm, trustworthy fintech brand for freelancers: soft blues, generous spacing",
  "A bold streetwear label: black and acid green, sharp corners, loud headlines",
  "A warm specialty coffee roaster: cream, espresso brown and copper, editorial serif",
  "A playful kids' learning app: bright primaries, very round shapes, friendly voice",
];

/** Six role colours as one strip (the "thumbnail" of a system). */
export function SystemStrip({ colors, className }: { colors: DesignSystemSummary["colors"]; className?: string }) {
  return <span className={cn("flex overflow-hidden rounded-md border border-line", className)} aria-hidden>{ROLES.map((k) => <span key={k} className="h-full flex-1" style={{ background: colors[k] }} />)}</span>;
}

// ------------------------------------------------------------------ create

function CreateSystem() {
  const { createSystem, creatingSystem, designs, systems, openSystem } = useDesign();
  const toast = useStore((s) => s.toast);
  const [source, setSource] = useState<"prompt" | "url" | "image" | "design">("prompt");
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [designId, setDesignId] = useState<string>("");
  const [image, setImage] = useState<{ file: File; preview: string; palette: PaletteColor[] } | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = !!creatingSystem;
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.preview); }, [image]);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast("error", "Choose an image (PNG, JPEG, WebP…)."); return; }
    if (file.size > 15 * 1024 * 1024) { toast("error", "That image is over 15 MB."); return; }
    try { const palette = await paletteFromFile(file); setImage({ file, preview: URL.createObjectURL(file), palette }); }
    catch { toast("error", "Couldn't read that image."); }
  }

  const canGo = !busy && (source === "prompt" ? prompt.trim().length >= 3 : source === "url" ? url.trim().length >= 4 : source === "image" ? (image?.palette.length ?? 0) >= 2 : !!designId);
  const go = async () => {
    if (!canGo) return;
    const n = name.trim() || undefined;
    const ok = await createSystem(
      source === "prompt" ? { from: "prompt", prompt: prompt.trim(), name: n }
        : source === "url" ? { from: "url", url: url.trim(), name: n, notes: notes.trim() || undefined }
        : source === "image" ? { from: "image", palette: image!.palette, notes: notes.trim() || undefined, name: n, fileName: image!.file.name }
        : { from: "design", designId, name: n },
    );
    if (ok) { setPrompt(""); setUrl(""); setNotes(""); setName(""); setImage(null); }
  };
  const STAGE: Record<string, string> = { prompt: "Designing the system…", url: "Reading the site and choosing roles…", image: "Turning the palette into a system…", design: "Extracting tokens…" };

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-10">
      <span className="inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-accent"><Layers className="size-3.5" aria-hidden /> Design systems</span>
      <h1 className="mt-3 font-display text-[clamp(2rem,4.5vw,3.1rem)] font-semibold leading-[1.04] tracking-[-0.035em]">One source of truth<br /><span className="text-gradient">for every design.</span></h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">Colour roles, fonts, a type scale, spacing, corners, elevation, voice and guidelines, with a living documentation page. Apply it to any design, and export it to CSS, Tailwind, design tokens or a React kit.</p>

      <div className="mt-8 rounded-3xl border border-line bg-panel/70 p-5 shadow-card backdrop-blur">
        <Segmented<typeof source> label="Start from" kind="tab" value={source} onChange={setSource} className="max-w-full overflow-x-auto"
          options={[{ value: "prompt", label: <><PenLine className="size-3.5" aria-hidden /> Describe</> }, { value: "url", label: <><Globe className="size-3.5" aria-hidden /> Website</> }, { value: "image", label: <><ImageIcon className="size-3.5" aria-hidden /> Screenshot</> }, { value: "design", label: <><Wand2 className="size-3.5" aria-hidden /> A design</> }]} />
        <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); void go(); }}>
          {source === "prompt" && (
            <>
              <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={4000} placeholder="Describe the brand: who it's for, the mood, colours you like, how it should sound…" aria-label="Describe the brand" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go(); }} />
              <div className="flex flex-wrap gap-1.5">{PROMPT_IDEAS.map((p) => <button key={p} type="button" onClick={() => setPrompt(p)} className="rounded-full border border-line bg-raised/60 px-3 py-1 pointer-coarse:min-h-11 text-xs text-muted transition hover:-translate-y-0.5 hover:border-accent/50 hover:text-fg">{p.length > 52 ? p.slice(0, 51) + "…" : p}</button>)}</div>
            </>
          )}
          {source === "url" && (
            <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
              <Field label="Website" htmlFor="ds-url" hint="Its colours, fonts and corners are measured from the page and its stylesheets."><Input id="ds-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="stripe.com" className="font-mono" autoComplete="off" spellCheck={false} /></Field>
              <Field label="Notes" htmlFor="ds-notes" hint="Optional: what to keep or change."><Input id="ds-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Keep the purple, make it friendlier" maxLength={600} /></Field>
            </div>
          )}
          {source === "image" && (
            <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
              <div
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); void pickFile(e.dataTransfer.files[0]); }}
                className={cn("relative grid min-h-40 place-items-center overflow-hidden rounded-2xl border-2 border-dashed p-4 text-center transition", drag ? "border-accent bg-accent/[0.06]" : "border-line hover:border-faint")}>
                {image ? <img src={image.preview} alt="" className="absolute inset-0 size-full object-cover opacity-90" /> : (
                  <div className="space-y-2 text-sm text-muted"><Upload className="mx-auto size-6 text-accent" aria-hidden /><p>Drop a screenshot, logo or moodboard</p><p className="text-xs text-faint">It's read in your browser; only the colours are sent.</p></div>
                )}
                <button type="button" onClick={() => fileRef.current?.click()} className="absolute inset-0" aria-label="Choose an image" />
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void pickFile(e.target.files?.[0])} />
              </div>
              <div className="space-y-3">
                <div className="text-[12px] font-semibold text-muted">Palette found</div>
                {image ? (
                  <ul className="flex flex-wrap gap-1.5" aria-label="Palette">
                    {image.palette.map((c) => <li key={c.hex} title={`${c.hex} · ${(c.weight * 100).toFixed(1)}%`} className="flex items-center gap-1.5 rounded-lg border border-line bg-raised/60 py-1 pl-1 pr-2 font-mono text-[11px]"><span className="size-5 rounded-md border border-line" style={{ background: c.hex }} />{c.hex}</li>)}
                  </ul>
                ) : <p className="text-xs text-faint">Choose an image to see its colours.</p>}
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes: e.g. it's a meditation app" aria-label="Notes" maxLength={600} />
              </div>
            </div>
          )}
          {source === "design" && (
            <Field label="Design" hint="Its colours, fonts and shape become a system you can reuse and export.">
              <Select value={designId} onValueChange={setDesignId} placeholder={designs.length ? "Choose a design…" : "No designs yet"} disabled={!designs.length} aria-label="Design" options={designs.map((d) => ({ value: d.id, label: d.name, hint: `v${d.version}` }))} />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="System name" maxLength={60} className="max-w-[220px]" />
            <span className="flex-1" />
            {busy && <span className="flex items-center gap-2 text-xs text-muted"><Sparkles className="size-3.5 animate-pulse-dot text-accent" aria-hidden />{STAGE[creatingSystem!]}</span>}
            <Button type="submit" variant="primary" disabled={!canGo} loading={busy}><Sparkles className="size-4" aria-hidden /> Create system</Button>
          </div>
        </form>
      </div>

      {systems.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Your systems</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {systems.map((s, i) => (
              <motion.li key={s.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                <button onClick={() => void openSystem(s.id)} className="group w-full rounded-2xl border border-line bg-panel/70 p-3 text-left transition duration-200 hover:-translate-y-0.5 hover:border-accent/45 hover:shadow-[0_14px_30px_-18px_rgb(var(--accent)/0.8)]">
                  <SystemStrip colors={s.colors} className="h-14 rounded-xl" />
                  <div className="mt-3 flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-semibold">{s.name}</span><ArrowRight className="size-4 text-faint transition group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden /></div>
                  <div className="truncate text-[11px] text-muted">{s.fonts.heading} / {s.fonts.body} · {timeAgo(s.updatedAt)}</div>
                </button>
              </motion.li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ editor

function ColorRow({ role, value, onChange, contrast, min = 4.5 }: { role: string; value: string; onChange: (v: string) => void; contrast?: number; min?: number }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = (v: string) => { const t = v.trim().toLowerCase(); if (/^#[0-9a-f]{6}$/.test(t)) onChange(t); else setText(value); };
  return (
    <li className="flex items-center gap-2.5">
      <label className="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-line shadow-card transition hover:scale-105" style={{ background: value }} title={`Pick ${role}`}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 size-full cursor-pointer opacity-0" aria-label={`${role} colour`} />
      </label>
      <span className="w-[78px] shrink-0 text-[12.5px] capitalize">{role}</span>
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commit(e.currentTarget.value); }} spellCheck={false} aria-label={`${role} hex`}
        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-sunken/60 px-2 font-mono text-xs outline-hidden transition focus:border-accent/60" />
      {contrast !== undefined && <span className={cn("shrink-0 font-mono text-[10px] tabular-nums", contrast >= 7 ? "text-ok" : contrast >= min ? "text-muted" : "text-err")} title={`Contrast with the background (needs ${min}:1)`}>{contrast.toFixed(1)}</span>}
    </li>
  );
}

function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="border-b border-line/70 px-4 py-4"><h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h3>{children}</section>;
}

function TokenEditor({ s, onChange }: { s: DesignSystemJson; onChange: (next: DesignSystemJson) => void }) {
  const fonts = useDesign((d) => d.fonts);
  const set = <K extends keyof DesignSystemJson>(k: K, v: DesignSystemJson[K]) => onChange({ ...s, [k]: v });
  const fontOpts = (filter?: (c: string) => boolean) => fonts.filter((f) => !filter || filter(f.category)).map((f) => ({ value: f.family, label: <span style={{ fontFamily: `"${f.family}", system-ui` }}>{f.family}</span>, textValue: f.family, hint: f.category }));
  const [principle, setPrinciple] = useState("");
  return (
    <div>
      <Group title="Identity">
        <div className="space-y-2.5">
          <Input value={s.name} onChange={(e) => set("name", e.target.value.slice(0, 60))} aria-label="Name" className="font-medium" />
          <Textarea value={s.description} onChange={(e) => set("description", e.target.value.slice(0, 300))} rows={2} placeholder="What this brand is" aria-label="Description" />
        </div>
      </Group>
      <Group title="Colour roles">
        <ul className="space-y-2">{ROLES.map((k) => <ColorRow key={k} role={k} value={s.colors[k]} onChange={(v) => set("colors", { ...s.colors, [k]: v })} contrast={k === "text" ? ratio(s.colors.text, s.colors.background) : undefined} />)}</ul>
        <h4 className="mb-2 mt-4 text-[11px] font-medium text-muted">Semantic</h4>
        <ul className="space-y-2">{SEMANTIC.map((k) => <ColorRow key={k} role={k} value={s.colors[k]} onChange={(v) => set("colors", { ...s.colors, [k]: v })} contrast={ratio(s.colors[k], s.colors.background)} min={3} />)}</ul>
      </Group>
      <Group title="Typography">
        <div className="space-y-2.5">
          <Field label="Headings"><Select value={s.typography.heading} onValueChange={(v) => set("typography", { ...s.typography, heading: v })} options={fontOpts()} aria-label="Heading font" /></Field>
          <Field label="Body"><Select value={s.typography.body} onValueChange={(v) => set("typography", { ...s.typography, body: v })} options={fontOpts()} aria-label="Body font" /></Field>
          <Field label="Code"><Select value={s.typography.mono} onValueChange={(v) => set("typography", { ...s.typography, mono: v })} options={fontOpts((c) => c === "mono")} aria-label="Code font" /></Field>
          <div className="flex flex-wrap items-center gap-2"><span className="w-12 text-xs text-muted">Size</span><Segmented size="sm" label="Base size" value={s.typography.scale} onChange={(v) => set("typography", { ...s.typography, scale: v })} options={[{ value: "compact", label: "15" }, { value: "normal", label: "16" }, { value: "large", label: "18" }]} /></div>
          <div className="flex flex-wrap items-center gap-2"><span className="w-12 text-xs text-muted">Ratio</span><Segmented size="sm" label="Type scale ratio" value={s.typography.ratio} onChange={(v) => set("typography", { ...s.typography, ratio: v })} options={["1.125", "1.2", "1.25", "1.333", "1.5"].map((r) => ({ value: r, label: r }))} /></div>
        </div>
      </Group>
      <Group title="Shape & space">
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2"><span className="w-14 text-xs text-muted">Corners</span><Segmented size="sm" label="Corner radius" value={s.shape.radius} onChange={(v) => set("shape", { ...s.shape, radius: v })} options={["none", "sm", "md", "lg", "xl"].map((r) => ({ value: r, label: r }))} /></div>
          <div className="flex flex-wrap items-center gap-2"><span className="w-14 text-xs text-muted">Shadow</span><Segmented size="sm" label="Shadow" value={s.shape.shadow} onChange={(v) => set("shape", { ...s.shape, shadow: v })} options={["none", "soft", "strong", "glow"].map((r) => ({ value: r, label: r }))} /></div>
          <div className="flex flex-wrap items-center gap-2"><span className="w-14 text-xs text-muted">Density</span><Segmented size="sm" label="Spacing" value={s.layout.spacing} onChange={(v) => set("layout", { ...s.layout, spacing: v })} options={[{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfy" }, { value: "spacious", label: "Airy" }]} /></div>
        </div>
      </Group>
      <Group title="Voice">
        <Input value={s.voice.tone} onChange={(e) => set("voice", { ...s.voice, tone: e.target.value.slice(0, 160) })} placeholder="e.g. Clear, warm and precise" aria-label="Tone" />
        <ul className="mt-2.5 space-y-1.5">
          {s.voice.principles.map((p, i) => (
            <li key={i} className="group flex items-start gap-2 rounded-lg border border-line bg-sunken/50 px-2.5 py-1.5 text-[12.5px]"><span className="font-mono text-[10px] text-faint">{i + 1}</span><span className="flex-1">{p}</span><button onClick={() => set("voice", { ...s.voice, principles: s.voice.principles.filter((_, j) => j !== i) })} aria-label={`Remove ${p}`} className="text-faint opacity-0 transition group-hover:opacity-100 hover:text-err"><X className="size-3.5" /></button></li>
          ))}
        </ul>
        {s.voice.principles.length < 5 && (
          <form className="mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); const p = principle.trim(); if (p) { set("voice", { ...s.voice, principles: [...s.voice.principles, p.slice(0, 140)] }); setPrinciple(""); } }}>
            <Input value={principle} onChange={(e) => setPrinciple(e.target.value)} placeholder="Add a writing principle" aria-label="New principle" className="h-8!" />
            <Button type="submit" size="sm" variant="secondary" disabled={!principle.trim()} aria-label="Add principle"><Plus className="size-3.5" /></Button>
          </form>
        )}
      </Group>
      <Group title="Guidelines">
        <ul className="space-y-2">
          {s.guidelines.map((g, i) => (
            <li key={i} className="space-y-1.5 rounded-xl border border-line bg-sunken/40 p-2.5">
              <div className="flex items-center gap-1.5"><Input value={g.title} onChange={(e) => set("guidelines", s.guidelines.map((x, j) => (j === i ? { ...x, title: e.target.value.slice(0, 60) } : x)))} aria-label="Guideline title" className="h-8! font-medium" /><IconButton label="Remove guideline" className="size-7 hover:text-err" onClick={() => set("guidelines", s.guidelines.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></IconButton></div>
              <Input value={g.do} onChange={(e) => set("guidelines", s.guidelines.map((x, j) => (j === i ? { ...x, do: e.target.value.slice(0, 200) } : x)))} placeholder="Do…" aria-label="Do" className="h-8! border-ok/30" />
              <Input value={g.dont ?? ""} onChange={(e) => set("guidelines", s.guidelines.map((x, j) => (j === i ? { ...x, dont: e.target.value.slice(0, 200) || undefined } : x)))} placeholder="Don't…" aria-label="Don't" className="h-8! border-err/30" />
            </li>
          ))}
        </ul>
        {s.guidelines.length < 8 && <Button size="sm" variant="ghost" className="mt-2" onClick={() => set("guidelines", [...s.guidelines, { title: "New guideline", do: "Describe what to do" }])}><Plus className="size-3.5" aria-hidden /> Add guideline</Button>}
      </Group>
    </div>
  );
}

function ApplyMenu({ systemId }: { systemId: string }) {
  const { designs, open } = useDesign();
  const toast = useStore((s) => s.toast);
  const [menu, setMenu] = useState(false);
  const ref = useDismiss(menu, () => setMenu(false));
  const apply = async (designId: string) => {
    setMenu(false);
    try {
      const r = await api<{ state: DesignState; summary: string }>(`/api/design/${designId}/system`, { method: "POST", body: { systemId } });
      toast("ok", r.summary);
      await open(designId);
      void useDesign.getState().load();
    } catch (e) { toast("error", (e as Error).message); }
  };
  return (
    <div className="relative" ref={ref}>
      <Button size="sm" variant="secondary" onClick={() => setMenu((m) => !m)} aria-expanded={menu}><Wand2 className="size-4" aria-hidden /> <span className="hidden sm:inline">Apply to design</span> <ChevronDown className="size-3.5" aria-hidden /></Button>
      <div hidden={!menu} inert={!menu} className="pop pop-up absolute right-0 top-full z-30 mt-2 w-72 origin-top-right rounded-2xl border border-line bg-panel/95 p-1.5 shadow-pop backdrop-blur-xl">
        {designs.length === 0 ? <p className="p-3 text-xs text-muted">No designs yet. Create one in Designs; new designs can start from this system.</p> : (
          <ul className="max-h-72 overflow-auto">{designs.map((d) => <li key={d.id}><button onClick={() => void apply(d.id)} className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm transition hover:bg-accent/[0.08]"><span className="min-w-0 flex-1 truncate">{d.name}</span><span className="font-mono text-[10px] text-faint">v{d.version}</span></button></li>)}</ul>
        )}
      </div>
    </div>
  );
}

function SystemEditor() {
  const { system, saveSystem, savingSystem, deleteSystem } = useDesign();
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setNew = useDesign((d) => d.setNewDesignSystem);
  const openDesign = useDesign((d) => d.open);
  const [exporting, setExporting] = useState(false);
  // On a phone the token panel covers the docs, so it starts closed there.
  const [panel, setPanel] = useState(() => typeof window === "undefined" || !window.matchMedia || window.matchMedia("(min-width: 768px)").matches);
  if (!system) return <div className="grid flex-1 place-items-center"><span className="size-5 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-label="Loading" /></div>;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <header className="glass flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 md:px-4">
        <IconButton label="Open list" className="md:hidden" onClick={() => toggleSidebar(true)}><Menu className="size-[18px]" /></IconButton>
        <SystemStrip colors={system.colors} className="h-6 w-14 shrink-0" />
        <h1 className="min-w-0 truncate text-sm font-semibold">{system.name}</h1>
        <Badge className="max-sm:hidden">{SOURCE_LABEL[system.source]}{system.sourceRef && system.source === "url" ? ` · ${system.sourceRef}` : ""}</Badge>
        {savingSystem ? <span className="text-[11px] text-faint">Saving…</span> : <span className="flex items-center gap-1 text-[11px] text-faint max-sm:hidden"><Check className="size-3" aria-hidden /> Saved</span>}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" className="max-md:hidden" onClick={() => { setNew(system.id); void openDesign(null); }} title="Start a new design that follows this system"><Plus className="size-4" aria-hidden /> New design</Button>
        <ApplyMenu systemId={system.id} />
        <Button size="sm" variant="primary" onClick={() => setExporting(true)}><Download className="size-4" aria-hidden /> <span className="hidden sm:inline">Export</span></Button>
        <IconButton label="Delete design system" className="hover:text-err" onClick={() => void deleteSystem(system.id)}><Trash2 className="size-4" /></IconButton>
        <IconButton label={panel ? "Hide tokens" : "Show tokens"} active={panel} onClick={() => setPanel((p) => !p)}><Layers className="size-4" /></IconButton>
      </header>
      <div className="flex min-h-0 flex-1">
        {panel && <aside aria-label="Tokens" className="glass w-[min(92vw,340px)] shrink-0 overflow-y-auto border-r border-line max-md:absolute max-md:bottom-0 max-md:left-0 max-md:top-14 max-md:z-20 max-md:bg-panel max-md:shadow-pop"><TokenEditor s={system.system} onChange={saveSystem} /></aside>}
        <div className="relative min-w-0 flex-1 bg-sunken/50">
          <iframe title={`${system.name} documentation`} srcDoc={system.docsHtml} sandbox="" referrerPolicy="no-referrer" className="absolute inset-0 size-full border-0 bg-white" />
          {savingSystem && <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden"><div className="h-full w-full animate-shimmer bg-linear-to-r/srgb from-transparent via-accent to-transparent bg-[length:200%_100%]" /></div>}
          {system.usedBy.length > 0 && <div className="glass absolute bottom-3 left-3 rounded-full border border-line px-3 py-1 text-[11px] text-muted shadow-card">Used by {system.usedBy.map((d) => d.name).join(", ")}</div>}
        </div>
      </div>
      <SystemExportDialog open={exporting} onClose={() => setExporting(false)} systemId={system.id} name={system.name} />
    </div>
  );
}

export function SystemsView() {
  const activeSystemId = useDesign((d) => d.activeSystemId);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  if (activeSystemId) return <SystemEditor />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="glass flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 md:hidden"><IconButton label="Open list" onClick={() => toggleSidebar(true)}><Menu className="size-[18px]" /></IconButton><span className="text-sm font-medium">Design systems</span></header>
      <div className="dotgrid min-h-0 flex-1 overflow-y-auto"><CreateSystem /></div>
    </div>
  );
}
