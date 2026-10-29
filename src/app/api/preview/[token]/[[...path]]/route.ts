import { candidates, contentType, previewHeaders, readPreviewToken, rewriteHtml } from "@/server/code/preview";
import { getProject } from "@/server/data/projects";
import { route } from "@/server/http";
import { sandboxFor } from "@/server/sandbox";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15_000_000;
const notFound = () => new Response("Not found", { status: 404, headers: { ...previewHeaders("text/plain; charset=utf-8") } });

/**
 * A project's files for the live preview (and verify_project's screenshots). No session cookie reaches a sandboxed
 * frame, so the URL itself is the key: a signed, expiring token for one user's project folder. Responses run in an
 * opaque origin (CSP sandbox), so a page can't call Morphie's API as you, and send no referrer.
 */
export const GET = route({ auth: "public" }, async (c) => {
  const tok = readPreviewToken(c.params.token ?? "");
  if (!tok) return new Response("This preview link has expired. Reopen the Preview tab.", { status: 403, headers: previewHeaders("text/plain; charset=utf-8") });
  const actor = { userId: tok.userId, sessionId: "preview" };
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(tok.projectId) || !(await getProject(actor, tok.projectId))) return notFound();
  const raw = c.params.path as unknown as string[] | string | undefined;
  const rel = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join("/");
  if (rel.split("/").some((s) => s === ".." || s === ".git") || /[\0\\]/.test(rel)) return notFound();
  const sb = await sandboxFor(actor, tok.projectId);
  for (const file of candidates(tok.root, rel)) {
    const data = await sb.readBytes(file, MAX_BYTES).catch(() => null);
    if (data === null) continue;
    const type = contentType(file);
    let body: Uint8Array | string = Buffer.from(data, "base64");
    if (type.startsWith("text/html")) {
      // The folder of the served file, relative to the preview root.
      const inRoot = tok.root === "." ? file : file.slice(tok.root.length + 1);
      body = rewriteHtml(Buffer.from(body).toString("utf8"), `/api/preview/${c.params.token}/`, inRoot.split("/").slice(0, -1).join("/"));
    }
    return new Response(body as BodyInit, { headers: previewHeaders(type) });
  }
  return notFound();
});
