import type { AgentSettings, Mode, ToolInfo } from "@/lib/types";
import { evaluate, suggestRule, type PermTarget } from "../code/permissions";
import { calculator } from "./calculator";
import { CODE_TOOLS, exitPlanMode } from "./code";
import { currentTime } from "./datetime";
import { designWebsite } from "./design";
import { saveMemory, searchDocs } from "./documents";
import { fetchUrl } from "./fetchUrl";
import { updatePlan } from "./plan";
import { createProjectTool, verifyProjectTool } from "./projectTools";
import { readSkillFileTool, useSkillTool } from "./skillTools";
import { askUserTool } from "./askUser";
import { taskTool } from "./task";
import type { ToolDef } from "./types";
import { webSearch } from "./webSearch";
import { workspaceDelete, workspaceList, workspaceRead, workspaceWrite } from "./workspaceTools";

/** Extra tools registered by other modules (e.g. the design agent) to avoid import cycles. */
const extra: ToolDef[] = [];
export function registerTool(tool: ToolDef): void {
  if (!extra.some((t) => t.name === tool.name)) extra.push(tool);
}

export function allTools(): ToolDef[] {
  return [
    calculator, currentTime, webSearch, searchDocs, fetchUrl, updatePlan, askUserTool, taskTool, exitPlanMode, useSkillTool, readSkillFileTool,
    ...CODE_TOOLS, verifyProjectTool, createProjectTool,
    workspaceList, workspaceRead, workspaceWrite, workspaceDelete, saveMemory, designWebsite, ...extra,
  ];
}

/** The general agent's own tools that make no sense inside a code project (it has the project's files instead). */
const NOT_IN_PROJECTS = new Set(["workspace_list", "workspace_read", "workspace_write", "workspace_delete", "design_website"]);

/** Code tools that run commands: left out in a project with no shell (a Lite project). */
const NEEDS_SHELL = new Set(["bash", "create_pull_request", "verify_project"]);

export interface ToolScope { hasDocuments: boolean; code?: boolean; /** The project's sandbox can run commands (false: Lite). */ shell?: boolean; planMode?: boolean; /** Agent mode without a project, on a server with a sandbox. */ canCreateProject?: boolean; /** The run has skills to load. */ skills?: boolean }

export function toolsFor(mode: Mode, settings: AgentSettings, scope: ToolScope): ToolDef[] {
  return allTools().filter((t) => {
    if (!t.modes.includes(mode) || settings.disabledTools.includes(t.name)) return false;
    if (t.name === "search_documents" && !scope.hasDocuments) return false;
    if (t.code && !scope.code) return false;
    if (scope.code && NOT_IN_PROJECTS.has(t.name)) return false;
    if (scope.code && scope.shell === false && NEEDS_SHELL.has(t.name)) return false;
    if (t.name === "exit_plan_mode") return !!scope.planMode;
    if (t.name === "create_project") return !scope.code && !!scope.canCreateProject && !scope.planMode;
    if (t.name === "use_skill" || t.name === "read_skill_file") return !!scope.skills;
    if (scope.planMode) return !!t.readOnly;
    return true;
  });
}

export function toolInfos(): ToolInfo[] {
  return allTools()
    .filter((t) => t.name !== "exit_plan_mode")
    .map((t) => ({ name: t.name, label: t.label, description: t.description.split(/(?<=\.)\s/)[0], risk: t.risk, modes: t.modes, needsKey: t.needsKey, code: t.code }));
}

/** Tools that only talk to the user: asking approval for them would be a question about a question. */
const NEVER_ASK = new Set(["update_plan", "ask_user"]);

/** The general approval setting for a tool (ignores permission rules). */
export function needsApproval(tool: ToolDef, settings: AgentSettings): boolean {
  if (NEVER_ASK.has(tool.name)) return false;
  if (tool.alwaysAsk) return true;
  if (settings.approval === "never") return false;
  if (settings.alwaysAllow.includes(tool.name)) return false;
  if (settings.approval === "always") return true;
  return tool.risk === "confirm";
}

export interface ApprovalDecision {
  action: "run" | "ask" | "deny";
  /** The rule that decided it, if one did. */
  rule?: string;
  /** What "Always allow" would add (a permission rule), for tools that have one. */
  suggest?: string;
  target?: PermTarget;
}

/**
 * Permission rules first (deny wins; the project's own deny rules count too), then the approval setting.
 * Tools that always ask (exit_plan_mode) ignore both.
 */
export function decideApproval(tool: ToolDef, args: Record<string, unknown>, settings: AgentSettings, projectDeny: string[] = []): ApprovalDecision {
  if (NEVER_ASK.has(tool.name)) return { action: "run" };
  if (tool.alwaysAsk) return { action: "ask" };
  const target = tool.permission?.(args);
  if (target) {
    const ev = evaluate({ allow: settings.permissions.allow, deny: [...settings.permissions.deny, ...projectDeny] }, target);
    if (ev.decision === "deny") return { action: "deny", rule: ev.rule, target };
    if (ev.decision === "allow") return { action: "run", rule: ev.rule, target };
  }
  return { action: needsApproval(tool, settings) ? "ask" : "run", target, suggest: target && tool.code ? suggestRule(target) : undefined };
}
