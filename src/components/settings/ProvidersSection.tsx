"use client";
import { Check, Gem, Globe, KeyRound, Lock, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { spotlight } from "../fx";
import type { ProfileView } from "@/lib/types";
import { Badge, Button, ConfirmDialog, EmptyState, cn } from "../ui";
import { BrandMark } from "../BrandMark";
import { ProviderDialog } from "./ProviderDialog";

interface Res { profiles: ProfileView[]; activeId: string | null }

export function ProvidersSection() {
  const { profiles: all, activeId, catalog, setProfiles, toast } = useStore();
  const plan = useStore((s) => s.plan);
  const openPlans = useStore((s) => s.openPlans);
  const profiles = all.filter((p) => !p.hosted);
  const hosted = all.filter((p) => p.hosted);
  const byok = !plan || plan.plans.find((p) => p.id === plan.plan)?.features.byok !== false;
  const byokPlan = plan?.plans.find((p) => p.features.byok)?.name;
  const [dialog, setDialog] = useState<{ editing: ProfileView | null; kind?: string | null } | null>(null);
  const [del, setDel] = useState<ProfileView | null>(null);

  const activateProvider = useStore((s) => s.activateProvider);
  const use = (p: ProfileView) => void activateProvider(p.id);
  const remove = async (p: ProfileView) => { try { const r = await api<Res>(`/api/providers/${p.id}`, { method: "DELETE" }); setProfiles(r.profiles, r.activeId); toast("ok", `Removed ${p.label}.`); } catch (e) { toast("error", (e as Error).message); } };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="font-display text-2xl font-semibold tracking-tight">AI providers</h2><p className="mt-1 max-w-xl text-sm text-muted">Connect as many as you like and switch between them from the composer. Keys are encrypted on this machine and never sent to the browser again.</p></div>
        {byok && <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setDialog({ editing: null, kind: "custom" })}><Globe className="size-4" aria-hidden /> OpenAI-compatible</Button>
          <Button variant="primary" onClick={() => setDialog({ editing: null })}><Plus className="size-4" aria-hidden /> Add provider</Button>
        </div>}
      </header>

      {hosted.length > 0 && <MorphieAI hosted={hosted} activeId={activeId} />}

      {!byok && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel/70 px-4 py-3" data-testid="byok-locked">
          <Lock className="size-4 text-faint" aria-hidden />
          <p className="min-w-0 flex-1 text-sm text-muted">Bring your own API keys (OpenAI, Claude, OpenRouter, Ollama and more) with {byokPlan ?? "a paid plan"} and up.{profiles.length ? " Your saved keys are kept, paused." : ""}</p>
          <Button size="sm" variant="soft" onClick={openPlans}>See plans</Button>
        </div>
      )}

      {profiles.length === 0 && (!byok || hosted.length > 0) ? null : profiles.length === 0 ? (
        <div className="relative overflow-hidden rounded-3xl border border-dashed border-line bg-panel/50 backdrop-blur">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-6 flex justify-center gap-3 opacity-60 [mask-image:linear-gradient(90deg,transparent,#000_30%,#000_70%,transparent)]">
            {["openai", "anthropic", "gemini", "mistral", "deepseek", "xai", "groq", "openrouter", "ollama"].map((k) => <BrandMark key={k} kind={k} size="sm" />)}
          </div>
          <div className="pt-10">
          <EmptyState icon={<KeyRound className="size-5" />} title="Connect your first model" action={<Button variant="primary" onClick={() => setDialog({ editing: null })}><Plus className="size-4" aria-hidden /> Add provider</Button>}>
            OpenAI, Claude, Gemini, Mistral, OpenRouter, Groq, Ollama, LM Studio, or any OpenAI-compatible endpoint you point it at.
          </EmptyState>
          </div>
        </div>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {profiles.map((p) => {
            const active = p.id === activeId;
            const spec = catalog.find((c) => c.kind === p.kind);
            return (
              <li key={p.id} onPointerMove={spotlight} className={cn("spotlight group flex flex-col rounded-2xl border bg-panel/80 p-4 backdrop-blur transition duration-300 hover:-translate-y-0.5", active ? "border-accent/50 shadow-glow" : "border-line hover:border-faint/50 hover:shadow-card")}>
                <div className="flex items-start gap-3">
                  <BrandMark kind={p.kind} label={p.label} active={active} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-medium">{p.label}</h3>{active && <Badge tone="accent"><Check className="size-3" aria-hidden /> Active</Badge>}{p.paused && <Badge tone="warn">Paused</Badge>}{p.kind === "custom" && <Badge tone="info">OpenAI-compatible</Badge>}</div>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted">{p.model}</p>
                    {(p.baseUrl || spec?.baseUrl) && <p className="mt-0.5 truncate font-mono text-[11px] text-faint" title={p.baseUrl ?? spec?.baseUrl}>{p.baseUrl ?? spec?.baseUrl}</p>}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span className="flex items-center gap-1"><KeyRound className="size-3" aria-hidden /> {p.hasKey ? <span className="font-mono">{p.keyHint}</span> : "no key"}</span>
                  {p.options.streaming === false && <span>no streaming</span>}
                  {p.options.nativeTools === false && <span className="flex items-center gap-1"><Zap className="size-3" aria-hidden /> prompt-based tools</span>}
                  {p.options.extraHeaders && <span>{Object.keys(p.options.extraHeaders).length} custom header{Object.keys(p.options.extraHeaders).length === 1 ? "" : "s"}</span>}
                </div>
                <div className="mt-4 flex items-center gap-1.5 border-t border-line pt-3">
                  {!active && !p.paused && <Button size="sm" variant="soft" onClick={() => use(p)}>Use this</Button>}
                  {byok && <Button size="sm" variant="ghost" onClick={() => setDialog({ editing: p })}><Pencil className="size-3.5" aria-hidden /> Edit</Button>}
                  <Button size="sm" variant="ghost" className="ml-auto hover:text-err" onClick={() => setDel(p)} aria-label={`Remove ${p.label}`}><Trash2 className="size-3.5" aria-hidden /></Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ProviderDialog open={!!dialog} onClose={() => setDialog(null)} editing={dialog?.editing ?? null} initialKind={dialog?.kind} />
      <ConfirmDialog open={!!del} title={`Remove ${del?.label}?`} body="Its saved key and settings will be erased from this machine." confirm="Remove" onConfirm={() => del && remove(del)} onClose={() => setDel(null)} />
    </div>
  );
}

/** Morphie AI: the models your plan includes (and the ones a bigger plan adds), one click to use. */
function MorphieAI({ hosted, activeId }: { hosted: ProfileView[]; activeId: string | null }) {
  const plan = useStore((s) => s.plan);
  const activate = useStore((s) => s.activateProvider);
  const openPlans = useStore((s) => s.openPlans);
  const name = (p: ProfileView) => plan?.models.find((m) => m.id === p.model)?.label ?? p.model;
  const tier = (id: string) => plan?.plans.find((x) => x.id === id)?.name ?? id;
  const mine = plan?.plans.find((p) => p.id === plan.plan)?.name;
  return (
    <section aria-label="Morphie AI" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight"><Gem className="size-4 text-accent" aria-hidden /> Morphie AI</h3>
        <button className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline" onClick={openPlans}>{mine ? `${mine} plan` : "Plans"} · credits</button>
      </div>
      <p className="-mt-1 text-sm text-muted">No keys needed: these run on Morphie's own accounts and use your plan's credits.</p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {hosted.map((p) => {
          const active = p.id === activeId;
          const h = p.hosted!;
          return (
            <li key={p.id} data-testid={`hosted-${p.model}`} className={cn("flex items-center gap-2.5 rounded-xl border bg-panel/80 px-3 py-2.5 transition", active ? "border-accent/50 shadow-glow" : "border-line", (h.locked || !h.available) && "opacity-65")}>
              <BrandMark kind={p.kind} label={name(p)} size="sm" active={active} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 truncate text-sm font-medium">{name(p)}</div>
                <div className="truncate text-[11px] text-muted">{h.free ? "Free daily credits" : `×${h.multiplier} credits`}</div>
              </div>
              {active ? <Badge tone="accent"><Check className="size-3" aria-hidden /> Active</Badge>
                : !h.available ? <Badge tone="neutral">Soon</Badge>
                : h.locked ? <button onClick={openPlans} className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-faint hover:text-fg" aria-label={`${name(p)} needs ${tier(h.tier)}`}><Lock className="size-3" aria-hidden />{tier(h.tier)}</button>
                : <Button size="sm" variant="soft" onClick={() => void activate(p.id)}>Use</Button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
