/**
 * Paying for a plan (hosted edition), with no gateway fees: UPI straight to your own UPI ID.
 *
 * 1. Checkout makes an order: the plan's price plus a few paise that make the amount unique among open orders
 *    (₹1,499.37), a short order code for the UPI note, and a upi:// link / QR code.
 * 2. The person pays in any UPI app and types the 12-digit UPI reference (UTR) into Morphie.
 * 3. The payment is confirmed either by an admin (Settings → Admin → Payments, after checking the bank app) or, when
 *    the bank's credit alert reaches Morphie by email, automatically: the alert's DKIM signature is verified and its
 *    amount / UTR matched to the open order (payments/email.ts).
 * 4. A paid order turns into the plan for a month or a year (renewing the same plan adds to its end date).
 */
import { planRank, type Currency, type Interval, type PlanId } from "@/lib/plans";
import type { AdminPayments, BillingInfo, OrderStatus, OrderView, PaymentSettings } from "@/lib/types";
import type { Actor } from "../auth/actor";
import { config } from "../config";
import { cfWaitUntil } from "../cf";
import * as plansStore from "../data/plans";
import * as store from "../data/payments";
import { isUniqueViolation, now } from "../db";
import { transport } from "../email";
import { ApiError } from "../http";
import { addMonths, entitlements, forgetEntitlements, plansEnabled } from "../plans";
import { addressOf, aligned, parseEmail, readAlert, verifyDkim, type TxtLookup } from "./email";

const SETTINGS_KEY = "payments";
export const ORDER_TTL_MS = 48 * 3600_000;
export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = { upi: { enabled: false, vpa: "", payee: "Morphie" }, email: { enabled: false, domains: [] } };

// ------------------------------------------------------------------ settings

export async function paymentSettings(): Promise<PaymentSettings> {
  const s = (await plansStore.readConfig(SETTINGS_KEY)) as Partial<PaymentSettings> | undefined;
  return { upi: { ...DEFAULT_PAYMENT_SETTINGS.upi, ...s?.upi }, email: { ...DEFAULT_PAYMENT_SETTINGS.email, ...s?.email } };
}

export const VPA = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/;

export async function savePaymentSettings(s: PaymentSettings): Promise<PaymentSettings> {
  if (s.upi.enabled && !VPA.test(s.upi.vpa)) throw new ApiError(400, "Enter your UPI ID (like yourname@okhdfcbank) before turning UPI on.", "invalid");
  const domains = [...new Set(s.email.domains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 10);
  if (s.email.enabled && !domains.length) throw new ApiError(400, "Add your bank's email domain (like hdfcbank.net) to confirm payments from its alerts.", "invalid");
  const next: PaymentSettings = { upi: { enabled: s.upi.enabled, vpa: s.upi.vpa.trim(), payee: s.upi.payee.trim().slice(0, 60) || "Morphie" }, email: { enabled: s.email.enabled, domains } };
  await plansStore.writeConfig(SETTINGS_KEY, next);
  return next;
}

// ------------------------------------------------------------------ orders

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** A short order code people can read out and type into a UPI note: MO + 8 letters/digits. */
export function orderCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `MO${[...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
}

export function upiUri(vpa: string, payee: string, amountMinor: number, note: string): string {
  const q = new URLSearchParams({ pa: vpa, pn: payee, am: (amountMinor / 100).toFixed(2), cu: "INR", tn: note });
  return `upi://pay?${q.toString().replace(/\+/g, "%20")}`;
}

const statusOf = (r: store.OrderRow, t = now()): OrderStatus => (r.status === "pending" && r.expires_at <= t ? "expired" : (r.status as OrderStatus));

export function orderView(r: store.OrderRow, settings: PaymentSettings, withEmail = false): OrderView {
  const status = statusOf(r);
  return {
    id: r.id, ...(withEmail ? { email: r.email } : {}), plan: r.plan as PlanId, period: r.period as Interval, currency: r.currency as Currency, amount: r.amount, method: "upi",
    status, utr: r.utr, createdAt: r.created_at, expiresAt: r.expires_at, paidAt: r.paid_at, reason: r.reason,
    ...((status === "pending" || status === "submitted") && settings.upi.vpa ? { upi: { uri: upiUri(settings.upi.vpa, settings.upi.payee, r.amount, r.id), vpa: settings.upi.vpa, payee: settings.upi.payee } } : {}),
  };
}

