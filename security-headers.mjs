/**
 * Security headers shared by next.config.mjs and the tests (plain JS so both can import it).
 * `production` is true for `next build` / `next start`; HSTS is never sent in development.
 */
export function pageHeaders({ production }) {
  const headers = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), accelerometer=(), gyroscope=(), magnetometer=()",
    },
  ];
  if (production) headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  return headers;
}

/** API responses are JSON, streams or downloads and never render as pages: lock them down completely. */
export function apiHeaders() {
  return [{ key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }];
}

/**
 * The project preview (/api/preview/<token>/...) is the one API path that renders as a page: inside Morphie's own
 * frame only, and always in an opaque, sandboxed origin so the project's scripts can never act as the user.
 * Listed last: for the same header key, the later rule wins.
 */
export function previewHeaders() {
  return [
    { key: "Content-Security-Policy", value: "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock; frame-ancestors 'self'" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
  ];
}

export function allHeaders({ production }) {
  return [
    { source: "/:path*", headers: pageHeaders({ production }) },
    { source: "/api/:path*", headers: apiHeaders() },
    { source: "/api/preview/:path*", headers: previewHeaders() },
  ];
}
