import { config } from "../config";
import { guardedFetch, securityCause } from "../net";
import { redact } from "../security";
import { ProviderError } from "./types";

export interface OpenedResponse {
  res: Response;
  /** Aborts the request (used by idle timeout / user stop). */
  abort: () => void;
  signal: AbortSignal;
}

export interface FetchOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  label: string;
  secrets?: Array<string | undefined>;
  retries?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** fetch with a headers timeout, user abort, friendly errors and a small retry for transient failures. */
export async function providerFetch(url: string, init: RequestInit, opts: FetchOptions): Promise<OpenedResponse> {
  const attempts = 1 + (opts.retries ?? 1);
  let lastErr: ProviderError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw new ProviderError("Stopped.", undefined, false);
    const controller = new AbortController();
    const onUserAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onUserAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs);
    try {
      const res = await guardedFetch(url, { ...init, signal: controller.signal }, { allowPrivate: config.allowPrivateUrls });
      clearTimeout(timer);
      if (res.status >= 300 && res.status < 400) {
        throw new ProviderError(`${opts.label} redirected the request (${res.status}). Check the base URL — it may be missing /v1 or use http instead of https.`, res.status);
      }
      if (!res.ok) {
        const err = await httpError(res, opts);
        if (err.retryable && attempt < attempts - 1) { lastErr = err; await sleep(700 * (attempt + 1), opts.signal); continue; }
        throw err;
      }
      return { res, abort: () => controller.abort(), signal: controller.signal };
    } catch (e) {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onUserAbort);
      if (e instanceof ProviderError) throw e;
      if (opts.signal?.aborted) throw new ProviderError("Stopped.", undefined, false);
      const blocked = securityCause(e);
      if (blocked) throw new ProviderError(`Blocked: ${blocked.message} Private and local addresses aren't allowed on this server.`, undefined, false);
      const err = timedOut
        ? new ProviderError(`${opts.label} didn't respond within ${Math.round(opts.timeoutMs / 1000)}s.`, 408, true)
        : new ProviderError(`Couldn't reach ${opts.label}. Check the base URL and your network. (${redact(String((e as Error)?.cause ?? (e as Error)?.message ?? e), opts.secrets ?? []).slice(0, 160)})`, undefined, true);
      if (attempt < attempts - 1) { lastErr = err; await sleep(700 * (attempt + 1), opts.signal); continue; }
      throw err;
    }
  }
  throw lastErr ?? new ProviderError(`Couldn't reach ${opts.label}.`);
}

async function httpError(res: Response, opts: FetchOptions): Promise<ProviderError> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      const e = data?.error ?? data;
      detail = typeof e === "string" ? e : [e?.code, e?.message ?? e?.detail ?? data?.message].filter(Boolean).join(": ");
      if (!detail) detail = text;
    } catch {
      detail = text.replace(/<[^>]+>/g, " ");
    }
  } catch { /* ignore */ }
  detail = redact(detail.replace(/\s+/g, " ").trim(), opts.secrets ?? []).slice(0, 300);
  const s = res.status;
  const tail = detail ? ` — ${detail}` : "";
  const l = opts.label;
  if (s === 401 || s === 403) return new ProviderError(`${l} rejected the API key (${s}). Check the key, and that it can use this model.${tail}`, s);
  if (s === 404) return new ProviderError(`${l} couldn't find that model or endpoint (404). Check the model ID and base URL.${tail}`, s);
  if (s === 408 || s === 504) return new ProviderError(`${l} timed out (${s}).${tail}`, s, true);
  if (s === 429) return new ProviderError(`${l} says you've hit a rate limit or ran out of quota (429).${tail}`, s, true);
  if (s >= 500) return new ProviderError(`${l} is having trouble (${s}).${tail}`, s, true);
  return new ProviderError(`${l} rejected the request (${s}).${tail}`, s);
}

// ------------------------------------------------------------ stream readers

/** Iterate lines of a streaming body; aborts if no bytes arrive for `idleMs`. */
export async function* readLines(opened: OpenedResponse, idleMs: number): AsyncGenerator<string> {
  const body = opened.res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        idle = setTimeout(() => { opened.abort(); reject(new ProviderError("The provider stopped sending data.", 408, true)); }, idleMs);
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), timeout]);
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        if (opened.signal.aborted) throw new ProviderError("Stopped.");
        throw new ProviderError("The connection to the provider dropped mid-response.", undefined, true);
      } finally {
        clearTimeout(idle);
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield buf.replace(/\r$/, "");
  } finally {
    reader.cancel().catch(() => {});
  }
}

export interface SSEEvent { event?: string; data: string }

export async function* readSSE(opened: OpenedResponse, idleMs: number): AsyncGenerator<SSEEvent> {
  let event: string | undefined;
  let data: string[] = [];
  for await (const line of readLines(opened, idleMs)) {
    if (line === "") {
      if (data.length) yield { event, data: data.join("\n") };
      event = undefined;
      data = [];
    } else if (line.startsWith(":")) {
      continue;
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length) yield { event, data: data.join("\n") };
}

// --------------------------------------------------------------- think tags

/** Routes `<think>…</think>` spans (DeepSeek-R1, Qwen, …) to a reasoning callback, even when split across chunks. */
export class ThinkFilter {
  private buf = "";
  private inThink = false;
  text = "";
  reasoning = "";
  constructor(private onText?: (s: string) => void, private onReasoning?: (s: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    this.drain(false);
  }

  end(): void {
    this.drain(true);
  }

  private drain(final: boolean): void {
    for (;;) {
      const tag = this.inThink ? "</think>" : "<think>";
      const i = this.buf.indexOf(tag);
      if (i >= 0) {
        this.emit(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      let keep = 0;
      if (!final) {
        for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
          if (tag.startsWith(this.buf.slice(-k))) { keep = k; break; }
        }
      }
      this.emit(this.buf.slice(0, this.buf.length - keep));
      this.buf = this.buf.slice(this.buf.length - keep);
      return;
    }
  }

  private emit(s: string): void {
    if (!s) return;
    if (this.inThink) { this.reasoning += s; this.onReasoning?.(s); }
    else { this.text += s; this.onText?.(s); }
  }
}

// ------------------------------------------------------------------ misc

export function parseToolArgs(raw: unknown): { args: Record<string, unknown>; error?: string } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { args: raw as Record<string, unknown> };
  if (typeof raw !== "string" || !raw.trim()) return { args: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return { args: v as Record<string, unknown> };
    return { args: {}, error: "Tool arguments must be a JSON object." };
  } catch {
    return { args: {}, error: "Tool arguments were not valid JSON." };
  }
}

/** Gemini's schema dialect rejects several standard JSON-Schema keywords. */
export function stripSchema(schema: unknown, banned: string[]): unknown {
  if (Array.isArray(schema)) return schema.map((s) => stripSchema(s, banned));
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) if (!banned.includes(k)) out[k] = stripSchema(v, banned);
    return out;
  }
  return schema;
}
