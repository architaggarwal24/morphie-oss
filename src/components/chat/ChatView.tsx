"use client";
import { ArrowDown, Bot, Bug, Calculator, Clock, FileText, FlaskConical, Globe, ListChecks, Mail, Map as MapIcon, Menu, MessagesSquare, PanelRight, ScrollText, Sparkles, WandSparkles, type LucideIcon } from "lucide-react";
import { ProjectPicker } from "../code/ProjectPicker";
import { HelpDialog } from "./HelpDialog";
import { api } from "@/lib/api";
import { SkillEditorDialog } from "../settings/SkillsSection";
import { BlurIn, TiltButton } from "../fx";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { prefersReducedMotion } from "@/lib/viewTransition";
import type { Mode } from "@/lib/types";
import { Badge, Button, IconButton, cn, useDelayedFlag } from "../ui";
import { AgentInspector } from "./AgentInspector";
import { Composer } from "./Composer";
import { AssistantMessage, HistorySkeleton, LiveMessage, UserMessage } from "./Message";
import { RewindDialog } from "./RewindDialog";

const ICONS: Record<string, LucideIcon> = { "Explain something": Sparkles, "Do some maths": Calculator, "Draft an email": Mail, "Check the time": Clock, "Research & report": FileText, "Read a page": Globe, "Plan & write": ListChecks, "Design a site": WandSparkles, "Map the codebase": MapIcon, "Write MORPHIE.md": ScrollText, "Run the tests": FlaskConical, "Hunt a bug": Bug };
const CODE_SUGGESTIONS: Array<{ title: string; prompt: string }> = [
  { title: "Map the codebase", prompt: "Give me a tour of this codebase: what it does, how it's structured, and where the important logic lives. Use sub-agents to explore in parallel." },
  { title: "Write MORPHIE.md", prompt: "/init" },
  { title: "Run the tests", prompt: "/test" },
  { title: "Hunt a bug", prompt: "Look for likely bugs or risky code in this project (error handling, edge cases, security). List the top issues with file:line, then wait for me before fixing." },
];
const SUGGESTIONS: Record<Mode, Array<{ title: string; prompt: string }>> = {
  chat: [
    { title: "Explain something", prompt: "Explain how a transformer language model works, then ask me three questions to check my understanding." },
    { title: "Do some maths", prompt: "What is 18% of 74,500, plus 240, divided by 7?" },
    { title: "Draft an email", prompt: "Draft a polite email declining a meeting invitation, offering two alternative times next week." },
    { title: "Check the time", prompt: "What time is it in Tokyo, London and New York right now?" },
  ],
  agent: [
    { title: "Research & report", prompt: "Research the trade-offs between SQLite and Postgres for a small self-hosted app, then save a one-page comparison to reports/sqlite-vs-postgres.md." },
    { title: "Read a page", prompt: "Read https://example.com and summarise what it says in three bullet points." },
    { title: "Plan & write", prompt: "Plan a four-week TypeScript study schedule and save it as a Markdown checklist in study/plan.md." },
    { title: "Design a site", prompt: "Design a landing page for a small specialty coffee roaster, then tell me which sections you chose and why." },
  ],
};

