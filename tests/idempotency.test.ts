import { beforeEach, describe, expect, it } from "vitest";
import * as memory from "@/app/api/memory/route";
import { route } from "@/server/http";
import { _resetIdempotencyForTests } from "@/server/idempotency";
import { accountClient } from "./helpers/users";

const KEY = "3f2b8c1e-0d4a-4c55-9a0e-7b1c2d3e4f50";
beforeEach(async () => _resetIdempotencyForTests());

describe("Idempotency-Key on routes that create things", () => {
  it("a retried create returns the first answer and creates nothing new", async () => {
    const c = accountClient();
    const body = { content: "I prefer short answers", category: "preference" };
    const first = await c.json(memory.POST, "/api/memory", { method: "POST", body, headers: { "idempotency-key": KEY } });
    const again = await c.json(memory.POST, "/api/memory", { method: "POST", body, headers: { "idempotency-key": KEY } });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.data).toEqual(first.data);
    expect((await c.json(memory.GET, "/api/memory")).data.memories).toHaveLength(1);
  });

  it("keys are per user: someone else's key never replays your answer", async () => {
    const a = accountClient(), b = accountClient();
    const body = { content: "Works on Saturdays", category: "profile" };
    await a.json(memory.POST, "/api/memory", { method: "POST", body, headers: { "idempotency-key": KEY } });
    const other = await b.json(memory.POST, "/api/memory", { method: "POST", body, headers: { "idempotency-key": KEY } });
    expect(other.headers.get("idempotent-replayed")).toBeNull();
    expect((await b.json(memory.GET, "/api/memory")).data.memories).toHaveLength(1);
  });

  it("the same key with a different request is refused", async () => {
    const c = accountClient();
    await c.json(memory.POST, "/api/memory", { method: "POST", body: { content: "Likes tea", category: "preference" }, headers: { "idempotency-key": KEY } });
    const r = await c.json(memory.POST, "/api/memory", { method: "POST", body: { content: "Likes coffee", category: "preference" }, headers: { "idempotency-key": KEY } });
    expect(r.status).toBe(422);
    expect(r.data.code).toBe("idempotency_mismatch");
  });

  it("a malformed key is refused before anything runs", async () => {
    const c = accountClient();
    const r = await c.json(memory.POST, "/api/memory", { method: "POST", body: { content: "Likes tea", category: "preference" }, headers: { "idempotency-key": "x" } });
    expect(r.status).toBe(400);
    expect((await c.json(memory.GET, "/api/memory")).data.memories).toHaveLength(0);
  });

  it("while the first request is still running a retry is told to wait; failures are not remembered", async () => {
    let release!: () => void;
    let calls = 0;
    const slow = route({ auth: "user" }, async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      await new Promise<void>((r) => { release = r; });
      return { made: calls };
    });
    const c = accountClient();
    const failed = await c.json(slow, "/api/thing", { method: "POST", body: {}, headers: { "idempotency-key": KEY } });
    expect(failed.status).toBe(500);
    const running = c.json(slow, "/api/thing", { method: "POST", body: {}, headers: { "idempotency-key": KEY } }); // the failure didn't burn the key
    await new Promise((r) => setTimeout(r, 10));
    const meanwhile = await c.json(slow, "/api/thing", { method: "POST", body: {}, headers: { "idempotency-key": KEY } });
    expect(meanwhile.status).toBe(409);
    expect(meanwhile.data.code).toBe("idempotency_in_progress");
    release();
    expect((await running).data).toEqual({ made: 2 });
    expect(calls).toBe(2);
  });

  it("a stream that already started is never run twice", async () => {
    let runs = 0;
    const stream = route({ auth: "user" }, async () => { runs += 1; return new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }); });
    const c = accountClient();
    expect((await c.call(stream, "/api/chat", { method: "POST", body: { message: "hi" }, headers: { "idempotency-key": KEY } })).status).toBe(200);
    const again = await c.json(stream, "/api/chat", { method: "POST", body: { message: "hi" }, headers: { "idempotency-key": KEY } });
    expect(again.status).toBe(409);
    expect(again.data.code).toBe("idempotency_replayed");
    expect(runs).toBe(1);
  });

  it("requests without a key behave exactly as before", async () => {
    const c = accountClient();
    const body = { content: "Uses Vim", category: "technical" };
    expect((await c.json(memory.POST, "/api/memory", { method: "POST", body })).status).toBe(200);
    expect((await c.json(memory.POST, "/api/memory", { method: "POST", body })).status).toBe(400); // the memory module's own duplicate check
  });
});
