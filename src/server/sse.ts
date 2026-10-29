/**
 * Server-sent events over a Response. The run gets an AbortSignal that fires when the browser
 * disconnects (Stop button, closed tab), so agents and provider calls never outlive their reader.
 */
export type Emit = (event: object) => void;

export function sse(req: Request, run: (emit: Emit, signal: AbortSignal) => Promise<void>): Response {
  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort(), { once: true });
  const enc = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(chunk)); } catch { closed = true; }
      };
      const emit: Emit = (e) => write(`data: ${JSON.stringify(e)}\n\n`);
      ping = setInterval(() => write(": ping\n\n"), 15_000);
      run(emit, ac.signal)
        .catch((err) => {
          console.error("[sse]", err);
          emit({ type: "error", message: "Something went wrong on the server." });
        })
        .finally(() => {
          clearInterval(ping);
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        });
    },
    cancel() {
      clearInterval(ping);
      ac.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
