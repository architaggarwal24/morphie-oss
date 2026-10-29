import { z } from "zod";
import { PLAN_ORDER, type PlanId } from "@/lib/plans";
import { route } from "@/server/http";
import { billingInfo, createOrder } from "@/server/payments";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What checkout offers here, and your orders (Settings → Plan). */
export const GET = route({ auth: "user" }, async (c) => await billingInfo(c.actor));

/** Start a checkout: an order for a plan, with its UPI link and the exact amount to pay. */
export const POST = route({ auth: "user", rate: { bucket: "billing", limit: 20, windowMs: 60_000 } }, async (c) => {
  const b = await c.body(z.object({ plan: z.enum(PLAN_ORDER as [PlanId, ...PlanId[]]), period: z.enum(["month", "year"]), currency: z.enum(["inr", "usd"]) }));
  const order = await createOrder(c.actor, b);
  return { order, ...(await billingInfo(c.actor)) };
});