const months = (period: Interval) => (period === "year" ? 12 : 1);

/** Orders belong to the verified email that plans apply to. */
async function payer(actor: Actor): Promise<string> {
  const row = await plansStore.accountPlanRow(actor);
  if (!row?.email || row.email_verified_at == null) throw new ApiError(400, "Verify your email first (sign in once with an email code): plans belong to a verified email.", "unverified");
  return row.email.toLowerCase();
}

export async function billingInfo(actor: Actor): Promise<BillingInfo> {
  const s = await paymentSettings();
  const e = plansEnabled() ? await entitlements(actor) : null;
  const orders = e?.email && e.verified ? await store.listOrdersFor(e.email) : [];
  return {
    upi: { enabled: s.upi.enabled && !!s.upi.vpa, payee: s.upi.payee, vpa: s.upi.enabled ? s.upi.vpa : "" },
    autoConfirm: s.email.enabled && !!config.inboundSecret, usd: false,
    orders: orders.map((o) => orderView(o, s)),
  };
}

/** A few paise on top of the price that no other open order has, so a bank alert's amount points at one order. */
function uniqueAmount(base: number, open: store.OrderRow[]): number {
  const taken = new Set(open.map((o) => o.amount));
  const free = Array.from({ length: 99 }, (_, i) => base + i + 1).filter((a) => !taken.has(a));
  if (!free.length) throw new ApiError(503, "Too many checkouts are open right now. Try again in a little while.", "busy");
  return free[crypto.getRandomValues(new Uint32Array(1))[0] % free.length];
}

export async function createOrder(actor: Actor, input: { plan: PlanId; period: Interval; currency: Currency }): Promise<OrderView> {
  if (!plansEnabled()) throw new ApiError(404, "This server has no plans.", "not_found");
  const email = await payer(actor);
  const s = await paymentSettings();
  if (input.currency !== "inr") throw new ApiError(400, "Paying in US dollars (cards) is coming soon. For now you can pay in ₹ with UPI.", "unsupported");
  if (!s.upi.enabled || !s.upi.vpa) throw new ApiError(400, "Online payments aren't set up on this server yet. Ask the admin to upgrade you.", "unavailable");
  const e = await entitlements(actor);
  const plan = e.cfg.plans.find((p) => p.id === input.plan);
  if (!plan || plan.id === "sketch") throw new ApiError(400, "Pick a paid plan.", "invalid");
  if (e.membership && planRank(plan.id) < planRank(e.plan.id)) throw new ApiError(400, `You're on ${e.plan.name}, which already includes ${plan.name}.`, "invalid");
  const price = plan.price.inr[input.period];
  if (!(price > 0)) throw new ApiError(400, "That plan has no price set.", "invalid");
  const t = now();
  // The same checkout again (a reload, a second tab) gets the same order.
  const mine = await store.listOrdersFor(email, 5);
  const same = mine.find((o) => statusOf(o, t) === "pending" && o.plan === plan.id && o.period === input.period && o.currency === "inr" && Math.floor(o.amount / 100) === price);
  if (same) return orderView(same, s);
  const row = { id: orderCode(), email, plan: plan.id, period: input.period, currency: "inr", amount: uniqueAmount(price * 100, await store.openOrders(t)), method: "upi", status: "pending", created_at: t, expires_at: t + ORDER_TTL_MS };
  await store.insertOrder(row);
  await store.cancelOpenOrders(email, row.id);
  return orderView({ ...row, utr: null, updated_at: t, paid_at: null, decided_by: null, reason: null }, s);
}

/** "I've paid": the UPI reference, so the admin (or the bank alert) can match it. */
export async function submitPayment(actor: Actor, id: string, utr: string): Promise<OrderView> {
  const email = await payer(actor);
  const o = await store.getOwnOrder(email, id);
  if (!o) throw new ApiError(404, "That order doesn't exist.", "not_found");
  const st = statusOf(o);
  if (st !== "pending" && st !== "submitted") throw new ApiError(409, st === "paid" ? "This order is already paid." : st === "expired" ? "This checkout expired. Start a new one (if you already paid, tell the admin your UTR)." : `This order is ${st}.`, "invalid");
  try {
    if (!(await store.updateOrder(id, ["pending", "submitted"], { status: "submitted", utr }))) throw new ApiError(409, "This order changed. Reload and try again.", "conflict");
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError(409, "That UPI reference is already on another order. Check the 12 digits.", "duplicate");
    throw e;
  }
  void notifyAdmins(`Payment to check: ${o.id}`, `${email} says they paid ₹${(o.amount / 100).toFixed(2)} for ${o.plan} (${o.period}).\nUPI reference: ${utr}\n\nApprove it in Settings → Admin → Payments.`);
  return orderView((await store.getOrder(id))!, await paymentSettings());
}

