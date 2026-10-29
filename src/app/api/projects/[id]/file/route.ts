import { ownProject, withSandbox } from "@/server/code/routes";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_VIEW = 1_000_000;

export const GET = route({ auth: "user" }, async (c) => {
  const project = await ownProject(c.actor, c.params.id);
  const path = c.url.searchParams.get("path") ?? "";
  const content = await withSandbox(c.actor, project, (sb) => sb.readFile(path));
  if (content === null) throw new ApiError(404, "That file doesn't exist.", "not_found");
  if (c.url.searchParams.get("download")) {
    // Always an attachment with a neutral type, so a project's .html can never run on our origin.
    const name = path.split("/").pop()!.replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(content, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"`, "x-content-type-options": "nosniff" } });
  }
  const binary = content.includes("\u0000");
  return { path, size: content.length, binary, truncated: content.length > MAX_VIEW, content: binary ? "" : content.slice(0, MAX_VIEW) };
});
