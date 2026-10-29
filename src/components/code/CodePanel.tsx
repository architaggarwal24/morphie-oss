"use client";
import { AppWindow, ArrowLeft, Bot, Check, CheckCheck, ChevronRight, Download, File, FileDiff, Folder, FolderOpen, GitBranch, GitCommitHorizontal, GitPullRequest, ListChecks, Loader2, RefreshCw, ShieldCheck, SquareTerminal, Trash2, Undo2, Upload, User, X } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { bytes, ms } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { PlanItem, ProjectChanges, ProjectEntry, ProjectView } from "@/lib/types";
import { Badge, Button, ConfirmDialog, Dialog, Field, IconButton, Input, Spinner, Textarea, Tip, cn } from "../ui";
import { PlanCard } from "../chat/Timeline";
import { CodeView } from "./CodeView";
import { DiffStat, DiffView } from "./DiffView";
import { PreviewTab } from "./PreviewTab";
import { RulesEditor } from "./RulesEditor";

export type CodeTab = "changes" | "preview" | "files" | "terminal" | "plan" | "rules";
const TABS: Array<{ id: CodeTab; label: string; icon: typeof FileDiff }> = [
  { id: "changes", label: "Changes", icon: FileDiff },
  { id: "preview", label: "Preview", icon: AppWindow },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "plan", label: "Plan", icon: ListChecks },
  { id: "rules", label: "Rules", icon: ShieldCheck },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

// ------------------------------------------------------------------ changes

function StatusBadge({ s }: { s: string }) {
  const map: Record<string, [string, string]> = { M: ["M", "text-warn bg-warn/12"], A: ["A", "text-ok bg-ok/12"], "?": ["U", "text-ok bg-ok/12"], D: ["D", "text-err bg-err/12"], R: ["R", "text-info bg-info/12"] };
  const [l, c] = map[s] ?? [s, "text-muted bg-fg/10"];
  return <span className={cn("grid size-4 shrink-0 place-items-center rounded font-mono text-[10px] font-semibold", c)} title={{ M: "Modified", A: "Added", "?": "New (untracked)", D: "Deleted", R: "Renamed" }[s]}>{l}</span>;
}

