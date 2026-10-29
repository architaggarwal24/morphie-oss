"use client";
import { BudgetSlider, HelperPicker } from "./BudgetControls";
import { Bot, Brain, Calculator, Check, Clock, Database, Download, FileCode2, FilePen, FilePlus2, FileSearch, FileText, FolderOpen, FolderTree, GitBranch, GitPullRequest, Globe, ListChecks, Monitor, Moon, Palette, Search, ShieldAlert, ShieldCheck, SquareTerminal, Sun, TextSearch, Trash2, Wrench, type LucideIcon } from "lucide-react";
import { RulesEditor } from "../code/RulesEditor";
import { useState } from "react";
import { api } from "@/lib/api";
import { askDesktopPermission, desktopPermission, getNotifyPrefs, setNotifyPrefs } from "@/lib/notify";
import { useStore, type ThemePref } from "@/lib/store";
import { SHORTCUTS, type Shortcut } from "@/lib/shortcuts";
import { Badge, Button, ConfirmDialog, Field, Input, KeyCombo, Slider, Switch, cn } from "../ui";

const Head = ({ title, children }: { title: string; children?: React.ReactNode }) => (
  <header><h2 className="font-display text-2xl font-semibold tracking-tight">{title}</h2>{children && <p className="mt-1 max-w-xl text-sm text-muted">{children}</p>}</header>
);
const Card = ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={cn("card-surface rounded-2xl p-5", className)}>{children}</div>;
const TOOL_ICONS: Record<string, LucideIcon> = {
  calculator: Calculator, get_current_time: Clock, web_search: Search, fetch_url: Globe, search_documents: FileSearch, update_plan: ListChecks,
  workspace_list: FolderOpen, workspace_read: FileText, workspace_write: FilePen, workspace_delete: Trash2, save_memory: Brain, design_website: Palette,
  bash: SquareTerminal, read_file: FileCode2, edit_file: FilePen, write_file: FilePlus2, list_files: FolderTree, glob: Search, grep: TextSearch, task: Bot, create_pull_request: GitPullRequest,
};

function GithubCard() {
  const github = useStore((s) => s.code.github);
  const setGithub = useStore((s) => s.setGithub);
  const toast = useStore((s) => s.toast);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { setGithub((await api<{ github: boolean }>("/api/settings/github", { method: "PUT", body: { token } })).github); setToken(""); toast("ok", "GitHub token saved."); }
    catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => { try { setGithub((await api<{ github: boolean }>("/api/settings/github", { method: "DELETE" })).github); toast("ok", "Token removed."); } catch (e) { toast("error", (e as Error).message); } };
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5"><Tile icon={GitBranch} /><h3 className="text-sm font-medium">GitHub</h3>{github ? <Badge tone="ok">Token saved</Badge> : <Badge>Optional</Badge>}</div>
      <p className="text-xs leading-relaxed text-muted">
        Lets code projects clone private repositories, push branches and open pull requests. Create a <a className="text-accent hover:underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">fine-grained token</a> with <b>Contents</b> and <b>Pull requests</b> read &amp; write on the repositories you want. It's stored encrypted and never enters the sandbox: Morphie adds it to GitHub requests on the way out.
      </p>
      <div className="flex gap-2">
        <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={github ? "Replace saved token" : "github_pat_… or ghp_…"} autoComplete="off" aria-label="GitHub token" className="font-mono" />
        <Button variant="primary" onClick={save} loading={busy} disabled={token.trim().length < 20}>Save</Button>
        {github && <Button variant="ghost" onClick={remove}>Remove</Button>}
      </div>
    </Card>
  );
}
/** A small tinted icon tile, the same one used across Settings. */
const Tile = ({ icon: Icon, danger }: { icon: LucideIcon; danger?: boolean }) => (
  <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset transition duration-300", danger ? "bg-err/10 text-err ring-err/25" : "bg-accent/12 text-accent ring-accent/25")}><Icon className="size-4" aria-hidden /></span>
);

