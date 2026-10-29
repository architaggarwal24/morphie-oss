import { z } from "zod";
import { finishLogin } from "@/server/auth/login";
import { verifyCode } from "@/server/auth/otp";
import { normalizeEmail } from "@/server/auth/accounts";
import { emailLoginEnabled } from "@/server/email";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Check the code and sign in (the same step also signs up an address that has no account yet). Any session the
 * browser already holds is rotated into a fresh one. Every kind of failure answers identically.
 */
export const POST = route({ auth: "public", rate: { bucket: "auth-email-verify", limit: 20, windowMs: 3_600_000, durable: true } }, async (c) => {
  if (!emailLoginEnabled()) throw new ApiError(404, "Email sign-in isn't available on this server.", "disabled");
  const b = await c.body(z.object({ email: z.string().max(254), code: z.string().max(12) }), 2_000);
  const result = await verifyCode(normalizeEmail(b.email), b.code);
  if (!result.ok) throw new ApiError(400, "That code didn't work. Check it, or ask for a new one.", "invalid_code");
  const { cookie } = await finishLogin(c.req, c.ip, c.session, result.user.id);
  c.cookies.push(cookie);
  return { ok: true, user: { email: result.user.email, displayName: result.user.displayName }, created: result.created, ...(result.passwordReset ? { passwordReset: true } : {}) };
});
