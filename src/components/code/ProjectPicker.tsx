"use client";
import { Check, ChevronDown, FolderGit2, FolderPlus, GitBranch, Inbox, Lock, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useStore } from "@/lib/store";
import type { ProjectView, RunnerView } from "@/lib/types";
import { Button, ConfirmDialog, Dialog, Field, IconButton, Input, cn, useDismiss } from "../ui";

/** "owner/repo" for GitHub URLs, the host+path otherwise. */
export function repoLabel(url: string | null): string | null {
  if (!url) return null;
  const m = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return m ? m[1] : url.replace(/^https:\/\//, "");
}

/** Where a project runs, in words: "Lite", "Runner · My laptop", or the repository. */
export function placeLabel(p: ProjectView, runners: RunnerView[]): string | null {
  const where = p.sandbox ?? "";
  if (where === "lite") return "Lite · files only";
  if (where.startsWith("runner:")) return `Runner · ${runners.find((r) => r.id === where.slice(7))?.name ?? "removed"}`;
  return null;
}

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createProject = useStore((s) => s.createProject);
  const github = useStore((s) => s.code.github);
  const sandbox = useStore((s) => s.code.sandbox);
  const runners = useStore((s) => s.code.runners);
  const [where, setWhere] = useState<string>("");
  const place = where || (sandbox !== "none" ? "server" : runners.find((r) => r.online) ? `runner:${runners.find((r) => r.online)!.id}` : "lite");
  const setTab = useStore((s) => s.setTab);
  const setSection = useStore((s) => s.setSettingsSection);
  const [repo, setRepo] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const p = await createProject({ repoUrl: place === "lite" ? undefined : repo.trim() || undefined, name: name.trim() || undefined, branch: branch.trim() || undefined, sandbox: place });
    setBusy(false);
    if (p) { setRepo(""); setName(""); setBranch(""); onClose(); }
  };
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title="New project" description="Clone a repository, or start from an empty folder. The agent works on it in an isolated sandbox."
      icon={<span className="grid size-10 place-items-center rounded-xl bg-accent/12 text-accent ring-1 ring-inset ring-accent/25"><FolderPlus className="size-5" aria-hidden /></span>}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>{busy ? (place !== "lite" && repo.trim() ? "Cloning…" : "Creating…") : place !== "lite" && repo.trim() ? "Clone" : "Create empty project"}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Where it runs">
          <div role="radiogroup" aria-label="Where it runs" className="grid gap-2">
            {[
              ...(sandbox !== "none" ? [{ value: "server", title: sandbox === "local" ? "This server" : "Cloud sandbox", hint: sandbox === "local" ? "A folder on the machine running Morphie, with its shell." : "An isolated Linux container in the cloud." }] : []),
              ...runners.map((r) => ({ value: `runner:${r.id}`, title: `Runner · ${r.name}`, hint: r.online ? `Your computer (${r.platform || "connected"}): your tools, free.` : "Offline: start it on that computer first." })),
              { value: "lite", title: "Lite", hint: "Files only, no shell: great for websites (HTML/CSS/JS). Works everywhere, free." },
            ].map((o) => (
              <button key={o.value} type="button" role="radio" aria-checked={place === o.value} onClick={() => setWhere(o.value)}
                className={cn("flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition", place === o.value ? "border-accent/60 bg-accent/[0.06]" : "border-line hover:border-faint/60")}>
                <span className={cn("mt-1 size-3 shrink-0 rounded-full border", place === o.value ? "border-accent bg-accent" : "border-faint")} aria-hidden />
                <span><span className="block text-sm font-medium">{o.title}</span><span className="block text-xs text-muted">{o.hint}</span></span>
              </button>
            ))}
            {!runners.length && <button type="button" className="text-left text-xs text-accent hover:underline" onClick={() => { onClose(); setTab("settings"); setSection("runners"); }}>Run projects on your own computer: add a Morphie Runner →</button>}
          </div>
        </Field>
        {place !== "lite" && <>
        <Field label="Repository" htmlFor="np-repo" hint={<>https URL or <code className="font-mono">owner/repo</code> for GitHub. Leave empty for a blank project.</>}>
          <div className="relative">
            <GitBranch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
            <Input id="np-repo" data-autofocus value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="vercel/next.js or https://github.com/owner/repo" className="pl-9 font-mono" autoComplete="off" spellCheck={false} />
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="np-name" hint="Optional"><Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={repo ? repo.split("/").pop()?.replace(/\.git$/, "") : "My app"} maxLength={80} /></Field>
          <Field label="Branch" htmlFor="np-branch" hint="Optional (default branch)"><Input id="np-branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className="font-mono" disabled={!repo.trim()} /></Field>
        </div>
        </>}
        <button type="submit" hidden />
        <div className={cn("flex items-start gap-2.5 rounded-xl border p-3 text-xs leading-relaxed", github ? "border-ok/30 bg-ok/5 text-muted" : "border-line bg-sunken/60 text-muted")}>
          <Lock className={cn("mt-0.5 size-3.5 shrink-0", github ? "text-ok" : "text-faint")} aria-hidden />
          {github ? <span>Your GitHub token is set: private repositories, pushes and pull requests work.</span>
            : <span>Public repositories clone without a token. For private ones, pushing and pull requests, <button type="button" className="text-accent hover:underline" onClick={() => { onClose(); setTab("settings"); setSection("tools"); }}>add a GitHub token</button>.</span>}
        </div>
        {place === "server" && sandbox === "local" && <p className="text-xs leading-relaxed text-warn">Projects run on this machine (local sandbox): commands the agent runs can touch anything your user account can. Keep approvals on.</p>}
      </form>
    </Dialog>
  );
}