/** Chime and desktop notification when a run finishes or needs you while you're in another tab (kept in this browser). */
function NotifySettings() {
  const [prefs, setPrefs] = useState(getNotifyPrefs);
  const [perm, setPerm] = useState(desktopPermission);
  const toast = useStore((s) => s.toast);
  const setDesktop = async (on: boolean) => {
    if (on) {
      const p = await askDesktopPermission();
      setPerm(p);
      if (p === "denied") toast("error", "Notifications are blocked for this site in your browser's settings.");
    }
    setPrefs(setNotifyPrefs({ desktop: on }));
  };
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-4">
        <div className="flex-1"><div className="text-sm font-medium">Notify me when I'm away</div><p className="mt-0.5 text-xs leading-relaxed text-muted">When a task finishes, pauses, or needs your approval or answers while Morphie is in a background tab. Saved in this browser.</p></div>
        <Switch checked={prefs.desktop} onChange={(v) => void setDesktop(v)} label="Desktop notifications" />
      </div>
      {prefs.desktop && perm !== "granted" && (
        <p className="text-xs text-warn">{perm === "unsupported" ? "This browser can't show notifications; the chime and the tab title still work." : perm === "denied" ? "Your browser blocks notifications for this site. Allow them in the site settings." : <>Your browser hasn't allowed notifications yet. <button className="underline underline-offset-2" onClick={() => void setDesktop(true)}>Allow</button></>}</p>
      )}
      <div className="flex items-start gap-4">
        <div className="flex-1"><div className="text-sm font-medium">Chime</div><p className="mt-0.5 text-xs leading-relaxed text-muted">A soft sound at the same moments.</p></div>
        <Switch checked={prefs.sound} onChange={(v) => setPrefs(setNotifyPrefs({ sound: v }))} label="Chime" />
      </div>
    </div>
  );
}

export function AgentSection() {
  const { settings, setSettings, server } = useStore();
  const [temp, setTemp] = useState(settings.temperature?.toString() ?? "");
  return (
    <div className="space-y-6">
      <Head title="Chat & agent">Defaults for how Morphie answers and how much freedom the agent has.</Head>
      <Card className="space-y-5">
        <div className="flex items-start gap-4"><div className="flex-1"><div className="text-sm font-medium">Long-term memory</div><p className="mt-0.5 text-xs leading-relaxed text-muted">Remember stable facts and preferences you share (never secrets) and recall them in later conversations. Review them in the Memory tab.</p></div><Switch checked={settings.memory} onChange={(v) => setSettings({ memory: v })} label="Long-term memory" /></div>
        <NotifySettings />
        <BudgetSlider />
        <HelperPicker />
        <Field label="Approvals" hint="What the agent must ask about first.">
          <div className="grid gap-2 sm:grid-cols-3">
            {([["ask", "Risky actions"], ["always", "Every tool"], ["never", "Nothing"]] as const).map(([v, l]) => (
              <button key={v} onClick={() => setSettings({ approval: v })} aria-pressed={settings.approval === v} className={cn("rounded-xl border px-3 py-2 text-sm transition duration-200 active:scale-[0.98]", settings.approval === v ? "border-accent/60 bg-accent/[0.08] font-medium text-fg shadow-[0_0_0_3px_rgb(var(--accent)/0.08)]" : "border-line text-muted hover:border-faint/60 hover:bg-fg/[0.03] hover:text-fg")}>{l}</button>
            ))}
          </div>
        </Field>
        <Field label="Temperature override" htmlFor="temp" hint="Leave blank to use each provider's default. Lower is more focused; higher is more creative.">
          <div className="flex gap-2"><Input id="temp" value={temp} onChange={(e) => setTemp(e.target.value)} inputMode="decimal" placeholder="default" className="max-w-[140px]" />
            <Button variant="secondary" onClick={() => { const n = Number(temp); setSettings({ temperature: temp.trim() === "" || !Number.isFinite(n) ? undefined : Math.min(2, Math.max(0, n)) }); }}>Apply</Button></div>
        </Field>
      </Card>
    </div>
  );
}

