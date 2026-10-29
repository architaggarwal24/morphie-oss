import { config } from "@/server/config";
import { ApiError, route } from "@/server/http";
import { DocumentError, ingest, listDocuments } from "@/server/rag";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ auth: "user" }, async (c) => ({ documents: await listDocuments(c.actor) }));

/** One file per request (multipart field "file"). */
export const POST = route({ auth: "user", rate: { bucket: "upload", limit: 30, windowMs: 60_000 } }, async (c) => {
  const limit = config.maxUploadBytes;
  if (Number(c.req.headers.get("content-length") ?? 0) > limit + 1_000_000) throw new ApiError(413, `File is too large. The limit is ${Math.round(limit / 1048576)} MB.`, "too_large");
  let form: FormData;
  try { form = await c.req.formData(); } catch { throw new ApiError(400, "Upload a file using multipart form data.", "invalid"); }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "No file was uploaded.", "invalid");
  if (file.size > limit) throw new ApiError(413, `File is too large. The limit is ${Math.round(limit / 1048576)} MB.`, "too_large");
  try {
    const { doc, created } = await ingest(c.actor, file.name, new Uint8Array(await file.arrayBuffer()), limit);
    return { document: doc, created, documents: await listDocuments(c.actor) };
  } catch (e) {
    if (e instanceof DocumentError) throw new ApiError(400, e.message, "document");
    throw e;
  }
});
