import { route } from "@/server/http";
import { requireAdmin } from "@/server/plans";
import { applyMemberAction, memberAction, members } from "@/server/plans/admin";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Accounts and plan grants, newest activity first; ?q= filters by email. Admins only. */
export const GET = route({ auth: "user" }, async (c) => {
  await requireAdmin(c.actor);
  return { members: await members(c.url.searchParams.get("q") ?? "") };
});

/** Give a plan to an email (signed up or not), take it back, or add bonus credits. Admins only. */
export const POST = route({ auth: "user", rate: { bucket: "admin", limit: 60, windowMs: 60_000 } }, async (c) => {
  const by = await requireAdmin(c.actor);
  const b = await c.body(memberAction);
  await applyMemberAction(b, by);
  return { members: await members(b.email) };
});
