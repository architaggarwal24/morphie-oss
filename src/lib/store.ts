"use client";
import { create } from "zustand";
import { api, ApiFailure, isPlanFailure, newIdempotencyKey, setSignedOutHandler, streamSSE } from "./api";
import { applyEvent, newRun, type RunState, type TerminalEntry } from "./runState";
import { withViewTransition } from "./viewTransition";
import { notifyRun } from "./notify";
import type { PlanStatus, RunnerView, SkillLibraryEntry, SkillSummary } from "./types";
import type { AgentEvent, AgentSettings, ConversationView, DocumentView, LoginMethods, MemoryView, MessageView, Mode, ProfileView, ProjectView, ProviderSpecView, SandboxKind, SessionView, SlashCommand, ToolInfo } from "./types";
import { DEFAULT_AGENT_SETTINGS } from "./types";

export type Tab = "chat" | "agent" | "design" | "documents" | "memory" | "settings";
export const TABS: readonly Tab[] = ["chat", "agent", "design", "documents", "memory", "settings"];
export const TAB_LABELS: Record<Tab, string> = { chat: "Chat", agent: "Agent", design: "Design", documents: "Documents", memory: "Memory", settings: "Settings" };
/** A visitor who has not logged in can use exactly one tab. */
export const PUBLIC_TAB: Tab = "chat";

/** sessionStorage key for a Google/GitHub round trip. Only { tab, draft } is ever kept there, and it is removed as soon as it is read. */
export const LOGIN_REDIRECT_KEY = "morphie.login";
export const DRAFT_MAX = 20_000;

/** Where focus returns when the login popup closes (named explicitly: not every browser focuses a button on click). */
let loginTrigger: HTMLElement | null = null;
export const getLoginTrigger = (): HTMLElement | null => loginTrigger;

