import { z } from "zod";
import { applySystem, applyThemePreset, editorHtml, exportDesign, exportZip, patchDesign, redo, renameDesign, requireDesign, restoreVersion, undo } from "@/server/design/service";
import { ApiError, route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const format = (url: URL) => url.searchParams.get("format") ?? "html";

const SECTION = z.string().min(1).max(40);
const PATCH = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_text"), section: SECTION, path: z.string().min(1).max(120), value: z.string().trim().min(1, "Text can't be empty.").max(400) }),
  z.object({ op: z.literal("move"), section: SECTION, direction: z.enum(["up", "down"]) }),
  z.object({ op: z.literal("duplicate"), section: SECTION }),
  z.object({ op: z.literal("remove"), section: SECTION }),
  z.object({ op: z.literal("set_color"), key: z.enum(["background", "surface", "primary", "secondary", "accent", "text"]), value: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb colour.") }),
]);

export const GET = route({ auth: "user" }, async (c) => {
  if (c.params.action === "export") return await exportDesign(c.actor, c.params.id, format(c.url));
  if (c.params.action === "editor") {
    await requireDesign(c.actor, c.params.id);
    return { html: await editorHtml(c.actor, c.params.id, Number(c.url.searchParams.get("scroll")) || 0) };
  }
  if (c.params.action === "download") {
    const zip = await exportZip(c.actor, c.params.id, format(c.url));
    return new Response(zip.bytes as unknown as BodyInit, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${zip.filename}"`, "x-content-type-options": "nosniff" } });
  }
  throw new ApiError(404, "Not found.", "not_found");
});

export const POST = route({ auth: "user" }, async (c) => {
  const { id, action } = c.params;
  switch (action) {
    case "undo": return { state: await undo(c.actor, id) };
    case "redo": return { state: await redo(c.actor, id) };
    case "restore": return { state: await restoreVersion(c.actor, id, (await c.body(z.object({ version: z.number().int() }))).version) };
    case "rename": return { state: await renameDesign(c.actor, id, (await c.body(z.object({ name: z.string().trim().min(1).max(60) }))).name) };
    case "system": {
      const out = await applySystem(c.actor, id, (await c.body(z.object({ systemId: z.string().max(40).nullable() }))).systemId);
      return { state: out.state, summary: out.summary, changed: out.changed };
    }
    case "patch": {
      const { patches } = await c.body(z.object({ patches: z.array(PATCH).min(1).max(20) }));
      const out = await patchDesign(c.actor, id, patches);
      return { state: out.state, summary: out.summary, changed: out.changed, notes: out.notes };
    }
    case "theme": {
      const out = await applyThemePreset(c.actor, id, (await c.body(z.object({ theme: z.string().max(30) }))).theme);
      return { state: out.state, summary: out.summary, changed: out.changed };
    }
  }
  throw new ApiError(404, "Not found.", "not_found");
});
