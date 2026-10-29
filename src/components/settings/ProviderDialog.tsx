"use client";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Eye, EyeOff, ExternalLink, Loader2, Plus, RefreshCw, Search, X, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiFailure, newIdempotencyKey } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { AuthStyle, ModelInfo, ProfileView, ProviderOptions, ProviderSpecView } from "@/lib/types";
import { BrandMark } from "../BrandMark";
import { Combobox } from "../Combobox";
import { spotlight } from "../fx";
import { Badge, Button, Dialog, Field, Input, Select, Switch, Textarea, cn, Segmented } from "../ui";

interface Row { k: string; v: string }
const CODE = "font-mono text-[13px]";
interface TestReport { ok: boolean; message: string; latencyMs?: number; reply?: string; tools?: string; hint?: string }

const AUTH_STYLES: Array<{ v: AuthStyle; label: string; hint: string }> = [
  { v: "bearer", label: "Authorization: Bearer <key>", hint: "The OpenAI standard. Most providers use this." },
  { v: "x-api-key", label: "x-api-key: <key>", hint: "Used by Anthropic-style gateways and some proxies." },
  { v: "api-key", label: "api-key: <key>", hint: "Used by Azure OpenAI." },
  { v: "header", label: "Custom header name…", hint: "Send the key in a header you name." },
  { v: "none", label: "No authentication", hint: "For local servers that don't need a key." },
];

const toRows = (o?: Record<string, string>): Row[] => Object.entries(o ?? {}).map(([k, v]) => ({ k, v }));
const fromRows = (rows: Row[], keepBlankValues: boolean): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.k.trim() && (keepBlankValues || r.v !== "")) out[r.k.trim()] = r.v;
  return Object.keys(out).length ? out : undefined;
};
const num = (s: string): number | undefined => { const n = Number(s); return s.trim() !== "" && Number.isFinite(n) ? n : undefined; };

function KeyValueRows({ rows, onChange, keyPlaceholder, valuePlaceholder, addLabel, secretValues, editing }: { rows: Row[]; onChange: (r: Row[]) => void; keyPlaceholder: string; valuePlaceholder: string; addLabel: string; secretValues?: boolean; editing?: boolean }) {
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <Input value={r.k} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} placeholder={keyPlaceholder} aria-label={`${keyPlaceholder} ${i + 1}`} className="font-mono" autoCapitalize="off" spellCheck={false} />
          <Input value={r.v} type={secretValues ? "password" : "text"} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} placeholder={editing && secretValues ? "unchanged" : valuePlaceholder} aria-label={`${valuePlaceholder} ${i + 1}`} className="font-mono" autoComplete="off" spellCheck={false} />
          <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove row" className="grid size-10 pointer-coarse:size-11 shrink-0 place-items-center rounded-xl text-muted transition hover:bg-err/10 hover:text-err active:scale-90"><X className="size-4" /></button>
        </div>
      ))}
      <Button type="button" size="sm" variant="ghost" onClick={() => onChange([...rows, { k: "", v: "" }])}><Plus className="size-3.5" aria-hidden /> {addLabel}</Button>
    </div>
  );
}

