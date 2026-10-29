import { z } from "zod";
import { runAgent } from "@/server/agent/loop";
import { failRun } from "@/server/agent/recover";
import { skillRuntime, type SkillRuntime } from "@/server/skills";
import { activeRun, followRun, startRun } from "@/server/agent/runs";
import { endSlices, sliceHook } from "@/server/agent/slices";
import { RUNNER_HEADER, viaRunner } from "@/server/agent/runner";
import { cfWaitUntil } from "@/server/cf";
import { openCode, type RunCode } from "@/server/code/open";
import { expandCommand } from "@/server/code/project";
import { LIMITS } from "@/server/config";
import { createConversation, deleteMessagesFrom, getConversation, getMessages } from "@/server/conversations";
import { holdLock } from "@/server/coordinator";
import { getProject } from "@/server/data/projects";
import { ApiError, route } from "@/server/http";
import { applyPlan, capBudget, entitlements } from "@/server/plans";
import { activeSetup, helperProvider, taskBudget } from "@/server/providers/active";
import { SandboxError } from "@/server/sandbox";
import { getSettings } from "@/server/settings";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.object({
  conversationId: z.string().max(40).optional(),
  mode: z.enum(["chat", "agent"]).default("chat"),
  message: z.string().trim().max(LIMITS.message, `Messages can be up to ${LIMITS.message.toLocaleString()} characters.`).optional(),
  /** Edit/regenerate: drop this user message and everything after it, then run again. */
  truncateFrom: z.number().int().positive().optional(),
  /** A new agent task in a code project. Ignored for existing conversations (they keep their own project). */
  projectId: z.string().max(40).optional(),
  /** Read-only until the user approves a plan. */
  planMode: z.boolean().optional(),
  /** Pick up the conversation's paused run where it stopped (the Continue button). */
  continue: z.boolean().optional(),
});

/**
 * Starts a run and streams its AgentEvents as server-sent events (each with a `seq`). The run doesn't depend on this
 * stream: closing the tab leaves it working, and GET /api/runs/[id]?from=<seq> picks the stream up again.
 */
export const POST = route({ auth: "user", rate: { bucket: "chat", limit: 40, windowMs: 60_000, skip: (req) => req.headers.has(RUNNER_HEADER) } }, async (c) => {
  const b = await c.body(body);
  if (!b.continue && !b.message) throw new ApiError(400, "message: Type a message first.", "invalid");
  if (b.continue && !b.conversationId) throw new ApiError(400, "Nothing to continue.", "invalid");
  // Ownership first: someone else's (or a missing) conversation or project is a 404 before anything else is looked at.
  let conv = b.conversationId ? await getConversation(c.actor, b.conversationId) : null;
  if (b.conversationId && !conv) throw new ApiError(404, "That conversation no longer exists.", "not_found");
  const projectId = conv ? conv.projectId ?? null : b.mode === "agent" ? b.projectId ?? null : null;
  const project = projectId ? await getProject(c.actor, projectId) : null;
  if (projectId && !project && !conv) throw new ApiError(404, "That project no longer exists.", "not_found");
  // The plan (hosted edition) turns off tools it doesn't include and caps the task budget; a no-op otherwise.
  const ent = await entitlements(c.actor);
  const settings = applyPlan(await getSettings(c.actor), ent);
  const { provider, profile } = await activeSetup(c.actor, settings);

  // A new conversation needs its id first: on Cloudflare that id decides which runner hosts the run.
  if (!conv) conv = await createConversation(c.actor, b.mode, "New conversation", project?.id ?? null);
  const forwarded = await viaRunner(c.req, conv.id, { ...b, conversationId: conv.id, projectId: undefined });
  if (forwarded) return forwarded;
  const conversation = conv;

  // One run at a time per conversation, across every server instance (the lock lives in the user's Coordinator).
  if (activeRun(conversation.id)) throw new ApiError(409, "This conversation is still working on a reply.", "busy");
  const unlock = await holdLock(c.actor.userId, `conv:${conversation.id}`);
  if (!unlock) throw new ApiError(409, "This conversation is still working on a reply.", "busy");
  try {
    if (b.truncateFrom && !b.continue) {
      const target = (await getMessages(c.actor, conversation.id)).find((m) => m.id === b.truncateFrom);
      if (!target || target.role !== "user") throw new ApiError(400, "Only your own messages can be edited or re-run.", "invalid");
      await deleteMessagesFrom(c.actor, conversation.id, b.truncateFrom);
    }
  } catch (e) {
    await unlock();
    throw e;
  }
  const helper = await helperProvider(c.actor, settings, provider);
  const budget = capBudget(taskBudget(settings, profile), ent);
  const message = b.message ?? "Continue";

  startRun(c.actor.userId, conversation.id, async (emit, signal) => {
    let code: RunCode | undefined;
    try {
      let prompt: string | undefined;
      if (project && conversation.mode === "agent") {
        try {
          code = await openCode(c.actor, project);
          if (message.startsWith("/") && !b.continue) prompt = expandCommand(message, code.info.commands) ?? undefined;
        } catch (e) {
          if (!(e instanceof SandboxError)) throw e;
          emit({ type: "error", message: e.message, code: "sandbox" });
          emit({ type: "done", reason: "error" });
          return;
        }
      }
      // Skills: the agent's own picks, plus any the user asked for with /name.
      let skills: SkillRuntime | undefined;
      let pinSkills: string[] | undefined;
      if (conversation.mode === "agent") {
        skills = await skillRuntime(c.actor, settings, "agent", code ? { sandbox: code.ctx.sandbox, skills: code.info.skills } : undefined);
        const slash = !b.continue && !prompt ? /^\/([a-z0-9][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/i.exec(message.trim()) : null;
        if (slash && skills.has(slash[1].toLowerCase())) {
          pinSkills = [slash[1].toLowerCase()];
          prompt = slash[2]?.trim() || `Use the ${pinSkills[0]} skill.`;
        }
      }
      try {
        await runAgent({
          actor: c.actor, conversationId: conversation.id, mode: conversation.mode, message, prompt, planMode: b.planMode, code, provider, helper, budget, settings, signal, emit,
          resume: !!b.continue, canCreateProject: conversation.mode === "agent" && !project, skills, pinSkills,
          slice: sliceHook(conversation.id),
        });
      } catch (e) {
        if (signal.aborted) throw e;
        await failRun(c.actor, conversation.id, e).catch(() => {});
        emit({ type: "error", message: "The run stopped because of an error on the server. Press Continue to pick it up." });
        emit({ type: "done", reason: "error", continuable: true });
      }
    } finally {
      endSlices(conversation.id);
      await unlock();
    }
  }, cfWaitUntil);

  return followRun(c.req, conversation.id, 0)!;
});
