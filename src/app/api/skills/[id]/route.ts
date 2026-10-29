import { z } from "zod";
import { route } from "@/server/http";
import { getSettings } from "@/server/settings";
import { deleteSkill, editSkill, getSkillView, library, listSkills } from "@/server/skills";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One skill with its SKILL.md and file list. Built-in skills have ids like builtin:clarify-first. */
export const GET = route({ auth: "user" }, async (c) => await getSkillView(c.actor, await getSettings(c.actor), decodeURIComponent(c.params.id)));

/** Edit the SKILL.md of a skill written in the app or uploaded. */
export const PUT = route({ auth: "user" }, async (c) => {
  const b = await c.body(z.object({ markdown: z.string().min(1).max(200_000) }), 400_000);
  const id = await editSkill(c.actor, c.params.id, b.markdown);
  const settings = await getSettings(c.actor);
  return { skill: await getSkillView(c.actor, settings, id), skills: await listSkills(c.actor, settings) };
});

export const DELETE = route({ auth: "user" }, async (c) => {
  await deleteSkill(c.actor, c.params.id);
  return { skills: await listSkills(c.actor, await getSettings(c.actor)), library: await library(c.actor) };
});
