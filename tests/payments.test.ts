/** Paying for plans by UPI: orders, the UPI reference, admin approval, and bank alerts confirmed through DKIM. */
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as adminPaymentsRoute from "@/app/api/admin/payments/route";
import * as billingRoute from "@/app/api/billing/route";
import * as inboundRoute from "@/app/api/billing/inbound/route";
import * as orderRoute from "@/app/api/billing/orders/[id]/route";
import { sqliteConn as db } from "@/server/db";
import { _resetPlanCaches, entitlements } from "@/server/plans";
import { handleBankEmail, orderCode, savePaymentSettings, upiUri } from "@/server/payments";
import { canonBody, parseEmail, readAlert, verifyDkim } from "@/server/payments/email";
import { _resetRateLimits } from "@/server/security";
import { Client } from "./helpers/client";
import { makeUser, signIn } from "./helpers/users";
// Only the tests sign mail: an independent DKIM implementation to check ours against.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { dkimSign } = require("mailauth/lib/dkim/sign") as { dkimSign: (msg: string, o: object) => Promise<{ signatures: string }> };

const ENV = { MORPHIE_PLANS: "on", MORPHIE_ADMIN_EMAILS: "owner@example.com", MORPHIE_AI_GEMINI_FREE_KEY: "g", MORPHIE_INBOUND_SECRET: "inbound-secret-0123456789abcdef" };
let seq = 0;
const person = (email = `buyer${++seq}-${Date.now()}@example.com`) => { const u = makeUser(email); const c = new Client(); signIn(c, u.userId); return { ...u, c, actor: { userId: u.userId, sessionId: "s" } }; };
let owner: ReturnType<typeof person>;

// The bank's DKIM key, published at s1._domainkey.hdfcbank.net in a fake DNS.
const bank = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const evil = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const spki = (k: crypto.KeyObject) => k.export({ type: "spki", format: "der" }).toString("base64");
const dns: Record<string, string[]> = { "s1._domainkey.hdfcbank.net": [`v=DKIM1; k=rsa; p=${spki(bank.publicKey)}`], "s1._domainkey.evil.example": [`v=DKIM1; k=rsa; p=${spki(evil.publicKey)}`] };
const lookup = async (name: string) => dns[name] ?? [];

function alertEmail(amount: string, utr: string, from = "HDFC Bank InstaAlerts <alerts@hdfcbank.net>") {
  return [
    `From: ${from}`, "To: payments@morphie.example", "Subject: You have done a UPI txn. Check details!", `Date: ${new Date().toUTCString()}`, "Message-ID: <a1@hdfcbank.net>",
    "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
    `<html><body><p>Dear Customer,</p><p>Rs.${amount} has been credited to account **1234 from VPA payer@okicici on 28-10-26. Your UPI transaction reference number is ${utr}.</p><p>Thank you for banking with us.</p></body></html>`,
    "",
  ].join("\r\n");
}
async function signed(raw: string, key: crypto.KeyObject = bank.privateKey, domain = "hdfcbank.net", canonicalization = "relaxed/relaxed") {
  const r = await dkimSign(raw, { canonicalization, algorithm: "rsa-sha256", signatureData: [{ signingDomain: domain, selector: "s1", privateKey: key.export({ type: "pkcs8", format: "pem" }), canonicalization }] });
  expect(r.signatures).toMatch(/^DKIM-Signature:/);
  return r.signatures + raw;
}

async function buy(p: ReturnType<typeof person>, plan = "shift", period = "month") {
  const r = await p.c.json(billingRoute.POST, "/api/billing", { method: "POST", body: { plan, period, currency: "inr" } });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data.order;
}

beforeAll(async () => {
  Object.assign(process.env, ENV); _resetPlanCaches();
  owner = person("owner@example.com");
  await savePaymentSettings({ upi: { enabled: true, vpa: "morphie@okhdfcbank", payee: "Morphie Studio" }, email: { enabled: true, domains: ["hdfcbank.net"] } });
});
afterAll(() => { for (const k of Object.keys(ENV)) delete process.env[k]; _resetPlanCaches(); });
beforeEach(() => { _resetRateLimits(); _resetPlanCaches(); });

