import { route } from "@/server/http";
import { deleteMemory, listMemories } from "@/server/memory";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = route({ auth: "user" }, async (c) => {
  await deleteMemory(c.actor, c.params.id);
  return { memories: await listMemories(c.actor) };
});
