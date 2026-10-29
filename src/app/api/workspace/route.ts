import { strToU8, zipSync } from "fflate";
import { fileSlug } from "@/server/code/projects";
import { ApiError, route } from "@/server/http";
import { listFiles, readFile } from "@/server/workspace";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The workspace files, or (?zip=1) them as one zip. `paths` (comma-separated) or `prefix` (a folder) limit the zip, `name`
 * names it; otherwise it's named after the files' common top folder ("friday-landing.zip"), or "morphie-workspace".
 */
export const GET = route({ auth: "user" }, async (c) => {
  if (c.url.searchParams.get("zip")) {
    let files = await listFiles(c.actor);
    const only = c.url.searchParams.get("paths");
    if (only) { const want = new Set(only.split(",").map((p) => p.trim()).filter(Boolean)); files = files.filter((f) => want.has(f.path)); }
    const under = c.url.searchParams.get("prefix");
    if (under) files = files.filter((f) => f.path.startsWith(under.replace(/\/?$/, "/")));
    if (!files.length) throw new ApiError(404, "The workspace is empty.", "empty");
    const tops = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
    const common = tops.size === 1 ? [...tops][0] : "";
    const name = fileSlug(c.url.searchParams.get("name") || common || "morphie-workspace", "morphie-workspace");
    const entries = await Promise.all(files.map(async (f) => [f.path, strToU8(await readFile(c.actor, f.path))] as const));
    const zipped = zipSync(Object.fromEntries(entries), { level: 6 });
    return new Response(zipped as unknown as BodyInit, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}.zip"`, "x-content-type-options": "nosniff" } });
  }
  return { files: await listFiles(c.actor) };
});