export function ToolsSection() {
  const { search, setSearch, tools, settings, setSettings, toast } = useStore();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { setSearch(await api<{ user: boolean; server: boolean }>("/api/settings/tavily", { method: "PUT", body: { key } })); setKey(""); toast("ok", "Web search key saved."); }
    catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => { try { setSearch(await api<{ user: boolean; server: boolean }>("/api/settings/tavily", { method: "DELETE" })); toast("ok", "Key removed."); } catch (e) { toast("error", (e as Error).message); } };
  return (
    <div className="space-y-6">
      <Head title="Tools">What Morphie can do beyond talking. The agent can use all of them; chat mode uses the read-only ones.</Head>
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-2.5"><Tile icon={Search} /><h3 className="text-sm font-medium">Web search</h3>{search.user ? <Badge tone="ok">Your key</Badge> : search.server ? <Badge tone="ok">Server key</Badge> : <Badge tone="warn">Not set up</Badge>}</div>
        <p className="text-xs leading-relaxed text-muted">Powered by <a className="text-accent hover:underline" href="https://tavily.com" target="_blank" rel="noopener noreferrer">Tavily</a> (free tier available). Without a key, the model will tell you search isn't available.</p>
        <div className="flex gap-2">
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={search.user ? "Replace saved key" : "tvly-…"} autoComplete="off" aria-label="Tavily API key" className="font-mono" />
          <Button variant="primary" onClick={save} loading={busy} disabled={key.trim().length < 8}>Save</Button>
          {search.user && <Button variant="ghost" onClick={remove}>Remove</Button>}
        </div>
      </Card>
      <GithubCard />
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-2.5"><Tile icon={ShieldCheck} /><h3 className="text-sm font-medium">Permission rules</h3></div>
        <RulesEditor compact />
      </Card>
      <Card>
        <h3 className="mb-3 text-sm font-medium">Available tools</h3>
        <ul className="divide-y divide-line">
          {tools.map((t) => (
            <li key={t.name} className="group flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset transition duration-300 group-hover:scale-105", settings.disabledTools.includes(t.name) ? "bg-fg/[0.04] text-faint ring-line" : "bg-accent/12 text-accent ring-accent/25")}>{(() => { const I = TOOL_ICONS[t.name] ?? Wrench; return <I className="size-4" aria-hidden />; })()}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">{t.label}<code className="font-mono text-[11px] font-normal text-faint">{t.name}</code>{t.risk === "confirm" && <Badge tone="warn">asks first</Badge>}{t.code ? <Badge tone="accent">code projects</Badge> : t.modes.length === 1 && <Badge>agent only</Badge>}</div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{t.description}</p>
              </div>
              <Switch checked={!settings.disabledTools.includes(t.name)} label={`Enable ${t.label}`} disabled={t.name === "update_plan"} onChange={(v) => setSettings({ disabledTools: v ? settings.disabledTools.filter((x) => x !== t.name) : [...settings.disabledTools, t.name] })} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function AppearanceSection() {
  const { theme, setTheme } = useStore();
  const opts: Array<{ v: ThemePref; label: string; icon: typeof Sun }> = [{ v: "system", label: "System", icon: Monitor }, { v: "light", label: "Paper", icon: Sun }, { v: "dark", label: "Ink", icon: Moon }];
  return (
    <div className="space-y-6">
      <Head title="Appearance">Two themes: crisp paper for daytime, deep ink for night. System follows your device.</Head>
      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
        {opts.map((o) => (
          <button key={o.v} role="radio" aria-checked={theme === o.v} onClick={() => setTheme(o.v)} className={cn("relative rounded-2xl border p-4 text-left transition duration-300 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99]", theme === o.v ? "border-accent/60 bg-accent/[0.05] shadow-glow" : "border-line bg-panel/60 hover:border-faint/60 hover:shadow-card")}>
            <div className="mb-3 flex h-20 overflow-hidden rounded-lg border border-line" aria-hidden>
              {(o.v === "system" ? ["light", "dark"] as const : [o.v] as const).map((v) => (
                <div key={v} className={cn("relative flex flex-1 overflow-hidden", v === "dark" ? "bg-[#09090e]" : "bg-[#f8f8fc]")}>
                  <span className={cn("absolute -left-4 -top-6 size-16 rounded-full blur-xl", v === "dark" ? "bg-[#a28bff]/50" : "bg-[#6346f0]/25")} />
                  <span className={cn("absolute -bottom-6 right-0 size-14 rounded-full blur-xl", v === "dark" ? "bg-[#22d3ee]/30" : "bg-[#db2777]/15")} />
                  <span className={cn("relative w-4 border-r", v === "dark" ? "border-white/10 bg-white/[0.03]" : "border-black/5 bg-white")}><span className="mx-auto mt-1.5 block size-2 rounded-[3px] bg-linear-to-br from-[#a28bff] to-[#f472b6]" /></span>
                  <span className="relative flex-1 p-2">
                    <span className={cn("block h-1.5 w-10 rounded-full", v === "dark" ? "bg-white/70" : "bg-black/70")} />
                    <span className={cn("mt-1.5 block h-1 w-14 rounded-full", v === "dark" ? "bg-white/25" : "bg-black/20")} />
                    <span className={cn("mt-2 block h-4 w-full rounded-md border", v === "dark" ? "border-[#a28bff]/40 bg-white/[0.04]" : "border-[#6346f0]/25 bg-white")} />
                  </span>
                </div>
              ))}
            </div>
            <span className="flex items-center gap-2 text-sm font-medium"><o.icon className="size-4 text-muted" aria-hidden /> {o.label}</span>
            {theme === o.v && <Check className="absolute right-3 top-3 size-4 text-accent" aria-hidden />}
          </button>
        ))}
      </div>
      <Card>
        <h3 className="mb-1 text-sm font-medium">Keyboard shortcuts</h3>
        <p className="mb-3 text-xs text-muted">Shortcuts without a modifier never fire while you type in a field; ⌘Z inside a text box undoes your typing, not the design.</p>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {([["Command palette", SHORTCUTS.palette], ["Send message", SHORTCUTS.send], ["New line", SHORTCUTS.newline], ["Close dialog", SHORTCUTS.close], ["Undo design change", SHORTCUTS.undo], ["Redo design change", SHORTCUTS.redo]] as Array<[string, Shortcut]>).map(([l, s]) => (
            <div key={l} className="flex items-center justify-between gap-3 rounded-lg bg-sunken px-3 py-2"><dt className="text-muted">{l}</dt><dd><KeyCombo shortcut={s} /></dd></div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

export function DataSection() {
  const { toast, version, server } = useStore();
  const [confirm, setConfirm] = useState(false);
  const [text, setText] = useState("");
  const wipe = async () => {
    try { await api("/api/data/wipe", { method: "POST", body: { confirm: true } }); toast("ok", "Everything was deleted."); setTimeout(() => location.reload(), 600); }
    catch (e) { toast("error", (e as Error).message); }
  };
  return (
    <div className="space-y-6">
      <Head title="Data & privacy">Morphie keeps everything in a local database next to the app. Nothing is sent anywhere except to the AI provider you choose.</Head>
      <Card className="space-y-3">
        <h3 className="flex items-center gap-2.5 text-sm font-medium"><Tile icon={Database} /> What's stored</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted">
          <li>Provider keys and custom header values: <strong className="font-medium text-fg">AES-256-GCM encrypted</strong>, never sent back to the browser.</li>
          <li>Conversations, memories, uploaded document text, designs and agent workspace files.</li>
          <li>Private network addresses (like <code className="font-mono text-xs">localhost</code>) for providers are {server.allowPrivateUrls ? "allowed on this server (local use)" : "blocked on this server"}.</li>
        </ul>
        <a href="/api/data/export" download><Button variant="secondary" className="mt-2"><Download className="size-4" aria-hidden /> Export my data (JSON)</Button></a>
        <p className="text-xs text-faint">Exports never include API keys or header values.</p>
      </Card>
      <Card className="space-y-3 ring-1 ring-err/30">
        <h3 className="flex items-center gap-2.5 text-sm font-medium text-err"><Tile icon={ShieldAlert} danger /> Delete everything</h3>
        <p className="text-sm leading-relaxed text-muted">Permanently removes your provider keys, conversations, memories, documents, designs and workspace files from this server.</p>
        <Button variant="danger" onClick={() => setConfirm(true)}><Trash2 className="size-4" aria-hidden /> Delete all my data</Button>
      </Card>
      <p className="text-center text-xs text-faint">Morphie {version}</p>
      <ConfirmDialog open={confirm} title="Delete all data?" confirm="Delete everything" onConfirm={wipe} onClose={() => { setConfirm(false); setText(""); }}
        body={<div className="space-y-3"><p>This can't be undone. Type <strong className="font-mono text-fg">DELETE</strong> to confirm.</p><Input value={text} onChange={(e) => setText(e.target.value)} aria-label="Type DELETE to confirm" placeholder="DELETE" /><p className={cn("text-xs", text === "DELETE" ? "text-ok" : "text-faint")}>{text === "DELETE" ? "Confirmed. Press Delete everything." : "The button works only after you type DELETE."}</p></div>} />
    </div>
  );
}
