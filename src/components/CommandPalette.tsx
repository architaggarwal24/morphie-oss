"use client";
import { ArrowUp, Bot, Brain, Library, LogIn, MessagesSquare, Monitor, Moon, Plus, Redo2, Search, Settings, Sun, Undo2, WandSparkles, type LucideIcon, CornerDownLeft } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDesign } from "@/lib/designStore";
import { PUBLIC_TAB, useStore, type Tab } from "@/lib/store";
import { SHORTCUTS, type Shortcut } from "@/lib/shortcuts";
import type { ProfileView } from "@/lib/types";
import { useSettingsSections } from "./settings/SettingsView";
import { Dialog, KeyCombo, Kbd, cn } from "./ui";

/** `hint` is extra searchable text shown on the right (a model name); `shortcut` draws the key combo instead. */
interface Cmd { id: string; label: string; hint?: string; shortcut?: Shortcut; icon: LucideIcon; run: () => void }

const RECENT_CONVERSATIONS = 30;

export function CommandPalette() {
  const { paletteOpen, setPalette, setTab, newConversation, profiles, activeId, activateProvider, setTheme, setSettingsSection, openLogin, sendDraft } = useStore();
  const loggedIn = useStore((s) => !!s.session);
  const sections = useSettingsSections();
  const mode = useStore((s) => (s.tab === "agent" ? "agent" : "chat"));
  const hasDraft = useStore((s) => s.drafts[s.tab === "agent" ? "agent" : "chat"].trim().length > 0);
  const openDesign = useDesign((d) => d.open);
  const designAct = useDesign((d) => d.act);
  const designHist = useDesign((d) => (d.state && !d.busy ? d.state.history : null));
  const onDesign = useStore((s) => s.tab === "design");
  const conversations = useStore((s) => s.conversations);
  const openConversation = useStore((s) => s.openConversation);
  const listId = useId();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  // What had focus before the palette opened. If a command ends in the login popup, focus returns there when it closes.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { if (paletteOpen) opener.current = document.activeElement as HTMLElement | null; }, [paletteOpen]);

  const cmds: Cmd[] = useMemo(() => {
    // Logged out, only Chat is open: every command that goes anywhere else opens the login popup (and resumes there after login).
    const needsLogin = (tab: Tab | null, run: () => void) => (loggedIn || tab === PUBLIC_TAB ? run : () => openLogin({ tab, trigger: opener.current }));
    const go = (tab: Tab) => needsLogin(tab, () => setTab(tab));
    const base: Cmd[] = [
      ...(hasDraft ? [{ id: "send", label: "Send message", shortcut: SHORTCUTS.send, icon: ArrowUp, run: () => sendDraft(mode, opener.current) }] : []),
      ...(onDesign && designHist?.canUndo ? [{ id: "design-undo", label: "Undo design change", shortcut: SHORTCUTS.undo, icon: Undo2, run: () => void designAct("undo") }] : []),
      ...(onDesign && designHist?.canRedo ? [{ id: "design-redo", label: "Redo design change", shortcut: SHORTCUTS.redo, icon: Redo2, run: () => void designAct("redo") }] : []),
      { id: "new-chat", label: "New chat", icon: Plus, run: needsLogin("chat", () => { setTab("chat"); newConversation("chat"); }) },
      { id: "new-task", label: "New agent task", icon: Plus, run: needsLogin("agent", () => { setTab("agent"); newConversation("agent"); }) },
      { id: "new-design", label: "New design", icon: Plus, run: needsLogin("design", () => { setTab("design"); void openDesign(null); }) },
      { id: "chat", label: "Go to Chat", icon: MessagesSquare, run: go("chat") },
      { id: "agent", label: "Go to Agent", icon: Bot, run: go("agent") },
      { id: "design", label: "Go to Design", icon: WandSparkles, run: go("design") },
      { id: "documents", label: "Go to Documents", icon: Library, run: go("documents") },
      { id: "memory", label: "Go to Memory", icon: Brain, run: go("memory") },
      ...(loggedIn
        ? [{ id: "settings", label: "Open Settings", icon: Settings, run: go("settings") }]
        : [{ id: "login", label: "Log in or sign up", icon: LogIn, run: () => openLogin({ trigger: opener.current }) }]),
      { id: "add-provider", label: "Add a provider", hint: "Settings", icon: Plus, run: needsLogin("settings", () => { setTab("settings"); setSettingsSection("providers"); }) },
      // Every Settings page is a destination of its own.
      ...sections.map((sec) => ({ id: `settings-${sec.id}`, label: `Settings: ${sec.label}`, icon: sec.icon, run: needsLogin("settings", () => { setTab("settings"); setSettingsSection(sec.id); }) })),
      { id: "theme-light", label: "Light theme", icon: Sun, run: () => setTheme("light") },
      { id: "theme-dark", label: "Dark theme", icon: Moon, run: () => setTheme("dark") },
      { id: "theme-system", label: "System theme", icon: Monitor, run: () => setTheme("system") },
    ];
    // Recent chats and tasks, searchable by title (a visitor has none).
    const hidden = useStore.getState().hidden;
    const recent: Cmd[] = conversations.filter((c) => !hidden[`conv:${c.id}`]).slice(0, RECENT_CONVERSATIONS).map((c) => ({
      id: `conv-${c.id}`, label: c.title, hint: c.mode === "agent" ? "Task" : "Chat", icon: c.mode === "agent" ? Bot : MessagesSquare,
      run: () => { setTab(c.mode); void openConversation(c.mode, c.id); },
    }));
    const switches: Cmd[] = profiles.filter((p) => p.id !== activeId && !p.hosted?.locked && !p.paused && p.hosted?.available !== false).map((p: ProfileView) => ({
      id: `use-${p.id}`, label: `Use ${p.label}`, hint: p.model, icon: Bot,
      run: () => void activateProvider(p.id),
    }));
    return [...switches, ...base, ...recent];
  }, [profiles, activeId, sections, loggedIn, hasDraft, mode, onDesign, designHist, designAct, conversations, openConversation, setTab, newConversation, openDesign, activateProvider, setTheme, setSettingsSection, openLogin, sendDraft]);

  const shown = cmds.filter((c) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  useEffect(() => { setSel(0); }, [q, paletteOpen]);
  useEffect(() => { if (!paletteOpen) setQ(""); }, [paletteOpen]);
  useEffect(() => { list.current?.children[sel]?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const exec = (c?: Cmd) => { if (!c) return; setPalette(false); c.run(); };

  return (
    <Dialog open={paletteOpen} onClose={() => setPalette(false)} title="Command palette" width="max-w-xl" bare>
      <div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages, chats and actions…" aria-label="Search commands"
            role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={shown[sel] ? `${listId}-${sel}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(shown.length - 1, s + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); exec(shown[sel]); }
            }}
            className="h-12 w-full rounded-xl border border-transparent bg-transparent pl-10 pr-3 text-[16px] outline-hidden transition placeholder:text-faint focus:bg-fg/[0.03]"
          />
        </div>
        <ul ref={list} id={listId} role="listbox" aria-label="Commands" className="mt-1 max-h-80 overflow-y-auto border-t border-line pt-2">
          {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">No matching commands.</li>}
          {shown.map((c, i) => (
            <li key={c.id} id={`${listId}-${i}`} role="option" aria-selected={i === sel}>
              {/* Arrow keys move the selection from the search box; the buttons are for the mouse, so they stay out of the Tab order. */}
              <button tabIndex={-1} onMouseEnter={() => setSel(i)} onClick={() => exec(c)} className={cn("relative z-0 flex w-full pointer-coarse:min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors", i === sel ? "text-fg" : "text-muted")}>
                {/* The highlight glides to the selected row on a spring (arrow keys or mouse). */}
                {i === sel && <motion.span layoutId="palette-sel" transition={{ type: "spring", stiffness: 600, damping: 42 }} className="absolute inset-0 -z-10 rounded-xl bg-accent/12 ring-1 ring-accent/25" />}
                <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg ring-1 ring-inset transition", i === sel ? "bg-accent/20 text-accent ring-accent/35" : "bg-fg/[0.04] text-faint ring-line")}><c.icon className="size-3.5" aria-hidden /></span><span className="min-w-0 flex-1 truncate">{c.label}</span>
                {i === sel && <CornerDownLeft className="size-3.5 shrink-0 text-accent" aria-hidden />}
                {c.shortcut ? <KeyCombo shortcut={c.shortcut} /> : c.hint && <span className="shrink-0 font-mono text-[11px] text-faint">{c.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
        <p className="-mx-3 -mb-3 mt-2 flex flex-wrap items-center gap-2 border-t border-line bg-sunken/50 px-4 py-2.5 text-[11px] text-faint"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate <Kbd>Enter</Kbd> run <Kbd>Esc</Kbd> close <span className="ml-auto flex items-center gap-1"><KeyCombo shortcut={SHORTCUTS.palette} /> open from anywhere</span></p>
      </div>
    </Dialog>
  );
}
