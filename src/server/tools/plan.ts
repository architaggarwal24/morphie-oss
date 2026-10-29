import type { PlanItem } from "@/lib/types";
import { ToolError, type ToolDef } from "./types";

export const updatePlan: ToolDef = {
  name: "update_plan",
  label: "Plan",
  description:
    "Create or update your task checklist. Call it at the start of any multi-step task with the steps you intend to take, and again whenever a step starts or finishes. " +
    "Each item has text and a status: pending, active (max one) or done. Send the FULL list every time.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "The complete checklist.",
        items: {
          type: "object",
          properties: { text: { type: "string" }, status: { type: "string", enum: ["pending", "active", "done"] } },
          required: ["text", "status"],
        },
      },
    },
    required: ["items"],
  },
  risk: "safe",
  modes: ["agent"],
  readOnly: true,
  describeCall: () => "Update the plan",
  async run(args, ctx) {
    const raw = Array.isArray(args.items) ? args.items : null;
    if (!raw || !raw.length) throw new ToolError('"items" must be a non-empty list.');
    const items: PlanItem[] = raw.slice(0, 12).map((i: any) => ({
      text: String(i?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      status: i?.status === "done" || i?.status === "active" ? i.status : "pending",
    })).filter((i) => i.text);
    if (!items.length) throw new ToolError("Each plan item needs text.");
    ctx.emit({ type: "plan", items });
    const done = items.filter((i) => i.status === "done").length;
    return { text: `Plan saved: ${done}/${items.length} done.`, summary: `${done}/${items.length} done` };
  },
};
