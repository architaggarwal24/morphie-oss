import { ApiError, route } from "@/server/http";
import { requireFeature } from "@/server/plans";
import { getSettings } from "@/server/settings";
import { installFromUpload, library, listSkills } from "@/server/skills";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 15 * 1024 * 1024;

/** A SKILL.md, or a .zip / .skill archive with one or more skill folders (multipart field "file"). */
export const POST = route({ auth: "user", rate: { bucket: "skills", limit: 30, windowMs: 60_000 } }, async (c) => {
  await requireFeature(c.actor, "skillImports");
  if (Number(c.req.headers.get("content-length") ?? 0) > LIMIT + 1_000_000) throw new ApiError(413, "That file is too large (max 15 MB).", "too_large");
  let form: FormData;
  try { form = await c.req.formData(); } catch { throw new ApiError(400, "Upload a file using multipart form data.", "invalid"); }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "No file was uploaded.", "invalid");
  if (file.size > LIMIT) throw new ApiError(413, "That file is too large (max 15 MB).", "too_large");
  const out = await installFromUpload(c.actor, file.name, new Uint8Array(await file.arrayBuffer()));
  return { ...out, skills: await listSkills(c.actor, await getSettings(c.actor)), library: await library(c.actor) };
});