describe("pieces", () => {
  it("order codes and UPI links", () => {
    expect(orderCode()).toMatch(/^MO[A-HJ-NP-Z2-9]{8}$/);
    expect(upiUri("me@okhdfcbank", "Morphie Studio", 149_937, "MOABCD2345")).toBe("upi://pay?pa=me%40okhdfcbank&pn=Morphie%20Studio&am=1499.37&cu=INR&tn=MOABCD2345");
  });

  it("reads bank alerts from several banks (amounts in paise, 12-digit UTRs), and tells credits from debits", () => {
    expect(readAlert("Rs.1,499.37 credited to a/c XXXXXX1234 on 28-10-26 by a/c linked to VPA x@ybl (UPI Ref No 430212345678).")).toEqual({ amounts: [149_937], utrs: ["430212345678"], credit: true });
    expect(readAlert("Dear Customer, Acct XX234 is credited with INR 499.07 on 28-Oct-26 from payer@oksbi. UPI:629812345678-ICICI Bank.")).toMatchObject({ amounts: [49_907], utrs: ["629812345678"], credit: true });
    expect(readAlert("Your A/C XXXXX123 has a credit by Transfer of ₹3,999.81 on 28/10/26 by UPI Ref 430298765432. -SBI")).toMatchObject({ amounts: [399_981], credit: true });
    expect(readAlert("Rs.500.00 debited from a/c **1234 on 28-10-26 to VPA shop@ybl. UPI Ref 430211112222. Not you? Call")).toMatchObject({ credit: false });
  });

  it("decodes quoted-printable HTML alerts to text", () => {
    const e = parseEmail("Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>Rs.1,499.37 has been =\r\ncredited.&nbsp;Ref 430212345678</p>");
    expect(e.text).toBe("Rs.1,499.37 has been credited. Ref 430212345678");
  });

  it("verifies DKIM the same way an independent signer computes it (relaxed and simple)", async () => {
    for (const c of ["relaxed/relaxed", "simple/simple", "relaxed/simple"]) {
      const raw = await signed(alertEmail("1.00", "111122223333"), bank.privateKey, "hdfcbank.net", c);
      expect(await verifyDkim(parseEmail(raw), lookup), c).toEqual([{ domain: "hdfcbank.net", ok: true }]);
    }
    const raw = await signed(alertEmail("1.00", "111122223333"));
    expect((await verifyDkim(parseEmail(raw.replace("Rs.1.00", "Rs.9999.00")), lookup))[0]).toMatchObject({ ok: false, reason: "body hash mismatch" });
    expect((await verifyDkim(parseEmail(raw.replace("Subject: You", "Subject: Yo")), lookup))[0]).toMatchObject({ ok: false, reason: "signature mismatch" });
    expect((await verifyDkim(parseEmail(raw), async () => []))[0]).toMatchObject({ ok: false, reason: "no public key in DNS" });
    expect(canonBody("a  b \r\n\r\n\r\n", "relaxed")).toBe("a b\r\n");
    expect(canonBody("", "simple")).toBe("\r\n");
  });
});

describe("checkout", () => {
  it("makes an order with a unique amount and a UPI link; the same checkout again gets the same order", async () => {
    const p = person();
    const o = await buy(p);
    expect(o).toMatchObject({ plan: "shift", period: "month", currency: "inr", status: "pending", utr: null, upi: { vpa: "morphie@okhdfcbank", payee: "Morphie Studio" } });
    expect(o.amount).toBeGreaterThan(149_900);
    expect(o.amount).toBeLessThan(150_000);
    expect(o.upi.uri).toContain(`am=${(o.amount / 100).toFixed(2)}`);
    expect(o.upi.uri).toContain(`tn=${o.id}`);
    expect((await buy(p)).id).toBe(o.id);
    // Others checking out the same plan get different amounts.
    const amounts = new Set([o.amount, (await buy(person())).amount, (await buy(person())).amount]);
    expect(amounts.size).toBe(3);
    // Yearly is its own order (and replaces the unpaid monthly one).
    const y = await buy(p, "shift", "year");
    expect(Math.floor(y.amount / 100)).toBe(14_990);
    expect((await p.c.json(billingRoute.GET, "/api/billing")).data.orders.map((x: { status: string }) => x.status)).toEqual(["pending", "canceled"]);
  });

  it("refuses $, the free plan, and buying a plan below the one you have", async () => {
    const p = person();
    expect((await p.c.json(billingRoute.POST, "/api/billing", { method: "POST", body: { plan: "shift", period: "month", currency: "usd" } })).data.error).toMatch(/coming soon/);
    expect((await p.c.json(billingRoute.POST, "/api/billing", { method: "POST", body: { plan: "sketch", period: "month", currency: "inr" } })).status).toBe(400);
    db().prepare("INSERT INTO memberships (email, plan, unlimited, source, starts_at, created_at, updated_at) VALUES (?, 'morph', 0, 'admin', ?, ?, ?)").run(p.email, Date.now() - 1000, Date.now(), Date.now());
    _resetPlanCaches();
    expect((await p.c.json(billingRoute.POST, "/api/billing", { method: "POST", body: { plan: "shape", period: "month", currency: "inr" } })).data.error).toMatch(/already includes Shape/);
  });

  it("takes the UPI reference, refuses one used on another order, and can be canceled only while unpaid", async () => {
    const a = person(); const b = person();
    const oa = await buy(a); const ob = await buy(b);
    const bad = await a.c.json(orderRoute.POST, `/api/billing/orders/${oa.id}`, { method: "POST", params: { id: oa.id }, body: { action: "submit", utr: "12345" } });
    expect(bad.status).toBe(400);
    const ok = await a.c.json(orderRoute.POST, `/api/billing/orders/${oa.id}`, { method: "POST", params: { id: oa.id }, body: { action: "submit", utr: "430200000001" } });
    expect(ok.data.order).toMatchObject({ status: "submitted", utr: "430200000001" });
    expect((await b.c.json(orderRoute.POST, `/api/billing/orders/${ob.id}`, { method: "POST", params: { id: ob.id }, body: { action: "submit", utr: "430200000001" } })).status).toBe(409);
    expect((await a.c.json(orderRoute.POST, `/api/billing/orders/${oa.id}`, { method: "POST", params: { id: oa.id }, body: { action: "cancel" } })).status).toBe(409);
    expect((await b.c.json(orderRoute.POST, `/api/billing/orders/${ob.id}`, { method: "POST", params: { id: ob.id }, body: { action: "cancel" } })).data.order.status).toBe("canceled");
    // Someone else's order doesn't exist for you.
    expect((await b.c.json(orderRoute.GET, `/api/billing/orders/${oa.id}`, { params: { id: oa.id } })).status).toBe(404);
  });
});

