import { z } from "zod";
import { wipeContent } from "@/server/data/users";
import { route } from "@/server/http";
import { destroyAllProjects } from "@/server/code/routes";
import { clearWorkspace } from "@/server/workspace";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Delete everything this account has stored: keys, chats, documents, memories, designs, files. The account itself stays. */
export const POST = route({ auth: "user" }, async (c) => {
  await c.body(z.object({ confirm: z.literal(true) }));
  await destroyAllProjects(c.actor); // before the rows go: it needs the list of projects
  await wipeContent(c.actor);
  await clearWorkspace(c.actor);
  return { ok: true };
});
