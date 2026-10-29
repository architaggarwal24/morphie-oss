import { loginMethods } from "@/server/auth/methods";
import { config } from "@/server/config";
import { listConversations } from "@/server/conversations";
import { listProjects } from "@/server/data/projects";
import { runningConversations } from "@/server/agent/recover";
import { route } from "@/server/http";
import { isAdmin, planStatus, plansEnabled } from "@/server/plans";
import { listProfiles } from "@/server/profiles";
import { listRunners } from "@/server/runners";
import { CUSTOM_PRESETS, publicCatalog } from "@/server/providers/catalog";
import { getSecret, getSettings } from "@/server/settings";
import { sandboxKind } from "@/server/sandbox";
import { toolInfos } from "@/server/tools";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VERSION = "2.0.0";

/**
 * Everything the UI needs on first load, in one round trip.
 *
 * Public, because the page has to be able to ask "who am I?" before anyone has signed in. A visitor with no valid
 * session gets the bare minimum (version, which login methods exist, `session: null`) and nothing is created for them:
 * no user, no session, no cookie. A signed-in user gets the full payload.
 */
export const GET = route({ auth: "public" }, async (c) => {
  const methods = loginMethods();
  if (!c.actor || !c.session) return { version: VERSION, methods, session: null };
  const { profiles, activeId } = await listProfiles(c.actor);
  return {
    version: VERSION,
    methods,
    session: {
      user: { email: c.session.user.email, displayName: c.session.user.displayName },
      expiresAt: c.session.absoluteExpiresAt,
      idleExpiresAt: c.session.idleExpiresAt,
    },
    catalog: publicCatalog(),
    customPresets: CUSTOM_PRESETS,
    profiles, activeId,
    settings: await getSettings(c.actor),
    tools: toolInfos(),
    search: { user: !!await getSecret(c.actor, "tavily"), server: !!config.tavilyKey },
    conversations: await listConversations(c.actor),
    running: await runningConversations(c.actor),
    projects: await listProjects(c.actor),
    code: { sandbox: sandboxKind(), github: !!await getSecret(c.actor, "github"), runners: await listRunners(c.actor) },
    // Hosted edition: your plan and credits (null when plans are off), and whether Settings → Admin is yours.
    plan: plansEnabled() ? await planStatus(c.actor) : null,
    admin: await isAdmin(c.actor),
    server: { allowPrivateUrls: config.allowPrivateUrls, maxUploadMb: Math.round(config.maxUploadBytes / 1048576), maxAgentSteps: config.maxAgentSteps },
  };
});
