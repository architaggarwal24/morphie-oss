import { route } from "@/server/http";
import { getSettings } from "@/server/settings";
import { getSkillView, listSkills, updateFromGitHub } from "@/server/skills";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Re-download a skill installed from GitHub. */
export const POST = route({ auth: "user", rate: { bucket: "skills", limit: 30, windowMs: 60_000 } }, async (c) => {
  await updateFromGitHub(c.actor, c.params.id, c.req.signal);
  const settings = await getSettings(c.actor);
  return { skill: await getSkillView(c.actor, settings, c.params.id), skills: await listSkills(c.actor, settings) };
});
