export class ApiFailure extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

let onSignedOut: (() => void) | null = null;
/** The store registers this: a 401 "unauthenticated" answer means the session ended, so the page returns to the sign-in screen. */
export function setSignedOutHandler(fn: (() => void) | null): void { onSignedOut = fn; }

/** The last "your plan doesn't include that / out of credits" answer, so its toast can offer "See plans". */
let lastPlanFailure: { message: string; at: number } | null = null;
export function isPlanFailure(text: string): boolean { return !!lastPlanFailure && lastPlanFailure.message === text && Date.now() - lastPlanFailure.at < 10_000; }

async function failure(res: Response): Promise<ApiFailure> {
  let message = `Request failed (${res.status}).`;
  let code: string | undefined;
  try {
    const j = await res.json();
    if (j?.error) message = String(j.error);
    code = j?.code;
  } catch { /* non-JSON error body */ }
  if (res.status === 401 && code === "unauthenticated") onSignedOut?.();
  if (res.status === 402 || code === "capacity") lastPlanFailure = { message, at: Date.now() };
  return new ApiFailure(message, res.status, code);
}

/**
 * A fresh Idempotency-Key. Make ONE when the person starts an action that creates something (send, upload, add) and
 * pass it to every attempt of that action; the server then runs it at most once (src/server/idempotency.ts).
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); // randomUUID needs a secure context; plain-http LAN use doesn't have one
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Waits between automatic retries of a keyed request (so 3 attempts in all). */
export const RETRY_DELAYS_MS = [400, 1200];
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; form?: FormData; keepalive?: boolean; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(init.body); }
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  // Only a request with an Idempotency-Key is retried automatically: the key makes a repeat harmless.
  for (let attempt = 0; ; attempt++) {
    const canRetry = !!init.idempotencyKey && attempt < RETRY_DELAYS_MS.length;
    let res: Response;
    try {
      res = await fetch(path, { method: init.method ?? (body ? "POST" : "GET"), headers, body, signal: init.signal, ...(init.keepalive ? { keepalive: true } : {}) });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      if (canRetry) { await sleep(RETRY_DELAYS_MS[attempt], init.signal); continue; }
      throw new ApiFailure("Couldn't reach the Morphie server. Is it still running?", 0, "network");
    }
    if (!res.ok) {
      const f = await failure(res);
      if (canRetry && (f.code === "idempotency_in_progress" || res.status === 502 || res.status === 503 || res.status === 504)) { await sleep(RETRY_DELAYS_MS[attempt], init.signal); continue; }
      throw f;
    }
    return (await res.json()) as T;
  }
}

/**
 * POST `body` (or GET when it's undefined) and consume a text/event-stream response, calling onEvent for every `data:`
 * message. A JSON answer instead of a stream (e.g. "nothing is running") is returned as is.
 */
export async function streamSSE<T>(path: string, body: unknown, onEvent: (e: T) => void, signal?: AbortSignal, opts: { idempotencyKey?: string } = {}): Promise<unknown> {
  const headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  let res!: Response;
  // With a key, a connection that fails before any answer arrives is retried: if the first try did reach the server,
  // the retry answers 409 "already sent" instead of starting the same run twice.
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(path, body === undefined ? { method: "GET", headers, signal } : { method: "POST", headers, body: JSON.stringify(body), signal });
      break;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (opts.idempotencyKey && attempt < RETRY_DELAYS_MS.length) {
        try { await sleep(RETRY_DELAYS_MS[attempt], signal); } catch { return; }
        continue;
      }
      throw new ApiFailure("Couldn't reach the Morphie server. Is it still running?", 0, "network");
    }
  }
  if (!res.ok) throw await failure(res);
  if ((res.headers.get("content-type") ?? "").includes("application/json")) return await res.json().catch(() => null);
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) {
            try { onEvent(JSON.parse(line.slice(6)) as T); } catch { /* ignore malformed event */ }
          }
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw new ApiFailure("The connection dropped while the reply was streaming.", 0, "network");
  }
}
