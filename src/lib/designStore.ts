"use client";
import { create } from "zustand";
import { api, ApiFailure, newIdempotencyKey, streamSSE } from "./api";
import type { DesignEvent, DesignPatch, DesignState, DesignSummary, DesignSystemJson, DesignSystemSummary, DesignSystemView, DesignThemeView } from "./types";
import { useStore } from "./store";

export type Device = "desktop" | "tablet" | "mobile";
export const DEVICE_WIDTHS: Record<Device, number> = { desktop: 1280, tablet: 768, mobile: 390 };

export type DesignMode = "designs" | "systems";
export type SystemInput =
  | { from: "prompt"; prompt: string; name?: string }
  | { from: "url"; url: string; name?: string; notes?: string }
  | { from: "image"; palette: Array<{ hex: string; weight: number }>; notes?: string; name?: string; fileName?: string }
  | { from: "design"; designId: string; name?: string };

export interface DesignTurn { id: number; prompt: string; reply?: string; kind?: string; error?: boolean; changed?: boolean; notes?: string[]; /** Design skills that guided this change. */ skills?: string[] }

interface DesignStore {
  loaded: boolean;
  /** Design skills picked for the next requests (relevant ones are added automatically too). */
  pickedSkills: string[];
  togglePickedSkill(name: string): void;
  designs: DesignSummary[];
  themes: DesignThemeView[];
  activeId: string | null;
  state: DesignState | null;
  device: Device;
  busy: { stage: string; attempt: number } | null;
  turns: DesignTurn[];
  /** Design systems: the list, the one open in the Systems view, and the one a NEW design starts from. */
  mode: DesignMode;
  systems: DesignSystemSummary[];
  fonts: Array<{ family: string; category: string }>;
  activeSystemId: string | null;
  system: DesignSystemView | null;
  newDesignSystemId: string | null;
  creatingSystem: string | null;
  savingSystem: boolean;
  /** Visual editing: the editor HTML (with in-place editing) and a counter that reloads it. */
  editMode: boolean;
  editorHtml: string | null;
  editorScroll: number;
  load(): Promise<void>;
  setMode(m: DesignMode): void;
  openSystem(id: string | null): Promise<void>;
  createSystem(input: SystemInput): Promise<boolean>;
  saveSystem(system: DesignSystemJson): void;
  deleteSystem(id: string): Promise<void>;
  setNewDesignSystem(id: string | null): void;
  applySystem(systemId: string | null): Promise<void>;
  setEditMode(on: boolean): void;
  loadEditor(): Promise<void>;
  setEditorScroll(y: number): void;
  patch(patches: DesignPatch[]): Promise<boolean>;
  open(id: string | null): Promise<void>;
  setDevice(d: Device): void;
  send(message: string): Promise<void>;
  stop(): void;
  act(action: "undo" | "redo", ): Promise<void>;
  restore(version: number): Promise<void>;
  applyTheme(theme: string): Promise<void>;
  rename(name: string): Promise<void>;
  remove(id: string): Promise<void>;
}

let controller: AbortController | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let turnId = 1;
const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const toast = (kind: "error" | "ok" | "info", text: string) => useStore.getState().toast(kind, text);

