import { z } from "zod";
import { finishLogin } from "@/server/auth/login";
import { passwordLoginEnabled } from "@/server/auth/methods";
import { signUpWithPassword } from "@/server/auth/password";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create an account with email + password and sign in. Needs no mail server. The address stays unverified, so it
 * links to nothing; a later proven login for the same address takes the account over (see auth/password.ts).
 * Unlike the email-code flow this one does say when an address is taken: there's no way to sign up without saying so.
 */
export const POST = route({ auth: "public", rate: { bucket: "auth-password-signup", limit: 10, windowMs: 3_600_000, durable: true } }, async (c) => {
  if (!passwordLoginEnabled()) throw new ApiError(404, "Password sign-up isn't available on this server.", "disabled");
  const b = await c.body(z.object({ email: z.string().max(254), password: z.string().max(400), name: z.string().max(60).optional() }), 4_000);
  const r = await signUpWithPassword(b.email, b.password, b.name);
  if (!r.ok) throw new ApiError(r.reason === "exists" ? 409 : 400, r.message, r.reason);
  const { cookie } = await finishLogin(c.req, c.ip, c.session, r.user.id);
  c.cookies.push(cookie);
  return { ok: true, created: true, user: { email: r.user.email, displayName: r.user.displayName } };
});
