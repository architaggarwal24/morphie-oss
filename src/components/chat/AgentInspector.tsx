"use client";
import { Download, Eye, FileText, FolderOpen, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { bytes } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { AgentSettings, MessageView, ProjectView } from "@/lib/types";
import { CodePanel } from "../code/CodePanel";
import { Badge, Button, Dialog, IconButton, Switch, cn } from "../ui";
import { BudgetSlider } from "../settings/BudgetControls";
import { PlanCard } from "./Timeline";

interface WFile { path: string; size: number; modified: number }

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-line/70 px-4 py-4">
      <div className="mb-2.5 flex items-center justify-between"><h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] tabular-nums text-faint">{title}</h3>{action}</div>
      {children}
    </section>
  );
}

const APPROVAL: Array<{ v: AgentSettings["approval"]; label: string; hint: string }> = [
  { v: "ask", label: "Ask for risky actions", hint: "Writing/deleting files, saving memories." },
  { v: "always", label: "Ask before every tool", hint: "Maximum control; slower." },
  { v: "never", label: "Auto-approve everything", hint: "Fast. The agent can change your workspace unattended." },
];

export function AgentInspector({ convId, messages, project }: { convId: string | null; messages: MessageView[]; project?: ProjectView | null }) {
  const { inspectorOpen, toggleInspector, run, settings, setSettings, tools, search, setTab, setSettingsSection, toast, undoable } = useStore();
  const hidden = useStore((s) => s.hidden);
  const convTitle = useStore((s) => (convId ? s.conversations.find((c) => c.id === convId)?.title : undefined));
  const [files, setFiles] = useState<WFile[]>([]);
  const [view, setView] = useState<{ path: string; content: string } | null>(null);

  const refresh = useCallback(async () => {
    try { setFiles((await api<{ files: WFile[] }>("/api/workspace")).files); } catch { /* ignore */ }
  }, []);
  const finished = run?.status === "done" || !run;
  useEffect(() => { void refresh(); }, [refresh, finished, convId, messages.length]);

  const lastPlan = run?.plan ?? [...messages].reverse().find((m) => m.meta?.plan)?.meta?.plan;
  const agentTools = tools.filter((t) => t.modes.includes("agent") && t.name !== "update_plan" && !t.code);
  const open = inspectorOpen;
  const busy = !!run && run.status !== "done" && run.status !== "error";
  const changed = useMemo(() => {
    const set = new Set<string>(run?.mode === "agent" ? run.changedFiles : []);
    for (const m of messages) for (const f of m.meta?.changed ?? []) set.add(f);
    return [...set];
  }, [run?.mode, run?.changedFiles, messages]);

  if (project) {
    return (
      <>
        {open && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => toggleInspector(false)} aria-hidden />}
        <aside aria-label="Project panel" className={cn("glass z-40 flex-col border-l border-line", open ? "fixed inset-y-0 right-0 flex w-[min(96vw,480px)] shadow-pop max-lg:pt-safe max-lg:pb-safe max-lg:pr-safe lg:static lg:w-[420px] lg:shadow-none xl:w-[500px]" : "hidden")}>
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4 lg:hidden"><span className="text-sm font-medium">{project.name}</span><IconButton label="Close" onClick={() => toggleInspector(false)}><X className="size-4" /></IconButton></div>
          <CodePanel key={project.id} project={project} plan={lastPlan} busy={busy} changed={changed} />
        </aside>
      </>
    );
  }

  async function openFile(path: string) {
    try { setView(await api<{ path: string; content: string }>(`/api/workspace/file?path=${encodeURIComponent(path)}`)); } catch (e) { toast("error", (e as Error).message); }
  }
  function remove(path: string) {
    undoable({
      key: `file:${path}`, text: `Deleted ${path}.`,
      commit: async ({ keepalive }) => setFiles((await api<{ files: WFile[] }>(`/api/workspace/file?path=${encodeURIComponent(path)}`, { method: "DELETE", keepalive })).files),
    });
  }
  const shownFiles = files.filter((f) => !hidden[`file:${f.path}`]);
  // The zip is named after the files' common folder ("friday-landing.zip"), or else this task.
  const tops = new Set(shownFiles.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  const zipName = (tops.size === 1 && [...tops][0]) || (convTitle && convTitle !== "New conversation" ? convTitle : "");

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => toggleInspector(false)} aria-hidden />}
      <aside aria-label="Task panel" className={cn("glass z-40 flex-col overflow-y-auto border-l border-line", open ? "fixed inset-y-0 right-0 flex w-[min(92vw,340px)] shadow-pop max-lg:pt-safe max-lg:pb-safe max-lg:pr-safe lg:static lg:w-80 lg:shadow-none" : "hidden")}>
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4 lg:hidden"><span className="text-sm font-medium">Task panel</span><IconButton label="Close" onClick={() => toggleInspector(false)}><X className="size-4" /></IconButton></div>

        <Section title="Plan">
          {lastPlan?.length ? <PlanCard plan={lastPlan} /> : <p className="text-[13px] leading-relaxed text-muted">For multi-step tasks the agent writes a checklist here and ticks it off as it goes.</p>}
        </Section>

        <Section title={`Workspace${shownFiles.length ? ` · ${shownFiles.length}` : ""}`} action={<IconButton label="Refresh files" onClick={refresh}><RefreshCw className="size-3.5" /></IconButton>}>
          {shownFiles.length === 0 ? (
            <p className="flex items-start gap-2 text-[13px] leading-relaxed text-muted"><FolderOpen className="mt-0.5 size-4 shrink-0" aria-hidden /> Files the agent writes appear here. They live in a private sandbox folder on this machine.</p>
          ) : (
            <ul className="space-y-0.5">
              {shownFiles.map((f) => (
                <li key={f.path} className="group flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-raised">
                  <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />
                  <button onClick={() => openFile(f.path)} className="min-w-0 flex-1 truncate pointer-coarse:min-h-11 text-left font-mono text-xs" title={f.path}>{f.path}</button>
                  <span className="shrink-0 text-[10px] tabular-nums text-faint group-hover:hidden">{bytes(f.size)}</span>
                  <span className="hidden shrink-0 gap-0.5 group-hover:flex group-focus-within:flex">
                    <IconButton label={`View ${f.path}`} className="size-6" onClick={() => openFile(f.path)}><Eye className="size-3" /></IconButton>
                    <a aria-label={`Download ${f.path}`} title="Download" href={`/api/workspace/file?path=${encodeURIComponent(f.path)}&download=1`} className="grid size-6 pointer-coarse:size-11 place-items-center rounded-md text-muted hover:bg-raised hover:text-fg"><Download className="size-3" /></a>
                    <IconButton label={`Delete ${f.path}`} className="size-6" onClick={() => remove(f.path)}><Trash2 className="size-3" /></IconButton>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {shownFiles.length > 0 && <a href={`/api/workspace?zip=1${zipName ? `&name=${encodeURIComponent(zipName)}` : ""}`} className="mt-2 inline-flex pointer-coarse:min-h-11 items-center gap-1.5 text-xs text-accent hover:underline"><Download className="size-3" aria-hidden /> Download all (.zip)</a>}
        </Section>

        <Section title="Approvals">
          <div role="radiogroup" aria-label="Approval mode" className="space-y-1.5">
            {APPROVAL.map((a) => (
              <button key={a.v} role="radio" aria-checked={settings.approval === a.v} onClick={() => setSettings({ approval: a.v })} className={cn("group flex w-full items-start gap-2.5 rounded-xl border p-2.5 text-left transition duration-200 active:scale-[0.99]", settings.approval === a.v ? "border-accent/60 bg-accent/[0.08] shadow-[0_0_0_3px_rgb(var(--accent)/0.08)]" : "border-line hover:border-faint/60 hover:bg-fg/[0.03]")}>
                <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition", settings.approval === a.v ? "border-accent bg-accent/15" : "border-faint group-hover:border-muted")}>{settings.approval === a.v && <span className="check-pop size-2 rounded-full bg-accent shadow-[0_0_8px_rgb(var(--accent))]" />}</span>
                <span><span className="block text-[13px] font-medium">{a.label}</span><span className="block text-xs text-muted">{a.hint}</span></span>
              </button>
            ))}
          </div>
          {settings.approval === "never" && <p className="mt-2 flex items-start gap-1.5 text-xs text-warn"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Web pages or documents could try to steer the agent. Keep this on only for tasks you trust.</p>}
          {settings.alwaysAllow.length > 0 && (
            <div className="mt-3 text-xs text-muted">
              Always allowed:{" "}
              {settings.alwaysAllow.map((t) => (
                <button key={t} onClick={() => setSettings({ alwaysAllow: settings.alwaysAllow.filter((x) => x !== t) })} className="mr-1 inline-flex pointer-coarse:min-h-11 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 font-mono hover:border-err/50 hover:text-err" title="Stop always allowing">{t}<X className="size-3" aria-hidden /></button>
              ))}
            </div>
          )}
        </Section>

        <Section title="Budget">
          <BudgetSlider label="Tokens per task" />
        </Section>

        <Section title="Tools">
          <ul className="space-y-2.5">
            {agentTools.map((t) => {
              const off = settings.disabledTools.includes(t.name);
              const missing = t.needsKey === "tavily" && !search.user && !search.server;
              return (
                <li key={t.name} className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">{t.label}{t.risk === "confirm" && <Badge tone="warn">asks first</Badge>}{missing && <button onClick={() => { setTab("settings"); setSettingsSection("tools"); }} className="rounded-full pointer-coarse:min-h-11"><Badge tone="err">needs key</Badge></button>}</div>
                    <p className="text-xs leading-snug text-muted">{t.description}</p>
                  </div>
                  <Switch checked={!off} label={`Enable ${t.label}`} onChange={(v) => setSettings({ disabledTools: v ? settings.disabledTools.filter((x) => x !== t.name) : [...settings.disabledTools, t.name] })} />
                </li>
              );
            })}
          </ul>
        </Section>
      </aside>

      <Dialog open={!!view} onClose={() => setView(null)} title={view?.path ?? ""} width="max-w-2xl" footer={view && <><a href={`/api/workspace/file?path=${encodeURIComponent(view.path)}&download=1`}><Button variant="secondary"><Download className="size-4" /> Download</Button></a><Button variant="primary" onClick={() => setView(null)}>Close</Button></>}>
        <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-sunken p-4 font-mono text-[13px] leading-relaxed">{view?.content || "(empty file)"}</pre>
      </Dialog>
    </>
  );
}