export const useDesign = create<DesignStore>((set, get) => ({
  loaded: false, pickedSkills: [], designs: [], themes: [], activeId: null, state: null, device: "desktop", busy: null, turns: [],
  mode: "designs", systems: [], fonts: [], activeSystemId: null, system: null, newDesignSystemId: null, creatingSystem: null, savingSystem: false,
  editMode: false, editorHtml: null, editorScroll: 0,

  async load() {
    try {
      const r = await api<{ designs: DesignSummary[]; themes: DesignThemeView[]; systems?: DesignSystemSummary[]; fonts?: Array<{ family: string; category: string }> }>("/api/design");
      set({ designs: r.designs, themes: r.themes, systems: r.systems ?? [], fonts: r.fonts ?? get().fonts, loaded: true });
    } catch (e) { if (!get().loaded) toast("error", errText(e)); } // a failed background refresh keeps the cached list quietly
  },
  async open(id) {
    if (!id) { set({ activeId: null, state: null, turns: [], mode: "designs", editMode: false, editorHtml: null }); return; }
    try {
      const r = await api<{ state: DesignState }>(`/api/design/${id}`);
      set({ activeId: id, state: r.state, turns: [], mode: "designs", editorHtml: null, editorScroll: 0 });
      if (get().editMode) void get().loadEditor();
    } catch (e) {
      toast("error", errText(e));
      void get().load();
    }
  },
  setDevice: (device) => set({ device }),
  togglePickedSkill: (name) => set((s) => ({ pickedSkills: s.pickedSkills.includes(name) ? s.pickedSkills.filter((n) => n !== name) : [...s.pickedSkills, name].slice(-4) })),

  async send(message) {
    if (get().busy) return;
    if (!useStore.getState().activeId) { toast("error", "Add an AI provider in Settings first."); useStore.getState().setTab("settings"); return; }
    const id = turnId++;
    controller = new AbortController();
    set((s) => ({ busy: { stage: "drafting", attempt: 0 }, turns: [...s.turns, { id, prompt: message }] }));
    const finishTurn = (patch: Partial<DesignTurn>) => set((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
    try {
      await streamSSE<DesignEvent>("/api/design", { designId: get().activeId, message, systemId: get().activeId ? undefined : get().newDesignSystemId ?? undefined, skills: get().pickedSkills.length ? get().pickedSkills : undefined }, (e) => {
        if (e.type === "stage") set({ busy: { stage: e.stage, attempt: e.attempt } });
        else if (e.type === "result") {
          set({ state: e.state, activeId: e.state.id });
          if (get().editMode) void get().loadEditor();
          finishTurn({ reply: e.summary, kind: e.kind, changed: e.changed, notes: e.notes, skills: e.skills });
        } else if (e.type === "clarify") finishTurn({ reply: e.message, kind: "clarify" });
        else if (e.type === "error") finishTurn({ reply: e.message, error: true });
      }, controller.signal, { idempotencyKey: newIdempotencyKey() });
      if (controller.signal.aborted) finishTurn({ reply: "Stopped.", error: true });
    } catch (e) {
      finishTurn({ reply: errText(e), error: true });
    } finally {
      set({ busy: null });
      controller = null;
      void get().load();
    }
  },
  stop() { controller?.abort(); },

  async act(action) {
    const id = get().activeId;
    if (!id) return;
    try { const r = await api<{ state: DesignState }>(`/api/design/${id}/${action}`, { method: "POST", body: {} }); set({ state: r.state }); void get().load(); if (get().editMode) void get().loadEditor(); }
    catch (e) { toast(e instanceof ApiFailure && e.status === 409 ? "info" : "error", errText(e)); }
  },
  async restore(version) {
    const id = get().activeId;
    if (!id) return;
    try { const r = await api<{ state: DesignState }>(`/api/design/${id}/restore`, { method: "POST", body: { version } }); set({ state: r.state }); if (get().editMode) void get().loadEditor(); }
    catch (e) { toast("error", errText(e)); }
  },
  async applyTheme(theme) {
    const id = get().activeId;
    if (!id) return;
    try {
      const r = await api<{ state: DesignState; summary: string }>(`/api/design/${id}/theme`, { method: "POST", body: { theme } });
      set({ state: r.state });
      toast("ok", r.summary);
      void get().load();
      if (get().editMode) void get().loadEditor();
    } catch (e) { toast("error", errText(e)); }
  },

  setMode: (mode) => set({ mode, ...(mode === "systems" ? { editMode: false } : {}) }),
  async openSystem(id) {
    if (!id) { set({ activeSystemId: null, system: null, mode: "systems" }); return; }
    set({ activeSystemId: id, mode: "systems" });
    try { const r = await api<{ system: DesignSystemView }>(`/api/systems/${id}`); if (get().activeSystemId === id) set({ system: r.system }); }
    catch (e) { toast("error", errText(e)); set({ activeSystemId: null, system: null }); void get().load(); }
  },
  async createSystem(input) {
    if (get().creatingSystem) return false;
    set({ creatingSystem: input.from });
    try {
      const r = await api<{ id: string; summary: string; notes: string[]; system: DesignSystemView; systems: DesignSystemSummary[] }>("/api/systems", { method: "POST", body: input, idempotencyKey: newIdempotencyKey() });
      set({ systems: r.systems, system: r.system, activeSystemId: r.id, mode: "systems" });
      toast("ok", r.summary);
      if (r.notes[0]) toast("info", r.notes[0]);
      return true;
    } catch (e) { toast("error", errText(e)); return false; }
    finally { set({ creatingSystem: null }); }
  },
  saveSystem(system) {
    const id = get().activeSystemId;
    const cur = get().system;
    if (!id || !cur) return;
    // The page updates at once; the save (and the re-rendered docs) follow, debounced while you drag a colour.
    set({ system: { ...cur, system, name: system.name } });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      set({ savingSystem: true });
      try {
        const r = await api<{ system: DesignSystemView; systems: DesignSystemSummary[] }>(`/api/systems/${id}`, { method: "PATCH", body: { system } });
        if (get().activeSystemId === id) set({ system: r.system });
        set({ systems: r.systems });
      } catch (e) { toast("error", errText(e)); }
      finally { set({ savingSystem: false }); }
    }, 550);
  },
  async deleteSystem(id) {
    const s = get().systems.find((x) => x.id === id);
    useStore.getState().undoable({
      key: `system:${id}`, text: `Deleted “${s?.name ?? "design system"}”.`,
      onHide: () => { if (get().activeSystemId === id) set({ activeSystemId: null, system: null }); if (get().newDesignSystemId === id) set({ newDesignSystemId: null }); },
      commit: async ({ keepalive }) => {
        const r = await api<{ systems: DesignSystemSummary[] }>(`/api/systems/${id}`, { method: "DELETE", keepalive });
        set({ systems: r.systems });
        if (get().state?.systemId === id) set((st) => ({ state: st.state ? { ...st.state, systemId: null } : null }));
      },
    });
  },
  setNewDesignSystem: (newDesignSystemId) => set({ newDesignSystemId }),
  async applySystem(systemId) {
    const id = get().activeId;
    if (!id) return;
    try {
      const r = await api<{ state: DesignState; summary: string }>(`/api/design/${id}/system`, { method: "POST", body: { systemId } });
      set({ state: r.state });
      toast("ok", r.summary);
      void get().load();
      if (get().editMode) void get().loadEditor();
    } catch (e) { toast("error", errText(e)); }
  },
  setEditMode(on) {
    set({ editMode: on });
    if (on && get().state) void get().loadEditor();
  },
  async loadEditor() {
    const id = get().activeId;
    if (!id) return;
    try {
      const r = await api<{ html: string }>(`/api/design/${id}/editor?scroll=${Math.round(get().editorScroll)}`);
      if (get().activeId === id) set({ editorHtml: r.html });
    } catch (e) { toast("error", errText(e)); set({ editMode: false }); }
  },
  setEditorScroll: (editorScroll) => set({ editorScroll }),
  async patch(patches) {
    const id = get().activeId;
    if (!id) return false;
    try {
      const r = await api<{ state: DesignState; summary: string; changed: boolean }>(`/api/design/${id}/patch`, { method: "POST", body: { patches } });
      set({ state: r.state });
      void get().loadEditor();
      void get().load();
      return true;
    } catch (e) {
      toast("error", errText(e));
      void get().loadEditor(); // put the text back as it is saved
      return false;
    }
  },
  async rename(name) {
    const id = get().activeId;
    if (!id) return;
    try { const r = await api<{ state: DesignState }>(`/api/design/${id}/rename`, { method: "POST", body: { name } }); set({ state: r.state }); void get().load(); }
    catch (e) { toast("error", errText(e)); }
  },
  async remove(id) {
    const d = get().designs.find((x) => x.id === id);
    let open: Pick<DesignStore, "activeId" | "state" | "turns"> | null = null;
    useStore.getState().undoable({
      key: `design:${id}`, text: `Deleted “${d?.name ?? "design"}”.`,
      onHide: () => { if (get().activeId === id) { open = { activeId: id, state: get().state, turns: get().turns }; set({ activeId: null, state: null, turns: [] }); } },
      onRestore: () => { if (open && !get().activeId) set(open); },
      commit: async ({ keepalive }) => {
        await api(`/api/design/${id}`, { method: "DELETE", keepalive });
        set((s) => ({ designs: s.designs.filter((x) => x.id !== id) }));
      },
    });
  },
}));

// When the session ends, drop every design held in memory: whoever logs in next on this page must never see them.
useStore.subscribe((s, prev) => { if (prev.session && !s.session) { controller?.abort(); useDesign.setState(useDesign.getInitialState(), true); } });
