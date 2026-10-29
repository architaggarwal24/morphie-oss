import { z } from "zod";
import { coordinator } from "@/server/coordinator";
import { ApiError, route } from "@/server/http";
import { runnerFromRequest, sawRunner } from "@/server/runners";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Morphie Runner's side (public/morphie-runner.mjs). No session: the runner's own token (Authorization: Bearer)
 * is the key, and it only ever reaches the jobs of the account that made it.
 */

/** Long poll: the jobs waiting for this runner, or an empty list after `wait` ms (at most 25 s). */
export const GET = route({ auth: "public", rate: { bucket: "runner", limit: 240, windowMs: 60_000 } }, async (c) => {
  const runner = await runnerFromRequest(c.req);
  await sawRunner(runner, (c.req.headers.get("x-runner-platform") ?? "").slice(0, 80));
  const wait = Math.min(25_000, Math.max(0, Number(c.url.searchParams.get("wait") ?? 25_000) || 0));
  return { jobs: await coordinator(runner.user_id).takeJobs(runner.id, wait) };
});

const result = z.object({ id: z.string().min(8).max(40), ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(4000).optional() });

/** What the runner did: one result per job. */
export const POST = route({ auth: "public", rate: { bucket: "runner-results", limit: 1200, windowMs: 60_000 } }, async (c) => {
  const runner = await runnerFromRequest(c.req);
  const b = await c.body(z.object({ results: z.array(result).min(1).max(50) }), 12_000_000);
  if (!b.results.length) throw new ApiError(400, "No results.", "invalid");
  const stub = coordinator(runner.user_id);
  let accepted = 0;
  for (const r of b.results) if (await stub.finishJob(r.id, { ok: r.ok, value: r.value, error: r.error })) accepted++;
  return { accepted };
});
