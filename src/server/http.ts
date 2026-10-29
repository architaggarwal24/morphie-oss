import { z, ZodType } from "zod";
import type { Actor, AuthLevel } from "./auth/actor";
import { purgeSessions, readSessionToken, resolveSession, type ResolvedSession } from "./auth/session";
import { config } from "./config";
import { NotFoundError } from "./data/errors";
import { hitDurable, purgeRateLimits } from "./data/rateLimits";
import { IdempotencyError, withIdempotency } from "./idempotency";
import { checkOrigin, clientIp, OriginError, rateLimit, SecurityError } from "./security";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}

export interface Ctx<A extends AuthLevel = AuthLevel> {
  req: Request;
  url: URL;
  /**
   * Who is calling. `public` routes get `Actor | null`: a visitor with no valid session is nobody, and nothing here
   * ever creates an identity for them. `user` routes only run for a signed-in user (anyone else gets 401).
   */
  actor: A extends "public" ? Actor | null : Actor;
  /** The resolved session for this request, if any (expiry info). Always set on `user` routes. */
  session: ResolvedSession | null;
  /** Client IP as far as it can be trusted (see MORPHIE_TRUSTED_PROXY), or "unknown". */
  ip: string;
  /** Dynamic path segments, e.g. { id } for /api/things/[id]. */
  params: Record<string, string>;
  /** Extra Set-Cookie headers to send with the response (login, logout). */
  cookies: string[];
  /** Parse and validate the JSON body. */
  body<T>(schema: ZodType<T>, maxBytes?: number): Promise<T>;
}

/** `auth` is required: leaving it out is a type error, so no route can forget to say who may call it. */
export interface RouteOptions<A extends AuthLevel> {
  auth: A;
  rate?: {
    bucket: string; limit: number; windowMs: number;
    /** Already counted (a request the worker forwarded to itself). */ skip?: (req: Request) => boolean;
    /** Also count in the database, so the limit holds across every server instance (sign-in and sign-up routes). */ durable?: boolean;
  };
}

/** The wrapped handler carries its declared level so tests can verify every route declares one. */
/** Route params: one segment per [name], a list for a catch-all [...name] / [[...name]]. */
export type RouteParams = Record<string, string | string[] | undefined>;
export type RouteHandler = ((req: Request, routeCtx: { params: Promise<RouteParams> }) => Promise<Response>) & { auth: AuthLevel };

function jsonError(status: number, message: string, code: string, cookies: string[], headers: Record<string, string> = {}): Response {
  const res = new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
  for (const c of cookies) res.headers.append("set-cookie", c);
  return res;
}

let lastPurge = 0;

/**
 * Resolve the caller's session. Reads only: it never creates a session, a user or a cookie. Sessions come into
 * being solely through a completed login (src/server/auth/login.ts).
 */
async function authenticate(req: Request, level: AuthLevel): Promise<ResolvedSession | null> {
  const token = readSessionToken(req);
  const existing = token ? await resolveSession(token) : null;
  if (existing) return existing;
  if (level === "public") return null;
  throw new ApiError(401, "Sign in to use this.", "unauthenticated");
}

/**
 * Wraps a route handler with: authentication at the declared level, CSRF check, rate limiting (per user and per IP),
 * body validation, uniform JSON errors and no-store caching. Handlers may return a Response or any JSON value.
 */
export function route<A extends AuthLevel>(opts: RouteOptions<A>, handler: (ctx: Ctx<A>) => Promise<unknown>): RouteHandler {
  const wrapped = async (req: Request, routeCtx: { params: Promise<RouteParams> }): Promise<Response> => {
    const cookies: string[] = [];
    try {
      // Handlers see [name] params as strings; a catch-all's list comes through as is (read it with a cast).
      const params = ((await routeCtx?.params) ?? {}) as Record<string, string>;
      const ip = clientIp(req);
      checkOrigin(req);
      const ipWait = rateLimit(`ip:${ip}`, config.ipRatePerMinute, 60_000);
      if (ipWait) throw new ApiError(429, `Slow down — try again in ${ipWait}s.`, "rate_limited");
      const session = await authenticate(req, opts.auth);
      const actor = session?.actor ?? null;
      if (opts.rate && !opts.rate.skip?.(req)) {
        const waitUser = rateLimit(`${opts.rate.bucket}:${actor?.userId ?? ip}`, opts.rate.limit, opts.rate.windowMs);
        // Rotating cookies must not escape the limit: the same bucket is also counted per IP, with room for shared networks.
        const waitIp = rateLimit(`${opts.rate.bucket}:ip:${ip}`, opts.rate.limit * 3, opts.rate.windowMs);
        let wait = Math.max(waitUser, waitIp);
        if (!wait && opts.rate.durable) {
          wait = Math.max(
            await hitDurable(`${opts.rate.bucket}:${actor?.userId ?? ip}`, opts.rate.limit, opts.rate.windowMs),
            await hitDurable(`${opts.rate.bucket}:ip:${ip}`, opts.rate.limit * 3, opts.rate.windowMs),
          );
        }
        if (wait) throw Object.assign(new ApiError(429, `Slow down — try again in ${wait}s.`, "rate_limited"), { retryAfter: wait });
      }
      if (Date.now() - lastPurge > 3_600_000) { lastPurge = Date.now(); try { await purgeSessions(); await purgeRateLimits(); } catch { /* best effort */ } }
      const ctx = {
        req, url: new URL(req.url), actor, session, ip, params, cookies,
        async body<T>(schema: ZodType<T>, maxBytes = 1_000_000) {
          const text = await req.text();
          if (text.length > maxBytes) throw new ApiError(413, "That request is too large.", "too_large");
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            throw new ApiError(400, "The request body isn't valid JSON.", "bad_json");
          }
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            const first = parsed.error.issues[0];
            const where = first?.path.length ? `${first.path.join(".")}: ` : "";
            throw new ApiError(400, `${where}${first?.message ?? "Invalid request."}`, "invalid");
          }
          return parsed.data;
        },
      } as unknown as Ctx<A>;
      const execute = async (): Promise<Response> => {
        const result = await handler(ctx);
        return result instanceof Response ? result : new Response(JSON.stringify(result ?? { ok: true }), { headers: { "content-type": "application/json" } });
      };
      // A POST carrying an Idempotency-Key runs at most once per signed-in user (see idempotency.ts).
      const res = actor ? await withIdempotency(req, actor.userId, new URL(req.url).pathname, execute) : await execute();
      for (const c of cookies) res.headers.append("set-cookie", c);
      if (!res.headers.has("cache-control")) res.headers.set("cache-control", "no-store");
      return res;
    } catch (err) {
      if (err instanceof ApiError) {
        const retry = (err as ApiError & { retryAfter?: number }).retryAfter;
        return jsonError(err.status, err.message, err.code, cookies, retry ? { "retry-after": String(retry) } : {});
      }
      if (err instanceof IdempotencyError) return jsonError(err.status, err.message, err.code, cookies);
      if (err instanceof NotFoundError) return jsonError(404, err.message, "not_found", cookies);
      if (err instanceof OriginError) return jsonError(403, err.message, "forbidden", cookies);
      if (err instanceof SecurityError) return jsonError(400, err.message, "invalid", cookies);
      console.error("[api]", req.method, new URL(req.url).pathname, err);
      return jsonError(500, "Something went wrong on the server.", "internal", cookies);
    }
  };
  return Object.assign(wrapped, { auth: opts.auth as AuthLevel });
}

export { z };
