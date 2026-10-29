"use client";
import { Check, Crown, Gauge, Lock, Sparkles, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatPrice, planHighlights, planIncludes, planRank, typicalTaskCredits, VENDOR_LABEL, type Currency, type Interval, type PlanDef, type PlanId } from "@/lib/plans";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { BillingInfo, OrderView, PlanStatus } from "@/lib/types";
import { CheckoutDialog, rupees, STATUS_LABEL } from "./Checkout";
import { BrandMark } from "../BrandMark";
import { Badge, Button, Segmented, Switch, cn } from "../ui";

const fmt = (n: number) => (n >= 100 ? Math.round(n).toLocaleString("en-US") : (Math.round(n * 10) / 10).toLocaleString("en-US"));
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** ₹ for visitors in India, $ for everyone else (they can switch). */
function guessCurrency(): Currency {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz === "Asia/Kolkata" || tz === "Asia/Calcutta" || /-IN$/i.test(navigator.language)) return "inr";
  } catch { /* default */ }
  return "usd";
}

export const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

const PLAN_ICON: Record<PlanId, string> = { sketch: "✎", shape: "◆", shift: "⟳", morph: "✦" };

export function Meter({ label, used, limit, hint, testId }: { label: string; used: number; limit: number; hint?: string; testId?: string }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
  const tone = pct >= 100 ? "bg-err" : pct >= 80 ? "bg-warn" : "bg-accent";
  return (
    <div data-testid={testId}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="font-mono text-xs tabular-nums text-muted">{fmt(used)} / {fmt(limit)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-sunken ring-1 ring-line" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.round(used)}>
        <div className={cn("h-full rounded-full transition-[width] duration-500", tone)} style={{ width: `${pct}%` }} />
      </div>
      {hint && <p className="mt-1 text-[11px] text-faint">{hint}</p>}
    </div>
  );
}

/** Settings → Plan: your plan and its credits, every plan with its limits, and the Morphie AI models. */
export function PlanSection() {
  const plan = useStore((s) => s.plan);
  const refresh = useStore((s) => s.refreshPlan);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!plan) return <p className="text-sm text-muted">This server has no plans: everything is included, with your own API keys.</p>;
  return <PlanView st={plan} />;
}

