import { z } from "zod";
import { normalizeEmail } from "@/server/auth/accounts";
import { isPlausibleEmail, requestCode, CODE_TTL_MS, RESEND_COOLDOWN_MS } from "@/server/auth/otp";
import { deliveryStatus, emailLoginEnabled } from "@/server/email";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ask for a sign-in code. The answer is the same for every well-formed address (known, unknown, or in cooldown),
 * so this endpoint can't be used to find out who has an account. Never creates an identity.
 */
export const POST = route({ auth: "public", rate: { bucket: "auth-email-request", limit: 10, windowMs: 3_600_000, durable: true } }, async (c) => {
  if (!emailLoginEnabled()) throw new ApiError(404, "Email sign-in isn't available on this server.", "disabled");
  const { email } = await c.body(z.object({ email: z.string().max(254) }), 2_000);
  const e = normalizeEmail(email);
  if (!isPlausibleEmail(e)) throw new ApiError(400, "Enter a valid email address.", "invalid_email");
  const code = await requestCode(e, c.ip);
  // `delivery` says something about the server, never about the address: "console" (development: nothing is emailed, the code
  // is printed in the server's terminal) or "failing" (the last send failed). Omitted when everything is fine.
  const delivery = deliveryStatus();
  // Development with no mail server: hand the code to the popup too, so signing in locally just works. The console
  // transport can't exist in production (email/index.ts refuses it three times), and `npm run dev` listens on
  // 127.0.0.1 only, so nobody else on the network can use this. Nothing changes when a real mailer is configured.
  const devCode = delivery === "console" && process.env.NODE_ENV !== "production" && code ? code : undefined;
  return { ok: true, expiresInMinutes: CODE_TTL_MS / 60_000, resendAfterSeconds: RESEND_COOLDOWN_MS / 1000, ...(delivery ? { delivery } : {}), ...(devCode ? { devCode } : {}) };
});