export function ChatView({ mode }: { mode: Mode }) {
  const convId = useStore((s) => s.activeConv[mode]);
  const allMessages = useStore((s) => (convId ? s.messages[convId] : undefined));
  const run = useStore((s) => s.run);
  const title = useStore((s) => s.conversations.find((c) => c.id === convId)?.title);
  const send = useStore((s) => s.send);
  const continueRun = useStore((s) => s.continueRun);
  const stop = useStore((s) => s.stop);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const toggleInspector = useStore((s) => s.toggleInspector);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const hasProvider = useStore((s) => !!s.activeId);
  const loggedIn = useStore((s) => !!s.session);
  const setDraft = useStore((s) => s.setDraft);
  const openLogin = useStore((s) => s.openLogin);
  const historyFailed = useStore((s) => (convId ? !!s.historyErrors[convId] : false));
  const loadMessages = useStore((s) => s.loadMessages);
  const conv = useStore((s) => (convId ? s.conversations.find((c) => c.id === convId) : undefined));
  const projects = useStore((s) => s.projects);
  const selectedProject = useStore((s) => s.selectedProject);
  // A task that exists keeps the project it started in; a new one uses the picker's choice.
  const project = mode !== "agent" ? null : convId ? (conv?.projectId ? projects.find((p) => p.id === conv.projectId) ?? null : null) : projects.find((p) => p.id === selectedProject) ?? null;

  const live = !!run && run.mode === mode && run.convId === convId;
  const running = !!run && (run.status === "connecting" || run.status === "running" || run.status === "waiting");
  // Another conversation's run keeps going on the server; this one is free.
  const busyHere = running && live;

  const messages = useMemo(() => {
    const list = allMessages ?? [];
    return live && run?.truncateFrom ? list.filter((m) => m.id < run.truncateFrom!) : list;
  }, [allMessages, live, run?.truncateFrom]);

  const scroller = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const onScroll = () => { const el = scroller.current; if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 140); };
  // Follows new output, but leaves the empty-state hero alone (on a phone it is taller than the screen).
  useEffect(() => { if (stick && !empty && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
  useEffect(() => { setStick(true); }, [convId]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const [rewindTarget, setRewindTarget] = useState<{ id: number; content: string; checkpoint: boolean } | null>(null);
  /** The files' checkpoint for a message lives on the reply it started. */
  const checkpointAfter = (i: number) => { for (let j = i + 1; j < messages.length && messages[j].role !== "user"; j++) if (messages[j].meta?.checkpoint) return true; return false; };
  // "Make a skill": the helper model drafts a SKILL.md from this conversation, you review it in the editor.
  const [drafting, setDrafting] = useState(false);
  const [skillDraft, setSkillDraft] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);
  const makeSkill = async () => {
    if (!convId) return;
    setDrafting(true);
    try { setSkillDraft((await api<{ markdown: string }>("/api/skills/draft", { method: "POST", body: { conversationId: convId } })).markdown); }
    catch (e) { toast("error", (e as Error).message); } finally { setDrafting(false); }
  };
  const regenerate = () => {
    const idx = messages.findIndex((m) => m === lastAssistant);
    const user = messages.slice(0, idx).reverse().find((m) => m.role === "user");
    if (user) void send(user.content, { truncateFrom: user.id });
  };
  // An opened conversation whose history hasn't arrived yet is loading, not empty: no "start something" hero for it.
  const loadingHistory = !!convId && allMessages === undefined && !live && !historyFailed;
  const slowHistory = useDelayedFlag(loadingHistory);
  const empty = messages.length === 0 && !live && !loadingHistory && !historyFailed;
  const Icon = mode === "agent" ? Bot : MessagesSquare;

  return (
    <div className="flex h-full min-w-0 flex-1">
      <section className="relative flex h-full min-w-0 flex-1 flex-col" aria-label={mode === "agent" ? "Agent" : "Chat"}>
        <header className="glass z-10 flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 md:px-5">
          <IconButton label="Open conversations" className="md:hidden" onClick={() => toggleSidebar(true)}><Menu className="size-[18px]" /></IconButton>
          <Icon className="hidden size-4 text-muted sm:block" aria-hidden />
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title ?? (mode === "agent" ? "New task" : "New chat")}</h1>
          {convId && messages.length > 1 && <IconButton label={drafting ? "Drafting a skill…" : "Make a skill from this conversation"} disabled={drafting || busyHere} onClick={makeSkill}><WandSparkles className={cn("size-[18px]", drafting && "animate-pulse-dot")} /></IconButton>}
          {mode === "agent" && <ProjectPicker lockedTo={convId ? project : undefined} disabled={busyHere} />}
          {mode === "agent" && !project && <Badge tone="accent" className="max-lg:hidden">Autonomous</Badge>}
          {mode === "agent" && <IconButton label={inspectorOpen ? (project ? "Hide project panel" : "Hide task panel") : project ? "Show project panel" : "Show task panel"} active={inspectorOpen} onClick={() => toggleInspector()}><PanelRight className="size-[18px]" /></IconButton>}
        </header>

        <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-7 px-4 py-6">
            {empty && (
              <div className="pt-[6vh]">
                <h2 className="font-display text-[clamp(2.2rem,5.5vw,3.4rem)] font-semibold leading-[1.02] tracking-[-0.035em]">
                  <BlurIn key={project?.id ?? "none"} lines={project ? ["What shall we", `build in ${project.name.length > 18 ? project.name.slice(0, 17) + "…" : project.name}?`] : mode === "agent" ? ["Hand it a task.", "Watch it work."] : ["What shall we", "think through?"]} lineClassName={(i) => (i === 1 ? "text-gradient pb-1" : undefined)} />
                </h2>
                <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">
                  {project
                    ? "It reads and searches the code, edits files, runs commands and tests in an isolated sandbox, and shows every change as a diff you can accept or reject. Type / for commands."
                    : mode === "agent"
                    ? "The agent plans, uses tools, checks its own results and asks before doing anything that changes your files. Pick a project to work on code."
                    : "Fast answers with optional tools: a calculator, the clock, web search and your documents."}
                </p>
                <div className="mt-8 grid gap-3 sm:grid-cols-2" style={{ perspective: 900 }}>
                  {(project ? CODE_SUGGESTIONS : SUGGESTIONS[mode]).map((s, i) => {
                    const Icon = ICONS[s.title] ?? Sparkles;
                    return (
                      <TiltButton key={s.title} disabled={(loggedIn && !hasProvider) || busyHere}
                        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 260, damping: 24, delay: 0.15 + i * 0.06 }}
                        // A visitor can't send yet: the prompt goes into the composer and the login popup opens, so after logging in it is waiting there.
                        onClick={(e) => { if (loggedIn) void send(s.prompt); else { setDraft(mode, s.prompt); openLogin({ tab: "chat", trigger: e.currentTarget }); } }}
                        className="group rounded-2xl border border-line bg-panel/70 p-4 text-left backdrop-blur transition-colors hover:border-accent/40 disabled:opacity-50">
                        <div className="flex items-center gap-2.5 text-sm font-semibold">
                          <span className="grid size-8 place-items-center rounded-xl bg-accent/12 text-accent ring-1 ring-accent/20 transition group-hover:scale-110 group-hover:bg-accent group-hover:text-accent-fg"><Icon className="size-4" aria-hidden /></span>
                          {s.title}
                        </div>
                        <div className="mt-2 line-clamp-2 text-[13px] leading-snug text-muted">{s.prompt}</div>
                      </TiltButton>
                    );
                  })}
                </div>
              </div>
            )}

            {loadingHistory && <div aria-busy="true" aria-label="Loading conversation" className="space-y-7">{slowHistory && <HistorySkeleton />}</div>}
            {historyFailed && !live && (
              <div className="pt-[6vh] text-center" role="alert">
                <p className="text-sm text-muted">This conversation couldn't be loaded.</p>
                <Button size="sm" variant="secondary" className="mt-3" onClick={() => convId && void loadMessages(convId)}>Try again</Button>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === "user" ? (
                <UserMessage key={m.id} m={m} canEdit={!busyHere} onEdit={(id, text) => send(text, { truncateFrom: id })}
                  onRewind={mode === "agent" ? () => setRewindTarget({ id: m.id, content: m.content, checkpoint: checkpointAfter(i) }) : undefined} />
              ) : (
                <AssistantMessage key={m.id} m={m} isLast={m === lastAssistant && i === messages.length - 1 && !live} canRegenerate={m === lastAssistant && !busyHere} onRegenerate={regenerate}
                  onContinue={convId ? () => void continueRun(convId) : undefined} canContinue={!busyHere} />
              ),
            )}

            {live && run && (
              <>
                {!run.continued && <div className="animate-rise flex justify-end"><div className="max-w-[85%] rounded-2xl rounded-br-md border border-accent/25 bg-linear-to-br/oklch from-accent/15 to-accent-3/10 px-4 py-3"><p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{run.userMessage}</p></div></div>}
                <LiveMessage run={run} />
              </>
            )}
          </div>
        </div>

        {(
          <button hidden={stick} inert={stick} onClick={() => { setStick(true); scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" }); }} className="glass absolute bottom-32 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 pointer-coarse:min-h-11 text-xs font-medium shadow-pop fade" aria-label="Jump to latest">
            <ArrowDown className="size-3.5" aria-hidden /> Latest
          </button>
        )}
        <Composer mode={mode} running={busyHere} onStop={stop} focusKey={`${mode}:${convId ?? "new"}`} projectId={project?.id ?? null} />
      </section>
      {mode === "agent" && <AgentInspector convId={convId} messages={messages} project={project} />}
      {mode === "agent" && <HelpDialog project={project} />}
      <RewindDialog target={rewindTarget} onClose={() => setRewindTarget(null)} convId={convId} mode={mode} hasCheckpoint={!!rewindTarget?.checkpoint} />
      <SkillEditorDialog open={skillDraft !== null} onClose={() => setSkillDraft(null)} initial={skillDraft ?? undefined} />
    </div>
  );
}
