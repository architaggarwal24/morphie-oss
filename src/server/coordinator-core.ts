/**
 * Pure coordination logic, no Cloudflare imports. It runs inside the `Coordinator` Durable Object in
 * production, and in-process in tests and `next dev` (where Durable Objects aren't available).
 *
 * One instance serves one anonymous user, so every key below is already user-scoped.
 */
export interface Decision { approved: boolean; always?: boolean; /** Nobody answered in time. */ timedOut?: boolean; /** ask_user: the answer to each question, by question text. */ answers?: Record<string, string> }

interface Lock { token: string; expires: number }
interface Waiter { ttlMs: number; resolve: (token: string | null) => void; timer: ReturnType<typeof setTimeout> }
interface Pending { promise: Promise<Decision>; resolve: (d: Decision) => void; decided: boolean; timer: ReturnType<typeof setTimeout> }

/** One operation for a Morphie Runner (exec, readFile…), and what came back. */
export interface RunnerJob { id: string; project: string; op: string; args: unknown[] }
export interface RunnerResult { ok: boolean; value?: unknown; error?: string }
interface JobWait { resolve: (r: RunnerResult) => void; timer: ReturnType<typeof setTimeout> }
interface PollWait { resolve: (jobs: RunnerJob[]) => void; timer: ReturnType<typeof setTimeout> }

export const RUNNER_OFFLINE = "This project's Morphie Runner isn't connected. Start it on that computer (Settings → Runners shows the command) and try again.";

