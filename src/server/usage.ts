/**
 * Token accounting. Every model call made on a user's behalf goes through `metered()`, which records one row in
 * usage_events (what it was for, which model, input/output/cached tokens) and tells the caller how much it used, so an
 * agent run can keep to its token budget. Providers that report no usage get an estimate (marked `estimated`).
 */
import type { UsageSummary } from "@/lib/types";
import type { Actor } from "./auth/actor";
import * as store from "./data/usage";
import { creditsFor } from "@/lib/plans";
import type { HostedBilling } from "./plans/hosted";
import type { ChatMessage, ChatRequest, ChatResult, Provider } from "./providers/types";

export type UsageFeature = "chat" | "agent" | "code" | "subagent" | "compaction" | "memory" | "design" | "design_system" | "verify" | "other";

export interface MeterContext {
  actor: Actor;
  feature: UsageFeature;
  conversationId?: string | null;
  designId?: string | null;
  /** Called after every call with what it used (input includes cached tokens). */
  onUsage?: (u: { input: number; output: number; cached: number; estimated: boolean }) => void;
}

/** ~3.6 characters per token across English prose and code; an image counts as ~1,200 tokens. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function estimateMessages(messages: ChatMessage[], tools?: ChatRequest["tools"]): number {
  let n = 0;
  for (const m of messages) {
    n += 4 + estimateTokens(m.content);
    if (m.toolCalls) for (const c of m.toolCalls) n += 8 + estimateTokens(JSON.stringify(c.arguments));
    if (m.images) n += 1200 * m.images.length;
  }
  if (tools) for (const t of tools) n += 10 + estimateTokens(t.description + JSON.stringify(t.parameters));
  return n;
}

const INNER = Symbol("inner");
type Metered = Provider & { [INNER]: Provider; meter: MeterContext };

/** A provider whose calls are recorded against `ctx`. Wrapping a metered provider again re-targets the same model. */
export function metered(provider: Provider, ctx: MeterContext): Provider {
  const inner = (provider as Metered)[INNER] ?? provider;
  const parent = (provider as Metered).meter;
  // A sub-feature (a sub-agent, a compaction) still counts toward the run that started it.
  const onUsage = ctx.onUsage ?? parent?.onUsage;
  const full: MeterContext = { ...parent, ...ctx, onUsage };
  const wrapped: Metered = {
    [INNER]: inner,
    meter: full,
    kind: inner.kind, label: inner.label, model: inner.model, nativeTools: inner.nativeTools, vision: inner.vision, contextWindow: inner.contextWindow,
    listModels: (signal) => inner.listModels(signal),
    async chat(req: ChatRequest): Promise<ChatResult> {
      // A stopped call still cost something: estimate it from what was sent and what streamed back before the stop.
      let streamed = 0;
      const counted: ChatRequest = {
        ...req,
        onText: req.onText && ((d) => { streamed += d.length; req.onText!(d); }),
        onReasoning: req.onReasoning && ((d) => { streamed += d.length; req.onReasoning!(d); }),
      };
      let res: ChatResult;
      try { res = await inner.chat(counted); }
      catch (e) {
        if (req.signal?.aborted) {
          const u = { input: estimateMessages(req.messages, req.tools), output: Math.ceil(streamed / 4), cached: 0, estimated: true };
          full.onUsage?.(u);
          await recordUsage(full, inner, u).catch((err) => console.error("[usage]", err));
          await settle(inner);
        }
        throw e;
      }
      const estimated = !res.usage || (!res.usage.input && !res.usage.output);
      const input = estimated ? estimateMessages(req.messages, req.tools) : res.usage!.input;
      const output = estimated ? estimateTokens(res.content + (res.reasoning ?? "") + res.toolCalls.map((c) => c.name + JSON.stringify(c.arguments)).join("")) : res.usage!.output;
      const cached = estimated ? 0 : res.usage!.cached ?? 0;
      full.onUsage?.({ input, output, cached, estimated });
      await recordUsage(full, inner, { input, output, cached, estimated }).catch((e) => console.error("[usage]", e));
      await settle(inner);
      return estimated ? { ...res, usage: { input, output } } : res;
    },
  };
  return wrapped;
}

/** Morphie AI calls hold credits until their cost is recorded (plans/hosted.ts); the cost is in, so let go. */
async function settle(p: Provider): Promise<void> {
  await (p as Provider & { settle?: () => Promise<void> }).settle?.();
}

async function recordUsage(ctx: MeterContext, p: Provider, u: { input: number; output: number; cached: number; estimated: boolean }): Promise<void> {
  // Morphie AI (hosted) calls also cost credits; calls on your own key are free to Morphie.
  const billing = (p as Provider & { billing?: HostedBilling }).billing;
  await store.insertUsage({
    credits: billing ? creditsFor(billing.price, u) : 0, billing: billing?.kind ?? "",
    userId: ctx.actor.userId, feature: ctx.feature, conversationId: ctx.conversationId ?? null, designId: ctx.designId ?? null,
    provider: p.label.slice(0, 80), model: p.model.slice(0, 120),
    input: Math.max(0, Math.round(u.input)), output: Math.max(0, Math.round(u.output)), cached: Math.max(0, Math.round(u.cached)), estimated: u.estimated,
  });
}

export const usageSummary = (actor: Actor, days: number): Promise<UsageSummary> => store.usageSummary(actor, days);
export const conversationUsage = (actor: Actor, conversationId: string) => store.conversationUsage(actor, conversationId);
