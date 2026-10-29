"use client";
import { Bot, FileDiff, ListChecks, ShieldCheck, Slash, SquareTerminal } from "lucide-react";
import { BASE_COMMANDS, useStore } from "@/lib/store";
import type { ProjectView } from "@/lib/types";
import { Badge, Dialog } from "../ui";

const FEATURES = [
  { icon: FileDiff, title: "Diffs you control", text: "Every edit shows as a diff. Approve it before it happens, then accept or reject files in the Changes panel." },
  { icon: SquareTerminal, title: "A real terminal", text: "The agent runs builds and tests in an isolated sandbox. You can run commands there too." },
  { icon: ListChecks, title: "Plan mode", text: "Turn it on to get a researched plan to approve before anything changes." },
  { icon: Bot, title: "Sub-agents", text: "For big questions the agent sends out parallel researchers with read-only tools." },
  { icon: ShieldCheck, title: "Permission rules", text: "Allow or block commands and paths, e.g. Bash(npm test *) or Edit(src/**)." },
];

export function HelpDialog({ project }: { project: ProjectView | null }) {
  const open = useStore((s) => s.helpOpen);
  const setOpen = useStore((s) => s.setHelpOpen);
  const commands = useStore((s) => (project ? s.projectCommands[project.id] : undefined)) ?? BASE_COMMANDS;
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="The coding agent" description={project ? `Working in ${project.name}.` : "Pick a project in the header to work on code."} width="max-w-2xl">
      <div className="grid gap-3 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="flex gap-3 rounded-xl border border-line bg-panel/50 p-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/12 text-accent ring-1 ring-inset ring-accent/25"><f.icon className="size-4" aria-hidden /></span>
            <div><div className="text-[13px] font-medium">{f.title}</div><p className="mt-0.5 text-xs leading-relaxed text-muted">{f.text}</p></div>
          </div>
        ))}
      </div>
      <h3 className="mb-2 mt-6 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint"><Slash className="size-3" aria-hidden /> Commands</h3>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {commands.map((c) => (
          <li key={c.name} className="flex items-baseline gap-3 px-3 py-2">
            <code className="shrink-0 font-mono text-[13px] text-accent">/{c.name}</code>
            {c.argHint && <code className="shrink-0 font-mono text-[11px] text-faint">{c.argHint}</code>}
            <span className="min-w-0 flex-1 text-xs text-muted">{c.description}</span>
            {c.source === "project" && <Badge>project</Badge>}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-muted">Add your own: put Markdown files in <code className="font-mono">.morphie/commands/</code> (or <code className="font-mono">.claude/commands/</code>) in the repository. <code className="font-mono">$ARGUMENTS</code> is replaced with what you type after the command. A <code className="font-mono">MORPHIE.md</code> (or CLAUDE.md / AGENTS.md) at the root is read at the start of every task.</p>
    </Dialog>
  );
}
