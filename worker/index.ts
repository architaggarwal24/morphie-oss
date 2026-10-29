/**
 * Worker entry point.
 *
 * - `fetch` delegates to the Worker that `opennextjs-cloudflare build` generates (the whole Next.js app).
 * - `Coordinator` is the Durable Object that holds the few things Morphie used to keep in process memory:
 *   pending agent approvals, "this conversation is busy" locks, per-design edit locks and rate limits.
 *   Workers run as many isolates in many places, so those cannot live in a module-level Map any more.
 * - `AgentRunner` is one Durable Object per conversation that hosts its agent runs, so a run keeps working after the
 *   browser tab closes and anyone can re-attach to it (src/server/agent/runner.ts forwards the requests here).
 */
import { DurableObject } from "cloudflare:workers";
// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "../.open-next/worker.js";
import { CoordinatorCore, type Decision, type RunnerJob, type RunnerResult } from "../src/server/coordinator-core";
import { resumeSlices, waitingSlices } from "../src/server/agent/slices";

// Count outbound requests, so a run can hand over before the Workers Free limit of 50 per invocation (agent/slices.ts).
{
  const g = globalThis as { __morphieFetches?: number; __morphieFetchCounted?: boolean; fetch: typeof fetch };
  if (!g.__morphieFetchCounted) {
    g.__morphieFetchCounted = true;
    const base = g.fetch;
    g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => { g.__morphieFetches = (g.__morphieFetches ?? 0) + 1; return base(input, init); }) as typeof fetch;
  }
}

// Code projects: the sandbox Durable Object, its outbound-network gate and the backup gateway it uses (worker/sandbox.ts).
export { DirectoryBackupGateway, MorphieSandbox, SandboxOutbound } from "./sandbox";

/** What the email handler uses of an incoming message (Cloudflare Email Routing → Email Worker). */
interface InboundEmail { readonly raw: ReadableStream<Uint8Array>; readonly rawSize: number; readonly from: string; setReject(reason: string): void }

export default {
  fetch: handler.fetch,
  /**
   * Bank alert emails, for confirming UPI payments (hosted edition). Route your bank's alerts to an address on this
   * Worker with Cloudflare Email Routing; the app checks the email's DKIM signature against the bank domains set in
   * Settings → Admin → Payments before it believes anything in it (src/server/payments). Off without
   * MORPHIE_INBOUND_SECRET.
   */
  async email(message: InboundEmail, env: CloudflareEnv, ctx: ExecutionContext): Promise<void> {
    const secret = (env as unknown as { MORPHIE_INBOUND_SECRET?: string }).MORPHIE_INBOUND_SECRET;
    if (!secret) { message.setReject("This address doesn't accept mail."); return; }
    if (message.rawSize > 512_000) { message.setReject("Message too large."); return; }
    const raw = await new Response(message.raw).text();
    const req = new Request("https://morphie.internal/api/billing/inbound", { method: "POST", headers: { "x-morphie-inbound": secret, "content-type": "message/rfc822" }, body: raw });
    const res = await handler.fetch(req, env, ctx);
    if (!res.ok) console.error("[inbound email]", res.status, (await res.text()).slice(0, 300));
  },
} satisfies ExportedHandler<CloudflareEnv>;

/**
 * Runs the Next.js app for requests about one conversation's agent run (start, follow, stop). The run itself lives in
 * this object's isolate (src/server/agent/runs.ts), detached from the request that started it; an alarm every 30 s
 * keeps the object awake while a run is in progress, even with nobody watching.
 */
export class AgentRunner extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    // Workers Free: a run that has used this invocation's share hands over to the next alarm (src/server/agent/slices.ts).
    (globalThis as { __morphieRunnerWake?: () => Promise<void> }).__morphieRunnerWake = () => this.ctx.storage.setAlarm(Date.now() + 10);
  }

  async fetch(request: Request): Promise<Response> {
    // Keep the object awake while a run is going; never push back an alarm that's due sooner (a waiting hand-over).
    const due = await this.ctx.storage.getAlarm();
    if (!due || due > Date.now() + 30_000) await this.ctx.storage.setAlarm(Date.now() + 30_000);
    const ctx = { waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    return handler.fetch(request, this.env, ctx);
  }

  async alarm(): Promise<void> {
    // A fresh invocation: runs waiting for one carry on here (and this alarm stays until they hand over again).
    await resumeSlices();
    const runs = (globalThis as { __morphieRuns?: Map<string, { done: boolean }> }).__morphieRuns;
    const due = await this.ctx.storage.getAlarm();
    if (!due && ((runs && [...runs.values()].some((r) => !r.done)) || waitingSlices())) await this.ctx.storage.setAlarm(Date.now() + (waitingSlices() ? 10 : 30_000));
  }
}

export class Coordinator extends DurableObject {
  private core = new CoordinatorCore();

  tryAcquire(key: string, ttlMs: number): string | null { return this.core.tryAcquire(key, ttlMs); }
  acquire(key: string, ttlMs: number, waitMs: number): Promise<string | null> { return this.core.acquire(key, ttlMs, waitMs); }
  renew(key: string, token: string, ttlMs: number): boolean { return this.core.renew(key, token, ttlMs); }
  release(key: string, token: string): void { this.core.release(key, token); }
  rateLimit(key: string, limit: number, windowMs: number): number { return this.core.rateLimit(key, limit, windowMs); }
  openApproval(id: string, timeoutMs: number): void { this.core.openApproval(id, timeoutMs); }
  awaitApproval(id: string): Promise<Decision> { return this.core.awaitApproval(id); }
  decide(id: string, decision: Decision): boolean { return this.core.decide(id, decision); }
  cancelApproval(id: string): void { this.core.cancelApproval(id); }
  heldKeys(prefix: string): string[] { return this.core.heldKeys(prefix); }
  runJob(runnerId: string, job: RunnerJob, timeoutMs: number): Promise<RunnerResult> { return this.core.runJob(runnerId, job, timeoutMs); }
  takeJobs(runnerId: string, waitMs: number): Promise<RunnerJob[]> { return this.core.takeJobs(runnerId, waitMs); }
  finishJob(jobId: string, result: RunnerResult): boolean { return this.core.finishJob(jobId, result); }
  online(runnerId: string): boolean { return this.core.online(runnerId); }
}
