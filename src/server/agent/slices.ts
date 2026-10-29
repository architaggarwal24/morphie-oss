/**
 * Run slices, for Cloudflare's Workers Free plan.
 *
 * One invocation of a Worker (or a Durable Object event) may make only 50 outbound requests on the free plan, and an
 * agent task can easily make more (a model call per step, searches, page fetches). With MORPHIE_RUN_SLICE_STEPS set,
 * a run hands itself over to a fresh invocation every few steps: it waits at the start of a step until the
 * conversation's AgentRunner Durable Object wakes up again (an alarm, which is a new invocation with a fresh budget)
 * and lets it go on from there. The run, its event stream and its reply stay one and the same; nobody sees the seams.
 *
 * Off (0) by default and everywhere but the AgentRunner: on Node and on Workers Paid a run simply keeps going.
 */
import { config } from "../config";

interface Slice { waiting?: () => void; ended?: () => void }
const g = globalThis as unknown as {
  __morphieSlices?: Map<string, Slice>;
  /** Set by the AgentRunner Durable Object (worker/index.ts): schedule an alarm right away. */
  __morphieRunnerWake?: () => unknown;
  /** Outbound fetches made in this isolate (counted by worker/index.ts). */
  __morphieFetches?: number;
};
const slices = () => (g.__morphieSlices ??= new Map());

/** Outbound requests one slice may make before handing over (the free plan allows 50 per invocation). */
export const SLICE_FETCHES = 30;

/**
 * For runAgent: called before every step after the first. Once this invocation has done its share (steps or outbound
 * requests), it waits for the next one to take over. Undefined when slicing is off or there's no runner to wake.
 */
export function sliceHook(convId: string, steps = config.runSliceSteps): ((signal: AbortSignal) => Promise<void>) | undefined {
  if (!steps || !g.__morphieRunnerWake) return undefined;
  let done = 0;
  let mark = g.__morphieFetches ?? 0;
  return async (signal) => {
    done++;
    if (done < steps && (g.__morphieFetches ?? 0) - mark < SLICE_FETCHES) return;
    const s = slices().get(convId) ?? {};
    slices().set(convId, s);
    // The invocation that hosted this slice can finish now…
    s.ended?.(); s.ended = undefined;
    // …and the next one picks the run up.
    await new Promise<void>((resolve) => {
      s.waiting = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
      void g.__morphieRunnerWake?.();
    });
    s.waiting = undefined;
    done = 0;
    mark = g.__morphieFetches ?? 0;
  };
}

/** The run is over: release whatever invocation is hosting it. */
export function endSlices(convId: string): void {
  const s = slices().get(convId);
  s?.ended?.();
  slices().delete(convId);
}

/** Runs waiting for a fresh invocation (the AgentRunner's alarm checks). */
export const waitingSlices = (): number => [...slices().values()].filter((s) => s.waiting).length;

/**
 * Called from the AgentRunner's alarm: let every waiting run go on in this invocation, and stay until each hands over
 * again or finishes (at most `maxMs`: alarms may run for 15 minutes).
 */
export async function resumeSlices(maxMs = 14 * 60_000): Promise<number> {
  const hosted: Array<Promise<void>> = [];
  for (const s of slices().values()) {
    const go = s.waiting;
    if (!go) continue;
    s.waiting = undefined;
    hosted.push(new Promise<void>((resolve) => { s.ended = resolve; go(); }));
  }
  if (!hosted.length) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(hosted), new Promise<void>((r) => { timer = setTimeout(r, maxMs); })]);
  clearTimeout(timer);
  return hosted.length;
}
