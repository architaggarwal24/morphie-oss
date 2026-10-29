import { z } from "zod";
import { route } from "@/server/http";
import { requireAdmin } from "@/server/plans";
import { adminPayments, handleBankEmail, markPaid, rejectOrder, savePaymentSettings } from "@/server/payments";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Settings → Admin → Payments: orders to check, the bank alert inbox, and the UPI settings. Admins only. */
export const GET = route({ auth: "user" }, async (c) => {
  await requireAdmin(c.actor);
  return await adminPayments();
});

const code = z.string().trim().regex(/^MO[A-Z0-9]{8}$/, "That isn't an order code.");
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), order: code, utr: z.string().trim().regex(/^\d{12}$/).optional() }),
  z.object({ action: z.literal("reject"), order: code, reason: z.string().trim().max(200).default("") }),
  z.object({
    action: z.literal("settings"),
    upi: z.object({ enabled: z.boolean(), vpa: z.string().trim().max(120), payee: z.string().trim().max(60) }),
    email: z.object({ enabled: z.boolean(), domains: z.array(z.string().trim().max(80)).max(10) }),
  }),
  /** Paste a bank alert to confirm the payment it describes (when alerts don't reach Morphie by email). */
  z.object({ action: z.literal("check"), raw: z.string().min(10).max(200_000) }),
]);

export const POST = route({ auth: "user", rate: { bucket: "admin", limit: 60, windowMs: 60_000 } }, async (c) => {
  const by = await requireAdmin(c.actor);
  const b = await c.body(body, 300_000);
  if (b.action === "approve") await markPaid(b.order, by, b.utr);
  else if (b.action === "reject") await rejectOrder(b.order, by, b.reason);
  else if (b.action === "settings") await savePaymentSettings({ upi: b.upi, email: b.email });
  else return { result: await handleBankEmail(b.raw, { trusted: true }), ...(await adminPayments()) };
  return await adminPayments();
});
