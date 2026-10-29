import { NextResponse, type NextRequest } from "next/server";

/*
 * Next 16 deprecates the `middleware` file name in favour of `proxy.ts`, but `proxy` always runs on the Node.js runtime.
 * This file runs on the Edge runtime (the default here), which is what @opennextjs/cloudflare supports on Workers; its
 * Node.js-middleware path is marked experimental and unsupported. So it stays `middleware.ts` (still supported in 16,
 * with a build-time deprecation notice) until OpenNext supports Node.js proxy on workerd.
 */

/**
 * Per-request CSP nonce. Scripts run only if they carry the nonce (or are loaded by one that does),
 * so an injected <script> can't execute even if markup ever slipped through escaping.
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Google Fonts are allowed because design previews (srcdoc frames inherit this policy) may use them.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    // Frames: design previews and the project preview (same origin); with the local sandbox, a project's dev server too.
    `frame-src 'self' blob:${dev || process.env.MORPHIE_LOCAL_SANDBOX === "1" ? " http://127.0.0.1:* http://localhost:*" : ""}`,
    "object-src 'none'",
    "worker-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }],
};
