import { z } from "zod";
import { decide } from "@/server/agent/approvals";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route({ auth: "user" }, async (c) => {
  const b = await c.body(z.object({
    id: z.string().max(40), approved: z.boolean(), always: z.boolean().optional(),
    /** Answers to an ask_user card, by question. */
    answers: z.record(z.string().max(500), z.string().max(4000)).optional(),
  }));
  if (b.answers && Object.keys(b.answers).length > 8) throw new ApiError(400, "Too many answers.", "invalid");
  if (!(await decide(c.actor.userId, b.id, { approved: b.approved, always: b.always, answers: b.answers }))) {
    throw new ApiError(410, "That request has already been answered or has expired.", "expired");
  }
  return { ok: true };
});
