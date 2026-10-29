import { exportSystemFiles, exportSystemZip } from "@/server/design/systems";
import { route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ?format=css|tailwind|tokens|react → the files as JSON (for the preview), or &download=1 for a zip. */
export const GET = route({ auth: "user" }, async (c) => {
  const format = c.url.searchParams.get("format") ?? "css";
  if (c.url.searchParams.get("download")) {
    const zip = await exportSystemZip(c.actor, c.params.id, format);
    return new Response(zip.bytes as unknown as BodyInit, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${zip.filename}"`, "x-content-type-options": "nosniff" } });
  }
  return await exportSystemFiles(c.actor, c.params.id, format);
});
