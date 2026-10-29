"use client";
import { ArrowUp, Map as MapIcon, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BASE_COMMANDS, DRAFT_MAX, useStore } from "@/lib/store";
import type { Mode } from "@/lib/types";
import { SHORTCUTS } from "@/lib/shortcuts";
import { Magnetic } from "../fx";
import { KeyCombo, cn } from "../ui";
import { ProviderChip } from "./ProviderChip";

const MAX = DRAFT_MAX;

export function Composer({ mode, running, onStop, focusKey, projectId = null }: { mode: Mode; running: boolean; onStop: () => void; focusKey: string; projectId?: string | null }) {
  const text = useStore((s) => s.drafts[mode]);
  const setDraft = useStore((s) => s.setDraft);
  const sendDraft = useStore((s) => s.sendDraft);
  const planMode = useStore((s) => s.planMode);
  const setPlanMode = useStore((s) => s.setPlanMode);
  const loadCommands = useStore((s) => s.loadCommands);
  const cached = useStore((s) => (projectId ? s.projectCommands[projectId] : undefined));
  const ref = useRef<HTMLTextAreaElement>(null);
  const agent = mode === "agent";

  // Slash commands: a menu while the message is just "/word".
  useEffect(() => { if (agent && projectId && !cached) void loadCommands(projectId); }, [agent, projectId, cached, loadCommands]);
  const skills = useStore((s) => s.skills);
  const loadSkills = useStore((s) => s.loadSkills);
  useEffect(() => { if (agent && skills === null) void loadSkills(); }, [agent, skills, loadSkills]);
  // Skills are commands too: /name loads that skill in full for this message.
  const commands = useMemo(() => {
    if (!agent) return [];
    const base = cached ?? BASE_COMMANDS;
    const taken = new Set(base.map((c) => c.name));
    const fromSkills = (skills ?? []).filter((s) => s.enabled && s.scope !== "design" && !taken.has(s.name))
      .map((s) => ({ name: s.name, description: s.description, source: "skill" as const, argHint: "[task]" }));
    return [...base, ...fromSkills];
  }, [agent, cached, skills]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const query = agent && /^\/[\w-]*$/.test(text) ? text.slice(1).toLowerCase() : null;
  const matches = useMemo(() => {
    if (query === null) return [];
    const starts = commands.filter((c) => c.name.startsWith(query));
    return [...starts, ...commands.filter((c) => !starts.includes(c) && c.name.includes(query))].slice(0, 12);
  }, [query, commands]);
  const menuOpen = matches.length > 0 && dismissed !== text;
  useEffect(() => { setMenuIndex(0); }, [query]);
  const choose = (i: number, run: boolean) => {
    const c = matches[i];
    if (!c) return;
    if (run && !c.argHint) { setDraft(mode, `/${c.name}`); queueMicrotask(() => sendDraft(mode, ref.current)); return; }
    setDraft(mode, `/${c.name} `);
    ref.current?.focus();
  };

  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [focusKey, running]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(220, el.scrollHeight) + "px";
  }, [text]);

  // Logged out, this opens the login popup and leaves the draft exactly where it is.
  const submit = (trigger: HTMLElement) => {
    if (running) return;
    sendDraft(mode, trigger);
  };
  const near = text.length > MAX * 0.8;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4 pt-2">
      {/* While Morphie works a light runs around the box (border-beam); focused, it glows. */}
      <div className={cn("glass relative rounded-3xl border border-line shadow-card transition duration-300 focus-within:border-accent/50 focus-within:shadow-glow", running && "border-beam", planMode && agent && "border-accent/40")}>
        {menuOpen && (
          <ul id="slash-menu" role="listbox" aria-label="Commands" className="pop absolute bottom-full left-0 z-30 mb-2 max-h-80 w-full max-w-md origin-bottom-left overflow-auto rounded-xl border border-line bg-panel/95 p-1 shadow-pop backdrop-blur-xl">
            {matches.map((c, i) => (
              <li key={c.name} id={`slash-${c.name}`} role="option" aria-selected={i === menuIndex}
                onMouseDown={(e) => { e.preventDefault(); choose(i, true); }} onMouseEnter={() => setMenuIndex(i)}
                className={cn("flex cursor-pointer items-baseline gap-2.5 rounded-lg px-2.5 py-1.5", i === menuIndex && "bg-accent/10")}>
                <code className="shrink-0 font-mono text-[13px] text-accent">/{c.name}</code>
                {c.argHint && <code className="shrink-0 font-mono text-[11px] text-faint">{c.argHint}</code>}
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{c.description}</span>
                {c.source === "project" && <span className="shrink-0 rounded bg-fg/[0.06] px-1 text-[10px] text-faint">project</span>}
                {c.source === "skill" && <span className="shrink-0 rounded bg-accent/10 px-1 text-[10px] text-accent">skill</span>}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref} value={text} rows={1}
          onChange={(e) => setDraft(mode, e.target.value)}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === "ArrowDown") { e.preventDefault(); setMenuIndex((i) => (i + 1) % matches.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setMenuIndex((i) => (i - 1 + matches.length) % matches.length); return; }
              if (e.key === "Tab") { e.preventDefault(); choose(menuIndex, false); return; }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); choose(menuIndex, true); return; }
              if (e.key === "Escape") { e.preventDefault(); setDismissed(text); return; }
            }
            // Shift+Tab toggles plan mode, as in Claude Code.
            if (agent && e.key === "Tab" && e.shiftKey) { e.preventDefault(); setPlanMode(!planMode); return; }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(e.currentTarget); }
          }}
          role={agent ? "combobox" : undefined} aria-expanded={agent ? menuOpen : undefined} aria-controls={agent ? "slash-menu" : undefined} aria-autocomplete={agent ? "list" : undefined}
          aria-activedescendant={menuOpen ? `slash-${matches[menuIndex]?.name}` : undefined}
          placeholder={mode === "agent" ? (planMode ? "Describe what to plan… (read-only until you approve)" : projectId ? "Ask for a change, or type / for commands…" : "Give the agent a task…") : "Ask anything…"}
          aria-label={mode === "agent" ? "Task for the agent" : "Message"}
          className="block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-relaxed outline-hidden placeholder:text-faint"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
          <ProviderChip disabled={running} />
          {agent && (
            <button type="button" onClick={() => setPlanMode(!planMode)} aria-pressed={planMode} title="Plan mode (Shift+Tab): research and propose a plan before changing anything"
              className={cn("flex items-center gap-1.5 rounded-lg border px-2 py-1 pointer-coarse:min-h-11 text-xs transition active:scale-[0.97]", planMode ? "border-accent/50 bg-accent/12 font-medium text-accent shadow-[0_0_14px_-4px_rgb(var(--accent)/0.7)]" : "border-transparent text-muted hover:bg-fg/[0.06] hover:text-fg")}>
              <MapIcon className="size-3.5" aria-hidden /> Plan{planMode ? " mode" : ""}
            </button>
          )}
          <div className="ml-auto flex items-center gap-3">
            {near && <span className={cn("font-mono text-[11px] tabular-nums", text.length > MAX ? "text-err" : "text-muted")}>{text.length.toLocaleString()}/{MAX.toLocaleString()}</span>}
            <span className="hidden items-center gap-1 text-[11px] text-faint sm:flex"><KeyCombo shortcut={SHORTCUTS.send} /> send · <KeyCombo shortcut={SHORTCUTS.newline} /> new line</span>
            {running ? (
              <Magnetic onClick={onStop} aria-label="Stop" className="grid size-10 pointer-coarse:size-11 place-items-center rounded-2xl bg-fg text-bg transition-opacity hover:opacity-90"><Square className="size-3.5 fill-current" /></Magnetic>
            ) : (
              <Magnetic onClick={(e) => submit(e.currentTarget)} disabled={!text.trim() || text.length > MAX} aria-label="Send" className="btn-glow grid size-10 pointer-coarse:size-11 place-items-center rounded-2xl text-accent-fg disabled:opacity-30 disabled:saturate-50"><ArrowUp className="size-[18px]" /></Magnetic>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