describe("confirming payments", () => {
  it("an admin approves: the plan starts now for a month; paying again for the same plan extends it", async () => {
    const p = person();
    const o = await buy(p);
    expect((await p.c.json(adminPaymentsRoute.POST, "/api/admin/payments", { method: "POST", body: { action: "approve", order: o.id } })).status).toBe(403);
    const r = await owner.c.json(adminPaymentsRoute.POST, "/api/admin/payments", { method: "POST", body: { action: "approve", order: o.id, utr: "430200000099" } });
    expect(r.status).toBe(200);
    expect(r.data.orders.find((x: { id: string }) => x.id === o.id)).toMatchObject({ status: "paid", utr: "430200000099", email: p.email });
    _resetPlanCaches();
    const e = await entitlements(p.actor);
    expect(e.plan.id).toBe("shift");
    expect(e.membership).toMatchObject({ source: "upi", billing: "month" });
    const end1 = e.membership!.endsAt!;
    expect(end1 - Date.now()).toBeGreaterThan(27 * 86_400_000);
    // Twice is refused.
    expect((await owner.c.json(adminPaymentsRoute.POST, "/api/admin/payments", { method: "POST", body: { action: "approve", order: o.id } })).status).toBe(409);
    // Renewing the same plan adds a month to the end.
    const again = await buy(p);
    await owner.c.json(adminPaymentsRoute.POST, "/api/admin/payments", { method: "POST", body: { action: "approve", order: again.id } });
    _resetPlanCaches();
    const end2 = (await entitlements(p.actor)).membership!.endsAt!;
    expect(end2 - end1).toBeGreaterThan(27 * 86_400_000);
  });

  it("an admin rejects with a reason the buyer sees", async () => {
    const p = person();
    const o = await buy(p);
    await owner.c.json(adminPaymentsRoute.POST, "/api/admin/payments", { method: "POST", body: { action: "reject", order: o.id, reason: "No such payment arrived" } });
    expect((await p.c.json(orderRoute.GET, `/api/billing/orders/${o.id}`, { params: { id: o.id } })).data.order).toMatchObject({ status: "rejected", reason: "No such payment arrived" });
  });

  it("a DKIM-signed bank alert with the order's exact amount confirms it (the buyer needn't type the UTR)", async () => {
    const p = person();
    const o = await buy(p);
    const raw = await signed(alertEmail((o.amount / 100).toFixed(2), "430277778888"));
    expect(await handleBankEmail(raw, { lookup })).toEqual({ outcome: "matched", orderId: o.id, amount: o.amount, utr: "430277778888", });
    _resetPlanCaches();
    expect((await entitlements(p.actor)).plan.id).toBe("shift");
    // The same email again matches nothing (the order is paid).
    expect((await handleBankEmail(raw, { lookup })).outcome).toBe("unmatched");
  });

  it("refuses alerts that aren't verified mail from the bank", async () => {
    const p = person();
    const o = await buy(p);
    const amount = (o.amount / 100).toFixed(2);
    const unsigned = alertEmail(amount, "430200001111");
    expect(await handleBankEmail(unsigned, { lookup })).toMatchObject({ outcome: "rejected", reason: expect.stringContaining("no DKIM signature") });
    // Signed, but by someone else's domain (posing as the bank in From).
    expect((await handleBankEmail(await signed(alertEmail(amount, "430200001111"), evil.privateKey, "evil.example"), { lookup })).outcome).toBe("rejected");
    // Signed by the bank, but the From says someone else.
    expect((await handleBankEmail(await signed(alertEmail(amount, "430200001111", "Bank <alerts@evil.example>")), { lookup })).outcome).toBe("rejected");
    // Changed after signing.
    const forged = (await signed(alertEmail("1.00", "430200001111"))).replace("Rs.1.00", `Rs.${amount}`);
    expect(await handleBankEmail(forged, { lookup })).toMatchObject({ outcome: "rejected", reason: expect.stringContaining("body hash mismatch") });
    expect((await p.c.json(orderRoute.GET, `/api/billing/orders/${o.id}`, { params: { id: o.id } })).data.order.status).toBe("pending");
  });

  it("matches by the UTR the buyer typed; amounts nobody is waiting for stay unmatched; admins can paste an alert", async () => {
    const p = person();
    const o = await buy(p);
    await p.c.json(orderRoute.POST, `/api/billing/orders/${o.id}`, { method: "POST", params: { id: o.id }, body: { action: "submit", utr: "430255556666" } });
    expect((await handleBankEmail(await signed(alertEmail("12.34", "430299990000")), { lookup })).outcome).toBe("unmatched");
    expect((await handleBankEmail(await signed(alertEmail((o.amount / 100).toFixed(2), "430255556666")), { lookup }))).toMatchObject({ outcome: "matched", orderId: o.id });
    const q = person();
    const oq = await buy(q, "shape");
    const pasted = await owner.c.json(adminPaymentsRoute.POST, "/api/admin/payments", { method: "POST", body: { action: "check", raw: `Subject: x\r\n\r\nINR ${(oq.amount / 100).toFixed(2)} credited to your account. UPI Ref 430212121212` } });
    expect(pasted.data.result).toMatchObject({ outcome: "matched", orderId: oq.id });
    const inbox = (await owner.c.json(adminPaymentsRoute.GET, "/api/admin/payments")).data.inbox;
    expect(inbox.map((m: { outcome: string }) => m.outcome)).toEqual(expect.arrayContaining(["matched", "unmatched", "rejected"]));
  });

  it("the inbound route only answers the Worker (shared secret)", async () => {
    const c = new Client();
    expect((await c.call(inboundRoute.POST, "/api/billing/inbound", { method: "POST", body: "x" })).status).toBe(404);
    expect((await c.call(inboundRoute.POST, "/api/billing/inbound", { method: "POST", body: "x", headers: { "x-morphie-inbound": "wrong-secret-0123456789abcdef" } })).status).toBe(404);
    const r = await c.json(inboundRoute.POST, "/api/billing/inbound", { method: "POST", body: alertEmail("1.00", "430200000000"), headers: { "x-morphie-inbound": ENV.MORPHIE_INBOUND_SECRET } });
    expect(r.status).toBe(200);
    expect(r.data.outcome).toBe("rejected"); // unsigned
  });

  it("payment settings: a UPI ID is required, and bank domains for alerts", async () => {
    const bad = await owner.c.json(adminPaymentsRoute.POST, "/api/admin/payments", { method: "POST", body: { action: "settings", upi: { enabled: true, vpa: "not a vpa", payee: "x" }, email: { enabled: false, domains: [] } } });
    expect(bad.status).toBe(400);
    const noDomains = await owner.c.json(adminPaymentsRoute.POST, "/api/admin/payments", { method: "POST", body: { action: "settings", upi: { enabled: true, vpa: "morphie@okhdfcbank", payee: "Morphie Studio" }, email: { enabled: true, domains: [] } } });
    expect(noDomains.status).toBe(400);
    const ok = await owner.c.json(adminPaymentsRoute.POST, "/api/admin/payments", { method: "POST", body: { action: "settings", upi: { enabled: true, vpa: "morphie@okhdfcbank", payee: "Morphie Studio" }, email: { enabled: true, domains: ["@HDFCBank.net", "icicibank.com"] } } });
    expect(ok.data.settings.email.domains).toEqual(["hdfcbank.net", "icicibank.com"]);
    expect(ok.data.inboundReady).toBe(true);
  });
});