function ToggleRow({ title, hint, checked, onChange }: { title: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-4 rounded-xl border border-line bg-sunken/40 p-3 transition hover:border-faint/50">
      <div className="flex-1"><div className="text-[13px] font-medium">{title}</div><p className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</p></div>
      <Switch checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

export function ProviderDialog({ open, onClose, editing, initialKind }: { open: boolean; onClose: () => void; editing: ProfileView | null; initialKind?: string | null }) {
  const { catalog, customPresets, setProfiles, toast, server } = useStore();
  const [kind, setKind] = useState<string | null>(null);

  useEffect(() => { if (open) setKind(editing?.kind ?? initialKind ?? null); }, [open, editing, initialKind]);
  const spec = catalog.find((c) => c.kind === kind);

  return (
    <Dialog open={open} onClose={onClose} title={editing ? `Edit ${editing.label}` : spec ? `Connect ${spec.label}` : "Add a provider"} description={!spec ? "Pick a service. Your key stays on this machine, encrypted." : spec.blurb} width={spec ? "max-w-2xl" : "max-w-3xl"}
      icon={spec ? <BrandMark kind={spec.kind} label={spec.label} size="lg" active /> : undefined}>
      {!spec ? <Picker catalog={catalog} onPick={setKind} /> : (
        <ProviderForm key={`${editing?.id ?? "new"}:${spec.kind}`} spec={spec} editing={editing} presets={customPresets} allowPrivate={server.allowPrivateUrls}
          onBack={editing ? undefined : () => setKind(null)}
          onSaved={(profiles, activeId, label) => { setProfiles(profiles, activeId); toast("ok", `${label} is ready.`); onClose(); }} />
      )}
    </Dialog>
  );
}

type Group = ProviderSpecView["group"];
const GROUPS: Array<{ id: Group | "all"; title: string }> = [{ id: "all", title: "All" }, { id: "hosted", title: "Hosted" }, { id: "gateway", title: "Gateways" }, { id: "local", title: "Run locally" }];
const SECTION: Record<Group, string> = { custom: "Bring your own endpoint", hosted: "Hosted", gateway: "Gateways", local: "Run locally" };

function Picker({ catalog, onPick }: { catalog: ProviderSpecView[]; onPick: (k: string) => void }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<Group | "all">("all");
  const query = q.trim().toLowerCase();
  const match = (c: ProviderSpecView) => (group === "all" || c.group === group || c.group === "custom") && (!query || `${c.label} ${c.blurb} ${c.kind}`.toLowerCase().includes(query));
  const custom = catalog.find((c) => c.group === "custom" && match(c));
  const sections = (["hosted", "gateway", "local"] as Group[]).map((g) => [g, catalog.filter((c) => c.group === g && match(c))] as const).filter(([, items]) => items.length);
  const total = sections.reduce((n, [, i]) => n + i.length, 0) + (custom ? 1 : 0);

  return (
    <div className="space-y-5">
      <div className="sticky -top-5 z-10 -mx-6 -mt-5 space-y-3 border-b border-line bg-panel/85 px-6 pb-3 pt-5 backdrop-blur-xl">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search providers…" aria-label="Search providers" className="pl-9" type="search" />
        </div>
        <div role="tablist" aria-label="Provider type" className="flex flex-wrap gap-1.5">
          {GROUPS.map((g) => {
            const on = g.id === group;
            return (
              <button key={g.id} role="tab" aria-selected={on} type="button" onClick={() => setGroup(g.id)}
                className={cn("relative h-8 rounded-full px-3.5 text-xs font-medium transition-colors duration-200 pointer-coarse:min-h-11", on ? "text-fg" : "text-muted hover:bg-fg/[0.06] hover:text-fg")}>
                {on && <motion.span layoutId="provider-group" className="absolute inset-0 -z-0 rounded-full bg-accent/15 ring-1 ring-inset ring-accent/40" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                <span className="relative">{g.title}</span>
              </button>
            );
          })}
        </div>
      </div>

      {custom && (
        <button type="button" onClick={() => onPick(custom.kind)} onPointerMove={spotlight}
          className="spotlight group relative flex w-full items-center gap-4 overflow-hidden rounded-2xl border border-accent/40 bg-linear-to-br/oklch from-accent/12 via-accent-3/6 to-accent-2/8 p-4 text-left transition duration-300 hover:-translate-y-0.5 hover:border-accent/70 hover:shadow-glow active:translate-y-0 active:scale-[0.995]">
          <BrandMark kind="custom" size="lg" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">{custom.label}<Badge tone="accent">Any endpoint</Badge></span>
            <span className="mt-0.5 block text-xs leading-snug text-muted">{custom.blurb}</span>
          </span>
          <ArrowRight className="size-4 shrink-0 text-accent transition-transform duration-300 group-hover:translate-x-1" aria-hidden />
        </button>
      )}

      {sections.map(([g, items]) => (
        <section key={g} aria-label={SECTION[g]}>
          <h3 className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">{SECTION[g]}<span className="h-px flex-1 bg-linear-to-r from-line to-transparent" /></h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {items.map((c) => (
              <button key={c.kind} type="button" onClick={() => onPick(c.kind)} onPointerMove={spotlight}
                className="spotlight group flex items-center gap-3 rounded-xl border border-line bg-raised/40 p-3 text-left transition duration-300 hover:-translate-y-0.5 hover:border-faint/50 hover:bg-raised/70 hover:shadow-card active:translate-y-0 active:scale-[0.99]">
                <BrandMark kind={c.kind} label={c.label} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">{c.label}{!c.requiresKey && <Badge>no key</Badge>}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted">{c.blurb}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 -translate-x-1 text-faint opacity-0 transition duration-300 group-hover:translate-x-0 group-hover:text-fg group-hover:opacity-100" aria-hidden />
              </button>
            ))}
          </div>
        </section>
      ))}

      {total === 0 && (
        <div className="grid place-items-center gap-2 py-10 text-center">
          <Search className="size-6 text-faint" aria-hidden />
          <p className="text-sm text-muted">No provider matches “{q}”.</p>
          <Button size="sm" variant="soft" onClick={() => onPick("custom")}>Connect it as an OpenAI-compatible endpoint</Button>
        </div>
      )}
    </div>
  );
}

