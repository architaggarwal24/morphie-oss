import { route } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ auth: "public" }, async () => ({ ok: true, name: "morphie", version: "2.0.0" }));