function PlanView({ st }: { st: PlanStatus }) {
  const { settings, setSettings } = useStore();
  const [currency, setCurrency] = useState<Currency>(guessCurrency);
  const [interval, setInterval] = useState<Interval>("month");
  const [upgrade, setUpgrade] = useState<PlanDef | null>(null);
  const [resume, setResume] = useState<OrderView | null>(null);
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  useEffect(() => { api<BillingInfo>("/api/billing").then(setBilling, () => {}); }, []);
  const openOrder = billing?.orders.find((o) => o.status === "pending" || o.status === "submitted");
  const endsSoon = st.membership?.endsAt && st.membership.endsAt - Date.now() < 10 * 86_400_000;
  const mine = st.plans.find((p) => p.id === st.plan)!;
  // This account's own limits (an unverified email has a smaller free allowance than the plan card says).
  const l = st.limits ?? mine.limits;
  const freeModel = st.models.find((m) => m.free && m.enabled && planIncludes(st.plan, m));
  const premiumTotal = l.monthlyCredits + st.usage.bonus;

  return (
    <div className="space-y-8">
      <header>
        <h2 className="font-display text-2xl font-semibold tracking-tight">Plan &amp; credits</h2>
        <p className="mt-1 max-w-xl text-sm text-muted">Morphie AI runs top models from Google, OpenAI and Anthropic for you. Each plan includes some of them and a number of credits: 1 credit is about $0.01 of model use, so bigger models use credits faster.</p>
      </header>

      {!st.verified && <p className="rounded-xl border border-warn/40 bg-warn/5 px-3.5 py-2.5 text-[13px] text-warn">Your email isn't verified yet, so paid plans can't apply to this account. Sign in once with an email code to verify it.</p>}

      {openOrder && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-info/30 bg-info/5 px-3.5 py-2.5 text-[13px]" data-testid="open-order">
          <span className="min-w-0 flex-1">{openOrder.status === "submitted" ? `We're checking your payment for ${st.plans.find((p) => p.id === openOrder.plan)?.name} (order ${openOrder.id}).` : `You have an unpaid checkout for ${st.plans.find((p) => p.id === openOrder.plan)?.name} (${rupees(openOrder.amount)}).`}</span>
          <Button size="sm" variant="soft" onClick={() => { setResume(openOrder); setUpgrade(st.plans.find((p) => p.id === openOrder.plan) ?? null); }}>{openOrder.status === "submitted" ? "View" : "Continue"}</Button>
        </div>
      )}
      {!openOrder && endsSoon && mine.id !== "sketch" && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn/5 px-3.5 py-2.5 text-[13px] text-warn" data-testid="renew">
          <span className="min-w-0 flex-1">Your {mine.name} plan ends on {day(st.membership!.endsAt!)}. Renew to keep your models and limits.</span>
          <Button size="sm" variant="soft" onClick={() => setUpgrade(mine)}>Renew</Button>
        </div>
      )}

      <section className="card-surface spotlight relative overflow-hidden rounded-3xl p-5" aria-label="Your plan">
        <div aria-hidden className="pointer-events-none absolute -right-10 -top-16 size-48 rounded-full bg-accent/15 blur-3xl" />
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-accent/12 text-xl text-accent ring-1 ring-accent/25" aria-hidden>{PLAN_ICON[mine.id]}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-xl font-semibold tracking-tight" data-testid="current-plan">{mine.name}</h3>
              {st.admin && <Badge tone="accent"><Crown className="size-3" aria-hidden /> Admin</Badge>}
              {st.unlimited && <Badge tone="ok">No limits</Badge>}
            </div>
            <p className="text-sm text-muted">{mine.tagline}</p>
            <p className="mt-1 text-xs text-faint">
              {st.membership?.endsAt ? `Until ${day(st.membership.endsAt)}` : st.membership ? "No end date" : "Free forever"}
              {st.membership && ` · credits renew on the ${ordinal(new Date(st.period.start).getUTCDate())} of each month`}
            </p>
          </div>
          {mine.id !== "morph" && !st.unlimited && <Button variant="primary" onClick={() => setUpgrade(st.plans[planRank(mine.id) + 1])}><Sparkles className="size-4" aria-hidden /> Upgrade</Button>}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {st.unlimited ? (
            <p className="text-sm text-muted sm:col-span-2" data-testid="unlimited-usage">No credit limits. This month so far: <span className="font-mono tabular-nums text-fg">{fmt(st.usage.month)}</span> premium and <span className="font-mono tabular-nums text-fg">{fmt(st.usage.freeToday)}</span> free-model credits today.</p>
          ) : (
            <>
              {premiumTotal > 0 && <Meter testId="meter-month" label="Premium credits this month" used={st.usage.month} limit={premiumTotal} hint={`Renews ${when(st.period.end)}${st.usage.bonus ? ` · includes ${fmt(st.usage.bonus)} bonus` : ""}`} />}
              {premiumTotal > 0 && l.dailyCredits > 0 && <Meter testId="meter-today" label="Premium credits today" used={st.usage.today} limit={l.dailyCredits} hint={`Resets ${when(st.day.end)}`} />}
              <Meter testId="meter-free" label="Free-model credits today" used={st.usage.freeToday} limit={l.freeDailyCredits} hint={`${freeModel ? `${freeModel.label} and other free models` : "Free models"} · resets ${when(st.day.end)}${!st.verified && l.freeDailyCredits < mine.limits.freeDailyCredits ? ` · verify your email for ${fmt(mine.limits.freeDailyCredits)} a day` : ""}`} />
            </>
          )}
        </div>

        {premiumTotal > 0 && !st.unlimited && (
          <div className="mt-5 flex items-start justify-between gap-4 border-t border-line pt-4">
            <div>
              <p className="text-sm font-medium">Keep going on a free model</p>
              <p className="text-xs leading-relaxed text-muted">When premium credits run out mid-task, carry on with {freeModel?.label ?? "the free model"} instead of pausing.</p>
            </div>
            <Switch label="Keep going on a free model" checked={settings.planFallback !== false} onChange={(v) => void setSettings({ planFallback: v })} />
          </div>
        )}
      </section>

      <section aria-label="Plans" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-lg font-semibold tracking-tight">Plans</h3>
          <div className="flex flex-wrap gap-2">
            <Segmented size="sm" label="Billing period" value={interval} onChange={setInterval} options={[{ value: "month", label: "Monthly" }, { value: "year", label: <span>Yearly <span className="text-ok">· 2 months free</span></span> }]} />
            <Segmented size="sm" label="Currency" value={currency} onChange={setCurrency} options={[{ value: "inr", label: "₹ INR" }, { value: "usd", label: "$ USD" }]} />
          </div>
        </div>
        <ul className="grid gap-3 md:grid-cols-2">
          {st.plans.map((p) => {
            const current = p.id === st.plan;
            const price = p.price[currency][interval];
            const higher = planRank(p.id) > planRank(st.plan);
            return (
              <li key={p.id} data-testid={`plan-${p.id}`} className={cn("relative flex flex-col rounded-2xl border bg-panel/80 p-4 backdrop-blur transition", current ? "border-accent/60 shadow-glow" : "border-line", p.id === "shift" && !current && "ring-1 ring-accent/20")}>
                {p.id === "shift" && !current && <span className="absolute -top-2.5 right-3 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-fg">Popular</span>}
                <div className="flex items-center gap-2">
                  <span className="text-accent" aria-hidden>{PLAN_ICON[p.id]}</span>
                  <h4 className="font-display text-lg font-semibold">{p.name}</h4>
                  {current && <Badge tone="accent"><Check className="size-3" aria-hidden /> Yours</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-muted">{p.tagline}</p>
                <p className="mt-3 font-display text-2xl font-semibold tabular-nums tracking-tight">
                  {formatPrice(price, currency)}<span className="ml-1 text-xs font-normal text-muted">{price ? `/ ${interval}` : ""}</span>
                </p>
                {interval === "year" && price > 0 && <p className="text-[11px] text-faint">{formatPrice(Math.round(price / 12), currency)} a month, billed yearly</p>}
                <ul className="mt-3 flex-1 space-y-1.5 text-[13px] leading-snug">
                  {planHighlights(p, st.plans, st.models).map((h) => <li key={h} className="flex gap-2"><Check className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden /><span>{h}</span></li>)}
                </ul>
                <div className="mt-4">
                  {current ? <Button size="sm" variant="soft" className="w-full" disabled>Current plan</Button>
                    : higher ? <Button size="sm" variant="primary" className="w-full" onClick={() => setUpgrade(p)}>Get {p.name}</Button>
                    : <Button size="sm" variant="ghost" className="w-full" disabled>Included in yours</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <ModelTable st={st} />

      {billing && billing.orders.length > 0 && <Payments orders={billing.orders} plans={st.plans} onOpen={(o) => { setResume(o); setUpgrade(st.plans.find((p) => p.id === o.plan) ?? null); }} />}

      {upgrade && <CheckoutDialog plan={upgrade} billing={billing} initial={resume} startInterval={resume?.period ?? interval} startCurrency={resume ? "inr" : currency}
        onClose={() => { setUpgrade(null); setResume(null); }} onChanged={setBilling} />}
    </div>
  );
}

function ModelTable({ st }: { st: PlanStatus }) {
  const models = useMemo(() => st.models.filter((m) => m.enabled).sort((a, b) => planRank(a.tier) - planRank(b.tier) || a.price.output - b.price.output), [st.models]);
  const tierName = (id: PlanId) => st.plans.find((p) => p.id === id)?.name ?? id;
  return (
    <section aria-label="Morphie AI models" className="space-y-3">
      <div>
        <h3 className="font-display text-lg font-semibold tracking-tight">Models</h3>
        <p className="text-sm text-muted">Pick one from the composer's model menu. The multiplier is how fast it uses credits next to the cheapest premium model.</p>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel/70">
        {models.map((m) => {
          const locked = !planIncludes(st.plan, m);
          return (
            <li key={m.id} className={cn("flex flex-wrap items-center gap-3 px-3.5 py-2.5", locked && "opacity-70")} data-testid={`model-${m.id}`}>
              <BrandMark kind={m.vendor} label={VENDOR_LABEL[m.vendor]} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{m.label}</span>
                  {m.free ? <Badge tone="ok">Free</Badge> : <Badge tone="neutral"><Zap className="size-3" aria-hidden /> ×{m.multiplier}</Badge>}
                  {!m.available && <Badge tone="warn">Not set up</Badge>}
                </div>
                <p className="truncate text-xs text-muted">{m.blurb}</p>
              </div>
              <span className="font-mono text-[11px] tabular-nums text-faint" title="A typical agent task: ~200k tokens in (half cached), 20k out"><Gauge className="mr-1 inline size-3" aria-hidden />≈{fmt(typicalTaskCredits(m))} / task</span>
              {locked ? <Badge tone="warn"><Lock className="size-3" aria-hidden /> {tierName(m.tier)}</Badge> : <Badge tone="accent"><Check className="size-3" aria-hidden /> Included</Badge>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Payments({ orders, plans, onOpen }: { orders: OrderView[]; plans: PlanDef[]; onOpen: (o: OrderView) => void }) {
  return (
    <section aria-label="Payments" className="space-y-3">
      <h3 className="font-display text-lg font-semibold tracking-tight">Payments</h3>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel/70">
        {orders.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5 text-sm" data-testid={`order-${o.id}`}>
            <span className="font-mono text-xs text-muted">{o.id}</span>
            <span className="min-w-0 flex-1">{plans.find((p) => p.id === o.plan)?.name} · {o.period === "year" ? "1 year" : "1 month"} · <span className="tabular-nums">{rupees(o.amount)}</span></span>
            <span className="text-xs text-faint">{day(o.paidAt ?? o.createdAt)}</span>
            <Badge tone={STATUS_LABEL[o.status].tone}>{STATUS_LABEL[o.status].text}</Badge>
            {(o.status === "pending" || o.status === "submitted") && <Button size="sm" variant="ghost" onClick={() => onOpen(o)}>{o.status === "pending" ? "Pay" : "View"}</Button>}
          </li>
        ))}
      </ul>
      <p className="text-xs text-faint">Need an invoice? Ask the admin, with the order code.</p>
    </section>
  );
}