function takeLoginRedirect(): { tab: Tab | null; draft: string } | null {
  try {
    const raw = sessionStorage.getItem(LOGIN_REDIRECT_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(LOGIN_REDIRECT_KEY);
    const v = JSON.parse(raw) as { tab?: unknown; draft?: unknown } | null;
    return { tab: TABS.includes(v?.tab as Tab) ? (v!.tab as Tab) : null, draft: typeof v?.draft === "string" ? v.draft.slice(0, DRAFT_MAX) : "" };
  } catch { return null; }
}
export type ThemePref = "system" | "light" | "dark";

export interface CustomPreset { id: string; label: string; baseUrl: string; note: string; options?: Record<string, unknown> }
export interface Toast { id: number; kind: "error" | "ok" | "info"; text: string; action?: { label: string; run(): void }; /** ms until it acts on its own (drawn as a countdown bar) */ duration?: number }

/** How long an Undo toast stays up before the delete is actually sent. */
export const UNDO_MS = 7000;

/** A delete that has happened on screen but not yet on the server. */
export interface Undoable {
  /** Hides the item everywhere it is listed while the toast is up (e.g. `doc:<id>`). */
  key: string;
  text: string;
  onHide?(): void;
  onRestore?(): void;
  /** Sends the real request. `keepalive` is set when the page is closing, so the request outlives it. */
  commit(opts: { keepalive: boolean }): Promise<void>;
}

/** What a signed-in user gets from /api/bootstrap. */
interface Bootstrap {
  version: string; methods: LoginMethods; session: SessionView;
  catalog: ProviderSpecView[]; customPresets: CustomPreset[]; profiles: ProfileView[]; activeId: string | null;
  settings: AgentSettings; tools: ToolInfo[]; search: { user: boolean; server: boolean }; conversations: ConversationView[];
  server: { allowPrivateUrls: boolean; maxUploadMb: number; maxAgentSteps: number };
  projects: ProjectView[]; code: { sandbox: SandboxKind; github: boolean; runners: RunnerView[] };
  /** Conversations with a run in progress on the server. */
  running?: string[];
  /** Hosted edition: your plan (null when plans are off) and whether Settings → Admin is yours. */
  plan?: PlanStatus | null;
  admin?: boolean;
}

/** Slash commands that work without a project (the rest come from GET /api/projects/[id]). */
export const BASE_COMMANDS: SlashCommand[] = [
  { name: "plan", description: "Toggle plan mode: research and propose a plan before changing anything", source: "builtin", clientOnly: true },
  { name: "clear", description: "Start a new task (clears the conversation)", source: "builtin", clientOnly: true },
  { name: "help", description: "Show what the agent can do and the available commands", source: "builtin", clientOnly: true },
];
const PROJECT_KEY = "morphie.project";
/** What anyone without a session gets: just enough to draw the sign-in screen. */
interface AnonymousBootstrap { version: string; methods: LoginMethods; session: null }

/** What a visitor asked for when the login popup opened (a locked tab, "connect a provider"...). Resumed after login. */
interface LoginOpts { tab?: Tab | null; trigger?: HTMLElement | null }

interface State {
  ready: boolean;
  loadError: string | null;
  version: string;
  /** null = nobody is signed in: the app shows the sign-in screen and nothing else. */
  session: SessionView | null;
  methods: LoginMethods;
  catalog: ProviderSpecView[];
  customPresets: CustomPreset[];
  profiles: ProfileView[];
  activeId: string | null;
  settings: AgentSettings;
  tools: ToolInfo[];
  search: { user: boolean; server: boolean };
  server: Bootstrap["server"];
  /** Hosted edition: your plan and credits (null when the server has no plans). */
  plan: PlanStatus | null;
  admin: boolean;
  refreshPlan(): Promise<void>;
  /** Settings → Plan. */
  openPlans(): void;

  tab: Tab;
  /** The login popup, and the tab to open once it succeeds (null = no preference). */
  loginOpen: boolean;
  pendingTab: Tab | null;
  /** What's typed in each composer. It lives here so it survives the login popup, tab switches and the login round trip. */
  drafts: Record<Mode, string>;
  settingsSection: string;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  paletteOpen: boolean;
  theme: ThemePref;

  conversations: ConversationView[];
  activeConv: Record<Mode, string | null>;
  messages: Record<string, MessageView[]>;
  /**
   * Last-known Documents and Memory lists (null = never loaded). Kept here rather than in the views so revisiting a tab
   * shows them instantly while a background refetch brings them up to date (stale-while-revalidate).
   */
  documents: DocumentView[] | null;
  memories: MemoryView[] | null;
  setDocuments(list: DocumentView[]): void;
  setMemories(list: MemoryView[]): void;
  /** Conversations whose history failed to load (so the view offers a retry instead of waiting forever). */
  historyErrors: Record<string, true>;
  /** Your skills and the library (null = not loaded yet). */
  skills: SkillSummary[] | null;
  skillLibrary: SkillLibraryEntry[] | null;
  loadSkills(): Promise<void>;
  setSkills(skills: SkillSummary[], library?: SkillLibraryEntry[]): void;
  run: RunState | null;
  /** Conversations whose agent is working on the server right now (even with no tab watching). */
  running: Record<string, true>;
  toasts: Toast[];

  /** Code projects, where they run, and whether a GitHub token is saved. */
  projects: ProjectView[];
  code: { sandbox: SandboxKind; github: boolean; runners: RunnerView[] };
  /** The project a NEW agent task will use (an existing task keeps its own). */
  selectedProject: string | null;
  /** The next agent message starts in plan mode. */
  planMode: boolean;
  projectCommands: Record<string, SlashCommand[]>;
  /** Terminal history per project: your commands and the agent's. */
  terminals: Record<string, TerminalEntry[]>;
  /** Bumped whenever a project's files may have changed (the Changes panel refetches). */
  changesTick: number;
  helpOpen: boolean;
  setSelectedProject(id: string | null): void;
  setPlanMode(on: boolean): void;
  setHelpOpen(open: boolean): void;
  refreshProjects(): Promise<void>;
  createProject(input: { name?: string; repoUrl?: string; branch?: string; sandbox?: string }): Promise<ProjectView | null>;
  renameProject(id: string, name: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  loadCommands(projectId: string): Promise<void>;
  runTerminal(projectId: string, command: string): Promise<void>;
  clearTerminal(projectId: string): void;
  setGithub(on: boolean): void;
  bumpChanges(): void;
  /** Items deleted on screen whose request is still waiting out the Undo window (keys from Undoable). */
  hidden: Record<string, true>;

  boot(): Promise<void>;
  /** The server says the session is gone (expired, revoked): go back to the sign-in screen. */
  signedOut(): void;
  /** Logged-out visitors can only open Chat: any other tab opens the login popup instead and the tab does not switch. */
  setTab(t: Tab, trigger?: HTMLElement | null): void;
  openLogin(opts?: LoginOpts): void;
  closeLogin(): void;
  /** Called just before leaving for Google/GitHub: keeps { tab, draft } for the way back. */
  saveLoginRedirect(): void;
  setDraft(mode: Mode, text: string): void;
  /** Send what's typed. Logged out, this opens the login popup and keeps the draft. */
  sendDraft(mode: Mode, trigger?: HTMLElement | null): void;
  setSettingsSection(s: string): void;
  toggleSidebar(open?: boolean): void;
  toggleInspector(open?: boolean): void;
  setPalette(open: boolean): void;
  setTheme(t: ThemePref): void;
  toast(kind: Toast["kind"], text: string, action?: Toast["action"]): void;
  dismissToast(id: number): void;
  /**
   * Delete without a confirm dialog: hide it now, show "Undo" for UNDO_MS, then send the request. Undo just shows it
   * again (nothing was sent). Closing the toast or the page sends it straight away.
   */
  undoable(u: Undoable): void;

  setProfiles(profiles: ProfileView[], activeId: string | null): void;
  /** Switch the active provider. The UI moves at once; a failed request puts the previous one back and says why. */
  activateProvider(id: string): Promise<void>;
  setSettings(patch: Partial<AgentSettings>): Promise<void>;
  setSearch(s: { user: boolean; server: boolean }): void;

  refreshConversations(q?: string, opts?: { quiet?: boolean }): Promise<void>;
  /** Background refresh (focus, network back): the conversation list with the last search, and the open history. */
  revalidate(): void;
  newConversation(mode: Mode): void;
  openConversation(mode: Mode, id: string): Promise<void>;
  loadMessages(id: string): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  pinConversation(id: string, pinned: boolean): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  send(message: string, opts?: { truncateFrom?: number }): Promise<void>;
  /** Resume the conversation's paused run (the Continue button). */
  continueRun(convId: string): Promise<void>;
  /** Follow a run that's already going on the server (after a reload, or coming back to its conversation). */
  attach(convId: string): Promise<void>;
  /** Stop following the live run without stopping it (switching conversations). */
  detach(): void;
  stop(): void;
  resolveApproval(id: string, approved: boolean, always?: boolean): Promise<void>;
  /** Rewind to before one of your messages: the project's files, the conversation, or both. */
  rewind(convId: string, mode: Mode, messageId: number, what: { code: boolean; conversation: boolean }): Promise<boolean>;
  /** Answer an ask_user card (null: skip, the agent uses defaults). */
  answerQuestion(id: string, answers: Record<string, string> | null): Promise<void>;
}

let controller: AbortController | null = null;
let toastId = 1;
let lastConvQuery: string | undefined;
const pendingUndo = new Map<number, Undoable & { timer: ReturnType<typeof setTimeout> }>();
const inflightHistory = new Map<string, Promise<void>>();
/** Conversations already resumed automatically after a restart (never twice). */
const autoResumed = new Set<string>();
const raf: (fn: () => void) => void = typeof requestAnimationFrame === "function" ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);

const errText = (e: unknown) => (e instanceof ApiFailure ? e.message : e instanceof Error ? e.message : "Something went wrong.");

export const useStore = create<State>((set, get) => ({
  ready: false, loadError: null, version: "", session: null, methods: { email: false, google: false, github: false }, catalog: [], customPresets: [], profiles: [], activeId: null,
  settings: DEFAULT_AGENT_SETTINGS, tools: [], search: { user: false, server: false }, server: { allowPrivateUrls: true, maxUploadMb: 10, maxAgentSteps: 30 },
  plan: null, admin: false,
  tab: "chat", loginOpen: false, pendingTab: null, drafts: { chat: "", agent: "" }, settingsSection: "providers", sidebarOpen: false, inspectorOpen: true, paletteOpen: false, theme: "system",
  conversations: [], activeConv: { chat: null, agent: null }, messages: {}, historyErrors: {}, documents: null, memories: null, run: null, running: {}, toasts: [], hidden: {}, skills: null, skillLibrary: null,
  projects: [], code: { sandbox: "none", github: false, runners: [] }, selectedProject: null, planMode: false, projectCommands: {}, terminals: {}, changesTick: 0, helpOpen: false,

  async boot() {
    try {
      const b = await api<Bootstrap | AnonymousBootstrap>("/api/bootstrap");
      let theme: ThemePref = "system";
      try { const t = localStorage.getItem("morphie.theme"); if (t === "light" || t === "dark") theme = t; } catch { /* storage blocked */ }
      // Back from Google/GitHub: put the draft back whether or not the login worked, so nothing typed is lost.
      const returned = takeLoginRedirect();
      const drafts = returned?.draft ? { ...get().drafts, chat: returned.draft } : get().drafts;
      if (!b.session) { set({ ready: true, loadError: null, theme, version: b.version, methods: b.methods, session: null, drafts }); return; }
      // The tab the visitor asked for before logging in wins; otherwise a brand-new account starts at Providers.
      const wanted = get().pendingTab ?? returned?.tab ?? null;
      let selectedProject: string | null = null;
      try { const id = localStorage.getItem(PROJECT_KEY); if (id && b.projects?.some((p) => p.id === id)) selectedProject = id; } catch { /* storage blocked */ }
      const { running, ...rest } = b;
      set({ ready: true, loadError: null, theme, ...rest, plan: b.plan ?? null, admin: !!b.admin, running: Object.fromEntries((running ?? []).map((id) => [id, true as const])), settings: { ...DEFAULT_AGENT_SETTINGS, ...b.settings, permissions: b.settings?.permissions ?? DEFAULT_AGENT_SETTINGS.permissions }, projects: b.projects ?? [], code: b.code ? { ...b.code, runners: b.code.runners ?? [] } : { sandbox: "none", github: false, runners: [] }, selectedProject, drafts, loginOpen: false, pendingTab: null, tab: wanted ?? (b.profiles.length ? get().tab : "settings") });
    } catch (e) {
      set({ loadError: errText(e) });
    }
  },
  signedOut() {
    if (!get().session) return;
    controller?.abort();
    for (const [, u] of pendingUndo) clearTimeout(u.timer); // no session to send them with: they simply don't happen
    pendingUndo.clear();
    // The session ended while the page was open: back to what a visitor sees, with nothing of the account left in memory.
    set({
      session: null, tab: PUBLIC_TAB, loginOpen: false, pendingTab: null, settingsSection: "providers", sidebarOpen: false,
      profiles: [], activeId: null, settings: DEFAULT_AGENT_SETTINGS, tools: [], search: { user: false, server: false },
      conversations: [], activeConv: { chat: null, agent: null }, messages: {}, historyErrors: {}, documents: null, memories: null, run: null, running: {}, hidden: {}, skills: null, skillLibrary: null,
      projects: [], selectedProject: null, planMode: false, projectCommands: {}, terminals: {}, code: { sandbox: "none", github: false, runners: [] },
      plan: null, admin: false,
    });
    get().toast("info", "You've been logged out. Log in to continue.");
  },
  async refreshPlan() {
    if (!get().plan) return;
    try { set({ plan: await api<PlanStatus>("/api/plan") }); } catch { /* the meters just stay as they were */ }
  },
  openPlans() {
    set({ settingsSection: "plan" });
    get().setTab("settings");
  },
  setTab(tab, trigger) {
    if (!get().session && tab !== PUBLIC_TAB) { get().openLogin({ tab, trigger }); return; }
    if (tab === get().tab) { set({ sidebarOpen: false }); return; }
    withViewTransition(() => set({ tab, sidebarOpen: false })); // a short crossfade; the rail's marker slides to the new tab
  },
  openLogin(opts = {}) {
    const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    loginTrigger = opts.trigger ?? (active && active !== document.body && !active.closest('[role="dialog"]') ? active : null);
    set({ loginOpen: true, pendingTab: opts.tab ?? null, paletteOpen: false });
  },
  closeLogin: () => set({ loginOpen: false, pendingTab: null }),
  saveLoginRedirect() {
    try { sessionStorage.setItem(LOGIN_REDIRECT_KEY, JSON.stringify({ tab: get().pendingTab, draft: get().drafts.chat })); } catch { /* storage blocked: the draft just isn't restored */ }
  },
  setDraft: (mode, text) => set((s) => ({ drafts: { ...s.drafts, [mode]: text } })),
  sendDraft(mode, trigger) {
    const s = get();
    const text = s.drafts[mode].trim();
    if (!text || text.length > DRAFT_MAX) return;
    if (!s.session) { get().openLogin({ tab: PUBLIC_TAB, trigger }); return; } // the draft stays where it is
    if (s.run && s.run.status !== "done" && s.run.status !== "error") return;
    // Commands the app handles itself.
    const local = mode === "agent" ? /^\/(plan|clear|help)(?:\s+([\s\S]*))?$/i.exec(text) : null;
    if (local) {
      const rest = (local[2] ?? "").trim();
      set((st) => ({ drafts: { ...st.drafts, [mode]: "" } }));
      const cmd = local[1].toLowerCase();
      if (cmd === "help") { set({ helpOpen: true }); return; }
      if (cmd === "clear") { get().newConversation("agent"); return; }
      // "/plan" toggles; "/plan <task>" plans that task.
      if (!rest) { const on = !get().planMode; set({ planMode: on }); get().toast("info", on ? "Plan mode on: the agent will research and propose a plan before changing anything." : "Plan mode off."); return; }
      set({ planMode: true });
      if (!s.activeId) { get().toast("error", "Add an AI provider in Settings first."); set({ tab: "settings", settingsSection: "providers" }); return; }
      void get().send(rest);
      return;
    }
    if (!s.activeId) { get().toast("error", "Add an AI provider in Settings first."); set({ tab: "settings", settingsSection: "providers" }); return; }
    set((st) => ({ drafts: { ...st.drafts, [mode]: "" } }));
    void get().send(text);
  },
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  toggleSidebar: (open) => set((s) => ({ sidebarOpen: open ?? !s.sidebarOpen })),
  toggleInspector: (open) => set((s) => ({ inspectorOpen: open ?? !s.inspectorOpen })),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setTheme(theme) {
    try {
      if (theme === "system") { localStorage.removeItem("morphie.theme"); delete document.documentElement.dataset.theme; }
      else { localStorage.setItem("morphie.theme", theme); document.documentElement.dataset.theme = theme; }
    } catch { /* ignore */ }
    set({ theme });
  },
  toast(kind, text, action) {
    const id = toastId++;
    // A plan or credits refusal points at the plans.
    if (kind === "error" && !action && get().plan && isPlanFailure(text)) action = { label: "See plans", run: () => get().openPlans() };
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, action }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 7000 : action ? 10_000 : 4000);
  },
  dismissToast(id) {
    if (pendingUndo.has(id)) { void finishUndo(id, false); return; } // closing an Undo toast means "yes, delete it"
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  undoable(u) {
    const id = toastId++;
    set((s) => ({ hidden: { ...s.hidden, [u.key]: true } }));
    u.onHide?.();
    pendingUndo.set(id, { ...u, timer: setTimeout(() => void finishUndo(id, false), UNDO_MS) });
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind: "info", text: u.text, duration: UNDO_MS, action: { label: "Undo", run: () => undoNow(id) } }] }));
  },

  setProfiles: (profiles, activeId) => set({ profiles, activeId }),
  async activateProvider(id) {
    const prev = get().activeId;
    if (id === prev) return;
    set({ activeId: id });
    try {
      const r = await api<{ profiles: ProfileView[]; activeId: string | null }>(`/api/providers/${id}/activate`, { method: "POST", body: {} });
      set({ profiles: r.profiles, activeId: r.activeId });
    } catch (e) {
      if (get().activeId === id) set({ activeId: prev }); // only undo our own change, not a newer switch
      get().toast("error", errText(e));
    }
  },
  setSearch: (search) => set({ search }),
  async setSettings(patch) {
    const prev = get().settings;
    set({ settings: { ...prev, ...patch } });
    try {
      const { temperature, ...rest } = patch;
      const saved = await api<AgentSettings>("/api/settings", { method: "PUT", body: { ...rest, ...(temperature === undefined && "temperature" in patch ? { temperature: null } : temperature !== undefined ? { temperature } : {}) } });
      set({ settings: saved });
    } catch (e) {
      set({ settings: prev });
      get().toast("error", errText(e));
    }
  },

  async loadSkills() {
    if (!get().session) return;
    try { const r = await api<{ skills: SkillSummary[]; library: SkillLibraryEntry[] }>("/api/skills"); set({ skills: r.skills, skillLibrary: r.library }); }
    catch { /* the menu just has no skills */ }
  },
  setSkills: (skills, library) => set((s) => ({ skills, skillLibrary: library ?? s.skillLibrary })),
  setDocuments: (documents) => set({ documents }),
  setMemories: (memories) => set({ memories }),

  async refreshConversations(q, opts) {
    if (!get().session) return; // a visitor has no conversations to fetch
    lastConvQuery = q;
    try {
      const r = await api<{ conversations: ConversationView[]; running?: string[] }>(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      set({ conversations: r.conversations, ...(r.running ? { running: Object.fromEntries(r.running.map((id) => [id, true as const])) } : {}) });
    } catch (e) { if (!opts?.quiet) get().toast("error", errText(e)); }
  },
  revalidate() {
    const s = get();
    if (!s.session) return;
    void get().refreshConversations(lastConvQuery, { quiet: true });
    const mode: Mode | null = s.tab === "agent" ? "agent" : s.tab === "chat" ? "chat" : null;
    const id = mode ? s.activeConv[mode] : null;
    const busy = !!s.run && s.run.status !== "done" && s.run.status !== "error";
    if (id && !busy) void get().loadMessages(id); // mid-run the live view owns the history
  },
  newConversation(mode) {
    if (get().run && get().run!.status !== "done" && get().run!.status !== "error") get().detach();
    set((s) => ({ activeConv: { ...s.activeConv, [mode]: null }, sidebarOpen: false }));
  },
  async openConversation(mode, id) {
    const live = get().run;
    if (live && live.convId !== id && live.status !== "done" && live.status !== "error") get().detach();
    set((s) => ({ activeConv: { ...s.activeConv, [mode]: id }, sidebarOpen: false }));
    await get().loadMessages(id);
  },
  loadMessages(id) {
    // One request per conversation at a time: opening it and a background revalidation share the same fetch.
    const pending = inflightHistory.get(id);
    if (pending) return pending;
    const p = loadHistory(id, set, get).finally(() => inflightHistory.delete(id));
    inflightHistory.set(id, p);
    return p;
  },
  async renameConversation(id, title) {
    const before = get().conversations.find((c) => c.id === id)?.title;
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, title } : c)) }));
    try { await api(`/api/conversations/${id}`, { method: "PATCH", body: { title } }); }
    catch (e) {
      if (before !== undefined) set((s) => ({ conversations: s.conversations.map((c) => (c.id === id && c.title === title ? { ...c, title: before } : c)) }));
      get().toast("error", errText(e));
    }
  },
  async pinConversation(id, pinned) {
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, pinned } : c)) }));
    try { await api(`/api/conversations/${id}`, { method: "PATCH", body: { pinned } }); }
    catch (e) {
      set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, pinned: !pinned } : c)) }));
      get().toast("error", errText(e));
      return;
    }
    void get().refreshConversations(lastConvQuery, { quiet: true });
  },
  async deleteConversation(id) {
    const c = get().conversations.find((x) => x.id === id);
    if (!c) return;
    const was = { chat: get().activeConv.chat === id, agent: get().activeConv.agent === id };
    get().undoable({
      key: `conv:${id}`, text: `Deleted “${c.title.length > 40 ? c.title.slice(0, 39) + "…" : c.title}”.`,
      onHide: () => set((s) => ({ activeConv: { chat: was.chat ? null : s.activeConv.chat, agent: was.agent ? null : s.activeConv.agent } })),
      // Put it back on screen only if nothing else was opened in the meantime.
      onRestore: () => set((s) => ({ activeConv: { chat: was.chat && !s.activeConv.chat ? id : s.activeConv.chat, agent: was.agent && !s.activeConv.agent ? id : s.activeConv.agent } })),
      commit: async ({ keepalive }) => {
        await api(`/api/conversations/${id}`, { method: "DELETE", keepalive });
        set((s) => ({ conversations: s.conversations.filter((x) => x.id !== id) }));
      },
    });
  },

  async send(message, opts = {}) {
    const s = get();
    if (!s.session) { get().openLogin({ tab: PUBLIC_TAB }); return; }
    const mode: Mode = s.tab === "agent" ? "agent" : "chat";
    const convId = s.activeConv[mode];
    if (s.run && s.run.status !== "done" && s.run.status !== "error") {
      if (s.run.convId === convId) return; // one run per conversation
      get().detach(); // the other one keeps working on the server
    }
    if (!s.activeId) { get().toast("error", "Add an AI provider in Settings first."); set({ tab: "settings", settingsSection: "providers" }); return; }
    const conv = convId ? s.conversations.find((c) => c.id === convId) : undefined;
    const projectId = mode === "agent" ? (convId ? conv?.projectId ?? null : s.selectedProject) : null;
    const planMode = mode === "agent" && s.planMode;
    set({ run: newRun({ convId, mode, userMessage: message, truncateFrom: opts.truncateFrom, planMode }) });
    // One key per send: an automatic retry after a dropped connection can't post the message twice.
    await follow(set, get, mode, projectId, (onEvent, signal) => streamSSE<AgentEvent>("/api/chat", { conversationId: convId ?? undefined, mode, message, truncateFrom: opts.truncateFrom, projectId: !convId && projectId ? projectId : undefined, planMode: planMode || undefined }, onEvent, signal, { idempotencyKey: newIdempotencyKey() }));
  },
  async continueRun(convId) {
    const s = get();
    if (!s.session) return;
    if (s.run && s.run.status !== "done" && s.run.status !== "error") { if (s.run.convId === convId) return; get().detach(); }
    const conv = s.conversations.find((c) => c.id === convId);
    const mode: Mode = conv?.mode ?? (s.tab === "agent" ? "agent" : "chat");
    set({ run: newRun({ convId, mode, userMessage: "", continued: true }) });
    await follow(set, get, mode, conv?.projectId ?? null, (onEvent, signal) => streamSSE<AgentEvent>("/api/chat", { conversationId: convId, mode, continue: true }, onEvent, signal, { idempotencyKey: newIdempotencyKey() }));
  },
  async attach(convId) {
    const s = get();
    if (s.run && s.run.convId === convId && s.run.status !== "done" && s.run.status !== "error") return;
    if (s.run && s.run.status !== "done" && s.run.status !== "error") get().detach();
    const conv = s.conversations.find((c) => c.id === convId);
    const mode: Mode = conv?.mode ?? "chat";
    set({ run: { ...newRun({ convId, mode, userMessage: "", continued: true }), status: "running" } });
    await follow(set, get, mode, conv?.projectId ?? null, (onEvent, signal) => streamSSE<AgentEvent>(`/api/runs/${convId}?from=0`, undefined, onEvent, signal), { reattach: true });
  },
  detach() {
    const run = get().run;
    controller?.abort();
    controller = null;
    if (run?.convId) set((st) => ({ run: null, running: { ...st.running, [run.convId!]: true } }));
    else set({ run: null });
  },
  stop() {
    const run = get().run;
    if (!run?.convId) { controller?.abort(); return; }
    // The run lives on the server: ask it to stop (it then sends its last events and "done"). If that fails, at least stop watching.
    api(`/api/runs/${run.convId}/stop`, { method: "POST", body: {} }).catch(() => controller?.abort());
  },

  setSelectedProject(id) {
    try { if (id) localStorage.setItem(PROJECT_KEY, id); else localStorage.removeItem(PROJECT_KEY); } catch { /* ignore */ }
    set({ selectedProject: id });
    if (id && !get().projectCommands[id]) void get().loadCommands(id);
  },
  setPlanMode: (planMode) => set({ planMode }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  async refreshProjects() {
    try { const r = await api<{ projects: ProjectView[] }>("/api/projects"); set({ projects: r.projects }); } catch { /* quiet */ }
  },
  async createProject(input) {
    try {
      const r = await api<{ project: ProjectView; projects: ProjectView[] }>("/api/projects", { method: "POST", body: input, idempotencyKey: newIdempotencyKey() });
      set({ projects: r.projects });
      get().setSelectedProject(r.project.id);
      get().newConversation("agent");
      get().toast("ok", input.repoUrl ? `Cloned ${r.project.name}.` : `Created ${r.project.name}.`);
      return r.project;
    } catch (e) { get().toast("error", errText(e)); return null; }
  },
  async renameProject(id, name) {
    try { const r = await api<{ projects: ProjectView[] }>(`/api/projects/${id}`, { method: "PATCH", body: { name } }); set({ projects: r.projects }); }
    catch (e) { get().toast("error", errText(e)); }
  },
  async deleteProject(id) {
    try {
      const r = await api<{ projects: ProjectView[] }>(`/api/projects/${id}`, { method: "DELETE" });
      set((st) => ({ projects: r.projects, selectedProject: st.selectedProject === id ? null : st.selectedProject, conversations: st.conversations.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)) }));
      if (get().selectedProject === null) get().setSelectedProject(null);
      get().toast("ok", "Project deleted.");
    } catch (e) { get().toast("error", errText(e)); }
  },
  async loadCommands(projectId) {
    try { const r = await api<{ commands: SlashCommand[] }>(`/api/projects/${projectId}`); set((st) => ({ projectCommands: { ...st.projectCommands, [projectId]: r.commands } })); }
    catch { /* the composer falls back to the basic commands */ }
  },
  async runTerminal(projectId, command) {
    const at = Date.now();
    const pending: TerminalEntry = { stepId: `you-${at}`, command, output: "", exitCode: -1, ms: 0, by: "you", at };
    const put = (e: TerminalEntry) => set((st) => ({ terminals: { ...st.terminals, [projectId]: [...(st.terminals[projectId] ?? []).filter((x) => x.stepId !== e.stepId).slice(-99), e] } }));
    put(pending);
    try {
      const r = await api<{ exitCode: number; output: string; ms: number; timedOut: boolean }>(`/api/projects/${projectId}/exec`, { method: "POST", body: { command } });
      put({ ...pending, output: r.output + (r.timedOut ? "\n[timed out]" : ""), exitCode: r.exitCode, ms: r.ms });
    } catch (e) { put({ ...pending, output: errText(e), exitCode: 1 }); }
    set((st) => ({ changesTick: st.changesTick + 1 }));
  },
  clearTerminal: (projectId) => set((st) => ({ terminals: { ...st.terminals, [projectId]: [] } })),
  setGithub: (github) => set((st) => ({ code: { ...st.code, github } })),
  bumpChanges: () => set((st) => ({ changesTick: st.changesTick + 1 })),
  async resolveApproval(id, approved, always) {
    set((st) => {
      if (!st.run) return {};
      const { [id]: gone, ...rest } = st.run.approvals;
      return { run: { ...st.run, approvals: rest, status: "running", timeline: st.run.timeline.map((it) => (it.kind === "tool" && it.step.id === gone?.stepId ? { kind: "tool" as const, step: { ...it.step, status: "running" as const } } : it)) } };
    });
    try { await api("/api/agent/approve", { method: "POST", body: { id, approved, always } }); }
    catch (e) { get().toast("error", errText(e)); }
  },
  async rewind(convId, mode, messageId, what) {
    try {
      const r = await api<{ code: boolean; conversation: boolean; prompt: string; undo: string | null }>(`/api/conversations/${convId}/rewind`, { method: "POST", body: { messageId, ...what } });
      if (r.conversation) { await get().loadMessages(convId); get().setDraft(mode, r.prompt); }
      if (r.code) set((st) => ({ changesTick: st.changesTick + 1 }));
      const text = r.code && r.conversation ? "Rewound the files and the conversation." : r.code ? "Rewound the files." : "Rewound the conversation. Your message is back in the box.";
      const undo = r.undo;
      let undone = false;
      get().toast("ok", text, undo ? {
        label: "Undo files",
        run: () => {
          if (undone) return;
          undone = true;
          void api(`/api/conversations/${convId}/rewind`, { method: "POST", body: { undo } })
            .then(() => { set((st) => ({ changesTick: st.changesTick + 1 })); get().toast("ok", "Put the files back."); }, (e) => get().toast("error", errText(e)));
        },
      } : undefined);
      return true;
    } catch (e) { get().toast("error", errText(e)); return false; }
  },
  async answerQuestion(id, answers) {
    set((st) => {
      if (!st.run) return {};
      const { [id]: gone, ...rest } = st.run.questions;
      const waiting = Object.keys(st.run.approvals).length > 0 || Object.keys(rest).length > 0;
      return { run: { ...st.run, questions: rest, status: waiting ? "waiting" : "running", timeline: st.run.timeline.map((it) => (it.kind === "tool" && it.step.id === gone?.stepId ? { kind: "tool" as const, step: { ...it.step, status: "running" as const } } : it)) } };
    });
    try { await api("/api/agent/approve", { method: "POST", body: { id, approved: !!answers, answers: answers ?? undefined } }); }
    catch (e) { get().toast("error", errText(e)); }
  },
}));

