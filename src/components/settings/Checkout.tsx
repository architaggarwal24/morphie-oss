"use client";
import { CheckCircle2, Clock, Copy, ExternalLink, QrCode, Smartphone, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { formatPrice, type Currency, type Interval, type PlanDef } from "@/lib/plans";
import { qrSvg } from "@/lib/qr";
import { useStore } from "@/lib/store";
import type { BillingInfo, OrderView } from "@/lib/types";
import { Badge, Button, Dialog, Input, Segmented, cn } from "../ui";

export const rupees = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const until = (t: number) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

export const STATUS_LABEL: Record<OrderView["status"], { text: string; tone: "neutral" | "accent" | "ok" | "warn" | "err" | "info" }> = {
  pending: { text: "Waiting for payment", tone: "warn" }, submitted: { text: "Checking payment", tone: "info" }, paid: { text: "Paid", tone: "ok" },
  rejected: { text: "Not confirmed", tone: "err" }, canceled: { text: "Canceled", tone: "neutral" }, expired: { text: "Expired", tone: "neutral" },
};

/**
 * Checkout: pick monthly or yearly, then pay by UPI (QR on a computer, the UPI app on a phone) and type the UPI
 * reference. The dialog then waits for the payment to be confirmed (automatically from the bank's alert, or by an admin).
 */
export function CheckoutDialog({ plan, billing, initial, startInterval, startCurrency, onClose, onChanged }: {
  plan: PlanDef | null; billing: BillingInfo | null; initial?: OrderView | null; startInterval: Interval; startCurrency: Currency;
  onClose: () => void; onChanged: (b: BillingInfo) => void;
}) {
  const toast = useStore((s) => s.toast);
  const refreshPlan = useStore((s) => s.refreshPlan);
  const [interval, setPeriod] = useState<Interval>(startInterval);
  const [currency, setCurrency] = useState<Currency>(startCurrency);
  const [order, setOrder] = useState<OrderView | null>(initial ?? null);
  const [utr, setUtr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOrder(initial ?? null); setPeriod(startInterval); setCurrency(startCurrency); setUtr(""); }, [plan, initial, startInterval, startCurrency]);

  // Waiting on a payment: check every few seconds until it's decided.
  const waiting = order?.status === "submitted" || order?.status === "pending";
  useEffect(() => {
    if (!order || !waiting) return;
    const t = setInterval(async () => {
      try {
        const r = await api<{ order: OrderView }>(`/api/billing/orders/${order.id}`);
        if (r.order.status !== order.status) {
          setOrder(r.order);
          if (r.order.status === "paid") { toast("ok", `You're on ${plan?.name} now. Thank you!`); void refreshPlan(); onChanged(await api<BillingInfo>("/api/billing")); }
        }
      } catch { /* try again next tick */ }
    }, 6000);
    return () => clearInterval(t);
  }, [order, waiting, plan, toast, refreshPlan, onChanged]);

  if (!plan) return null;
  const price = plan.price[currency][interval];
  const upiOn = !!billing?.upi.enabled;

  const start = async () => {
    setBusy(true);
    try {
      const r = await api<BillingInfo & { order: OrderView }>("/api/billing", { method: "POST", body: { plan: plan.id, period: interval, currency } });
      setOrder(r.order);
      onChanged(r);
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };
  const act = async (body: Record<string, unknown>) => {
    if (!order) return;
    setBusy(true);
    try {
      const r = await api<{ order: OrderView }>(`/api/billing/orders/${order.id}`, { method: "POST", body });
      setOrder(r.order);
      onChanged(await api<BillingInfo>("/api/billing"));
      if (body.action === "cancel") onClose();
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Dialog open onClose={onClose} title={order ? `${plan.name} · ${order.period === "year" ? "yearly" : "monthly"}` : `Get ${plan.name}`} description={order ? `Order ${order.id}` : plan.tagline} width="max-w-md">
      {!order ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Segmented size="sm" label="Billing period" value={interval} onChange={setPeriod} options={[{ value: "month", label: "Monthly" }, { value: "year", label: <span>Yearly <span className="text-ok">· 2 months free</span></span> }]} />
            <Segmented size="sm" label="Currency" value={currency} onChange={setCurrency} options={[{ value: "inr", label: "₹ UPI" }, { value: "usd", label: "$ Card" }]} />
          </div>
          <p className="font-display text-3xl font-semibold tabular-nums tracking-tight">{formatPrice(price, currency)}<span className="ml-1 text-sm font-normal text-muted">/ {interval}</span></p>
          {currency === "usd" ? (
            <p className="rounded-xl border border-line bg-sunken/60 px-3 py-2.5 text-sm text-muted">Card payments in US dollars are coming soon. You can pay in ₹ with any UPI app today.</p>
          ) : !upiOn ? (
            <p className="rounded-xl border border-line bg-sunken/60 px-3 py-2.5 text-sm text-muted">Online payments aren't set up on this server yet. An admin can move your account to {plan.name} straight away: send them the email you sign in with.</p>
          ) : (
            <>
              <p className="text-sm text-muted">Pay with any UPI app: Google Pay, PhonePe, Paytm, BHIM or your bank's. No card, no fees. {interval === "year" ? "Covers 12 months." : "Covers one month."} Paying again for the same plan adds to its end date.</p>
              <Button variant="primary" className="w-full" loading={busy} onClick={start}>Pay {formatPrice(price, "inr")} with UPI</Button>
            </>
          )}
        </div>
      ) : order.status === "paid" ? (
        <div className="space-y-3 py-2 text-center" data-testid="checkout-paid">
          <CheckCircle2 className="mx-auto size-10 text-ok" aria-hidden />
          <p className="font-display text-xl font-semibold">You're on {plan.name}</p>
          <p className="text-sm text-muted">Payment of {rupees(order.amount)} confirmed. Your new models and limits are live.</p>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      ) : order.status === "rejected" || order.status === "expired" || order.status === "canceled" ? (
        <div className="space-y-3 py-2 text-center">
          <XCircle className="mx-auto size-10 text-err" aria-hidden />
          <p className="text-sm text-muted">{order.status === "rejected" ? `We couldn't confirm this payment${order.reason ? `: ${order.reason}` : "."}` : order.status === "expired" ? "This checkout expired." : "This checkout was canceled."} If money left your account, write to the admin with order {order.id}.</p>
          <Button variant="primary" onClick={() => setOrder(null)}>Start again</Button>
        </div>
      ) : (
        <PayStep order={order} utr={utr} setUtr={setUtr} busy={busy} autoConfirm={!!billing?.autoConfirm}
          onSubmit={() => act({ action: "submit", utr: utr.trim() })} onCancel={() => act({ action: "cancel" })} />
      )}
    </Dialog>
  );
}

function PayStep({ order, utr, setUtr, busy, autoConfirm, onSubmit, onCancel }: {
  order: OrderView; utr: string; setUtr: (v: string) => void; busy: boolean; autoConfirm: boolean; onSubmit: () => void; onCancel: () => void;
}) {
  const toast = useStore((s) => s.toast);
  const svg = useMemo(() => (order.upi ? qrSvg(order.upi.uri) : ""), [order.upi]);
  const copy = (text: string, what: string) => { void navigator.clipboard?.writeText(text).then(() => toast("ok", `${what} copied.`), () => {}); };
  const submitted = order.status === "submitted";
  return (
    <div className="space-y-4" data-testid="checkout-pay">
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        {svg && <div className="size-40 shrink-0 overflow-hidden rounded-xl bg-white p-1 ring-1 ring-line" role="img" aria-label={`UPI QR code for ${rupees(order.amount)}`} dangerouslySetInnerHTML={{ __html: svg }} />}
        <div className="min-w-0 flex-1 space-y-2 text-sm">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Pay exactly</div>
            <button className="flex items-center gap-1.5 font-display text-2xl font-semibold tabular-nums" onClick={() => copy((order.amount / 100).toFixed(2), "Amount")} aria-label={`Copy amount ${rupees(order.amount)}`} data-testid="pay-amount">{rupees(order.amount)} <Copy className="size-3.5 text-faint" aria-hidden /></button>
            <p className="text-[11px] text-faint">The paise make your payment easy to match.</p>
          </div>
          {order.upi && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">To</div>
              <button className="flex max-w-full items-center gap-1.5 truncate font-mono text-[13px]" onClick={() => copy(order.upi!.vpa, "UPI ID")} aria-label="Copy UPI ID">{order.upi.vpa} <Copy className="size-3 shrink-0 text-faint" aria-hidden /></button>
              <p className="truncate text-xs text-muted">{order.upi.payee} · note <span className="font-mono">{order.id}</span></p>
            </div>
          )}
        </div>
      </div>
      {order.upi && (
        <a href={order.upi.uri} className="flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-sunken/60 px-3 py-2 text-sm font-medium transition hover:border-accent/50 sm:hidden"><Smartphone className="size-4" aria-hidden /> Open in a UPI app <ExternalLink className="size-3.5 text-faint" aria-hidden /></a>
      )}
      <p className="hidden items-center gap-1.5 text-xs text-muted sm:flex"><QrCode className="size-3.5" aria-hidden /> Scan with your phone's UPI app, or pay to the UPI ID with the exact amount.</p>

      <div className="border-t border-line pt-4">
        {submitted ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-info/30 bg-info/5 px-3 py-2.5 text-sm" data-testid="checkout-waiting">
            <Clock className="mt-0.5 size-4 shrink-0 animate-pulse text-info" aria-hidden />
            <div><p className="font-medium">Checking your payment (UTR {order.utr})</p><p className="text-xs text-muted">{autoConfirm ? "Usually confirmed within a minute of the bank's alert. You can close this; your plan switches on by itself." : "An admin confirms it shortly. You can close this; your plan switches on by itself."}</p></div>
          </div>
        ) : (
          <div className="space-y-2">
            <label htmlFor="utr" className="text-sm font-medium">After paying, enter the UPI reference</label>
            <div className="flex gap-2">
              <Input id="utr" inputMode="numeric" autoComplete="off" placeholder="12-digit UTR / UPI Ref No." value={utr} maxLength={12} onChange={(e) => setUtr(e.target.value.replace(/\D/g, ""))} className="font-mono tabular-nums" />
              <Button variant="primary" loading={busy} disabled={utr.length !== 12} onClick={onSubmit}>I've paid</Button>
            </div>
            <p className="text-[11px] text-faint">Find it in your UPI app's payment details ("UPI Ref No.", "UTR" or "Transaction ID", 12 digits).</p>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted">
          <span className="flex items-center gap-1"><Badge tone={STATUS_LABEL[order.status].tone}>{STATUS_LABEL[order.status].text}</Badge>{order.status === "pending" && <span>· open until {until(order.expiresAt)}</span>}</span>
          {order.status === "pending" && <button className={cn("hover:text-err", busy && "pointer-events-none opacity-50")} onClick={onCancel}>Cancel checkout</button>}
        </div>
      </div>
    </div>
  );
}
