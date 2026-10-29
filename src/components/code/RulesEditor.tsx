"use client";
import { BudgetSlider } from "../settings/BudgetControls";
import { Ban, Plus, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { useStore } from "@/lib/store";
import type { AgentSettings } from "@/lib/types";
import { Button, Input, cn } from "../ui";

/** Same grammar as src/server/code/permissions.ts (the server validates again). */
const RULE_RE = /^(Bash|Edit|Write|Read|WebFetch|WebSearch|PullRequest)(?:\((.{1,200})\))?$/;
export function ruleProblem(r: string): string | null {
  const m = RULE_RE.exec(r.trim());
  if (!m) return "Use Tool or Tool(pattern): Bash, Edit, Write, Read, WebFetch, WebSearch or PullRequest.";
  if (m[2] !== undefined && !m[2].trim()) return "The pattern in brackets is empty.";
  if (m[1] === "WebFetch" && m[2] && !/^domain:[a-z0-9.-]+$/i.test(m[2])) return "WebFetch takes domain:example.com.";
  if ((m[1] === "WebSearch" || m[1] === "PullRequest") && m[2]) return `${m[1]} doesn't take a pattern.`;
  return null;
}

const EXAMPLES = {
  allow: ["Bash(npm test *)", "Bash(npm run lint *)", "Bash(git status)", "Bash(git diff *)", "Edit(src/**)", "Read"],
  deny: ["Bash(rm *)", "Bash(git push *)", "Read(**/.env)", "Edit(.github/**)"],
};

const APPROVAL: Array<{ v: AgentSettings["approval"]; label: string; hint: string }> = [
  { v: "ask", label: "Ask for risky actions", hint: "Edits, commands, pull requests, saving memories." },
  { v: "always", label: "Ask before every tool", hint: "Maximum control; slower." },
  { v: "never", label: "Auto-approve everything", hint: "Fast. Deny rules and plan approval still apply." },
];

function RuleList({ kind }: { kind: "allow" | "deny" }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const list = settings.permissions[kind];
  const save = (next: string[]) => setSettings({ permissions: { ...settings.permissions, [kind]: next } });
  const add = (r: string) => {
    const rule = r.trim();
    const problem = ruleProblem(rule);
    if (problem) { setErr(problem); return; }
    if (!list.includes(rule)) save([...list, rule]);
    setDraft(""); setErr(null);
  };
  const Icon = kind === "allow" ? ShieldCheck : Ban;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold"><Icon className={cn("size-3.5", kind === "allow" ? "text-ok" : "text-err")} aria-hidden />{kind === "allow" ? "Allow without asking" : "Never allow"}</div>
      {list.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {list.map((r) => (
            <li key={r} className={cn("flex items-center gap-1 rounded-md border py-0.5 pl-2 pr-0.5 font-mono text-[11.5px]", kind === "allow" ? "border-ok/30 bg-ok/[0.06]" : "border-err/30 bg-err/[0.06]")}>
              {r}
              <button onClick={() => save(list.filter((x) => x !== r))} aria-label={`Remove ${r}`} className="grid size-5 pointer-coarse:size-9 place-items-center rounded text-muted hover:bg-fg/10 hover:text-fg"><X className="size-3" /></button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); add(draft); }}>
        <Input value={draft} onChange={(e) => { setDraft(e.target.value); setErr(null); }} placeholder={kind === "allow" ? "Bash(npm test *)" : "Bash(rm *)"} aria-label={kind === "allow" ? "New allow rule" : "New deny rule"} className="h-8! font-mono" spellCheck={false} />
        <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim()} aria-label="Add rule"><Plus className="size-3.5" aria-hidden /></Button>
      </form>
      {err && <p className="mt-1 text-[11px] text-err" role="alert">{err}</p>}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {EXAMPLES[kind].filter((x) => !list.includes(x)).slice(0, 4).map((x) => (
          <button key={x} onClick={() => add(x)} className="rounded-md border border-dashed border-line px-1.5 py-0.5 font-mono text-[10.5px] text-muted transition hover:border-accent/50 hover:text-fg">+ {x}</button>
        ))}
      </div>
    </div>
  );
}

/** Approvals, permission rules and the token budget: how much the agent may do on its own. */
export function RulesEditor({ compact }: { compact?: boolean }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  return (
    <div className="space-y-5">
      {!compact && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Approvals</h3>
          <div role="radiogroup" aria-label="Approval mode" className="space-y-1.5">
            {APPROVAL.map((a) => (
              <button key={a.v} role="radio" aria-checked={settings.approval === a.v} onClick={() => setSettings({ approval: a.v })} className={cn("group flex w-full items-start gap-2.5 rounded-xl border p-2.5 text-left transition duration-200 active:scale-[0.99]", settings.approval === a.v ? "border-accent/60 bg-accent/[0.08] shadow-[0_0_0_3px_rgb(var(--accent)/0.08)]" : "border-line hover:border-faint/60 hover:bg-fg/[0.03]")}>
                <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition", settings.approval === a.v ? "border-accent bg-accent/15" : "border-faint group-hover:border-muted")}>{settings.approval === a.v && <span className="check-pop size-2 rounded-full bg-accent shadow-[0_0_8px_rgb(var(--accent))]" />}</span>
                <span><span className="block text-[13px] font-medium">{a.label}</span><span className="block text-xs text-muted">{a.hint}</span></span>
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="space-y-4">
        {!compact && <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Permission rules</h3>}
        <p className="text-xs leading-relaxed text-muted">
          Rules for code projects, like Claude Code's: <code className="font-mono">Bash(npm test *)</code> allows that command with any arguments, <code className="font-mono">Edit(src/**)</code> allows edits under src. Deny rules always win, and a project's own <code className="font-mono">.morphie/settings.json</code> can add deny rules (never allow rules).
        </p>
        <RuleList kind="allow" />
        <RuleList kind="deny" />
      </section>
      {!compact && (
        <section>
          <BudgetSlider />
        </section>
      )}
    </div>
  );
}