type Set = (partial: Partial<State> | ((s: State) => Partial<State>)) => void;

type Opener = (onEvent: (e: AgentEvent) => void, signal: AbortSignal) => Promise<unknown>;

/**
 * Stream a run into `run`: the reply as it's written, its tools, approvals and budget. If the connection drops before
 * the run says it's done, re-attach (GET /api/runs/[id]?from=seq) and carry on where it left off: the run itself never
 * depended on this connection.
 */
async function follow(set: Set, get: () => State, mode: Mode, projectId: string | null, open: Opener, opts: { reattach?: boolean } = {}): Promise<void> {
  const ctl = new AbortController();
  controller = ctl;
  let project = projectId;
  // Token deltas arrive far faster than a screen refreshes: coalesce them to one state update per frame.
  let pending: AgentEvent[] = [];
  let scheduled = false;
  const mine = () => controller === ctl;
  const flush = () => {
    scheduled = false;
    if (!pending.length || !mine()) { pending = []; return; }
    const batch = pending; pending = [];
    set((st) => (st.run ? { run: batch.reduce(applyEvent, st.run) } : {}));
  };
  const onEvent = (e: AgentEvent) => {
    if (!mine()) return;
    if (e.type === "start") {
      const cid = e.conversationId;
      // Seed an empty history so nothing tries to lazy-load this conversation mid-run (it would show the user message twice).
      set((st) => ({ activeConv: { ...st.activeConv, [e.mode]: cid }, running: { ...st.running, [cid]: true }, messages: st.messages[cid] ? st.messages : { ...st.messages, [cid]: [] } }));
      if (!get().conversations.some((c) => c.id === cid)) {
        const now = Date.now();
        set((st) => ({ conversations: [{ id: cid, title: "New conversation", mode: e.mode, pinned: false, createdAt: now, updatedAt: now, projectId: project }, ...st.conversations] }));
      }
    }
    if (e.type === "plan_mode" && !e.active) set({ planMode: false });
    if (e.type === "file_change") set((st) => ({ changesTick: st.changesTick + 1 }));
    if (e.type === "project") {
      // The agent made a project for this task: the conversation now lives in it, and the panel shows its files.
      project = e.project.id;
      const cid = get().run?.convId;
      set((st) => ({
        projects: st.projects.some((p) => p.id === e.project.id) ? st.projects : [e.project, ...st.projects],
        conversations: st.conversations.map((c) => (c.id === cid ? { ...c, projectId: e.project.id } : c)),
      }));
      get().setSelectedProject(e.project.id);
    }
    if (e.type === "terminal" && project) {
      const pid = project;
      const entry: TerminalEntry = { stepId: e.stepId, command: e.command, output: e.output, exitCode: e.exitCode, ms: e.ms, by: "agent", at: Date.now() };
      set((st) => ({ terminals: { ...st.terminals, [pid]: [...(st.terminals[pid] ?? []).slice(-99), entry] } }));
    }
    if (e.type === "title") set((st) => ({ conversations: st.conversations.map((c) => (c.id === get().run?.convId ? { ...c, title: e.title } : c)) }));
    if (e.type === "approval" || e.type === "question" || e.type === "done") {
      // Away in another tab? Chime and notify when it needs you or has finished.
      const kind = e.type === "done" ? (e.reason === "error" ? "error" : e.continuable ? "paused" : e.stopped ? null : "done") : e.type;
      const cid = get().run?.convId;
      if (kind) notifyRun(kind, get().conversations.find((c) => c.id === cid)?.title);
      if (e.type === "done") void get().refreshPlan(); // the credit meters move with every run
    }
    pending.push(e);
    if (e.type === "text" || e.type === "thinking") { if (!scheduled) { scheduled = true; raf(flush); } }
    else flush();
  };

  let error: unknown;
  try {
    const answer = await open(onEvent, ctl.signal);
    if (opts.reattach && answer && typeof answer === "object" && (answer as { active?: boolean }).active === false) {
      onEvent({ type: "done" });
    }
  } catch (e) { error = e; }
  flush();
  // Dropped before "done"? The run is still going on the server: pick the stream up again.
  for (let attempt = 0; mine() && !error && get().run && get().run!.status !== "done" && get().run!.status !== "error" && get().run!.convId && attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, Math.min(8000, 600 * 2 ** attempt)));
    if (!mine()) break;
    const cid = get().run!.convId!;
    try {
      const answer = await streamSSE<AgentEvent>(`/api/runs/${cid}?from=${get().run!.seq}`, undefined, onEvent, ctl.signal);
      flush();
      if (answer && typeof answer === "object" && (answer as { active?: boolean }).active === false) break; // it ended while we were away
    } catch { /* try again */ }
  }
  if (error && mine()) onEvent({ type: "error", message: errText(error) });
  flush();
  if (!mine()) return; // detached: another conversation is showing now
  const finished = get().run;
  const cid = finished?.convId;
  if (cid) {
    set((st) => { const { [cid]: _, ...rest } = st.running; return { running: rest }; });
    await get().loadMessages(cid);
  }
  await get().refreshConversations(lastConvQuery, { quiet: true });
  if (project) set((st) => ({ changesTick: st.changesTick + 1 }));
  if (finished?.status === "error" && finished.error && !finished.convId) get().toast("error", finished.error);
  if (controller === ctl) controller = null;
  set({ run: finished && finished.status === "error" && !cid ? finished : null });
}
/** Fetch one conversation's history. Use loadMessages, which de-duplicates concurrent calls. */
async function loadHistory(id: string, set: Set, get: () => State): Promise<void> {
  if (get().historyErrors[id]) set((s) => { const { [id]: _, ...rest } = s.historyErrors; return { historyErrors: rest }; });
  try {
    const r = await api<{ messages: MessageView[]; running?: boolean }>(`/api/conversations/${id}`);
    set((s) => ({ messages: { ...s.messages, [id]: r.messages } }));
    // Its agent is still working (started in another tab, or before a reload): follow it live.
    const s = get();
    const showing = s.activeConv.chat === id || s.activeConv.agent === id;
    if (r.running && showing && !(s.run && s.run.convId === id)) void get().attach(id);
    else if (!r.running && s.running[id]) set((st) => { const { [id]: _, ...rest } = st.running; return { running: rest }; });
    // A run the server lost moments ago (a dev server restarting): pick it up again by itself, once.
    const last = r.messages.at(-1);
    const busy = !!s.run && s.run.status !== "done" && s.run.status !== "error";
    if (!r.running && showing && !busy && last?.role === "assistant" && last.meta?.autoResume && last.meta.continuable && !autoResumed.has(id) && Date.now() - last.createdAt < 15 * 60_000) {
      autoResumed.add(id);
      get().toast("info", "The server restarted mid-task: picking it up where it stopped.");
      void get().continueRun(id);
    }
  } catch (e) {
    if (!get().messages[id]) set((s) => ({ historyErrors: { ...s.historyErrors, [id]: true } }));
    if (e instanceof ApiFailure && e.status === 404) {
      set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id), activeConv: { chat: s.activeConv.chat === id ? null : s.activeConv.chat, agent: s.activeConv.agent === id ? null : s.activeConv.agent } }));
    } else if (!get().messages[id]) get().toast("error", errText(e)); // with history on screen a failed background refresh stays quiet
  }
}

const unhide = (key: string) => useStore.setState((s) => { const { [key]: _, ...rest } = s.hidden; return { hidden: rest }; });
const dropToast = (id: number) => useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));

/** The Undo window is over (or the toast was closed, or the page is going away): send the delete. */
async function finishUndo(id: number, keepalive: boolean): Promise<void> {
  const u = pendingUndo.get(id);
  if (!u) return;
  pendingUndo.delete(id);
  clearTimeout(u.timer);
  dropToast(id);
  try {
    await u.commit({ keepalive });
    unhide(u.key); // commit has already removed it from the cached list, so nothing reappears
  } catch (e) {
    unhide(u.key);
    u.onRestore?.();
    useStore.getState().toast("error", `Couldn't delete: ${errText(e)}`);
  }
}

function undoNow(id: number): void {
  const u = pendingUndo.get(id);
  if (!u) return;
  pendingUndo.delete(id);
  clearTimeout(u.timer);
  dropToast(id);
  unhide(u.key);
  u.onRestore?.();
}

// Leaving the page during an Undo window still deletes: keepalive lets the requests finish after the page is gone.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => { for (const id of [...pendingUndo.keys()]) void finishUndo(id, true); });

setSignedOutHandler(() => useStore.getState().signedOut());
