import { config } from "@/server/config";
import { safeEqualHex } from "@/server/crypto";
import { ApiError, route } from "@/server/http";
import { handleBankEmail } from "@/server/payments";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A bank alert email, handed over by the Worker's email handler (worker/index.ts). No session: the shared
 * MORPHIE_INBOUND_SECRET is the key (unset = off), and the email itself must then pass DKIM for a bank domain the admin
 * listed before anything in it is believed (src/server/payments).
 */
export const POST = route({ auth: "public", rate: { bucket: "inbound", limit: 60, windowMs: 60_000 } }, async (c) => {
  const secret = config.inboundSecret;
  const given = c.req.headers.get("x-morphie-inbound") ?? "";
  if (!secret || !safeEqualHex(secret, given)) throw new ApiError(404, "Not found.", "not_found");
  const raw = await c.req.text();
  if (raw.length > 512_000) throw new ApiError(413, "That email is too large.", "too_large");
  return await handleBankEmail(raw);
});
