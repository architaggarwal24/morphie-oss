/**
 * Runs that outlive the browser tab. A run is started detached from the request that asked for it; its events go into
 * a buffer that any number of streams can follow (the tab that started it, the same tab after a reload, another
 * device). Closing a stream never stops the run: only stop() does.
 *
 * The hub is in-process. On Node (next dev / next start) that's the server. On Cloudflare every request about a
 * conversation's run is routed to that conversation's AgentRunner Durable Object (worker/index.ts), so the run and
 * everyone following it share one isolate there too (see runner.ts).
 */
import type { AgentEvent } from "@/lib/types";

interface Entry { seq: number; e: AgentEvent }
interface Run {
  convId: string;
  userId: string;
  events: Entry[];
  seq: number;
  subs: Set<(x: Entry) => void>;
  ac: AbortController;
  done: boolean;
  startedAt: number;
  finishedAt?: number;
  promise?: Promise<void>;
}

const g = globalThis as unknown as { __morphieRuns?: Map<string, Run> };
const runs = (): Map<string, Run> => (g.__morphieRuns ??= new Map());

/** Events kept for replay; past this only the structural ones are kept (text deltas are already in the final reply). */
const MAX_BUFFER = 60_000;
const KEEP_FINISHED_MS = 3 * 60_000;

export function activeRun(convId: string): Run | undefined {
  const r = runs().get(convId);
  return r && !r.done ? r : undefined;
}

export function anyActive(): boolean {
  for (const r of runs().values()) if (!r.done) return true;
  return false;
}

/**
 * Start `fn` as the conversation's run. Throws if one is already going. `fn` gets an emit and a signal that only
 * stop() (or a server shutdown) fires.
 */
export function startRun(userId: string, convId: string, fn: (emit: (e: AgentEvent) => void, signal: AbortSignal) => Promise<void>, keepAlive?: (p: Promise<void>) => void): Run {
  if (activeRun(convId)) throw new Error("busy");
  const run: Run = { convId, userId, events: [], seq: 0, subs: new Set(), ac: new AbortController(), done: false, startedAt: Date.now() };
  runs().set(convId, run);
  const emit = (e: AgentEvent) => {
    const entry = { seq: ++run.seq, e };
    // The activity line only ever shows the latest one: replace rather than pile up.
    const prev = run.events[run.events.length - 1];
    if (e.type === "activity" && prev?.e.type === "activity") run.events[run.events.length - 1] = entry;
    else if (run.events.length < MAX_BUFFER || (e.type !== "text" && e.type !== "thinking" && e.type !== "activity")) run.events.push(entry);
    for (const s of run.subs) { try { s(entry); } catch { /* a broken subscriber doesn't stop the run */ } }
  };
  run.promise = (async () => {
    try { await fn(emit, run.ac.signal); }
    catch (err) {
      console.error("[run]", err);
      emit({ type: "error", message: "Something went wrong on the server." });
      emit({ type: "done", reason: "error", continuable: true });
    } finally {
      run.done = true;
      run.finishedAt = Date.now();
      for (const s of run.subs) { try { s({ seq: -1, e: { type: "done" } as AgentEvent }); } catch { /* ignore */ } }
      run.subs.clear();
      setTimeout(() => { if (runs().get(convId) === run) runs().delete(convId); }, KEEP_FINISHED_MS);
    }
  })();
  keepAlive?.(run.promise);
  return run;
}

export function stopRun(convId: string): boolean {
  const r = activeRun(convId);
  if (!r) return false;
  r.ac.abort();
  return true;
}

/** Wait for a run to end (tests, and Node's graceful shutdown). */
export async function settled(convId: string): Promise<void> {
  await runs().get(convId)?.promise;
}

/**
 * A text/event-stream that replays the run's events from `from` (exclusive) and then follows it live. Each event
 * carries its `seq`, so a client that loses the connection re-attaches where it left off. Disconnecting only stops
 * following.
 */
export function followRun(req: Request, convId: string, from = 0): Response | null {
  const run = runs().get(convId);
  if (!run) return null;
  const enc = new TextEncoder();
  let unsubscribe = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(ping);
        try { controller.close(); } catch { /* already closed */ }
      };
      const write = (x: Entry) => {
        if (closed) return;
        if (x.seq < 0) { close(); return; }
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify({ ...x.e, seq: x.seq })}\n\n`)); } catch { close(); }
      };
      for (const x of run.events) if (x.seq > from) write(x);
      if (run.done) { close(); return; }
      run.subs.add(write);
      unsubscribe = () => run.subs.delete(write);
      ping = setInterval(() => { if (!closed) try { controller.enqueue(enc.encode(": ping\n\n")); } catch { close(); } }, 15_000);
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel() { unsubscribe(); clearInterval(ping); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no", "x-content-type-options": "nosniff" },
  });
}

/** Test hook. */
export function _resetRuns(): void {
  for (const r of runs().values()) r.ac.abort();
  g.__morphieRuns = new Map();
}
