/**
 * Idempotency keys for requests that create something (Stripe-style). The browser makes one key when the person starts
 * an action and sends it as `Idempotency-Key` on every retry of that action, so a retry after a dropped connection can
 * never create a second conversation, memory, document or provider.
 *
 * - Same key, same request, finished with 2xx: the stored answer is replayed (header `idempotent-replayed: true`).
 *   Streams (chat, design) can't be replayed: they answer 409 `idempotency_replayed` and the client reloads history.
 * - Same key while the first is still running: 409 `idempotency_in_progress` (retry shortly).
 * - Same key, different request: 422 `idempotency_mismatch`.
 * - Errors (4xx/5xx or a throw) are not stored, so the key can be retried.
 *
 * Kept in memory, per user, for 24 hours, like the rate limits: Morphie runs as one process (see README).
 */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
const MAX_ENTRIES = 10_000;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

interface Entry { fingerprint: string; at: number; state: "running" | "done"; stream?: boolean; status?: number; body?: string; contentType?: string }
const g = globalThis as unknown as { __morphieIdem?: Map<string, Entry> };
const store = (): Map<string, Entry> => (g.__morphieIdem ??= new Map());

export class IdempotencyError extends Error {
  constructor(public status: number, message: string, public code: string) { super(message); }
}

async function fingerprint(req: Request, path: string): Promise<string> {
  const body = new Uint8Array(await req.clone().arrayBuffer());
  const head = new TextEncoder().encode(`${req.method} ${path}\n${req.headers.get("content-type")?.split(";")[0] ?? ""}\n`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head); all.set(body, head.length);
  // Multipart boundaries differ per send, so for uploads only the method, path and size are compared, not the bytes.
  const data = (req.headers.get("content-type") ?? "").startsWith("multipart/") ? new TextEncoder().encode(`${req.method} ${path} multipart`) : all;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function prune(now: number): void {
  const m = store();
  for (const [k, e] of m) if (now - e.at > IDEMPOTENCY_TTL_MS) m.delete(k);
  while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value!); // oldest first (Map keeps insertion order)
}

/** Runs `run` at most once per (user, key). Requests without a key run normally. */
export async function withIdempotency(req: Request, userId: string, path: string, run: () => Promise<Response>): Promise<Response> {
  const key = req.headers.get("idempotency-key");
  if (key === null || req.method !== "POST") return run();
  if (!KEY_RE.test(key)) throw new IdempotencyError(400, "The Idempotency-Key header must be 8 to 200 letters, digits or - _ . :", "idempotency_invalid");
  const now = Date.now();
  prune(now);
  const id = `${userId}\u0000${key}`;
  const fp = await fingerprint(req, path);
  const seen = store().get(id);
  if (seen) {
    if (seen.fingerprint !== fp) throw new IdempotencyError(422, "That Idempotency-Key was already used for a different request.", "idempotency_mismatch");
    if (seen.state === "running") throw new IdempotencyError(409, "This request is still being processed. Try again in a moment.", "idempotency_in_progress");
    if (seen.stream) throw new IdempotencyError(409, "This was already sent. It's in your history.", "idempotency_replayed");
    return new Response(seen.body, { status: seen.status, headers: { "content-type": seen.contentType ?? "application/json", "idempotent-replayed": "true" } });
  }
  store().set(id, { fingerprint: fp, at: now, state: "running" });
  let res: Response;
  try { res = await run(); } catch (e) { store().delete(id); throw e; }
  if (!res.ok) { store().delete(id); return res; }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.startsWith("text/event-stream")) store().set(id, { fingerprint: fp, at: now, state: "done", stream: true });
  else store().set(id, { fingerprint: fp, at: now, state: "done", status: res.status, body: await res.clone().text(), contentType });
  return res;
}

export function _resetIdempotencyForTests(): void { store().clear(); }
