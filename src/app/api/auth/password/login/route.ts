import { z } from "zod";
import { normalizeEmail } from "@/server/auth/accounts";
import { finishLogin } from "@/server/auth/login";
import { passwordLoginEnabled } from "@/server/auth/methods";
import { logInWithPassword } from "@/server/auth/password";
import { ApiError, route } from "@/server/http";
import { hitDurable } from "@/server/data/rateLimits";
import { rateLimit } from "@/server/security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Log in with email + password. Wrong password and unknown address answer the same way, after the same work. */
export const POST = route({ auth: "public", rate: { bucket: "auth-password-login", limit: 30, windowMs: 900_000, durable: true } }, async (c) => {
  if (!passwordLoginEnabled()) throw new ApiError(404, "Password login isn't available on this server.", "disabled");
  const b = await c.body(z.object({ email: z.string().max(254), password: z.string().max(400) }), 4_000);
  // Per address too, so guessing one account's password from many IPs is still capped.
  const key = `auth-password-login:addr:${normalizeEmail(b.email)}`;
  const wait = rateLimit(key, 10, 900_000) || await hitDurable(key, 10, 900_000);
  if (wait) throw Object.assign(new ApiError(429, `Too many attempts for this account. Try again in ${wait}s.`, "rate_limited"), { retryAfter: wait });
  const user = await logInWithPassword(b.email, b.password);
  if (!user) throw new ApiError(400, "That email and password don't match.", "invalid_credentials");
  const { cookie } = await finishLogin(c.req, c.ip, c.session, user.id);
  c.cookies.push(cookie);
  return { ok: true, user: { email: user.email, displayName: user.displayName } };
});
