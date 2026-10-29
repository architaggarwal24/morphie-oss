import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }
export interface Mock { url: string; calls: Recorded[]; close(): Promise<void> }

export type Handler = (req: Recorded, res: http.ServerResponse) => void;

export async function startMock(handler: Handler): Promise<Mock> {
  const calls: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      let body: any = raw;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { /* keep raw */ }
      const rec = { method: req.method!, url: req.url!, headers: req.headers, body };
      calls.push(rec);
      handler(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

export function sse(res: http.ServerResponse, events: Array<string | object>, opts: { event?: string } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) {
    res.write(`${opts.event ? `event: ${opts.event}\n` : ""}data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
  }
  res.end();
}

export function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
