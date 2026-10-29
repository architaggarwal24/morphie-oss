"use client";
import { AlertTriangle, BadgeCheck, CircleDollarSign, Gift, KeyRound, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PLAN_ORDER, VENDOR_LABEL, type HostedModel, type PlanDef, type PlanFeatures, type PlanId, type PlanLimits, type Vendor } from "@/lib/plans";
import { useStore } from "@/lib/store";
import type { AdminOverview, AdminPayments, MemberView, OrderView, PaymentSettings } from "@/lib/types";
import { rupees, STATUS_LABEL } from "./Checkout";
import { BrandMark } from "../BrandMark";
import { Badge, Button, ConfirmDialog, Dialog, Field, IconButton, Input, Segmented, Select, Spinner, Switch, Textarea, cn } from "../ui";

type Tab = "members" | "payments" | "plans" | "models" | "spend";
const DAY = 86_400_000;
const date = (t: number | null | undefined) => (t ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");
const planName = (o: AdminOverview | null, id: PlanId) => o?.plans.find((p) => p.id === id)?.name ?? id;

/** Settings → Admin: members and their plans, the plans themselves, the Morphie AI models, and spend. */
export function AdminSection() {
  const toast = useStore((s) => s.toast);
  const [o, setO] = useState<AdminOverview | null>(null);
  const [tab, setTab] = useState<Tab>("members");
  const load = useCallback(async () => {
    try { setO(await api<AdminOverview>("/api/admin")); } catch (e) { toast("error", (e as Error).message); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  const save = async (patch: Record<string, unknown>, done = "Saved.") => {
    try { setO(await api<AdminOverview>("/api/admin", { method: "PUT", body: patch })); toast("ok", done); void useStore.getState().refreshPlan(); return true; }
    catch (e) { toast("error", (e as Error).message); return false; }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-tight"><ShieldCheck className="size-6 text-accent" aria-hidden /> Admin</h2>
          <p className="mt-1 max-w-xl text-sm text-muted">Give anyone a plan, add bonus credits, tune the plans and models, and keep Morphie AI spend inside its budgets.</p>
        </div>
        <Segmented label="Admin section" kind="tab" value={tab} onChange={setTab} size="sm" options={[
          { value: "members", label: "Members" }, { value: "payments", label: "Payments" }, { value: "plans", label: "Plans" }, { value: "models", label: "Models" }, { value: "spend", label: "Spend" },
        ]} />
      </header>
      {o && !o.enabled && (
        <p className="flex gap-2 rounded-xl border border-warn/40 bg-warn/5 px-3.5 py-2.5 text-[13px] text-warn"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Plans are off on this server, so nothing here applies yet. Set <code className="font-mono">MORPHIE_PLANS=on</code> and your Morphie AI keys (<code className="font-mono">MORPHIE_AI_GEMINI_KEY</code> and friends) to turn them on. You can set everything up first.</span>
        </p>
      )}
      {!o ? <div className="grid place-items-center py-10"><Spinner /></div>
        : tab === "members" ? <Members o={o} onChanged={load} />
        : tab === "payments" ? <PaymentsAdmin o={o} />
        : tab === "plans" ? <PlansEditor o={o} save={save} />
        : tab === "models" ? <ModelsEditor o={o} save={save} />
        : <SpendView o={o} save={save} reload={load} />}
    </div>
  );
}

// ------------------------------------------------------------------ members

interface GrantForm { email: string; plan: PlanId; days: string; unlimited: boolean; note: string }

function Members({ o, onChanged }: { o: AdminOverview; onChanged: () => void }) {
  const toast = useStore((s) => s.toast);
  const [q, setQ] = useState("");
  const [list, setList] = useState<MemberView[] | null>(null);
  const [grant, setGrant] = useState<GrantForm | null>(null);
  const [credits, setCredits] = useState<{ email: string; credits: string; days: string; note: string } | null>(null);
  const [revoke, setRevoke] = useState<MemberView | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (text: string) => {
    try { setList((await api<{ members: MemberView[] }>(`/api/admin/members?q=${encodeURIComponent(text)}`)).members); } catch (e) { toast("error", (e as Error).message); }
  }, [toast]);
  useEffect(() => { const t = setTimeout(() => void search(q), q ? 250 : 0); return () => clearTimeout(t); }, [q, search]);

  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try { await api("/api/admin/members", { method: "POST", body }); toast("ok", done); await search(q); onChanged(); void useStore.getState().refreshPlan(); return true; }
    catch (e) { toast("error", (e as Error).message); return false; }
    finally { setBusy(false); }
  };

  return (
    <section className="space-y-4" aria-label="Members">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by email" aria-label="Search members" className="pl-9" />
        </div>
        <Button variant="primary" onClick={() => setGrant({ email: q.includes("@") ? q : "", plan: "morph", days: "0", unlimited: true, note: "" })}><UserPlus className="size-4" aria-hidden /> Give a plan</Button>
      </div>
      <p className="text-xs text-muted">{o.counts.users} accounts · {PLAN_ORDER.filter((p) => p !== "sketch").map((p) => `${o.counts.byPlan[p] ?? 0} on ${planName(o, p)}`).join(" · ")}. A plan given to an email that hasn't signed up yet starts when they do (with a verified email).</p>

      {!list ? <div className="grid place-items-center py-8"><Spinner /></div> : !list.length ? <p className="py-6 text-center text-sm text-muted">No one matches.</p> : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel/70">
          {list.map((m) => (
            <li key={m.email} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5" data-testid={`member-${m.email}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{m.email}</span>
                  {m.verified ? <BadgeCheck className="size-3.5 text-ok" aria-label="Verified email" /> : m.userId ? <Badge tone="warn">Unverified</Badge> : <Badge tone="info">Not signed up</Badge>}
                  {m.admin && <Badge tone="accent">Admin</Badge>}
                </div>
                <p className="text-xs text-muted">
                  <span className="font-medium text-fg">{planName(o, m.plan)}</span>{m.unlimited && " · no limits"}
                  {m.membership && ` · ${m.membership.endsAt ? `until ${date(m.membership.endsAt)}` : "no end date"}`}
                  {m.membership?.note && ` · ${m.membership.note}`}
                  {m.userId && ` · ${m.credits30.toLocaleString()} credits in 30 days`}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="soft" onClick={() => setGrant({ email: m.email, plan: m.membership ? m.plan : "shape", days: m.membership?.endsAt ? String(Math.max(1, Math.round((m.membership.endsAt - Date.now()) / DAY))) : m.membership ? "0" : "30", unlimited: m.unlimited && !m.admin, note: m.membership?.note ?? "" })}>{m.membership ? "Change" : "Give plan"}</Button>
                <IconButton label={`Bonus credits for ${m.email}`} onClick={() => setCredits({ email: m.email, credits: "100", days: "30", note: "" })}><Gift className="size-4" /></IconButton>
                {m.membership && <IconButton label={`Remove ${m.email}'s plan`} onClick={() => setRevoke(m)} className="hover:text-err"><Trash2 className="size-4" /></IconButton>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!grant} onClose={() => setGrant(null)} title="Give a plan" description="Starts now. Credits renew monthly from today."
        footer={<><Button variant="ghost" onClick={() => setGrant(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
          if (!grant) return;
          if (await act({ action: "grant", email: grant.email.trim(), plan: grant.plan, days: Number(grant.days), unlimited: grant.unlimited, note: grant.note }, `${grant.email.trim()} is on ${planName(o, grant.plan)}.`)) setGrant(null);
        }}>Save</Button></>}>
        {grant && (
          <div className="space-y-4">
            <Field label="Email" htmlFor="grant-email"><Input id="grant-email" type="email" value={grant.email} onChange={(e) => setGrant({ ...grant, email: e.target.value })} placeholder="tester@example.com" /></Field>
            <Field label="Plan"><Segmented label="Plan" value={grant.plan} onChange={(plan) => setGrant({ ...grant, plan })} options={PLAN_ORDER.map((p) => ({ value: p, label: planName(o, p) }))} /></Field>
            <Field label="For how long">
              <Select aria-label="Duration" value={grant.days} onValueChange={(days) => setGrant({ ...grant, days })} options={[
                { value: "7", label: "1 week" }, { value: "30", label: "1 month" }, { value: "90", label: "3 months" }, { value: "365", label: "1 year" }, { value: "0", label: "Until I remove it" },
                ...(["7", "30", "90", "365", "0"].includes(grant.days) ? [] : [{ value: grant.days, label: `${grant.days} more days` }]),
              ]} />
            </Field>
            <div className="flex items-start justify-between gap-4">
              <div><p className="text-sm font-medium">No limits</p><p className="text-xs text-muted">Full access: no credit caps (for you and testers). Spend still counts toward the budgets.</p></div>
              <Switch label="No limits" checked={grant.unlimited} onChange={(unlimited) => setGrant({ ...grant, unlimited })} />
            </div>
            <Field label="Note (only admins see it)" htmlFor="grant-note"><Input id="grant-note" value={grant.note} onChange={(e) => setGrant({ ...grant, note: e.target.value })} placeholder="Beta tester, paid by UPI on 2 Nov…" maxLength={200} /></Field>
          </div>
        )}
      </Dialog>

      <Dialog open={!!credits} onClose={() => setCredits(null)} title="Bonus credits" description={credits?.email}
        footer={<><Button variant="ghost" onClick={() => setCredits(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
          if (!credits) return;
          if (await act({ action: "credits", email: credits.email, credits: Number(credits.credits), days: Number(credits.days), note: credits.note }, `Added ${credits.credits} credits for ${credits.email}.`)) setCredits(null);
        }}>Add credits</Button></>}>
        {credits && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Credits" htmlFor="bonus-credits" hint="Premium credits on top of the plan (negative takes some back)."><Input id="bonus-credits" type="number" value={credits.credits} onChange={(e) => setCredits({ ...credits, credits: e.target.value })} /></Field>
            <Field label="Valid for (days)" htmlFor="bonus-days"><Input id="bonus-days" type="number" min={1} value={credits.days} onChange={(e) => setCredits({ ...credits, days: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Field label="Note" htmlFor="bonus-note"><Input id="bonus-note" value={credits.note} onChange={(e) => setCredits({ ...credits, note: e.target.value })} maxLength={200} /></Field></div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog open={!!revoke} title={`Remove ${revoke?.email}'s plan?`} body="They go back to Sketch (free) straight away. Their data stays." confirm="Remove plan"
        onConfirm={() => revoke && void act({ action: "revoke", email: revoke.email }, `${revoke.email} is back on ${planName(o, "sketch")}.`)} onClose={() => setRevoke(null)} />
    </section>
  );
}

// ------------------------------------------------------------------ plans

const LIMIT_FIELDS: Array<{ key: keyof PlanLimits; label: string; step?: number }> = [
  { key: "monthlyCredits", label: "Premium credits / month" }, { key: "dailyCredits", label: "Premium credits / day (0 = no cap)" },
  { key: "freeDailyCredits", label: "Free-model credits / day" }, { key: "taskTokenBudget", label: "Agent task budget (tokens)", step: 10_000 },
  { key: "projects", label: "Projects" }, { key: "documents", label: "Documents (max 50)" }, { key: "designs", label: "Designs" }, { key: "designSystems", label: "Design systems (max 30)" },
];
const FEATURE_FIELDS: Array<{ key: keyof PlanFeatures; label: string }> = [
  { key: "byok", label: "Own API keys" }, { key: "skillImports", label: "Skill imports" }, { key: "githubRepos", label: "GitHub repos" }, { key: "webSearch", label: "Web search" }, { key: "subagents", label: "Sub-agents" },
];

function PlansEditor({ o, save }: { o: AdminOverview; save: (p: Record<string, unknown>, done?: string) => Promise<boolean> }) {
  const [plans, setPlans] = useState<PlanDef[]>(o.plans);
  const [reset, setReset] = useState(false);
  useEffect(() => setPlans(o.plans), [o.plans]);
  const dirty = JSON.stringify(plans) !== JSON.stringify(o.plans);
  const edit = (id: PlanId, fn: (p: PlanDef) => PlanDef) => setPlans((ps) => ps.map((p) => (p.id === id ? fn(p) : p)));
  const num = (v: string) => (v === "" ? 0 : Number(v));
  return (
    <section className="space-y-4" aria-label="Plans editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Plan cards describe these numbers, so they always match what's enforced.</p>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setReset(true)}><RotateCcw className="size-3.5" aria-hidden /> Defaults</Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save({ plans }, "Plans saved.")}>Save plans</Button>
        </div>
      </div>
      {plans.map((p) => (
        <details key={p.id} className="group rounded-2xl border border-line bg-panel/70 open:shadow-card" open={p.id === "sketch"}>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3">
            <span className="font-display text-base font-semibold">{p.name}</span>
            <span className="text-xs text-muted">₹{p.price.inr.month} · ${p.price.usd.month} / month · {p.limits.monthlyCredits.toLocaleString()} credits</span>
          </summary>
          <div className="grid gap-3 border-t border-line p-4 sm:grid-cols-2">
            <Field label="Name" htmlFor={`${p.id}-name`}><Input id={`${p.id}-name`} value={p.name} maxLength={30} onChange={(e) => edit(p.id, (x) => ({ ...x, name: e.target.value }))} /></Field>
            <Field label="Tagline" htmlFor={`${p.id}-tag`}><Input id={`${p.id}-tag`} value={p.tagline} maxLength={120} onChange={(e) => edit(p.id, (x) => ({ ...x, tagline: e.target.value }))} /></Field>
            {LIMIT_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`${p.id}-${f.key}`}>
                <Input id={`${p.id}-${f.key}`} type="number" min={0} step={f.step ?? 1} value={p.limits[f.key]} onChange={(e) => edit(p.id, (x) => ({ ...x, limits: { ...x.limits, [f.key]: num(e.target.value) } }))} />
              </Field>
            ))}
            {(["inr", "usd"] as const).flatMap((cur) => (["month", "year"] as const).map((iv) => (
              <Field key={`${cur}-${iv}`} label={`Price ${cur === "inr" ? "₹" : "$"} / ${iv}`} htmlFor={`${p.id}-${cur}-${iv}`}>
                <Input id={`${p.id}-${cur}-${iv}`} type="number" min={0} value={p.price[cur][iv]} onChange={(e) => edit(p.id, (x) => ({ ...x, price: { ...x.price, [cur]: { ...x.price[cur], [iv]: num(e.target.value) } } }))} />
              </Field>
            )))}
            <div className="flex flex-wrap gap-x-5 gap-y-2 sm:col-span-2">
              {FEATURE_FIELDS.map((f) => (
                <label key={f.key} className="flex items-center gap-2 text-sm">
                  <Switch label={`${p.name}: ${f.label}`} checked={p.features[f.key]} onChange={(v) => edit(p.id, (x) => ({ ...x, features: { ...x.features, [f.key]: v } }))} /> {f.label}
                </label>
              ))}
            </div>
          </div>
        </details>
      ))}
      <ConfirmDialog open={reset} title="Reset plans and models to the defaults?" body="Every plan's limits and prices, the model list and the budgets go back to what Morphie ships with." confirm="Reset"
        onConfirm={() => void save({ reset: true }, "Back to the defaults.")} onClose={() => setReset(false)} />
    </section>
  );
}

// ------------------------------------------------------------------ models

const blankModel = (): HostedModel => ({ id: "", vendor: "openai", label: "", blurb: "", tier: "shift", free: false, price: { input: 1, output: 5 }, enabled: true, vision: true });

function ModelsEditor({ o, save }: { o: AdminOverview; save: (p: Record<string, unknown>, done?: string) => Promise<boolean> }) {
  const [models, setModels] = useState<HostedModel[]>(o.models);
  const [def, setDef] = useState(o.defaultModel);
  useEffect(() => { setModels(o.models); setDef(o.defaultModel); }, [o.models, o.defaultModel]);
  const dirty = JSON.stringify(models) !== JSON.stringify(o.models) || def !== o.defaultModel;
  const edit = (i: number, patch: Partial<HostedModel>) => setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const known = new Set(o.models.map((m) => m.id));
  const freeChoices = models.filter((m) => m.enabled && m.tier === "sketch" && m.id);
  return (
    <section className="space-y-4" aria-label="Models editor">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-[220px]">
          <div className="mb-1 text-sm font-medium">Default model</div>
          <Select aria-label="Default model" value={def} onValueChange={setDef} options={freeChoices.map((m) => ({ value: m.id, label: m.label }))} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setModels((ms) => [...ms, blankModel()])}><Plus className="size-3.5" aria-hidden /> Add model</Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save({ models: models.map((m) => ({ ...m, price: { ...m.price, cached: m.price.cached || undefined } })), defaultModel: def }, "Models saved.")}>Save models</Button>
        </div>
      </div>
      <p className="text-xs text-muted">Prices are the provider's list price in US dollars per 1M tokens: they decide how many credits a call costs. "Free" models use the free daily allowance (Gemini's free tier).</p>
      <ul className="space-y-2">
        {models.map((m, i) => (
          <li key={`${m.id}-${i}`} className={cn("rounded-2xl border border-line bg-panel/70 p-3", !m.enabled && "opacity-60")} data-testid={`edit-model-${m.id || i}`}>
            <div className="flex items-center gap-2">
              <BrandMark kind={m.vendor} label={VENDOR_LABEL[m.vendor]} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.label || "New model"}</span>
              <label className="flex items-center gap-1.5 text-xs text-muted"><Switch label={`${m.label || "Model"} is free`} checked={m.free} onChange={(free) => edit(i, { free })} /> Free</label>
              <label className="flex items-center gap-1.5 text-xs text-muted"><Switch label={`${m.label || "Model"} enabled`} checked={m.enabled} onChange={(enabled) => edit(i, { enabled })} /> On</label>
              {!known.has(m.id) && <IconButton label="Remove this model" onClick={() => setModels((ms) => ms.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Mini label="Name"><Input aria-label="Label" value={m.label} placeholder="Display name" onChange={(e) => edit(i, { label: e.target.value })} /></Mini>
              <Mini label="API model id"><Input aria-label="Model id" value={m.id} placeholder="api-model-id" readOnly={known.has(m.id) && !!m.id} onChange={(e) => edit(i, { id: e.target.value.trim() })} className="font-mono text-xs" /></Mini>
              <Mini label="Vendor"><Select aria-label="Vendor" value={m.vendor} onValueChange={(v) => edit(i, { vendor: v as Vendor })} options={(["gemini", "openai", "anthropic"] as Vendor[]).map((v) => ({ value: v, label: VENDOR_LABEL[v] }))} /></Mini>
              <Mini label="Lowest plan"><Select aria-label="Lowest plan" value={m.tier} onValueChange={(v) => edit(i, { tier: v as PlanId })} options={PLAN_ORDER.map((p) => ({ value: p, label: planName(o, p) }))} /></Mini>
              <Mini label="$ / 1M input"><Input aria-label="Input price" type="number" min={0} step={0.01} value={m.price.input} onChange={(e) => edit(i, { price: { ...m.price, input: Number(e.target.value) } })} /></Mini>
              <Mini label="$ / 1M cached input"><Input aria-label="Cached input price" type="number" min={0} step={0.001} value={m.price.cached ?? ""} placeholder={String(m.price.input / 10)} onChange={(e) => edit(i, { price: { ...m.price, cached: e.target.value === "" ? undefined : Number(e.target.value) } })} /></Mini>
              <Mini label="$ / 1M output"><Input aria-label="Output price" type="number" min={0} step={0.01} value={m.price.output} onChange={(e) => edit(i, { price: { ...m.price, output: Number(e.target.value) } })} /></Mini>
              <Mini label="One line about it"><Input aria-label="Blurb" value={m.blurb} onChange={(e) => edit(i, { blurb: e.target.value })} maxLength={160} /></Mini>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Mini({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1 block text-[11px] font-medium text-muted">{label}</span>{children}</label>;
}

// ------------------------------------------------------------------ spend

function SpendView({ o, save, reload }: { o: AdminOverview; save: (p: Record<string, unknown>, done?: string) => Promise<boolean>; reload: () => Promise<void> }) {
  const [budgets, setBudgets] = useState(o.budgets);
  useEffect(() => setBudgets(o.budgets), [o.budgets]);
  const [unverified, setUnverified] = useState(o.unverifiedFreeDaily);
  useEffect(() => setUnverified(o.unverifiedFreeDaily), [o.unverifiedFreeDaily]);
  const dirty = JSON.stringify(budgets) !== JSON.stringify(o.budgets) || unverified !== o.unverifiedFreeDaily;
  return (
    <section className="space-y-4" aria-label="Spend">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Morphie AI spend since {date(o.monthStart)}, at list price. When a vendor reaches its budget, its models pause for everyone until next month (0 = no budget).</p>
        <div className="flex gap-2">
          <IconButton label="Refresh" onClick={() => void reload()}><RefreshCw className="size-4" /></IconButton>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save({ budgets, unverifiedFreeDaily: unverified }, "Budgets saved.")}>Save budgets</Button>
        </div>
      </div>
      <ul className="grid gap-3 md:grid-cols-3">
        {o.spend.map((s) => {
          const budget = budgets[s.vendor];
          const pct = budget > 0 ? Math.min(100, (s.usd / budget) * 100) : 0;
          const tone = pct >= 100 ? "bg-err" : pct >= 80 ? "bg-warn" : "bg-accent";
          return (
            <li key={s.vendor} className="card-surface rounded-2xl p-4" data-testid={`spend-${s.vendor}`}>
              <div className="flex items-center gap-2">
                <BrandMark kind={s.vendor} label={VENDOR_LABEL[s.vendor]} size="sm" />
                <span className="text-sm font-medium">{VENDOR_LABEL[s.vendor]}</span>
                <span className="flex-1" />
                {s.keyed ? <Badge tone="ok"><KeyRound className="size-3" aria-hidden /> Key set</Badge> : <Badge tone="warn">No key</Badge>}
              </div>
              <p className="mt-3 font-display text-2xl font-semibold tabular-nums">${s.usd.toFixed(2)}<span className="ml-1 text-xs font-normal text-muted">{budget > 0 ? `of $${budget}` : "no budget"}</span></p>
              {budget > 0 && <div className="mt-2 h-2 overflow-hidden rounded-full bg-sunken ring-1 ring-line"><div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} /></div>}
              {pct >= 80 && <p className="mt-1.5 flex items-center gap-1 text-xs text-warn"><AlertTriangle className="size-3.5" aria-hidden /> {pct >= 100 ? "Budget reached: these models are paused." : "Over 80% of the budget."}</p>}
              <p className="mt-1.5 text-xs text-muted">{s.calls.toLocaleString()} calls{s.free ? ` · plus ${s.free.calls.toLocaleString()} free-tier calls ($${s.free.usd.toFixed(2)} at list price)` : ""}</p>
              <div className="mt-3"><Field label="Monthly budget ($)" htmlFor={`budget-${s.vendor}`}><Input id={`budget-${s.vendor}`} type="number" min={0} value={budget} onChange={(e) => setBudgets({ ...budgets, [s.vendor]: Number(e.target.value || 0) })} /></Field></div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-end gap-4 rounded-2xl border border-line bg-panel/70 p-4 text-sm">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-medium"><BadgeCheck className="size-4 text-accent" aria-hidden /> Unverified accounts</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">Free-model credits a day for an account whose email isn't verified yet (password sign-ups). Accounts are free to make, so this keeps the free models from being farmed. Verifying gives the plan's full allowance.</p>
        </div>
        <div className="w-40"><Field label="Credits / day" htmlFor="unverified-free"><Input id="unverified-free" type="number" min={0} value={unverified} onChange={(e) => setUnverified(Math.max(0, Math.floor(Number(e.target.value || 0))))} /></Field></div>
      </div>
      <div className="rounded-2xl border border-line bg-panel/70 p-4 text-sm">
        <p className="flex items-center gap-2 font-medium"><CircleDollarSign className="size-4 text-accent" aria-hidden /> Keys</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">Set these as server secrets: <code className="font-mono">MORPHIE_AI_GEMINI_FREE_KEY</code> ({o.keys.geminiFree ? "set" : "not set"}: a Google project without billing, for the free models), <code className="font-mono">MORPHIE_AI_GEMINI_KEY</code> ({o.keys.gemini ? "set" : "not set"}), <code className="font-mono">MORPHIE_AI_OPENAI_KEY</code> ({o.keys.openai ? "set" : "not set"}), <code className="font-mono">MORPHIE_AI_ANTHROPIC_KEY</code> ({o.keys.anthropic ? "set" : "not set"}). Admins: {o.admins.join(", ") || "none"} (<code className="font-mono">MORPHIE_ADMIN_EMAILS</code>).</p>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ payments

type OrderFilter = "review" | "open" | "all";

export function PaymentsAdmin({ o }: { o: AdminOverview }) {
  const toast = useStore((s) => s.toast);
  const [p, setP] = useState<AdminPayments | null>(null);
  const [filter, setFilter] = useState<OrderFilter>("review");
  const [form, setForm] = useState<PaymentSettings | null>(null);
  const [domains, setDomains] = useState("");
  const [approve, setApprove] = useState<OrderView | null>(null);
  const [utr, setUtr] = useState("");
  const [reject, setReject] = useState<OrderView | null>(null);
  const [reason, setReason] = useState("");
  const [paste, setPaste] = useState("");
  const [checked, setChecked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api<AdminPayments>("/api/admin/payments"); setP(r); setForm(r.settings); setDomains(r.settings.email.domains.join(", ")); }
    catch (e) { toast("error", (e as Error).message); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  const post = async (body: Record<string, unknown>, done?: string) => {
    setBusy(true);
    try { const r = await api<AdminPayments & { result?: { outcome: string; orderId?: string; reason?: string } }>("/api/admin/payments", { method: "POST", body }); setP(r); if (done) toast("ok", done); return r; }
    catch (e) { toast("error", (e as Error).message); return null; }
    finally { setBusy(false); }
  };

  if (!p || !form) return <div className="grid place-items-center py-10"><Spinner /></div>;
  const shown = p.orders.filter((x) => filter === "all" || (filter === "review" ? x.status === "submitted" : x.status === "pending" || x.status === "submitted"));
  const review = p.orders.filter((x) => x.status === "submitted").length;
  const dirty = JSON.stringify({ ...form, email: { ...form.email, domains: domains.split(",").map((d) => d.trim()).filter(Boolean) } }) !== JSON.stringify(p.settings);

  return (
    <section className="space-y-6" aria-label="Payments">
      <div className="card-surface space-y-4 rounded-2xl p-4">
        <div className="flex items-start justify-between gap-4">
          <div><p className="text-sm font-medium">UPI checkout</p><p className="text-xs leading-relaxed text-muted">People pay your UPI ID directly (no gateway, no fees) and type the UPI reference. ₹ prices only; $ shows "coming soon".</p></div>
          <Switch label="UPI checkout" checked={form.upi.enabled} onChange={(enabled) => setForm({ ...form, upi: { ...form.upi, enabled } })} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Your UPI ID" htmlFor="upi-vpa"><Input id="upi-vpa" value={form.upi.vpa} placeholder="yourname@okhdfcbank" onChange={(e) => setForm({ ...form, upi: { ...form.upi, vpa: e.target.value } })} /></Field>
          <Field label="Name shown in UPI apps" htmlFor="upi-payee"><Input id="upi-payee" value={form.upi.payee} maxLength={60} onChange={(e) => setForm({ ...form, upi: { ...form.upi, payee: e.target.value } })} /></Field>
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-line pt-4">
          <div>
            <p className="text-sm font-medium">Confirm automatically from bank alerts</p>
            <p className="text-xs leading-relaxed text-muted">Forward your bank's credit alert emails to this Worker (Cloudflare Email Routing). Each one must carry a valid DKIM signature from a domain below; its amount and UTR are matched to the open order. {p.inboundReady ? <span className="text-ok">MORPHIE_INBOUND_SECRET is set.</span> : <span className="text-warn">Set MORPHIE_INBOUND_SECRET (24+ characters) to turn the inbox on.</span>}</p>
          </div>
          <Switch label="Confirm from bank alerts" checked={form.email.enabled} onChange={(enabled) => setForm({ ...form, email: { ...form.email, enabled } })} />
        </div>
        <Field label="Bank email domains" htmlFor="bank-domains" hint="Comma-separated, e.g. hdfcbank.net, icicibank.com, axisbank.com"><Input id="bank-domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="hdfcbank.net" /></Field>
        <div className="flex justify-end"><Button size="sm" variant="primary" disabled={!dirty} loading={busy} onClick={() => void post({ action: "settings", upi: form.upi, email: { enabled: form.email.enabled, domains: domains.split(",").map((d) => d.trim()).filter(Boolean) } }, "Payment settings saved.")}>Save payment settings</Button></div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-lg font-semibold tracking-tight">Orders</h3>
          <div className="flex gap-2">
            <Segmented size="sm" label="Show orders" value={filter} onChange={setFilter} options={[{ value: "review", label: `To check${review ? ` · ${review}` : ""}` }, { value: "open", label: "Open" }, { value: "all", label: "All" }]} />
            <IconButton label="Refresh payments" onClick={() => void load()}><RefreshCw className="size-4" /></IconButton>
          </div>
        </div>
        {!shown.length ? <p className="py-6 text-center text-sm text-muted">{filter === "review" ? "Nothing to check right now." : "No orders."}</p> : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel/70">
            {shown.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5" data-testid={`admin-order-${x.id}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm"><span className="font-mono text-xs">{x.id}</span><span className="font-medium">{x.email}</span><Badge tone={STATUS_LABEL[x.status].tone}>{STATUS_LABEL[x.status].text}</Badge></div>
                  <p className="text-xs text-muted">{planName(o, x.plan)} · {x.period === "year" ? "yearly" : "monthly"} · <span className="font-medium tabular-nums text-fg">{rupees(x.amount)}</span>{x.utr && <> · UTR <span className="font-mono">{x.utr}</span></>} · {date(x.createdAt)}{x.reason && ` · ${x.reason}`}</p>
                </div>
                {(x.status === "submitted" || x.status === "pending" || x.status === "expired") && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="soft" onClick={() => { setApprove(x); setUtr(x.utr ?? ""); }}>Approve</Button>
                    {x.status !== "expired" && <Button size="sm" variant="ghost" onClick={() => { setReject(x); setReason(""); }}>Reject</Button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="font-display text-lg font-semibold tracking-tight">Bank alerts</h3>
        <div className="space-y-2 rounded-2xl border border-line bg-panel/70 p-3">
          <label htmlFor="paste-alert" className="text-sm font-medium">Paste a bank alert</label>
          <Textarea id="paste-alert" rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Rs.1,499.37 credited to your A/c XX1234 by VPA name@okicici on 28-10-26. UPI Ref No 430212345678." />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">{checked ?? "Matches the amount and UTR to an open order and confirms it (you're trusted, so no DKIM check)."}</span>
            <Button size="sm" variant="soft" disabled={paste.trim().length < 10} loading={busy} onClick={async () => {
              const r = await post({ action: "check", raw: `Subject: Pasted alert\r\n\r\n${paste}` });
              if (r?.result) { setChecked(r.result.outcome === "matched" ? `Confirmed order ${r.result.orderId}.` : `${r.result.outcome}: ${r.result.reason ?? ""}`); if (r.result.outcome === "matched") setPaste(""); }
            }}>Check</Button>
          </div>
        </div>
        {p.inbox.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel/70">
            {p.inbox.map((m) => (
              <li key={m.id} className="px-3.5 py-2.5 text-xs" data-testid={`inbox-${m.id}`}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={m.outcome === "matched" ? "ok" : m.outcome === "rejected" ? "err" : m.outcome === "unmatched" ? "warn" : "neutral"}>{m.outcome}</Badge>
                  <span className="font-medium text-fg">{m.sender || "pasted"}</span>{m.dkim && <span className="text-faint">· signed by {m.dkim}</span>}<span className="text-faint">· {date(m.at)}</span>
                </div>
                <p className="mt-0.5 text-muted">{m.amount != null && <>{rupees(m.amount)} · </>}{m.utr && <>UTR <span className="font-mono">{m.utr}</span> · </>}{m.orderId ? `order ${m.orderId}` : m.subject}</p>
                {m.outcome !== "matched" && <p className="mt-0.5 line-clamp-2 text-faint">{m.excerpt}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={!!approve} onClose={() => setApprove(null)} title={`Approve ${approve?.id}`} description={approve ? `${approve.email} · ${planName(o, approve.plan)} · ${rupees(approve.amount)}` : undefined}
        footer={<><Button variant="ghost" onClick={() => setApprove(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
          if (!approve) return;
          if (await post({ action: "approve", order: approve.id, ...(utr && !approve.utr ? { utr } : {}) }, `${approve.email} is on ${planName(o, approve.plan)}.`)) setApprove(null);
        }}>Mark paid</Button></>}>
        <p className="text-sm text-muted">Check your bank app for <span className="font-medium text-fg">{approve && rupees(approve.amount)}</span>{approve?.utr ? <> with UTR <span className="font-mono text-fg">{approve.utr}</span></> : ""}. Marking it paid starts (or extends) their plan straight away.</p>
        {approve && !approve.utr && <div className="mt-3"><Field label="UTR (optional)" htmlFor="approve-utr"><Input id="approve-utr" inputMode="numeric" maxLength={12} value={utr} onChange={(e) => setUtr(e.target.value.replace(/\D/g, ""))} /></Field></div>}
      </Dialog>

      <Dialog open={!!reject} onClose={() => setReject(null)} title={`Reject ${reject?.id}`} description={reject?.email}
        footer={<><Button variant="ghost" onClick={() => setReject(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
          if (!reject) return;
          if (await post({ action: "reject", order: reject.id, reason }, `Rejected ${reject.id}.`)) setReject(null);
        }}>Reject</Button></>}>
        <Field label="Reason (they see it)" htmlFor="reject-reason"><Input id="reject-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="No payment with this UTR arrived" /></Field>
      </Dialog>
    </section>
  );
}
