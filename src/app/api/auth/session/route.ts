import { loginMethods } from "@/server/auth/methods";
import { deliveryStatus } from "@/server/email";
import { route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who am I? Never creates anything: a visitor with no session simply gets authenticated:false. */
export const GET = route({ auth: "public" }, async (c) => {
  const s = c.session;
  const methods = loginMethods();
  // Lets the login popup notice, a few seconds after asking for a code, that the mail server rejected it.
  if (!s) return { authenticated: false, user: null, methods, ...(deliveryStatus() === "failing" ? { emailDelivery: "failing" as const } : {}) };
  return {
    authenticated: true,
    user: { email: s.user.email, displayName: s.user.displayName },
    expiresAt: s.absoluteExpiresAt,
    idleExpiresAt: s.idleExpiresAt,
    methods,
  };
});
