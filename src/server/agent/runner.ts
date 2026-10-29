/**
 * Cloudflare: each conversation's runs live in its own AgentRunner Durable Object (worker/index.ts), so a run keeps
 * going after the browser leaves and every client that follows it reaches the same place. Requests about a run
 * (start, follow, stop) are forwarded there, where the very same Next.js route handles them in the object's isolate.
 * Elsewhere (Node) there is one process and nothing needs forwarding.
 */
import { cfEnv } from "../cf";
import { hmacHex, safeEqualHex } from "../crypto";
import { ApiError } from "../http";

export const RUNNER_HEADER = "x-morphie-runner";

function namespace(): AgentRunnerNamespaceLike | undefined {
  if (process.env.NODE_ENV === "test") return undefined;
  try { return cfEnv().AGENT_RUNNER; } catch { return undefined; }
}

const tokenFor = (convId: string) => hmacHex("agent-runner", convId);

/** True when this request was forwarded by the worker to the conversation's runner (and carries a valid token). */
export function insideRunner(req: Request, convId: string): boolean {
  const h = req.headers.get(RUNNER_HEADER);
  if (!h) return false;
  if (!safeEqualHex(h, tokenFor(convId))) throw new ApiError(403, "Invalid runner token.", "forbidden");
  return true;
}

/**
 * On Cloudflare, outside the runner: send the request to the conversation's runner and return its response.
 * Otherwise null (handle it here). `body` replaces the request body (it has already been read).
 */
export async function viaRunner(req: Request, convId: string, body?: unknown): Promise<Response | null> {
  const ns = namespace();
  if (!ns || insideRunner(req, convId)) return null;
  const headers = new Headers(req.headers);
  // The key was claimed by this request; the forwarded copy must not be refused as a replay.
  headers.delete("idempotency-key");
  headers.delete("content-length");
  headers.set(RUNNER_HEADER, tokenFor(convId));
  if (body !== undefined) headers.set("content-type", "application/json");
  const forwarded = new Request(req.url, { method: req.method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: req.signal });
  return ns.get(ns.idFromName(convId)).fetch(forwarded);
}

/** Stop a conversation's run wherever it lives (deleting a conversation that's still working). Best effort. */
export async function stopEverywhere(req: Request, convId: string): Promise<void> {
  const { stopRun } = await import("./runs");
  stopRun(convId);
  const ns = namespace();
  if (!ns) return;
  const headers = new Headers(req.headers);
  headers.delete("idempotency-key");
  headers.delete("content-length");
  headers.set(RUNNER_HEADER, tokenFor(convId));
  headers.set("content-type", "application/json");
  const url = new URL(`/api/runs/${convId}/stop`, req.url);
  await ns.get(ns.idFromName(convId)).fetch(new Request(url, { method: "POST", headers, body: "{}" })).catch(() => {});
}
