import { z } from "zod";
import { route } from "@/server/http";
import { cancelOrder, myOrder, submitPayment } from "@/server/payments";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One of your orders (checkout polls it to see the payment confirmed). Someone else's is a 404. */
export const GET = route({ auth: "user" }, async (c) => ({ order: await myOrder(c.actor, c.params.id) }));

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit"), utr: z.string().trim().regex(/^\d{12}$/, "The UPI reference (UTR) is the 12-digit number in your UPI app's payment details.") }),
  z.object({ action: z.literal("cancel") }),
]);

/** "I've paid" (with the UPI reference), or cancel an unpaid checkout. */
export const POST = route({ auth: "user", rate: { bucket: "billing", limit: 20, windowMs: 60_000 } }, async (c) => {
  const b = await c.body(body);
  return { order: b.action === "submit" ? await submitPayment(c.actor, c.params.id, b.utr) : await cancelOrder(c.actor, c.params.id) };
});
