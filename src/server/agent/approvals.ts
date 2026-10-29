import { coordinator, type Decision } from "../coordinator";
import { randomId } from "../crypto";

export type { Decision };

export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * Suspend the agent until the user answers (or the run is stopped / the prompt times out → denied).
 * The request lives in the user's Coordinator (a Durable Object on Cloudflare), so the approve call can land on any
 * isolate. It is registered before this returns, so the `approval` event can't race ahead of it.
 */
export async function requestApproval(userId: string, signal: AbortSignal, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<{ id: string; decision: Promise<Decision> }> {
  const id = randomId(9);
  const stub = coordinator(userId);
  await stub.openApproval(id, timeoutMs);
  const decision = new Promise<Decision>((resolve) => {
    let done = false;
    const finish = (d: Decision) => { if (!done) { done = true; signal.removeEventListener("abort", onAbort); resolve(d); } };
    const onAbort = () => { void stub.cancelApproval(id).catch(() => {}); finish({ approved: false }); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    stub.awaitApproval(id).then(finish, () => finish({ approved: false }));
  });
  return { id, decision };
}

/** Called by the approve endpoint. Approvals are kept per user, so only the user who owns the run can answer it. */
export async function decide(userId: string, id: string, decision: Decision): Promise<boolean> {
  return coordinator(userId).decide(id, decision);
}
