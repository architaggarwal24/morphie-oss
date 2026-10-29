import { route } from "@/server/http";
import { planStatus } from "@/server/plans";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Your plan, the credits you've used, and every plan and Morphie AI model (Settings → Plan). */
export const GET = route({ auth: "user" }, async (c) => await planStatus(c.actor));
