import { expect } from "vitest";

export const ORIGIN = "http://localhost:3000";

export interface CallInit { method?: string; body?: unknown; origin?: string | null; params?: Record<string, string>; headers?: Record<string, string>; form?: FormData }

/** A browser stand-in: keeps a cookie jar (honouring Max-Age=0 deletions) and calls route handlers directly. */
export class Client {
  jar = new Map<string, string>();
  constructor(public origin = ORIGIN, public defaults: Record<string, string> = {}) {}

  get cookieHeader(): string { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  /** The value of the session cookie, whichever name it has. */
  get sessionToken(): string | undefined { return this.jar.get("morphie_session") ?? this.jar.get("__Host-morphie_session"); }

  async call(handler: Function, p: string, init: CallInit = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { host: new URL(this.origin).host, ...this.defaults, ...init.headers };
    if (init.origin !== null) headers.origin = init.origin ?? this.origin;
    if (this.jar.size) headers.cookie = this.cookieHeader;
    let body: BodyInit | undefined;
    if (init.form) body = init.form;
    else if (init.body !== undefined) { body = JSON.stringify(init.body); headers["content-type"] = "application/json"; }
    const res: Response = await handler(new Request(this.origin + p, { method, headers, body }), { params: Promise.resolve(init.params ?? {}) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";").map((x) => x.trim());
      const i = pair.indexOf("=");
      const name = pair.slice(0, i), value = pair.slice(i + 1);
      if (!value || attrs.some((a) => /^max-age=0$/i.test(a))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }

  async json(handler: Function, p: string, init: CallInit = {}) {
    const res = await this.call(handler, p, init);
    const text = await res.text();
    let data: any; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
}

export function expectDenied(status: number) {
  expect([403, 404], `expected 403/404 but got ${status}`).toContain(status);
}