export async function cancelOrder(actor: Actor, id: string): Promise<OrderView> {
  const email = await payer(actor);
  const o = await store.getOwnOrder(email, id);
  if (!o) throw new ApiError(404, "That order doesn't exist.", "not_found");
  if (!(await store.updateOrder(id, ["pending"], { status: "canceled" }))) throw new ApiError(409, "Only an unpaid checkout can be canceled.", "invalid");
  return orderView((await store.getOrder(id))!, await paymentSettings());
}

export async function myOrder(actor: Actor, id: string): Promise<OrderView> {
  const email = await payer(actor);
  const o = await store.getOwnOrder(email, id);
  if (!o) throw new ApiError(404, "That order doesn't exist.", "not_found");
  return orderView(o, await paymentSettings());
}

/** A paid order becomes the plan: the same live plan is extended from its end, anything else starts today. */
async function applyOrder(o: store.OrderRow, by: string): Promise<void> {
  const t = now();
  const prev = await plansStore.getMembership(o.email);
  const live = prev && prev.starts_at <= t && (prev.ends_at == null || prev.ends_at > t);
  const extend = live && prev.plan === o.plan;
  const period = o.period as Interval;
  await plansStore.upsertMembership({
    email: o.email, plan: o.plan, unlimited: live && prev.unlimited ? 1 : 0, source: "upi", billing: period,
    starts_at: extend ? prev.starts_at : t,
    ends_at: extend ? (prev.ends_at == null ? null : addMonths(prev.ends_at, months(period))) : addMonths(t, months(period)),
    note: `Order ${o.id}${o.utr ? ` · UTR ${o.utr}` : ""}`, granted_by: by,
  });
  forgetEntitlements();
}

/** Mark an order paid (once) and give the plan. */
export async function markPaid(id: string, by: string, utr?: string | null): Promise<OrderView> {
  const o = await store.getOrder(id);
  if (!o) throw new ApiError(404, "That order doesn't exist.", "not_found");
  const patch = { status: "paid", paidAt: now(), decidedBy: by, ...(utr && !o.utr ? { utr } : {}) };
  let ok: boolean;
  try { ok = await store.updateOrder(id, ["pending", "submitted"], patch); }
  catch (e) { if (!isUniqueViolation(e)) throw e; ok = await store.updateOrder(id, ["pending", "submitted"], { status: "paid", paidAt: patch.paidAt, decidedBy: by }); }
  if (!ok) throw new ApiError(409, `This order is already ${statusOf(o)}.`, "conflict");
  const paid = (await store.getOrder(id))!;
  await applyOrder(paid, by);
  void notifyPerson(paid.email, "Your Morphie plan is active", `Thanks! We received ₹${(paid.amount / 100).toFixed(2)} (order ${paid.id}). Your ${paid.plan} plan is active now.`);
  return orderView(paid, await paymentSettings(), true);
}

export async function rejectOrder(id: string, by: string, reason: string): Promise<OrderView> {
  const o = await store.getOrder(id);
  if (!o) throw new ApiError(404, "That order doesn't exist.", "not_found");
  if (!(await store.updateOrder(id, ["pending", "submitted"], { status: "rejected", decidedBy: by, reason: reason || null }))) throw new ApiError(409, `This order is already ${statusOf(o)}.`, "conflict");
  void notifyPerson(o.email, "About your Morphie payment", `We couldn't confirm the payment for order ${o.id}${reason ? `: ${reason}` : "."}\nReply to this email, or start a new checkout in Settings → Plan.`);
  return orderView((await store.getOrder(id))!, await paymentSettings(), true);
}

