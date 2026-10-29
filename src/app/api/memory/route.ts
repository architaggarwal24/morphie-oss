import { z } from "zod";
import { ApiError, route } from "@/server/http";
import { CATEGORIES, addMemory, clearMemories, listMemories } from "@/server/memory";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ auth: "user" }, async (c) => ({ memories: await listMemories(c.actor) }));

export const POST = route({ auth: "user" }, async (c) => {
  const b = await c.body(z.object({ content: z.string().trim().min(3).max(300), category: z.enum(CATEGORIES).default("other") }));
  const memory = await addMemory(c.actor, b.content, b.category, "manual");
  if (!memory) throw new ApiError(400, "That can't be saved: it looks like a secret or an instruction, it's already remembered, or memory is full.", "rejected");
  return { memory, memories: await listMemories(c.actor) };
});

export const DELETE = route({ auth: "user" }, async (c) => {
  await clearMemories(c.actor);
  return { memories: [] };
});
