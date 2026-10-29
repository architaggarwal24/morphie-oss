import { z } from "zod";
import { requireFeature } from "@/server/plans";
import { route } from "@/server/http";
import { getSettings } from "@/server/settings";
import { createSkill, installFromGitHub, installFromLibrary, library, listSkills } from "@/server/skills";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Your skills (installed + built-in) and the library of popular open-source skills. */
export const GET = route({ auth: "user" }, async (c) => ({ skills: await listSkills(c.actor, await getSettings(c.actor)), library: await library(c.actor) }));

const body = z.discriminatedUnion("from", [
  z.object({ from: z.literal("markdown"), markdown: z.string().min(1, "Write the skill first.").max(200_000) }),
  z.object({ from: z.literal("github"), url: z.string().trim().min(3, "Paste a GitHub link.").max(500), pick: z.array(z.string().max(400)).max(60).optional() }),
  z.object({ from: z.literal("library"), name: z.string().max(64) }),
]);

/** Add a skill: written in the app, from a GitHub link (returns choices when the link holds several), or from the library. */
export const POST = route({ auth: "user", rate: { bucket: "skills", limit: 30, windowMs: 60_000 } }, async (c) => {
  const b = await c.body(body, 400_000);
  await requireFeature(c.actor, "skillImports");
  let result: { installed?: string[]; choices?: unknown[] };
  if (b.from === "markdown") { await createSkill(c.actor, b.markdown); result = { installed: [] }; }
  else if (b.from === "github") result = await installFromGitHub(c.actor, b.url, { pick: b.pick, signal: c.req.signal });
  else result = await installFromLibrary(c.actor, b.name, c.req.signal);
  return { ...result, skills: await listSkills(c.actor, await getSettings(c.actor)), library: await library(c.actor) };
});