export async function adminPayments(): Promise<AdminPayments> {
  const s = await paymentSettings();
  const [orders, inbox] = await Promise.all([store.recentOrders(), store.listInbox()]);
  return {
    settings: s, inboundReady: !!config.inboundSecret,
    orders: orders.map((o) => orderView(o, s, true)),
    inbox: inbox.map((r) => ({ id: r.id, at: r.at, sender: r.sender, dkim: r.dkim, subject: r.subject, amount: r.amount, utr: r.utr, orderId: r.order_id, outcome: r.outcome, excerpt: r.excerpt })),
  };
}

// ------------------------------------------------------------------ bank alerts

export interface AlertOutcome { outcome: "matched" | "unmatched" | "rejected" | "ignored"; orderId?: string; amount?: number; utr?: string; reason?: string }

/**
 * A bank alert email. From the Worker it must carry a valid DKIM signature from one of the admin's bank domains,
 * aligned with its From address; an admin pasting one into Settings is trusted as is (`trusted`).
 */
export async function handleBankEmail(raw: string, opts: { trusted?: boolean; lookup?: TxtLookup } = {}): Promise<AlertOutcome> {
  const s = await paymentSettings();
  const email = parseEmail(raw.slice(0, 512_000));
  const sender = addressOf(email.from);
  const record = async (r: AlertOutcome, dkim = "") => {
    await store.insertInbox({ sender, dkim, subject: email.subject, amount: r.amount ?? null, utr: r.utr ?? null, orderId: r.orderId ?? null, outcome: r.outcome, excerpt: r.reason ? `${r.reason}\n\n${email.text}` : email.text });
    return r;
  };
  if (!opts.trusted && !s.email.enabled) return record({ outcome: "ignored", reason: "Confirming payments from bank emails is off." });
  let signer = opts.trusted ? "pasted by an admin" : "";
  if (!opts.trusted) {
    const results = await verifyDkim(email, opts.lookup);
    const good = results.find((r) => r.ok && s.email.domains.some((d) => r.domain === d || r.domain.endsWith(`.${d}`)) && aligned(sender, r.domain));
    if (!good) return record({ outcome: "rejected", reason: `Not a verified email from your bank (${results.map((r) => `${r.domain || "?"}: ${r.ok ? "signed" : r.reason}`).join("; ") || "no DKIM signature"}).` });
    signer = good.domain;
  }
  const alert = readAlert(`${email.subject}\n${email.text}`);
  if (!alert.credit || !alert.amounts.length) return record({ outcome: "ignored", reason: "It doesn't read as money received." }, signer);
  const open = await store.openOrders();
  // 1. The UTR the person typed, with the right amount.
  let match = open.find((o) => o.utr && alert.utrs.includes(o.utr) && alert.amounts.includes(o.amount));
  // 2. Otherwise the one open order with exactly this amount (the paise make it unique).
  if (!match) {
    const byAmount = open.filter((o) => alert.amounts.includes(o.amount));
    if (byAmount.length === 1) match = byAmount[0];
  }
  const utr = match?.utr ?? (alert.utrs.length === 1 ? alert.utrs[0] : undefined);
  if (!match) return record({ outcome: "unmatched", amount: alert.amounts[0], utr, reason: "No open order has this amount." }, signer);
  // A UTR that already paid for something else is a replay, not a new payment.
  if (utr && !match.utr) {
    const other = await store.orderByUtr(utr);
    if (other && other.id !== match.id) return record({ outcome: "rejected", amount: match.amount, utr, reason: `UTR already used by order ${other.id}.` }, signer);
  }
  await markPaid(match.id, opts.trusted ? "admin (pasted alert)" : `bank email (${signer})`, utr);
  return record({ outcome: "matched", orderId: match.id, amount: match.amount, utr }, signer);
}

// ------------------------------------------------------------------ notifications (best effort)

async function send(to: string, subject: string, text: string): Promise<void> {
  try { await transport().send({ to, subject, text }); } catch { /* no email transport, or it failed: the app still shows everything */ }
}
/** Fire and forget (kept alive on Workers until sent). */
const later = (p: Promise<unknown>) => { cfWaitUntil(p); return p; };
const notifyAdmins = (subject: string, text: string) => later(Promise.all(config.adminEmails.map((a) => send(a, subject, text))));
const notifyPerson = (to: string, subject: string, text: string) => later(send(to, subject, text));