function ChangesTab({ project }: { project: ProjectView }) {
  const tick = useStore((s) => s.changesTick);
  const github = useStore((s) => s.code.github);
  const toast = useStore((s) => s.toast);
  const setTab = useStore((s) => s.setTab);
  const setSection = useStore((s) => s.setSettingsSection);
  const [data, setData] = useState<ProjectChanges | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirmReject, setConfirmReject] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [pr, setPr] = useState({ title: "", body: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api<ProjectChanges>(`/api/projects/${project.id}/changes`)); setError(null); }
    catch (e) { setError(errText(e)); }
    finally { setLoading(false); }
  }, [project.id]);
  // Refetch when the agent (or the terminal) may have changed files: debounced, since edits come in bursts.
  useEffect(() => { const t = setTimeout(() => void load(), tick ? 500 : 0); return () => clearTimeout(t); }, [load, tick]);

  async function act(key: string, body: Record<string, unknown>, ok?: (r: any) => string | undefined) {
    setBusy(key);
    try {
      const r = await api<{ changes: ProjectChanges } & Record<string, any>>(`/api/projects/${project.id}/changes`, { method: "POST", body });
      setData(r.changes);
      const msg = ok?.(r);
      if (msg) toast("ok", msg);
      return r;
    } catch (e) { toast("error", errText(e)); return null; }
    finally { setBusy(null); }
  }

  if (!data && loading) return <div className="grid place-items-center py-16"><Spinner /></div>;
  if (error && !data) return <div className="p-4 text-sm text-err" role="alert">{error} <Button size="sm" variant="ghost" onClick={() => void load()}>Retry</Button></div>;
  if (!data) return null;
  if (!data.git) {
    return (
      <div className="grid place-items-center gap-3 px-6 py-14 text-center">
        <span className="grid size-11 place-items-center rounded-2xl bg-accent/12 text-accent ring-1 ring-inset ring-accent/25"><GitBranch className="size-5" aria-hidden /></span>
        <p className="text-sm text-muted">This project isn't a git repository, so changes can't be tracked yet.</p>
        <Button size="sm" variant="secondary" loading={busy === "init"} onClick={async () => { setBusy("init"); try { await api(`/api/projects/${project.id}/exec`, { method: "POST", body: { command: "git init -q && git add -A && git commit -qm 'Initial commit' --allow-empty" } }); await load(); } catch (e) { toast("error", errText(e)); } finally { setBusy(null); } }}>Initialize git</Button>
      </div>
    );
  }
  const total = data.files.reduce((a, f) => [a[0] + f.added, a[1] + f.removed], [0, 0]);
  const staged = new Set(data.files.filter((f) => f.staged).map((f) => f.path));
  const canPr = !!project.repoUrl;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-fg/[0.05] px-2 py-0.5 font-mono text-[11px]"><GitBranch className="size-3 shrink-0 text-accent" aria-hidden /><span className="truncate">{data.branch ?? "detached"}</span>{data.ahead ? <span className="text-info" title={`${data.ahead} commit(s) not pushed`}>↑{data.ahead}</span> : null}</span>
        {data.files.length > 0 && <span className="text-[11px] text-muted">{data.files.length} file{data.files.length === 1 ? "" : "s"}</span>}
        {data.files.length > 0 && <DiffStat added={total[0]} removed={total[1]} />}
        <span className="flex-1" />
        {loading && <Loader2 className="size-3.5 animate-spin text-faint" aria-label="Refreshing" />}
        <IconButton label="Refresh changes" className="size-7" onClick={() => void load()}><RefreshCw className="size-3.5" /></IconButton>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {data.files.length === 0 ? (
          <div className="grid place-items-center gap-2 px-4 py-12 text-center">
            <span className="grid size-11 place-items-center rounded-2xl bg-ok/10 text-ok ring-1 ring-inset ring-ok/25"><CheckCheck className="size-5" aria-hidden /></span>
            <p className="text-sm font-medium">Working tree clean</p>
            <p className="max-w-[260px] text-xs leading-relaxed text-muted">Edits the agent makes show up here as diffs you can accept or reject.</p>
            {!!data.ahead && <Button size="sm" variant="secondary" className="mt-2" loading={busy === "push"} onClick={() => void act("push", { action: "push" }, () => "Pushed.")}><Upload className="size-3.5" aria-hidden /> Push {data.ahead} commit{data.ahead === 1 ? "" : "s"}</Button>}
          </div>
        ) : (
          <>
            <ul className="space-y-0.5 rounded-xl border border-line bg-panel/50 p-1">
              {data.files.map((f) => (
                <li key={f.path} className="group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-fg/[0.04]">
                  <StatusBadge s={f.status} />
                  <span className={cn("min-w-0 flex-1 truncate font-mono text-[12px]", f.status === "D" && "line-through decoration-err/50")} title={f.path}>{f.path}</span>
                  <DiffStat added={f.added} removed={f.removed} />
                  {f.staged ? <Tip content="Accepted (staged)"><span className="grid size-6 place-items-center text-ok"><Check className="size-3.5" aria-label="Accepted" /></span></Tip>
                    : <IconButton label={`Accept ${f.path}`} className="size-6 opacity-70 group-hover:opacity-100 hover:text-ok" disabled={!!busy} onClick={() => void act(`a:${f.path}`, { action: "accept", path: f.path })}><Check className="size-3.5" /></IconButton>}
                  <IconButton label={`Reject ${f.path}`} className="size-6 opacity-70 group-hover:opacity-100 hover:text-err" disabled={!!busy} onClick={() => void act(`r:${f.path}`, { action: "reject", path: f.path }, () => `Reverted ${f.path}.`)}><Undo2 className="size-3.5" /></IconButton>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" className="flex-1" disabled={!!busy || staged.size === data.files.length} loading={busy === "acceptAll"} onClick={() => void act("acceptAll", { action: "accept" })}><CheckCheck className="size-3.5" aria-hidden /> Accept all</Button>
              <Button size="sm" variant="ghost" className="flex-1 hover:text-err" disabled={!!busy} onClick={() => setConfirmReject(true)}><Undo2 className="size-3.5" aria-hidden /> Reject all</Button>
            </div>
            <DiffView diff={data.diff} actions={(p) => staged.has(p) ? <Badge tone="ok" className="ml-1">accepted</Badge> : null} />
            {data.truncated && <p className="text-center text-[11px] text-muted">The diff is long, so only the first part is shown.</p>}
          </>
        )}
      </div>

      {data.files.length > 0 && (
        <form className="space-y-2 border-t border-line bg-sunken/40 p-3" onSubmit={async (e) => { e.preventDefault(); const r = await act("commit", { action: "commit", message }, (x) => `Committed ${x.commit ?? ""}`.trim()); if (r) setMessage(""); }}>
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="Commit message" aria-label="Commit message" className="min-h-0" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit(); }} />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={!message.trim() || !!busy} loading={busy === "commit"}><GitCommitHorizontal className="size-3.5" aria-hidden /> Commit all</Button>
            {canPr && <Button type="button" size="sm" variant="secondary" disabled={!!busy} onClick={() => { if (!github) { setTab("settings"); setSection("tools"); toast("info", "Add a GitHub token to open pull requests."); return; } setPr({ title: message.split("\n")[0], body: message.split("\n").slice(1).join("\n").trim() }); setPrOpen(true); }}><GitPullRequest className="size-3.5" aria-hidden /> Pull request</Button>}
          </div>
        </form>
      )}

      <ConfirmDialog open={confirmReject} title="Reject every change?" confirm="Reject all" body="All uncommitted changes are discarded and new files are deleted. This can't be undone." onConfirm={() => void act("rejectAll", { action: "reject" }, () => "All changes reverted.")} onClose={() => setConfirmReject(false)} />
      <Dialog open={prOpen} onClose={() => busy !== "pr" && setPrOpen(false)} title="Open a pull request" description="Creates a branch if you're on the default one, commits everything, pushes and opens the PR on GitHub."
        footer={<><Button variant="ghost" onClick={() => setPrOpen(false)} disabled={busy === "pr"}>Cancel</Button><Button variant="primary" loading={busy === "pr"} disabled={!pr.title.trim()} onClick={async () => { const r = await act("pr", { action: "pr", title: pr.title, body: pr.body }); if (r?.pr) { setPrOpen(false); toast("ok", `Opened pull request #${r.pr.number}.`); window.open(r.pr.url, "_blank", "noopener"); } }}><GitPullRequest className="size-4" aria-hidden /> Create</Button></>}>
        <div className="space-y-4">
          <Field label="Title" htmlFor="pr-title"><Input id="pr-title" value={pr.title} onChange={(e) => setPr({ ...pr, title: e.target.value })} maxLength={250} /></Field>
          <Field label="Description" htmlFor="pr-body" hint="Markdown"><Textarea id="pr-body" value={pr.body} onChange={(e) => setPr({ ...pr, body: e.target.value })} rows={6} /></Field>
        </div>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------ files

function FilesTab({ project, changed }: { project: ProjectView; changed: string[] }) {
  const toast = useStore((s) => s.toast);
  const tick = useStore((s) => s.changesTick);
  const [dirs, setDirs] = useState<Record<string, ProjectEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [view, setView] = useState<{ path: string; content: string; binary: boolean; truncated: boolean } | null>(null);

  const loadDir = useCallback(async (dir: string) => {
    setLoading((s) => new Set(s).add(dir));
    try { const r = await api<{ entries: ProjectEntry[] }>(`/api/projects/${project.id}/tree?dir=${encodeURIComponent(dir)}`); setDirs((d) => ({ ...d, [dir]: r.entries })); }
    catch (e) { toast("error", errText(e)); }
    finally { setLoading((s) => { const n = new Set(s); n.delete(dir); return n; }); }
  }, [project.id, toast]);
  useEffect(() => { setDirs({}); setOpen(new Set()); setView(null); void loadDir(""); }, [loadDir]);
  // After changes, refresh what's expanded (quietly).
  const openRef = useRef(open); openRef.current = open;
  useEffect(() => { if (!tick) return; const t = setTimeout(() => { void loadDir(""); for (const d of openRef.current) void loadDir(d); }, 700); return () => clearTimeout(t); }, [tick, loadDir]);

  async function openFile(path: string) {
    try { setView(await api(`/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`)); } catch (e) { toast("error", errText(e)); }
  }
  const toggle = (dir: string) => {
    setOpen((s) => { const n = new Set(s); if (n.has(dir)) n.delete(dir); else { n.add(dir); if (!dirs[dir]) void loadDir(dir); } return n; });
  };
  const changedSet = useMemo(() => new Set(changed), [changed]);

  if (view) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5 border-b border-line/70 px-2 py-1.5">
          <IconButton label="Back to files" className="size-7" onClick={() => setView(null)}><ArrowLeft className="size-3.5" /></IconButton>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={view.path}>{view.path}</span>
          <a href={`/api/projects/${project.id}/file?path=${encodeURIComponent(view.path)}&download=1`} aria-label={`Download ${view.path}`} title="Download" className="grid size-7 pointer-coarse:size-11 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"><Download className="size-3.5" /></a>
          <IconButton label="Close file" className="size-7" onClick={() => setView(null)}><X className="size-3.5" /></IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col p-3">
          {view.binary ? <p className="text-sm text-muted">This is a binary file. Download it to open it.</p> : <CodeView path={view.path} code={view.content} />}
          {view.truncated && <p className="mt-2 text-[11px] text-muted">Only the first megabyte is shown.</p>}
        </div>
      </div>
    );
  }

  const render = (dir: string, depth: number): React.ReactNode => {
    const list = dirs[dir];
    if (!list) return loading.has(dir) ? <div className="py-1" style={{ paddingLeft: 12 + depth * 14 }}><Loader2 className="size-3.5 animate-spin text-faint" aria-label="Loading" /></div> : null;
    if (!list.length && depth === 0) return <p className="px-3 py-8 text-center text-xs text-muted">The project is empty. Ask the agent to scaffold something.</p>;
    return list.map((e) => {
      const name = e.path.split("/").pop()!;
      const isOpen = open.has(e.path);
      const dirty = e.type === "file" ? changedSet.has(e.path) : changed.some((c) => c.startsWith(e.path + "/"));
      return (
        <div key={e.path}>
          <button onClick={() => (e.type === "dir" ? toggle(e.path) : void openFile(e.path))} className="group flex w-full pointer-coarse:min-h-11 items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[12.5px] hover:bg-fg/[0.05]" style={{ paddingLeft: 6 + depth * 14 }} aria-expanded={e.type === "dir" ? isOpen : undefined}>
            {e.type === "dir" ? <ChevronRight className={cn("size-3 shrink-0 text-faint transition-transform duration-200", isOpen && "rotate-90")} aria-hidden /> : <span className="w-3 shrink-0" />}
            {e.type === "dir" ? (isOpen ? <FolderOpen className="size-3.5 shrink-0 text-accent/80" aria-hidden /> : <Folder className="size-3.5 shrink-0 text-accent/70" aria-hidden />) : <File className="size-3.5 shrink-0 text-muted" aria-hidden />}
            <span className={cn("min-w-0 flex-1 truncate", dirty && "text-warn")}>{name}</span>
            {dirty && <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-label="changed" />}
            {e.type === "file" && e.size != null && <span className="hidden shrink-0 text-[10px] tabular-nums text-faint group-hover:inline">{bytes(e.size)}</span>}
          </button>
          {e.type === "dir" && isOpen && render(e.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{project.name}</span>
        <IconButton label="Refresh files" className="size-7" onClick={() => { void loadDir(""); for (const d of open) void loadDir(d); }}><RefreshCw className="size-3.5" /></IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 font-mono">{render("", 0)}</div>
    </div>
  );
}

// ------------------------------------------------------------------ terminal

function TerminalTab({ project, busy }: { project: ProjectView; busy: boolean }) {
  const entries = useStore((s) => s.terminals[project.id]) ?? [];
  const runTerminal = useStore((s) => s.runTerminal);
  const clearTerminal = useStore((s) => s.clearTerminal);
  const [cmd, setCmd] = useState("");
  const [hist, setHist] = useState(-1);
  const scroller = useRef<HTMLDivElement>(null);
  const mine = entries.filter((e) => e.by === "you").map((e) => e.command);
  const running = entries.some((e) => e.by === "you" && e.exitCode === -1);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [entries.length, entries.at(-1)?.output]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0b0d12] text-[#d6deeb]">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-3 font-mono text-[12px] leading-relaxed" role="log" aria-label="Terminal output">
        {entries.length === 0 && <p className="text-[#7f8aa3]">Commands you run here, and the ones the agent runs, appear in this terminal. The working directory is the project root.</p>}
        {entries.map((e) => (
          <div key={e.stepId + e.at} className="mb-3">
            <div className="flex items-center gap-1.5">
              {e.by === "agent" ? <Bot className="size-3 shrink-0 text-violet-300" aria-label="Agent" /> : <User className="size-3 shrink-0 text-sky-300" aria-label="You" />}
              <span className="select-none text-emerald-400">$</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-white">{e.command}</span>
              {e.exitCode >= 0 && <span className={cn("shrink-0 text-[10px]", e.exitCode === 0 ? "text-[#7f8aa3]" : "text-rose-400")}>{e.exitCode === 0 ? "" : `exit ${e.exitCode} · `}{ms(e.ms)}</span>}
            </div>
            {e.exitCode === -1 ? <Loader2 className="mt-1 size-3.5 animate-spin text-[#7f8aa3]" aria-label="Running" /> : e.output && <pre className="mt-0.5 whitespace-pre-wrap break-words text-[#c3cbe0]">{e.output.trimEnd()}</pre>}
          </div>
        ))}
      </div>
      <form className="flex items-center gap-2 border-t border-white/10 px-3 py-2" onSubmit={(e) => { e.preventDefault(); const c = cmd.trim(); if (!c || running) return; setCmd(""); setHist(-1); void runTerminal(project.id, c); }}>
        <span className="select-none font-mono text-[13px] text-emerald-400">$</span>
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} disabled={busy} spellCheck={false} autoComplete="off" aria-label="Command"
          placeholder={busy ? "The agent is working…" : "npm test, git log --oneline, ls…"}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && mine.length) { e.preventDefault(); const i = hist < 0 ? mine.length - 1 : Math.max(0, hist - 1); setHist(i); setCmd(mine[i]); }
            if (e.key === "ArrowDown" && hist >= 0) { e.preventDefault(); const i = hist + 1; if (i >= mine.length) { setHist(-1); setCmd(""); } else { setHist(i); setCmd(mine[i]); } }
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-white outline-hidden placeholder:text-[#5c6680]" />
        {running && <Loader2 className="size-3.5 animate-spin text-[#7f8aa3]" aria-hidden />}
        <button type="button" onClick={() => clearTerminal(project.id)} aria-label="Clear terminal" title="Clear" className="grid size-7 pointer-coarse:size-11 place-items-center rounded-md text-[#7f8aa3] hover:bg-white/10 hover:text-white"><Trash2 className="size-3.5" /></button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ panel

export function CodePanel({ project, plan, busy, changed }: { project: ProjectView; plan?: PlanItem[]; busy: boolean; changed: string[] }) {
  const [tab, setTab] = useState<CodeTab>("changes");
  const planMode = useStore((s) => s.planMode);
  const setPlanMode = useStore((s) => s.setPlanMode);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Project panels" className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-line px-2 pt-1.5">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("relative flex items-center gap-1.5 rounded-t-lg px-2.5 pb-2 pt-1.5 text-[12.5px] font-medium transition-colors", tab === t.id ? "text-fg" : "text-muted hover:text-fg")}>
            <t.icon className="size-3.5" aria-hidden />{t.label}
            {t.id === "changes" && changed.length > 0 && <span className="rounded-full bg-warn/15 px-1.5 text-[10px] tabular-nums text-warn">{changed.length}</span>}
            {tab === t.id && <motion.span layoutId="code-tab" className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-linear-to-r/oklch from-accent to-accent-2" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
          </button>
        ))}
      </div>
      {tab === "changes" && <ChangesTab project={project} />}
      {tab === "preview" && <PreviewTab project={project} />}
      {tab === "files" && <FilesTab project={project} changed={changed} />}
      {tab === "terminal" && <TerminalTab project={project} busy={busy} />}
      {tab === "plan" && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {plan?.length ? <PlanCard plan={plan} /> : <p className="text-[13px] leading-relaxed text-muted">For multi-step work the agent keeps a checklist here and ticks it off as it goes.</p>}
          <div className="rounded-xl border border-line bg-panel/50 p-3">
            <div className="flex items-center gap-2 text-[13px] font-medium"><ListChecks className="size-4 text-accent" aria-hidden /> Plan mode <Badge tone={planMode ? "accent" : "neutral"}>{planMode ? "on" : "off"}</Badge></div>
            <p className="mt-1 text-xs leading-relaxed text-muted">With plan mode on, the agent only reads and researches, then shows you a plan to approve before it edits anything or runs commands. Toggle it in the composer or type <code className="font-mono">/plan</code>.</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => setPlanMode(!planMode)}>{planMode ? "Turn off" : "Turn on"}</Button>
          </div>
        </div>
      )}
      {tab === "rules" && <div className="min-h-0 flex-1 overflow-y-auto p-3"><RulesEditor /></div>}
    </div>
  );
}
