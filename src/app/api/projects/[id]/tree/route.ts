import { ownProject, withSandbox } from "@/server/code/routes";
import { route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Files and folders under ?dir= (default the root), ?depth= levels (1–4, default 1: the tree loads folder by folder). */
export const GET = route({ auth: "user" }, async (c) => {
  const project = await ownProject(c.actor, c.params.id);
  const dir = c.url.searchParams.get("dir") ?? "";
  const depth = Math.min(4, Math.max(1, Number(c.url.searchParams.get("depth")) || 1));
  const entries = await withSandbox(c.actor, project, (sb) => sb.list(dir, depth));
  return { dir, entries };
});
