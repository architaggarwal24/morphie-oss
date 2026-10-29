import { z } from "zod";
import { DesignClarification, DesignGenerationError } from "@/server/design/agent";
import { DesignStateError, catalog, handleMessage, listDesigns, requireDesign } from "@/server/design/service";
import { listSystems, loadSystem } from "@/server/design/systems";
import { route } from "@/server/http";
import { checkLimit } from "@/server/plans";
import { activeProvider } from "@/server/providers/active";
import { metered } from "@/server/usage";
import { getSettings } from "@/server/settings";
import { designGuidance, skillRuntime } from "@/server/skills";
import { ProviderError } from "@/server/providers/types";
import { sse } from "@/server/sse";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = route({ auth: "user" }, async (c) => ({ designs: await listDesigns(c.actor), systems: await listSystems(c.actor), ...catalog() }));

const body = z.object({
  designId: z.string().max(40).nullable().optional(),
  message: z.string().trim().min(1, "Describe what to design or change.").max(4000),
  /** A new design can start from one of your design systems. */
  systemId: z.string().max(40).nullable().optional(),
  /** Design skills picked for this request (others may be added by relevance, plus any that are always on). */
  skills: z.array(z.string().max(64)).max(6).optional(),
});

/** Streams DesignEvents: progress stages, then a result (or a clarification / error). */
export const POST = route({ auth: "user", rate: { bucket: "design", limit: 20, windowMs: 60_000 } }, async (c) => {
  const b = await c.body(body);
  if (b.designId) await requireDesign(c.actor, b.designId); // someone else's design is a 404 before the stream starts
  if (b.systemId && !b.designId) await loadSystem(c.actor, b.systemId); // likewise someone else's system
  if (!b.designId) await checkLimit(c.actor, "designs", async () => (await listDesigns(c.actor)).length);
  const provider = metered(await activeProvider(c.actor), { actor: c.actor, feature: "design", designId: b.designId ?? null });
  const guidance = await designGuidance(await skillRuntime(c.actor, await getSettings(c.actor), "design"), b.message, b.skills);
  return sse(c.req, async (emit, signal) => {
    try {
      const out = await handleMessage(c.actor, b.designId ?? null, b.message, provider, { signal, systemId: b.designId ? null : b.systemId ?? null, guidance: guidance.text, onProgress: (p) => emit({ type: "stage", ...p }) });
      emit({ type: "result", state: out.state, changed: out.changed, kind: out.kind, summary: out.summary, notes: out.notes, skills: out.kind === "theme" || !guidance.used.length ? undefined : guidance.used });
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof DesignClarification) emit({ type: "clarify", message: e.message });
      else if (e instanceof DesignGenerationError || e instanceof ProviderError || e instanceof DesignStateError) emit({ type: "error", message: e.message });
      else { console.error("[design]", e); emit({ type: "error", message: "Something went wrong while designing." }); }
    }
  });
});
