import { z } from "zod";
import { TASK_BUDGET } from "@/lib/types";
import { config } from "@/server/config";
import { isValidRule } from "@/server/code/permissions";
import { ApiError, route } from "@/server/http";
import { hostedModelId } from "@/lib/plans";
import { assertHostedChoice } from "@/server/plans/hosted";
import { resolveProfile } from "@/server/profiles";
import { getSettings, saveSettings } from "@/server/settings";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route({ auth: "user" }, async (c) => await getSettings(c.actor));

const body = z.object({
  taskTokenBudget: z.number().int().min(TASK_BUDGET.min).max(TASK_BUDGET.max).optional(),
  helperProfileId: z.string().max(100).nullable().optional(),
  planFallback: z.boolean().optional(),
  skills: z.object({ disabled: z.array(z.string().max(64)).max(300), pinned: z.array(z.string().max(64)).max(50) }).optional(),
  approval: z.enum(["ask", "always", "never"]).optional(),
  alwaysAllow: z.array(z.string().max(40)).max(40).optional(),
  disabledTools: z.array(z.string().max(40)).max(40).optional(),
  memory: z.boolean().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  permissions: z.object({ allow: z.array(z.string().max(240)).max(100), deny: z.array(z.string().max(240)).max(100) }).optional(),
});

export const PUT = route({ auth: "user" }, async (c) => {
  const { temperature, permissions, helperProfileId, ...parsed } = await c.body(body);
  const rest: Partial<import("@/lib/types").AgentSettings> = parsed;
  if (permissions) {
    const bad = [...permissions.allow, ...permissions.deny].find((r) => !isValidRule(r));
    if (bad) throw new ApiError(400, `"${bad}" isn't a valid rule. Use Tool or Tool(pattern), e.g. Bash(npm test *), Edit(src/**), WebFetch(domain:github.com).`, "invalid");
    rest.permissions = permissions;
  }
  if (helperProfileId !== undefined) {
    // Only one of your own saved providers can be the helper.
    // Only one of your own saved providers (or a Morphie AI model your plan includes) can be the helper.
    if (helperProfileId && hostedModelId(helperProfileId)) await assertHostedChoice(c.actor, helperProfileId);
    else if (helperProfileId && !(await resolveProfile(c.actor, helperProfileId))) throw new ApiError(400, "That provider no longer exists.", "invalid");
    rest.helperProfileId = helperProfileId || null;
  }
  return await saveSettings(c.actor, {
    ...rest,
    ...(temperature === undefined ? {} : { temperature: temperature ?? undefined }),
  });
});