let counter = 0;
const newToken = () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export class CoordinatorCore {
  private locks = new Map<string, Lock>();
  private waiters = new Map<string, Waiter[]>();
  private approvals = new Map<string, Pending>();
  private buckets = new Map<string, number[]>();
  private queues = new Map<string, RunnerJob[]>();
  private polls = new Map<string, PollWait>();
  private jobs = new Map<string, JobWait>();
  private seen = new Map<string, number>();

  // ------------------------------------------------------------------ locks
  // Locks carry a TTL so a crashed/evicted request can never wedge a conversation or design forever.

  private live(key: string): Lock | undefined {
    const l = this.locks.get(key);
    if (l && l.expires <= Date.now()) { this.locks.delete(key); return undefined; }
    return l;
  }

  /** Non-blocking: returns a token, or null if the key is already held. */
  tryAcquire(key: string, ttlMs: number): string | null {
    if (this.live(key)) return null;
    const token = newToken();
    this.locks.set(key, { token, expires: Date.now() + ttlMs });
    return token;
  }

  /** FIFO queue: waits up to `waitMs` for the key. Returns a token, or null on timeout. */
  acquire(key: string, ttlMs: number, waitMs: number): Promise<string | null> {
    const now = this.tryAcquire(key, ttlMs);
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const queue = this.waiters.get(key) ?? [];
      const w: Waiter = {
        ttlMs, resolve,
        timer: setTimeout(() => {
          const q = this.waiters.get(key);
          if (q) { const i = q.indexOf(w); if (i >= 0) q.splice(i, 1); if (!q.length) this.waiters.delete(key); }
          resolve(null);
        }, waitMs),
      };
      queue.push(w);
      this.waiters.set(key, queue);
      // The holder's TTL may lapse without a release(); make sure a waiter notices.
      const held = this.live(key);
      if (held) setTimeout(() => this.drain(key), Math.max(0, held.expires - Date.now()) + 5);
    });
  }

  /** Extend a held lock (a heartbeat for long runs). False if it was lost (expired and taken, or released). */
  renew(key: string, token: string, ttlMs: number): boolean {
    const l = this.live(key);
    if (!l || l.token !== token) return false;
    l.expires = Date.now() + ttlMs;
    return true;
  }

  /** Keys currently held that start with `prefix` (e.g. the conversations with a run in progress). */
  heldKeys(prefix: string): string[] {
    const out: string[] = [];
    for (const k of [...this.locks.keys()]) if (k.startsWith(prefix) && this.live(k)) out.push(k);
    return out;
  }

  release(key: string, token: string): void {
    const l = this.locks.get(key);
    if (l && l.token === token) this.locks.delete(key);
    this.drain(key);
  }

  private drain(key: string): void {
    if (this.live(key)) return;
    const q = this.waiters.get(key);
    while (q?.length) {
      const w = q.shift()!;
      clearTimeout(w.timer);
      const token = this.tryAcquire(key, w.ttlMs);
      w.resolve(token);
      if (token) break;
    }
    if (q && !q.length) this.waiters.delete(key);
  }

  // ------------------------------------------------------------- rate limits

  /** Sliding window. Returns seconds to wait, or 0 if the call may proceed. */
  rateLimit(key: string, limit: number, windowMs: number): number {
    const t = Date.now();
    const hits = (this.buckets.get(key) ?? []).filter((h) => t - h < windowMs);
    if (hits.length >= limit) {
      this.buckets.set(key, hits);
      return Math.max(1, Math.ceil((windowMs - (t - hits[0])) / 1000));
    }
    hits.push(t);
    this.buckets.set(key, hits);
    if (this.buckets.size > 200) {
      for (const [k, b] of this.buckets) if (!b.length || t - b[b.length - 1] > 120_000) this.buckets.delete(k);
    }
    return 0;
  }

  // --------------------------------------------------------------- approvals
  // Two steps on purpose: openApproval() registers the request and returns once it exists, and only then is the
  // `approval` event sent to the browser. That guarantees decide() can never arrive before the request is known.

  openApproval(id: string, timeoutMs: number): void {
    let resolve!: (d: Decision) => void;
    const promise = new Promise<Decision>((r) => { resolve = r; });
    const p: Pending = { promise, resolve, decided: false, timer: setTimeout(() => this.settle(id, { approved: false, timedOut: true }), timeoutMs) };
    this.approvals.set(id, p);
  }

  /** Resolves when decide() / cancelApproval() is called, or the timeout elapses (→ denied). */
  awaitApproval(id: string): Promise<Decision> {
    return this.approvals.get(id)?.promise ?? Promise.resolve({ approved: false });
  }

  private settle(id: string, d: Decision): boolean {
    const p = this.approvals.get(id);
    if (!p || p.decided) return false;
    p.decided = true;
    clearTimeout(p.timer);
    p.resolve(d);
    // Keep the settled entry briefly so a late awaitApproval() still receives the answer, then forget it.
    setTimeout(() => this.approvals.delete(id), 60_000);
    return true;
  }

  decide(id: string, decision: Decision): boolean {
    return this.settle(id, decision);
  }

  cancelApproval(id: string): void {
    this.settle(id, { approved: false });
  }

  pendingApprovals(): number {
    let n = 0;
    for (const p of this.approvals.values()) if (!p.decided) n++;
    return n;
  }

  // ------------------------------------------------------------------ Morphie Runner jobs
  // The agent hands a job to one of the user's runners and waits for the answer; the runner long-polls for jobs and
  // posts results. Nothing here is persisted: a job outlives neither a restart nor its timeout.

  /** Queue a job for a runner and wait for its result (or a timeout → an error result). */
  runJob(runnerId: string, job: RunnerJob, timeoutMs: number): Promise<RunnerResult> {
    if (!this.online(runnerId)) return Promise.resolve({ ok: false, error: RUNNER_OFFLINE });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.jobs.delete(job.id);
        const q = this.queues.get(runnerId);
        if (q) this.queues.set(runnerId, q.filter((j) => j.id !== job.id));
        resolve({ ok: false, error: this.online(runnerId) ? "The runner didn't answer in time." : RUNNER_OFFLINE });
      }, timeoutMs);
      this.jobs.set(job.id, { resolve, timer });
      const q = this.queues.get(runnerId) ?? [];
      q.push(job);
      this.queues.set(runnerId, q);
      this.deliver(runnerId);
    });
  }

  /** The runner asks for work: whatever is queued, or wait up to `waitMs` for some. */
  takeJobs(runnerId: string, waitMs: number): Promise<RunnerJob[]> {
    this.seen.set(runnerId, Date.now());
    const prev = this.polls.get(runnerId);
    if (prev) { clearTimeout(prev.timer); prev.resolve([]); this.polls.delete(runnerId); }
    const q = this.queues.get(runnerId);
    if (q?.length) { this.queues.delete(runnerId); return Promise.resolve(q); }
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.polls.delete(runnerId); this.seen.set(runnerId, Date.now()); resolve([]); }, waitMs);
      this.polls.set(runnerId, { resolve, timer });
    });
  }

  private deliver(runnerId: string): void {
    const poll = this.polls.get(runnerId);
    const q = this.queues.get(runnerId);
    if (!poll || !q?.length) return;
    clearTimeout(poll.timer);
    this.polls.delete(runnerId);
    this.queues.delete(runnerId);
    this.seen.set(runnerId, Date.now());
    poll.resolve(q);
  }

  /** A runner's answer to a job. False when nobody is waiting for it any more. */
  finishJob(jobId: string, result: RunnerResult): boolean {
    const w = this.jobs.get(jobId);
    if (!w) return false;
    clearTimeout(w.timer);
    this.jobs.delete(jobId);
    w.resolve(result);
    return true;
  }

  /** A runner counts as connected while it's polling (or polled in the last 40 s). */
  online(runnerId: string): boolean {
    return this.polls.has(runnerId) || Date.now() - (this.seen.get(runnerId) ?? 0) < 40_000;
  }
}
