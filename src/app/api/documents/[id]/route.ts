import { route } from "@/server/http";
import { deleteDocument, listDocuments } from "@/server/rag";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = route({ auth: "user" }, async (c) => {
  await deleteDocument(c.actor, c.params.id);
  return { documents: await listDocuments(c.actor) };
});