/** The agent's project switcher. A task that already started stays with its project (shown, not switchable). */
export function ProjectPicker({ lockedTo, disabled }: { lockedTo?: ProjectView | null; disabled?: boolean }) {
  const { projects, selectedProject, setSelectedProject, deleteProject, renameProject, newConversation } = useStore();
  const runners = useStore((s) => s.code.runners);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<ProjectView | null>(null);
  const [renaming, setRenaming] = useState<ProjectView | null>(null);
  const [newName, setNewName] = useState("");
  const ref = useDismiss(open, () => setOpen(false));
  const current = lockedTo !== undefined ? lockedTo : projects.find((p) => p.id === selectedProject) ?? null;
  const locked = lockedTo !== undefined;

  const chip = (
    <span className="flex min-w-0 items-center gap-1.5">
      {current ? <FolderGit2 className="size-3.5 shrink-0 text-accent" aria-hidden /> : <Inbox className="size-3.5 shrink-0" aria-hidden />}
      <span className="truncate font-medium">{current ? current.name : "No project"}</span>
      {current?.repoUrl && <span className="hidden truncate font-mono text-[11px] text-faint md:inline">{repoLabel(current.repoUrl)}</span>}
    </span>
  );

  if (locked) {
    return <span title={current ? `This task works in ${current.name}` : "This task uses the private workspace"} className="flex max-w-[260px] items-center gap-1.5 rounded-lg border border-line bg-raised/50 px-2 py-1 text-xs text-muted">{chip}</span>;
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} disabled={disabled} aria-haspopup="listbox" aria-expanded={open}
        className={cn("group flex max-w-[280px] items-center gap-1.5 rounded-lg border px-2 py-1 pointer-coarse:min-h-11 text-xs transition active:scale-[0.97] disabled:opacity-60", current ? "border-accent/35 bg-accent/[0.07] text-fg hover:border-accent/60" : "border-line text-muted hover:border-faint/60 hover:text-fg")}>
        {chip}
        <ChevronDown className={cn("size-3 shrink-0 transition-transform duration-300", open && "rotate-180")} aria-hidden />
      </button>
      <div role="listbox" aria-label="Choose a project" hidden={!open} inert={!open} className="pop absolute right-0 top-full z-30 mt-2 w-80 origin-top-right overflow-hidden rounded-xl border border-line bg-panel/95 p-1 shadow-pop backdrop-blur-xl">
        <button role="option" aria-selected={!current} onClick={() => { setSelectedProject(null); newConversation("agent"); setOpen(false); }} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-accent/10", !current && "bg-accent/[0.08]")}>
          <span className="grid size-7 place-items-center rounded-lg bg-fg/[0.06] text-muted"><Inbox className="size-3.5" aria-hidden /></span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-medium">No project</span><span className="block text-[11px] text-muted">Research, writing, the private workspace</span></span>
          {!current && <Check className="size-4 text-accent" aria-hidden />}
        </button>
        {projects.length > 0 && <div className="mx-2 my-1 border-t border-line" />}
        <div className="max-h-72 overflow-auto">
          {projects.map((p) => (
            <div key={p.id} className="group relative">
              <button role="option" aria-selected={p.id === current?.id} onClick={() => { setSelectedProject(p.id); newConversation("agent"); setOpen(false); }} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-2 pr-16 text-left transition hover:bg-accent/10", p.id === current?.id && "bg-accent/[0.08]")}>
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-linear-to-br/oklch from-accent/80 to-accent-2/70 font-display text-xs font-semibold text-white">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{p.name}</span><span className="block truncate font-mono text-[11px] text-muted">{placeLabel(p, runners) ?? repoLabel(p.repoUrl) ?? "project"}</span></span>
                {p.id === current?.id && <Check className="size-4 shrink-0 text-accent group-hover:hidden" aria-hidden />}
              </button>
              <span className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 gap-0.5 group-hover:flex group-focus-within:flex">
                <IconButton label={`Rename ${p.name}`} className="size-7" onClick={() => { setRenaming(p); setNewName(p.name); setOpen(false); }}><Pencil className="size-3" /></IconButton>
                <IconButton label={`Delete ${p.name}`} className="size-7 hover:text-err" onClick={() => { setConfirm(p); setOpen(false); }}><Trash2 className="size-3" /></IconButton>
              </span>
            </div>
          ))}
        </div>
        <button onClick={() => { setOpen(false); setCreating(true); }} className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-line px-2.5 py-2 text-left text-sm text-accent transition hover:bg-accent/10"><FolderPlus className="size-4" aria-hidden /> New project…</button>
      </div>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog open={!!confirm} title={`Delete ${confirm?.name ?? "project"}?`} body={<>Its files are deleted for good, including uncommitted and unpushed work. Tasks that used it stay in your history.</>} onConfirm={() => confirm && void deleteProject(confirm.id)} onClose={() => setConfirm(null)} />
      <Dialog open={!!renaming} onClose={() => setRenaming(null)} title="Rename project" width="max-w-sm" footer={<><Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button><Button variant="primary" disabled={!newName.trim()} onClick={() => { if (renaming) void renameProject(renaming.id, newName.trim()); setRenaming(null); }}>Save</Button></>}>
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} aria-label="Project name" onKeyDown={(e) => { if (e.key === "Enter" && newName.trim() && renaming) { void renameProject(renaming.id, newName.trim()); setRenaming(null); } }} />
      </Dialog>
    </div>
  );
}
