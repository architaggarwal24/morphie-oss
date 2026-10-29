import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * The only place that touches the Cloudflare runtime context. Everything else asks for `cfEnv()`.
 * Tests alias "@opennextjs/cloudflare" to a stub (see vitest.config.mts), so this file stays trivial.
 */
export function cfEnv(): CloudflareEnv {
  return getCloudflareContext().env as CloudflareEnv;
}

/** Keep the isolate alive until `p` settles (Workers' ctx.waitUntil). No-op elsewhere. */
export function cfWaitUntil(p: Promise<unknown>): void {
  try { (getCloudflareContext().ctx as { waitUntil?: (p: Promise<unknown>) => void } | undefined)?.waitUntil?.(p); } catch { /* not on Workers */ }
}
