import { assertProductionConfig, config } from "./server/config";

/**
 * In production, refuse to start on unsafe configuration: print every problem and exit with status 1, so a supervisor
 * (systemd, Docker, a PaaS) sees a crash instead of a half-working server. Also warn about settings that weaken per-IP limits.
 */
export function startupChecks(): void {
  try {
    assertProductionConfig();
  } catch (e) {
    console.error(`\n${(e as Error).message}\n`);
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production" && config.trustedProxyHops === 0) {
    console.warn("[security] MORPHIE_TRUSTED_PROXY is not set: the client IP is unknown, so per-IP limits act as one global limit. Set it to the number of reverse proxies in front of Morphie.");
  }
}
