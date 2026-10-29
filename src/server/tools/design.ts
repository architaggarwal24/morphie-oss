import { DesignClarification, DesignGenerationError } from "../design/agent";
import { handleMessage } from "../design/service";
import { ProviderError } from "../providers/types";
import { ToolError, str, type ToolDef } from "./types";

export const designWebsite: ToolDef = {
  name: "design_website",
  label: "Design a website",
  description:
    "Create or edit a website/UI design (landing page, SaaS site, portfolio, dashboard…) with Morphie's Design Agent. Pass a plain-language brief, or an instruction to change an existing design by passing its design_id. " +
    "The result appears in the user's Design tab with a live preview and HTML/React export.",
  parameters: {
    type: "object",
    properties: {
      brief: { type: "string", description: "What to design, or what to change. Include the product, audience and mood." },
      design_id: { type: "string", description: "Optional: id of an existing design to edit. Omit to create a new one." },
    },
    required: ["brief"],
  },
  risk: "safe",
  modes: ["agent"],
  describeCall: (a) => `Design: ${String(a.brief ?? "").slice(0, 100)}`,
  async run(args, ctx) {
    const brief = str(args, "brief", 2000);
    const designId = typeof args.design_id === "string" && args.design_id.trim() ? args.design_id.trim() : null;
    try {
      const out = await handleMessage(ctx.actor, designId, brief, ctx.provider, { signal: ctx.signal });
      const d = out.state.design;
      return {
        text: `${out.summary}\nDesign "${d.name}" (id: ${out.state.id}, version ${out.state.history.version}) has ${d.sections.length} sections: ${d.sections.map((s) => s.type).join(", ")}. It is available in the Design tab.`,
        summary: `${d.name} · v${out.state.history.version}`,
      };
    } catch (e) {
      if (e instanceof DesignClarification || e instanceof DesignGenerationError) throw new ToolError(e.message);
      if (e instanceof ProviderError) throw new ToolError(e.message);
      if (e && (e as { status?: number }).status === 404) throw new ToolError("That design doesn't exist.");
      throw e;
    }
  },
};

