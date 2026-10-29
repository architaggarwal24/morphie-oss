import { z } from "zod";
import type { Actor } from "@/server/auth/actor";
import { config } from "@/server/config";
import { route } from "@/server/http";
import { deleteSecret, getSecret, setSecret } from "@/server/settings";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const state = async (actor: Actor) => ({ user: !!(await getSecret(actor, "tavily")), server: !!config.tavilyKey });

export const PUT = route({ auth: "user" }, async (c) => {
  const { key } = await c.body(z.object({ key: z.string().trim().min(8, "That key looks too short.").max(300).regex(/^\S+$/, "Keys can't contain spaces.") }));
  await setSecret(c.actor, "tavily", key);
  return state(c.actor);
});

export const DELETE = route({ auth: "user" }, async (c) => {
  await deleteSecret(c.actor, "tavily");
  return state(c.actor);
});
