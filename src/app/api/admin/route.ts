import { route } from "@/server/http";
import { requireAdmin } from "@/server/plans";
import { adminOverview, configPatch, updateConfig } from "@/server/plans/admin";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Settings → Admin: plans, Morphie AI models, budgets and spend. Admins only (MORPHIE_ADMIN_EMAILS, verified). */
export const GET = route({ auth: "user" }, async (c) => {
  await requireAdmin(c.actor);
  return await adminOverview();
});

export const PUT = route({ auth: "user", rate: { bucket: "admin", limit: 30, windowMs: 60_000 } }, async (c) => {
  await requireAdmin(c.actor);
  return await updateConfig(await c.body(configPatch, 200_000));
});
