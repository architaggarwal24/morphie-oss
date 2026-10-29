import { z } from "zod";
import { getConversation, getMessages } from "@/server/conversations";
import { ApiError, route } from "@/server/http";
import { requireFeature } from "@/server/plans";
import { activeSetup, helperProvider } from "@/server/providers/active";
import { getSettings } from "@/server/settings";
import { draftSkillFromConversation } from "@/server/skills/draft";
import { metered } from "@/server/usage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** "Turn this conversation into a skill": a SKILL.md draft to review and save in the editor. */
export const POST = route({ auth: "user", rate: { bucket: "skills", limit: 30, windowMs: 60_000 } }, async (c) => {
  const b = await c.body(z.object({ conversationId: z.string().max(40) }));
  await requireFeature(c.actor, "skillImports");
  const conv = await getConversation(c.actor, b.conversationId);
  if (!conv) throw new ApiError(404, "That conversation no longer exists.", "not_found");
  const messages = await getMessages(c.actor, conv.id, 60);
  if (!messages.length) throw new ApiError(400, "This conversation is empty.", "invalid");
  const { provider } = await activeSetup(c.actor);
  const helper = metered(await helperProvider(c.actor, await getSettings(c.actor), provider), { actor: c.actor, feature: "other", conversationId: conv.id });
  return { markdown: await draftSkillFromConversation(helper, conv.title, messages, c.req.signal) };
});
