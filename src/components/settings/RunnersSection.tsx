"use client";
import { CheckCircle2, Copy, Cpu, Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { RunnerView } from "@/lib/types";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, IconButton, Input, Segmented, cn } from "../ui";

const ago = (t: number | null) => {
  if (!t) return "never connected";
  const s = Math.round((Date.now() - t) / 1000);
  return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};

/** The commands that download the runner and start it with this token. */
export function runnerCommands(origin: string, token: string): { unix: string; windows: string } {
  const url = `${origin}/morphie-runner.mjs`;
  return {
    unix: `curl -fsSL ${url} -o morphie-runner.mjs && node morphie-runner.mjs --server ${origin} --token ${token}`,
    windows: `iwr ${url} -OutFile morphie-runner.mjs; node morphie-runner.mjs --server ${origin} --token ${token}`,
  };
}

/**
 * Settings → Runners: Morphie Runners run your code projects on your own computer or VM, for free, with its tools.
 * Adding one shows the command (with its token, shown once) and waits until it connects.
 */
export function RunnersSection() {
  const toast = useStore((s) => s.toast);
  const [runners, setRunners] = useState<RunnerView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ runner: RunnerView; token: string } | null>(null);
  const [os, setOs] = useState<"unix" | "windows">(() => (typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent) ? "windows" : "unix"));
  const [remove, setRemove] = useState<RunnerView | null>(null);
  const [busy, setBusy] = useState(false);

  const save = (list: RunnerView[]) => { setRunners(list); useStore.setState((s) => ({ code: { ...s.code, runners: list } })); };
  const load = async () => { try { save((await api<{ runners: RunnerView[] }>("/api/runners")).runners); } catch (e) { toast("error", (e as Error).message); } };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // While the new runner's command is on screen, watch for it to connect.
  const waiting = created && !runners?.find((r) => r.id === created.runner.id)?.online;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    setBusy(true);
    try {
      const r = await api<{ runner: RunnerView; token: string; runners: RunnerView[] }>("/api/runners", { method: "POST", body: { name: name.trim() } });
      save(r.runners); setCreated({ runner: r.runner, token: r.token }); setAdding(false); setName("");
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  const del = async (r: RunnerView) => {
    try { save((await api<{ runners: RunnerView[] }>(`/api/runners/${r.id}`, { method: "DELETE" })).runners); toast("ok", `Removed ${r.name}.`); } catch (e) { toast("error", (e as Error).message); }
  };
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const cmd = created ? runnerCommands(origin, created.token)[os] : "";
  const connected = created && runners?.find((r) => r.id === created.runner.id)?.online;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-tight">Runners</h2>
          <p className="mt-1 max-w-xl text-sm text-muted">Run your code projects on your own computer or VM: the agent's commands (npm, git, tests) run there with your tools, for free. The runner connects out to Morphie, so nothing has to be opened up.</p>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden /> Add runner</Button>
      </header>

      {runners && !runners.length ? (
        <EmptyState icon={<Cpu className="size-5" />} title="No runners yet" action={<Button variant="primary" onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden /> Add runner</Button>}>
          You need Node.js 18+ on that computer. Projects can also be <span className="font-medium text-fg">Lite</span> (files only, no setup): good for websites.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel/70">
          {(runners ?? []).map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3.5 py-3" data-testid={`runner-${r.id}`}>
              <span className={cn("size-2.5 shrink-0 rounded-full", r.online ? "bg-ok shadow-[0_0_8px_rgb(var(--ok))]" : "bg-faint/50")} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">{r.name}<Badge tone={r.online ? "ok" : "neutral"}>{r.online ? "Connected" : "Offline"}</Badge></div>
                <p className="truncate text-xs text-muted">{r.platform || "Not connected yet"} · {r.online ? "online now" : `last seen ${ago(r.lastSeenAt)}`}</p>
              </div>
              <IconButton label={`Remove ${r.name}`} onClick={() => setRemove(r)} className="hover:text-err"><Trash2 className="size-4" /></IconButton>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a runner" description="Name the computer it will run on."
        footer={<><Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={add}>Create</Button></>}>
        <Field label="Name" htmlFor="runner-name"><Input id="runner-name" data-autofocus value={name} maxLength={40} placeholder="My laptop" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} /></Field>
      </Dialog>

      <Dialog open={!!created} onClose={() => setCreated(null)} title={`Start ${created?.runner.name ?? "the runner"}`} description="Run this in a terminal on that computer. The token is shown only now." width="max-w-xl"
        footer={<Button variant="primary" onClick={() => setCreated(null)}>{connected ? "Done" : "Close"}</Button>}>
        <div className="space-y-3">
          <Segmented size="sm" label="Operating system" value={os} onChange={setOs} options={[{ value: "unix", label: "macOS / Linux" }, { value: "windows", label: "Windows (PowerShell)" }]} />
          <div className="relative">
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-[#0b0d12] p-3 pr-10 font-mono text-[12px] leading-relaxed text-[#cfd6e4]" data-testid="runner-command">{cmd}</pre>
            <IconButton label="Copy command" className="absolute right-1.5 top-1.5" onClick={() => void navigator.clipboard?.writeText(cmd).then(() => toast("ok", "Command copied."), () => {})}><Copy className="size-4" /></IconButton>
          </div>
          <p className="text-xs leading-relaxed text-muted">Projects go in <code className="font-mono">~/morphie-projects</code> (change it with <code className="font-mono">--dir</code>). Commands run as you, so keep approvals on. Ctrl+C stops it; remove the runner here to revoke the token.</p>
          <p className={cn("flex items-center gap-2 text-sm", connected ? "text-ok" : "text-muted")} data-testid="runner-status">
            {connected ? <><CheckCircle2 className="size-4" aria-hidden /> Connected. Pick it when you make a new project.</> : <><Loader2 className="size-4 animate-spin" aria-hidden /> Waiting for it to connect…</>}
          </p>
        </div>
      </Dialog>

      <ConfirmDialog open={!!remove} title={`Remove ${remove?.name}?`} body="Its token stops working. Projects on it stay on that computer, but Morphie can't reach them until you add a runner again." confirm="Remove"
        onConfirm={() => remove && void del(remove)} onClose={() => setRemove(null)} />
    </div>
  );
}