function ProviderForm({ spec, editing, presets, allowPrivate, onBack, onSaved }: { spec: ProviderSpecView; editing: ProfileView | null; presets: Array<{ id: string; label: string; baseUrl: string; note: string; options?: Record<string, unknown> }>; allowPrivate: boolean; onBack?: () => void; onSaved: (p: ProfileView[], activeId: string | null, label: string) => void }) {
  const isCustom = spec.kind === "custom";
  const o = editing?.options ?? {};
  const [label, setLabel] = useState(editing?.label ?? (isCustom ? "" : spec.label));
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? (spec.editableBaseUrl ? spec.baseUrl : ""));
  const [model, setModel] = useState(editing?.model ?? spec.defaultModel);
  const [preset, setPreset] = useState("");
  const [advanced, setAdvanced] = useState(false);

  const [authStyle, setAuthStyle] = useState<AuthStyle>(o.authStyle ?? (spec.requiresKey || isCustom ? "bearer" : "none"));
  const [authHeaderName, setAuthHeaderName] = useState(o.authHeaderName ?? "");
  const [headers, setHeaders] = useState<Row[]>(toRows(o.extraHeaders));
  const [query, setQuery] = useState<Row[]>(toRows(o.queryParams));
  const [chatPath, setChatPath] = useState(o.chatPath ?? "");
  const [modelsPath, setModelsPath] = useState(o.modelsPath ?? "");
  const [streaming, setStreaming] = useState(o.streaming !== false);
  const [nativeTools, setNativeTools] = useState(o.nativeTools !== false && spec.nativeTools);
  const [temperature, setTemperature] = useState(o.temperature?.toString() ?? "");
  const [topP, setTopP] = useState(o.topP?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(o.maxTokens?.toString() ?? "");
  const [tokenParam, setTokenParam] = useState<"max_tokens" | "max_completion_tokens">(o.tokenParam ?? "max_tokens");
  const [systemPrompt, setSystemPrompt] = useState(o.systemPrompt ?? "");
  const [timeoutSec, setTimeoutSec] = useState(o.timeoutSec?.toString() ?? "");
  const [vision, setVision] = useState<"auto" | "yes" | "no">(o.vision === true ? "yes" : o.vision === false ? "no" : "auto");
  const [contextWindow, setContextWindow] = useState(o.contextWindow?.toString() ?? "");
  const [taskBudget, setTaskBudget] = useState(o.taskTokenBudget?.toString() ?? "");

  const [models, setModels] = useState<ModelInfo[]>(spec.exampleModels.map((id) => ({ id })));
  const [modelsState, setModelsState] = useState<{ loading: boolean; note?: string; error?: string }>({ loading: false });
  const [test, setTest] = useState<TestReport | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoFetched = useRef(false);

  const options = useMemo((): ProviderOptions => {
    const out: ProviderOptions = {};
    if (isCustom) {
      out.authStyle = authStyle;
      if (authStyle === "header") out.authHeaderName = authHeaderName.trim();
      const h = fromRows(headers, true); if (h) out.extraHeaders = h;
      const q = fromRows(query, true); if (q) out.queryParams = q;
      if (chatPath.trim()) out.chatPath = chatPath.trim();
      if (modelsPath.trim()) out.modelsPath = modelsPath.trim();
      out.streaming = streaming;
      out.nativeTools = nativeTools;
      out.tokenParam = tokenParam;
      if (systemPrompt.trim()) out.systemPrompt = systemPrompt;
      const t = num(timeoutSec); if (t !== undefined) out.timeoutSec = Math.round(t);
      const p = num(topP); if (p !== undefined) out.topP = p;
    }
    const temp = num(temperature); if (temp !== undefined) out.temperature = temp;
    const mt = num(maxTokens); if (mt !== undefined) out.maxTokens = Math.round(mt);
    if (vision !== "auto") out.vision = vision === "yes";
    const cw = num(contextWindow); if (cw !== undefined) out.contextWindow = Math.min(2_000_000, Math.max(4000, Math.round(cw)));
    const tb = num(taskBudget); if (tb !== undefined) out.taskTokenBudget = Math.min(1_000_000, Math.max(20_000, Math.round(tb)));
    return out;
  }, [isCustom, authStyle, authHeaderName, headers, query, chatPath, modelsPath, streaming, nativeTools, tokenParam, systemPrompt, timeoutSec, topP, temperature, maxTokens, vision, contextWindow, taskBudget]);

  const payload = () => ({ profileId: editing?.id, kind: spec.kind, apiKey: apiKey.trim() || undefined, baseUrl: spec.editableBaseUrl ? baseUrl.trim() : undefined, options });

  function applyPreset(id: string) {
    setPreset(id);
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setBaseUrl(p.baseUrl);
    if (!label.trim() && id !== "blank") setLabel(p.label);
    const po = (p.options ?? {}) as ProviderOptions;
    setAuthStyle(po.authStyle ?? "bearer");
    setQuery(toRows(po.queryParams));
    setModels([]); setModelsState({ loading: false });
    autoFetched.current = false;
  }

  async function fetchModels(silent = false) {
    if (spec.editableBaseUrl && !baseUrl.trim()) { if (!silent) setModelsState({ loading: false, error: "Enter the base URL first." }); return; }
    if (spec.requiresKey && !apiKey.trim() && !editing?.hasKey) { if (!silent) setModelsState({ loading: false, error: "Enter your API key first." }); return; }
    setModelsState({ loading: true });
    try {
      const r = await api<{ models: ModelInfo[]; source: string; warning?: string }>("/api/providers/models", { method: "POST", body: payload() });
      setModels(r.models);
      const ids = r.models.map((m) => m.id);
      if (!ids.includes(model)) {
        const pick = ids.find((i) => !/embed|whisper|tts|moderation|dall|image|rerank|guard/i.test(i));
        if (!model.trim() && pick) setModel(pick);
      }
      setModelsState({ loading: false, note: r.warning ?? `${r.models.length} models found.` });
    } catch (e) {
      setModelsState({ loading: false, error: silent ? undefined : e instanceof ApiFailure ? e.message : "Couldn't load models." });
    }
  }

  async function runTest() {
    setTesting(true); setTest(null); setError(null);
    try { setTest(await api<TestReport>("/api/providers/test", { method: "POST", body: { ...payload(), model: model.trim(), label } })); }
    catch (e) { setTest({ ok: false, message: e instanceof Error ? e.message : "Test failed." }); }
    finally { setTesting(false); }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!model.trim()) { setError("Choose or type a model ID."); return; }
    setSaving(true);
    try {
      const r = await api<{ profile: ProfileView; profiles: ProfileView[]; activeId: string | null }>("/api/providers", {
        method: "POST", body: { id: editing?.id, kind: spec.kind, label: label.trim() || undefined, model: model.trim(), apiKey: apiKey.trim() || undefined, baseUrl: spec.editableBaseUrl ? baseUrl.trim() : undefined, options, activate: true },
        idempotencyKey: newIdempotencyKey(), // this Save: retried automatically if the connection drops, created once
      });
      onSaved(r.profiles, r.activeId, r.profile.label);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't save."); }
    finally { setSaving(false); }
  }

  const keyBlurFetch = () => { if (!autoFetched.current && spec.canListModels && apiKey.trim() && (!spec.editableBaseUrl || baseUrl.trim())) { autoFetched.current = true; void fetchModels(true); } };
  const currentPreset = presets.find((p) => p.id === preset);
  const http = baseUrl.trim().startsWith("http://");

  return (
    <form onSubmit={save} className="space-y-5" noValidate>
      {onBack && <button type="button" onClick={onBack} className="group -mt-1 inline-flex h-7 items-center gap-1 rounded-full pl-1.5 pr-3 text-xs font-medium text-muted transition hover:bg-fg/[0.06] hover:text-fg pointer-coarse:min-h-11"><ChevronLeft className="size-3.5 transition-transform group-hover:-translate-x-0.5" aria-hidden /> All providers</button>}

      {isCustom && !editing && (
        <Field label="Start from a preset" hint={currentPreset?.note ?? "Fills in the URL and sensible defaults. You can change everything afterwards."}>
          <Select value={preset} onValueChange={applyPreset} aria-label="Preset" placeholder="Choose a preset…"
            options={presets.map((p) => ({ value: p.id, label: p.label, textValue: p.label, hint: p.baseUrl || undefined }))} />
        </Field>
      )}

      {(isCustom || spec.kind === "ollama" || spec.kind === "lmstudio") && (
        <Field label="Name" htmlFor="pf-label" hint="How this provider appears in the model switcher."><Input id="pf-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={isCustom ? "e.g. CodeCraft API" : spec.label} maxLength={60} /></Field>
      )}

      {spec.editableBaseUrl && (
        <Field label="Base URL" htmlFor="pf-url" hint={isCustom ? <>Usually ends in <code className="font-mono">/v1</code>. Morphie adds <code className="font-mono">/chat/completions</code> and <code className="font-mono">/models</code> itself.</> : undefined}>
          <Input id="pf-url" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); autoFetched.current = false; }} placeholder="https://api.example.com/v1" inputMode="url" spellCheck={false} autoCapitalize="off" className="font-mono" />
          {http && !allowPrivate && <p className="mt-1 text-xs text-warn">Plain http:// sends your key unencrypted. Use https:// for remote providers.</p>}
        </Field>
      )}

      {(spec.requiresKey || isCustom || spec.kind === "ollama") && (
        <Field label={isCustom ? "API key" : spec.requiresKey ? "API key" : "API key (optional)"} htmlFor="pf-key" hint={<>{editing?.hasKey ? `Saved (${editing.keyHint}). Leave blank to keep it.` : isCustom ? "Leave blank if the endpoint needs no key." : spec.kind === "ollama" ? "Only for Ollama Cloud. Local Ollama needs none." : "Stored encrypted on this machine and never shown again."}{spec.keyUrl && <> <a href={spec.keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">Get a key <ExternalLink className="size-3" aria-hidden /></a></>}</>}>
          <div className="relative">
            <Input id="pf-key" type={showKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={keyBlurFetch} placeholder={editing?.hasKey ? "••••••••••••" : "sk-…"} autoComplete="off" spellCheck={false} autoCapitalize="off" className="pr-10 font-mono" />
            <button type="button" onClick={() => setShowKey((s) => !s)} aria-label={showKey ? "Hide key" : "Show key"} className="absolute right-1.5 top-1/2 grid size-7 pointer-coarse:right-0 pointer-coarse:size-11 -translate-y-1/2 place-items-center rounded-lg text-muted hover:text-fg">{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
          </div>
        </Field>
      )}

      <Field label="Model" htmlFor="pf-model" error={modelsState.error} hint={modelsState.note ?? (isCustom ? "Fetch the list from your provider, or type any model ID." : "Pick one or type any model ID.")}>
        <div className="flex gap-2">
          <Combobox id="pf-model" value={model} onChange={setModel} placeholder="model-id" mono options={models.map((m) => ({ value: m.id, label: m.label }))} />
          {spec.canListModels && <Button type="button" variant="secondary" onClick={() => fetchModels()} loading={modelsState.loading} aria-label="Fetch models"><RefreshCw className="size-4" aria-hidden /> <span className="hidden sm:inline">Fetch</span></Button>}
        </div>
      </Field>

      <div className={cn("overflow-hidden rounded-xl border transition-colors duration-300", advanced ? "border-accent/30 bg-sunken/30" : "border-line hover:border-faint/50")}>
        <button type="button" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced} className="group flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium transition hover:bg-fg/[0.03]">
          <ChevronRight className={cn("size-4 text-muted transition-transform duration-300 group-hover:text-fg", advanced && "rotate-90 text-accent")} aria-hidden /> Advanced {isCustom ? "connection settings" : "options"}
          <span className="ml-auto text-xs font-normal text-muted">{isCustom ? "auth, headers, paths, streaming, tools" : "sampling"}</span>
        </button>
        <AnimatePresence initial={false}>
        {advanced && (
          <motion.div key="adv" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: "spring", stiffness: 380, damping: 36 }} className="overflow-hidden">
          <div className="space-y-5 border-t border-line p-4">
            {isCustom && (
              <>
                <Field label="Authentication" hint={AUTH_STYLES.find((a) => a.v === authStyle)?.hint}>
                  <Select value={authStyle} onValueChange={setAuthStyle} aria-label="Authentication style" options={AUTH_STYLES.map((a) => ({ value: a.v, label: <code className={CODE}>{a.label}</code>, textValue: a.label, hint: a.hint }))} />
                </Field>
                {authStyle === "header" && <Field label="Header name" htmlFor="pf-hn"><Input id="pf-hn" value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} placeholder="X-Gateway-Key" className="font-mono" spellCheck={false} /></Field>}
                <Field label="Extra headers" hint="Sent with every request (team IDs, org headers…). Values are encrypted and never shown again.">
                  <KeyValueRows rows={headers} onChange={setHeaders} keyPlaceholder="Header-Name" valuePlaceholder="value" addLabel="Add header" secretValues editing={!!editing} />
                </Field>
                <Field label="Query parameters" hint="Appended to every URL, e.g. api-version for Azure.">
                  <KeyValueRows rows={query} onChange={setQuery} keyPlaceholder="name" valuePlaceholder="value" addLabel="Add parameter" />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Chat path" htmlFor="pf-cp" hint="Default /chat/completions"><Input id="pf-cp" value={chatPath} onChange={(e) => setChatPath(e.target.value)} placeholder="/chat/completions" className="font-mono" spellCheck={false} /></Field>
                  <Field label="Models path" htmlFor="pf-mp" hint="Default /models"><Input id="pf-mp" value={modelsPath} onChange={(e) => setModelsPath(e.target.value)} placeholder="/models" className="font-mono" spellCheck={false} /></Field>
                </div>
                <ToggleRow title="Stream responses" hint="Show text as it's written. Turn off if your gateway breaks on streaming." checked={streaming} onChange={setStreaming} />
                <ToggleRow title="Native tool calling" hint="The model calls tools through the API's function-calling. If agent mode misbehaves, turn this off and Morphie will use prompt-based tools instead." checked={nativeTools} onChange={setNativeTools} />
              </>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Temperature" htmlFor="pf-t" hint="Blank = provider default"><Input id="pf-t" value={temperature} onChange={(e) => setTemperature(e.target.value)} inputMode="decimal" placeholder="default" /></Field>
              {isCustom && <Field label="Top P" htmlFor="pf-p" hint="Blank = default"><Input id="pf-p" value={topP} onChange={(e) => setTopP(e.target.value)} inputMode="decimal" placeholder="default" /></Field>}
              <Field label="Max output tokens" htmlFor="pf-m" hint="Blank = default"><Input id="pf-m" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} inputMode="numeric" placeholder="default" /></Field>
            </div>
            {isCustom && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Token limit parameter" hint="Newer OpenAI-style APIs want max_completion_tokens."><Select value={tokenParam} onValueChange={setTokenParam} aria-label="Token limit parameter" options={[{ value: "max_tokens" as const, label: <code className={CODE}>max_tokens</code>, textValue: "max_tokens" }, { value: "max_completion_tokens" as const, label: <code className={CODE}>max_completion_tokens</code>, textValue: "max_completion_tokens" }]} /></Field>
                <Field label="Timeout (seconds)" htmlFor="pf-to" hint="Default 90"><Input id="pf-to" value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} inputMode="numeric" placeholder="90" /></Field>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Accepts images" hint="Screenshots go to models that can see them. Auto guesses from the model name.">
                <Segmented size="sm" label="Accepts images" value={vision} onChange={setVision} options={[{ value: "auto", label: "Auto" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
              </Field>
              <Field label="Context window" htmlFor="pf-cw" hint="Tokens. Long agent runs are summarised before they reach ~60% of it. Blank = known value or 64k."><Input id="pf-cw" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} inputMode="numeric" placeholder="auto" /></Field>
              <Field label="Token budget per task" htmlFor="pf-tb" hint="20,000 – 1,000,000. Blank = the general setting (Settings → Chat & agent)."><Input id="pf-tb" value={taskBudget} onChange={(e) => setTaskBudget(e.target.value)} inputMode="numeric" placeholder="general setting" /></Field>
            </div>
            {isCustom && <Field label="System prompt prefix" htmlFor="pf-sp" hint="Added in front of Morphie's own instructions for this provider only."><Textarea id="pf-sp" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={3} maxLength={4000} placeholder="Optional" /></Field>}
          </div>
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      {test && (
        <div role="status" className={cn("animate-rise rounded-xl border p-3.5 text-sm", test.ok ? "border-ok/40 bg-ok/[0.07] shadow-[0_8px_30px_-16px_rgb(var(--ok)/0.6)]" : "border-err/40 bg-err/[0.07]")}>
          <div className={cn("flex items-start gap-2 font-medium", test.ok ? "text-ok" : "text-err")}>{test.ok ? <Check className="mt-0.5 size-4 shrink-0" aria-hidden /> : <X className="mt-0.5 size-4 shrink-0" aria-hidden />}<span>{test.message}</span></div>
          {test.ok && test.reply && <p className="mt-1 pl-6 text-xs text-muted">Model said: “{test.reply}”</p>}
          {test.ok && test.tools && test.tools !== "skipped" && (
            <p className="mt-1 flex items-center gap-1.5 pl-6 text-xs text-muted"><Zap className="size-3" aria-hidden /> Tool calling: {test.tools === "supported" ? <Badge tone="ok">works</Badge> : test.tools === "prompted" ? <Badge tone="info">prompt-based</Badge> : <Badge tone="warn">not detected</Badge>}</p>
          )}
          {test.hint && <p className="mt-1.5 pl-6 text-xs leading-relaxed text-muted">{test.hint}</p>}
        </div>
      )}
      {error && <p className="rounded-xl border border-err/40 bg-err/5 p-3 text-sm text-err" role="alert">{error}</p>}

      <div className="sticky -bottom-5 -mx-6 -mb-5 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-panel/85 px-6 py-4 backdrop-blur-xl">
        <Button type="button" variant="ghost" onClick={runTest} disabled={testing || !model.trim()}>{testing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Zap className="size-4" aria-hidden />} Test connection</Button>
        <Button type="submit" variant="primary" loading={saving}>{editing ? "Save changes" : "Save & use"}</Button>
      </div>
    </form>
  );
}
