"use client";
import { BookOpen, Check, Download, Eye, FileUp, GitBranch, Library, Pencil, Pin, PinOff, Plus, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, newIdempotencyKey } from "@/lib/api";
import { SKILL_TEMPLATE, splitSkill } from "@/lib/skillTemplate";
import { useStore } from "@/lib/store";
import type { SkillChoice, SkillLibraryEntry, SkillSummary, SkillView } from "@/lib/types";
import { Markdown } from "../chat/Markdown";
import { Badge, Bone, Button, Checkbox, Dialog, IconButton, Input, Segmented, Switch, Textarea, cn } from "../ui";

type Lists = { skills: SkillSummary[]; library?: SkillLibraryEntry[] };
const SCOPE: Record<string, string> = { agent: "Agent", design: "Design", both: "Agent + Design" };
const SOURCE: Record<string, string> = { builtin: "Built-in", github: "GitHub", upload: "Uploaded", editor: "Written here", project: "Project" };

/** Write or edit a SKILL.md (also used for "make a skill from this conversation"). */
export function SkillEditorDialog({ open, onClose, initial, editId }: { open: boolean; onClose: () => void; initial?: string; editId?: string }) {
  const setSkills = useStore((s) => s.setSkills);
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState(initial ?? SKILL_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setText(initial ?? SKILL_TEMPLATE); setError(null); } }, [open, initial]);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = editId
        ? await api<Lists>(`/api/skills/${encodeURIComponent(editId)}`, { method: "PUT", body: { markdown: text } })
        : await api<Lists>("/api/skills", { method: "POST", body: { from: "markdown", markdown: text }, idempotencyKey: newIdempotencyKey() });
      setSkills(r.skills, r.library);
      toast("ok", editId ? "Skill saved." : "Skill added. The agent can use it from now on.");
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={editId ? "Edit skill" : "Write a skill"} width="max-w-3xl"
      description="A SKILL.md: front-matter (name, description, scope) and the instructions the agent follows when the description matches the task."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={busy}>Save skill</Button></>}>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={18} spellCheck={false} aria-label="SKILL.md" className="font-mono" />
      <p className="mt-2 text-xs text-muted"><code className="font-mono">scope: agent</code> for coding and tasks, <code className="font-mono">design</code> for the Design agent, <code className="font-mono">both</code> for either. Add <code className="font-mono">disable-model-invocation: true</code> for a skill that only runs when you type <code className="font-mono">/name</code>.</p>
      {error && <p className="mt-2 text-sm text-err" role="alert">{error}</p>}
    </Dialog>
  );
}

function AddSkillDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const setSkills = useStore((s) => s.setSkills);
  const toast = useStore((s) => s.toast);
  const [tab, setTab] = useState<"github" | "upload" | "write">("github");
  const [url, setUrl] = useState("");
  const [choices, setChoices] = useState<SkillChoice[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writeOpen, setWriteOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setChoices(null); setPicked([]); setError(null); } }, [open]);
  const done = (r: Lists & { installed?: string[] }) => {
    setSkills(r.skills, r.library);
    toast("ok", r.installed?.length ? `Installed ${r.installed.join(", ")}.` : "Skill added.");
    onClose();
  };
  const fromGitHub = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<Lists & { installed?: string[]; choices?: SkillChoice[] }>("/api/skills", { method: "POST", body: { from: "github", url, pick: choices ? picked : undefined }, idempotencyKey: newIdempotencyKey() });
      if (r.choices) { setChoices(r.choices); setPicked([]); } else done(r);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const upload = async (file: File) => {
    setBusy(true); setError(null);
    try {
      const form = new FormData(); form.append("file", file);
      done(await api<Lists & { installed: string[] }>("/api/skills/upload", { method: "POST", form }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <Dialog open={open && !writeOpen} onClose={onClose} title="Add a skill" width="max-w-xl" description="Install skills from GitHub, upload a SKILL.md or a .zip, or write your own."
        footer={tab === "github" ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={fromGitHub} loading={busy} disabled={!url.trim() || (!!choices && !picked.length)}>{choices ? `Install ${picked.length || ""} selected` : "Find skills"}</Button></> : <Button variant="ghost" onClick={onClose}>Close</Button>}>
        <Segmented label="How to add a skill" value={tab} onChange={(v) => { setTab(v); setError(null); }} options={[
          { value: "github", label: <span className="flex items-center gap-1.5"><GitBranch className="size-3.5" aria-hidden />GitHub link</span> },
          { value: "upload", label: <span className="flex items-center gap-1.5"><Upload className="size-3.5" aria-hidden />Upload</span> },
          { value: "write", label: <span className="flex items-center gap-1.5"><Pencil className="size-3.5" aria-hidden />Write</span> },
        ]} />
        <div className="mt-4">
          {tab === "github" && (
            <div className="space-y-3">
              <Input value={url} onChange={(e) => { setUrl(e.target.value); setChoices(null); }} placeholder="https://github.com/owner/repo/tree/main/skills/name  or  owner/repo" aria-label="GitHub link" className="font-mono" onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) void fromGitHub(); }} />
              <p className="text-xs text-muted">A link to one skill folder installs it; a link to a repository lists its skills so you can pick. Private repositories need a GitHub token (Settings → Tools).</p>
              {choices && (
                <div className="max-h-72 space-y-1 overflow-auto rounded-xl border border-line p-2">
                  <div className="flex items-center justify-between px-1 pb-1 text-xs text-muted"><span>{choices.length} skills found</span><button className="text-accent hover:underline" onClick={() => setPicked(picked.length === choices.length ? [] : choices.map((c) => c.path))}>{picked.length === choices.length ? "Select none" : "Select all"}</button></div>
                  {choices.map((c) => (
                    <label key={c.path} className="flex cursor-pointer items-start gap-2.5 rounded-lg p-2 hover:bg-raised">
                      <Checkbox checked={picked.includes(c.path)} onChange={(v) => setPicked(v ? [...picked, c.path] : picked.filter((p) => p !== c.path))} label={`Install ${c.name}`} />
                      <span className="min-w-0"><span className="block font-mono text-[13px] font-medium">{c.name}</span>{c.description && <span className="block text-xs text-muted">{c.description}</span>}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === "upload" && (
            <button onClick={() => fileRef.current?.click()} disabled={busy} className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line p-8 text-center transition hover:border-accent/50 hover:bg-accent/[0.03]"
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void upload(f); }}>
              <FileUp className="size-6 text-accent" aria-hidden />
              <span className="text-sm font-medium">{busy ? "Installing…" : "Drop a SKILL.md, .zip or .skill here"}</span>
              <span className="text-xs text-muted">or click to choose a file (up to 15 MB). A zip can hold several skill folders.</span>
              <input ref={fileRef} type="file" accept=".md,.markdown,.zip,.skill" className="hidden" aria-label="Skill file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
            </button>
          )}
          {tab === "write" && (
            <div className="space-y-3 text-sm text-muted">
              <p>Write a skill in Markdown: what it's for, when to use it, and the steps and rules to follow. Tip: in a conversation that went well, use <b>Make a skill</b> in its header to draft one from it.</p>
              <Button variant="primary" onClick={() => setWriteOpen(true)}><Pencil className="size-4" aria-hidden /> Open the editor</Button>
            </div>
          )}
          {error && <p className="mt-3 text-sm text-err" role="alert">{error}</p>}
        </div>
      </Dialog>
      <SkillEditorDialog open={writeOpen} onClose={() => { setWriteOpen(false); onClose(); }} />
    </>
  );
}

function ViewSkillDialog({ id, onClose, onEdit }: { id: string | null; onClose: () => void; onEdit: (v: SkillView) => void }) {
  const [view, setView] = useState<SkillView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setView(null); setError(null);
    if (id) api<SkillView>(`/api/skills/${encodeURIComponent(id)}`).then(setView, (e) => setError((e as Error).message));
  }, [id]);
  const parts = view ? splitSkill(view.markdown) : null;
  return (
    <Dialog open={!!id} onClose={onClose} title={view?.name ?? "Skill"} width="max-w-3xl" description={view?.description}
      footer={<>{view?.editable && <Button variant="secondary" onClick={() => onEdit(view)}><Pencil className="size-4" aria-hidden /> Edit</Button>}<Button variant="primary" onClick={onClose}>Close</Button></>}>
      {error && <p className="text-sm text-err">{error}</p>}
      {!view && !error && <div className="space-y-2"><Bone className="block h-4 w-2/3" /><Bone className="block h-4 w-full" /><Bone className="block h-4 w-5/6" /></div>}
      {view && parts && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            <Badge>{SCOPE[view.scope]}</Badge><Badge tone="info">{SOURCE[view.source]}</Badge>{view.license && <Badge>{view.license.length > 40 ? "License: see repository" : view.license}</Badge>}
            {view.sourceUrl && <a href={view.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-xs text-accent hover:underline">{view.sourceUrl.replace("https://github.com/", "")}</a>}
          </div>
          <div className="max-h-[50dvh] overflow-auto rounded-xl border border-line bg-sunken/50 p-4"><Markdown text={parts.body} /></div>
          {view.fileList.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted">Files that come with it</div>
              <ul className="flex flex-wrap gap-1.5">{view.fileList.slice(0, 80).map((f) => <li key={f.path}><code className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[11px]">{f.path}</code></li>)}</ul>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function SkillRow({ s, onView }: { s: SkillSummary; onView: () => void }) {
  const { settings, setSettings, setSkills, toast, undoable } = useStore();
  const [busy, setBusy] = useState(false);
  const toggle = (on: boolean) => setSettings({ skills: { ...settings.skills, disabled: on ? settings.skills.disabled.filter((n) => n !== s.name) : [...settings.skills.disabled, s.name] } });
  const pin = () => setSettings({ skills: { ...settings.skills, pinned: s.pinned ? settings.skills.pinned.filter((n) => n !== s.name) : [...settings.skills.pinned, s.name] } });
  const update = async () => {
    setBusy(true);
    try { setSkills((await api<Lists>(`/api/skills/${s.id}/update`, { method: "POST", body: {} })).skills); toast("ok", `Updated ${s.name}.`); }
    catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  const remove = () => undoable({
    key: `skill:${s.id}`, text: `Deleted the ${s.name} skill.`,
    commit: async ({ keepalive }) => { const r = await api<Lists>(`/api/skills/${s.id}`, { method: "DELETE", keepalive }); setSkills(r.skills, r.library); },
  });
  return (
    <li className={cn("group flex items-start gap-3 rounded-xl px-3 py-2.5 transition hover:bg-raised/60", !s.enabled && "opacity-60")}>
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent ring-1 ring-accent/20"><Sparkles className="size-4" aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={onView} className="font-mono text-[13px] font-semibold hover:text-accent">{s.name}</button>
          <Badge>{SCOPE[s.scope]}</Badge>
          {s.source !== "builtin" && <Badge tone="info">{SOURCE[s.source]}</Badge>}
          {s.manual && <Badge tone="warn">/{s.name} only</Badge>}
          {s.pinned && s.enabled && <Badge tone="accent">Always on</Badge>}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{s.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label={`View ${s.name}`} onClick={onView}><Eye className="size-3.5" /></IconButton>
        <IconButton label={s.pinned ? `Stop always using ${s.name}` : `Always use ${s.name}`} active={s.pinned} onClick={pin}>{s.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}</IconButton>
        {s.source === "github" && <IconButton label={`Update ${s.name} from GitHub`} onClick={update} disabled={busy}><RefreshCw className={cn("size-3.5", busy && "animate-spin")} /></IconButton>}
        {s.source !== "builtin" && <IconButton label={`Delete ${s.name}`} onClick={remove}><Trash2 className="size-3.5" /></IconButton>}
        <Switch checked={s.enabled} onChange={toggle} label={`Use ${s.name}`} />
      </div>
    </li>
  );
}

function LibraryCard({ l }: { l: SkillLibraryEntry }) {
  const setSkills = useStore((s) => s.setSkills);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const install = async () => {
    setBusy(true);
    try { const r = await api<Lists & { installed: string[] }>("/api/skills", { method: "POST", body: { from: "library", name: l.name }, idempotencyKey: newIdempotencyKey() }); setSkills(r.skills, r.library); toast("ok", `Installed ${l.name}.`); }
    catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <li className="card-surface flex flex-col gap-2 rounded-2xl p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-[13px] font-semibold">{l.name}</div>
          <a href={`https://github.com/${l.repo}`} target="_blank" rel="noopener noreferrer nofollow" className="text-[11px] text-faint hover:text-accent">{l.repo}</a>
        </div>
        {l.installs && <span className="flex shrink-0 items-center gap-1 rounded-full bg-fg/[0.05] px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted" title="Installs on skills.sh"><Download className="size-3" aria-hidden />{l.installs}</span>}
      </div>
      <p className="flex-1 text-xs leading-relaxed text-muted">{l.summary}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="flex flex-wrap gap-1"><Badge>{SCOPE[l.scope]}</Badge><Badge>{l.license}</Badge></span>
        {l.installed ? <span className="flex items-center gap-1 text-xs text-ok"><Check className="size-3.5" aria-hidden /> Installed</span> : <Button size="sm" variant="secondary" onClick={install} loading={busy}>Install</Button>}
      </div>
    </li>
  );
}

/** Settings → Skills: what the agent and the Design agent can use, the library, and adding your own. */
export function SkillsSection() {
  const { skills, skillLibrary, loadSkills } = useStore();
  const [tab, setTab] = useState<"mine" | "library">("mine");
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [editing, setEditing] = useState<SkillView | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => { void loadSkills(); }, [loadSkills]);
  const hidden = useStore((s) => s.hidden);
  const mine = useMemo(() => (skills ?? []).filter((s) => !hidden[`skill:${s.id}`] && (!q || `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase()))), [skills, hidden, q]);
  const groups: Array<[string, SkillSummary[]]> = [["Installed", mine.filter((s) => s.source !== "builtin")], ["Built-in", mine.filter((s) => s.source === "builtin")]];
  const lib = (skillLibrary ?? []).filter((l) => !q || `${l.name} ${l.summary} ${l.repo}`.toLowerCase().includes(q.toLowerCase()));
  const categories = [...new Set(lib.map((l) => l.category))];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-tight">Skills</h2>
          <p className="mt-1 max-w-xl text-sm text-muted">Playbooks the agent loads when a task matches, like Claude Code. Only their names and descriptions sit in its instructions until one is needed. Pin one to use it on every task, or type <code className="font-mono">/name</code> in the agent to use it once. Design skills also guide the Design agent.</p>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden /> Add skill</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Skills view" kind="tab" value={tab} onChange={setTab} options={[
          { value: "mine", label: <span className="flex items-center gap-1.5"><BookOpen className="size-3.5" aria-hidden />Your skills{skills ? ` · ${skills.length}` : ""}</span> },
          { value: "library", label: <span className="flex items-center gap-1.5"><Library className="size-3.5" aria-hidden />Library</span> },
        ]} />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills" aria-label="Search skills" className="max-w-xs" />
      </div>
      {skills === null && <div className="space-y-2">{[0, 1, 2].map((i) => <Bone key={i} className="block h-14 rounded-xl" />)}</div>}
      {skills && tab === "mine" && groups.map(([title, list]) => list.length > 0 && (
        <section key={title}>
          <h3 className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h3>
          <ul className="card-surface divide-y divide-line/50 rounded-2xl p-1">{list.map((s) => <SkillRow key={s.id} s={s} onView={() => setViewing(s.id)} />)}</ul>
        </section>
      ))}
      {skills && tab === "library" && (
        <>
          <p className="text-xs text-muted">Popular open-source skills, installed straight from their GitHub repositories (each keeps its own license). Install counts are from skills.sh.</p>
          {categories.map((c) => (
            <section key={c}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{c}</h3>
              <ul className="grid gap-3 sm:grid-cols-2">{lib.filter((l) => l.category === c).map((l) => <LibraryCard key={`${l.repo}/${l.name}`} l={l} />)}</ul>
            </section>
          ))}
        </>
      )}
      <AddSkillDialog open={adding} onClose={() => setAdding(false)} />
      <ViewSkillDialog id={viewing} onClose={() => setViewing(null)} onEdit={(v) => { setViewing(null); setEditing(v); }} />
      <SkillEditorDialog open={!!editing} onClose={() => setEditing(null)} initial={editing?.markdown} editId={editing?.id} />
    </div>
  );
}
