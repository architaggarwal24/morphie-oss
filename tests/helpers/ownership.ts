import { COMPONENTS } from "@/server/design/components";
import { THEMES } from "@/server/design/themes";
import { resolveSession, startSession } from "@/server/auth/session";
import type { Actor } from "@/server/auth/actor";
import { createConversation, addMessageForTest } from "./convHelpers";
import { ingest } from "@/server/rag";
import { addMemory } from "@/server/memory";
import { saveProfile } from "@/server/profiles";
import { writeFile } from "@/server/workspace";
import { insertProject } from "@/server/data/projects";
import { LocalSandbox } from "@/server/sandbox/local";
import { createSystem } from "@/server/design/systems";
import { createSkill } from "@/server/skills";
import * as svc from "@/server/design/service";
import { Scripted } from "./scripted";
import { accountPlanRow } from "@/server/data/plans";
import { insertOrder } from "@/server/data/payments";
import { orderCode } from "@/server/payments";
import { createRunner } from "@/server/runners";
import type { Client } from "./client";

export type Verb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Resources {
  conversationId: string; designId: string; documentId: string; memoryId: string; profileId: string; workspacePath: string; projectId: string; systemId: string; skillId: string;
  /** A plan checkout (orders belong to the account's verified email). */
  orderId: string;
  runnerId: string;
  /** A second, live session of the same account (another device), so revoking it doesn't sign the test client out. */
  sessionId: string;
}

export const actorOf = async (c: Client): Promise<Actor> => (await resolveSession(c.sessionToken!))!.actor;

const t = THEMES["modern-saas"];
const design = () => ({
  name: "Victim Co", theme: { ...t.colors }, typography: { ...t.typography }, style: { ...t.style },
  sections: [COMPONENTS.hero.example, COMPONENTS.pricing.example, COMPONENTS.navbar.example, COMPONENTS.footer.example],
});

/** Give a client's actor one of everything that can be addressed by id or path. */
export async function seedResources(c: Client): Promise<Resources> {
  const a = await actorOf(c);
  const conv = await createConversation(a, "chat", "Victim's private chat");
  await addMessageForTest(a, conv.id);
  const state = await svc.handleMessage(a, null, "make a page", new Scripted([{ content: JSON.stringify(design()) }]) as never);
  const doc = await ingest(a, "victim.txt", new TextEncoder().encode("The victim's confidential roadmap says launch in March."), 1_000_000);
  const mem = (await addMemory(a, "Victim prefers dark mode and works at Initech", "preference", "manual"))!;
  const prof = await saveProfile(a, { kind: "custom", model: "m", apiKey: "sk-victim-123456789", baseUrl: "http://127.0.0.1:9/v1" });
  await writeFile(a, "notes/plan.md", "victim secret");
  const other = await startSession(a.userId, { ip: "test", userAgent: "Victim's phone" });
  const project = await insertProject(a, { name: "Victim app", repoUrl: null, branch: null });
  await new LocalSandbox(a.userId, project.id).writeFile("secret.txt", "victim secret");
  const sys = await createSystem(a, { from: "manual", system: { name: "Victim brand", colors: { ...t.colors }, typography: { heading: "Inter", body: "Inter" } } }, null);
  const skillId = await createSkill(a, "---\nname: victim-playbook\ndescription: The victim's private playbook.\n---\nSecret steps.");
  const orderId = orderCode();
  const email = (await accountPlanRow(a))!.email!;
  await insertOrder({ id: orderId, email, plan: "shift", period: "month", currency: "inr", amount: 149_937, method: "upi", status: "pending", created_at: Date.now(), expires_at: Date.now() + 3_600_000 });
  const { runner } = await createRunner(a, "Victim's laptop");
  return { runnerId: runner.id, orderId, skillId, systemId: sys.id, projectId: project.id, conversationId: conv.id, designId: state.state.id, documentId: doc.doc.id, memoryId: mem.id, profileId: prof.id, workspacePath: "notes/plan.md", sessionId: other.sessionId };
}

export interface Case {
  /** Route pattern as discovered from the file path, e.g. /api/design/[id]/[action]. */
  route: string;
  verb: Verb;
  label: string;
  url: (r: Resources) => string;
  params?: (r: Resources) => Record<string, string>;
  body?: (r: Resources) => unknown;
  /** A list endpoint: B gets 200 but must see none of A's data (instead of a 404). */
  listing?: boolean;
  /** What the legitimate owner gets. Default 200. "reaches-handler": anything except 403/404. */
  owner?: number[] | "reaches-handler";
}

const P = (r: Resources) => ({ id: r.designId });
export const CASES: Case[] = [
  { route: "/api/conversations/[id]", verb: "GET", label: "read a conversation", url: (r) => `/api/conversations/${r.conversationId}`, params: (r) => ({ id: r.conversationId }) },
  { route: "/api/conversations/[id]", verb: "PATCH", label: "rename a conversation", url: (r) => `/api/conversations/${r.conversationId}`, params: (r) => ({ id: r.conversationId }), body: () => ({ title: "pwned" }) },
  { route: "/api/conversations/[id]", verb: "DELETE", label: "delete a conversation", url: (r) => `/api/conversations/${r.conversationId}`, params: (r) => ({ id: r.conversationId }) },
  { route: "/api/design/[id]", verb: "GET", label: "read a design", url: (r) => `/api/design/${r.designId}`, params: P },
  { route: "/api/design/[id]", verb: "DELETE", label: "delete a design", url: (r) => `/api/design/${r.designId}`, params: P },
  { route: "/api/design/[id]/[action]", verb: "GET", label: "export a design", url: (r) => `/api/design/${r.designId}/export?format=html`, params: (r) => ({ id: r.designId, action: "export" }) },
  { route: "/api/design/[id]/[action]", verb: "GET", label: "download a design zip", url: (r) => `/api/design/${r.designId}/download?format=html`, params: (r) => ({ id: r.designId, action: "download" }) },
  { route: "/api/design/[id]/[action]", verb: "POST", label: "undo", url: (r) => `/api/design/${r.designId}/undo`, params: (r) => ({ id: r.designId, action: "undo" }), owner: [409] },
  { route: "/api/design/[id]/[action]", verb: "POST", label: "redo", url: (r) => `/api/design/${r.designId}/redo`, params: (r) => ({ id: r.designId, action: "redo" }), owner: [409] },
  { route: "/api/design/[id]/[action]", verb: "POST", label: "restore a version", url: (r) => `/api/design/${r.designId}/restore`, params: (r) => ({ id: r.designId, action: "restore" }), body: () => ({ version: 1 }), owner: [409] },
  { route: "/api/design/[id]/[action]", verb: "POST", label: "rename a design", url: (r) => `/api/design/${r.designId}/rename`, params: (r) => ({ id: r.designId, action: "rename" }), body: () => ({ name: "pwned" }) },
  { route: "/api/design/[id]/[action]", verb: "POST", label: "apply a theme", url: (r) => `/api/design/${r.designId}/theme`, params: (r) => ({ id: r.designId, action: "theme" }), body: () => ({ theme: "modern-saas" }) },
  { route: "/api/documents/[id]", verb: "DELETE", label: "delete a document", url: (r) => `/api/documents/${r.documentId}`, params: (r) => ({ id: r.documentId }) },
  { route: "/api/memory/[id]", verb: "DELETE", label: "delete a memory", url: (r) => `/api/memory/${r.memoryId}`, params: (r) => ({ id: r.memoryId }) },
  { route: "/api/providers/[id]", verb: "DELETE", label: "delete a provider", url: (r) => `/api/providers/${r.profileId}`, params: (r) => ({ id: r.profileId }) },
  { route: "/api/providers/[id]/activate", verb: "POST", label: "activate a provider", url: (r) => `/api/providers/${r.profileId}/activate`, params: (r) => ({ id: r.profileId }) },
  { route: "/api/workspace/file", verb: "GET", label: "read a workspace file", url: (r) => `/api/workspace/file?path=${r.workspacePath}` },
  { route: "/api/workspace/file", verb: "GET", label: "download a workspace file", url: (r) => `/api/workspace/file?path=${r.workspacePath}&download=1` },
  { route: "/api/workspace/file", verb: "DELETE", label: "delete a workspace file", url: (r) => `/api/workspace/file?path=${r.workspacePath}` },
  { route: "/api/account/sessions/[id]", verb: "DELETE", label: "sign out another account's session", url: (r) => `/api/account/sessions/${r.sessionId}`, params: (r) => ({ id: r.sessionId }) },
  { route: "/api/projects/[id]", verb: "GET", label: "open a project", url: (r) => `/api/projects/${r.projectId}`, params: (r) => ({ id: r.projectId }) },
  { route: "/api/projects/[id]", verb: "PATCH", label: "rename a project", url: (r) => `/api/projects/${r.projectId}`, params: (r) => ({ id: r.projectId }), body: () => ({ name: "pwned" }) },
  { route: "/api/projects/[id]", verb: "DELETE", label: "delete a project", url: (r) => `/api/projects/${r.projectId}`, params: (r) => ({ id: r.projectId }) },
  { route: "/api/projects/[id]/tree", verb: "GET", label: "list a project's files", url: (r) => `/api/projects/${r.projectId}/tree`, params: (r) => ({ id: r.projectId }) },
  { route: "/api/projects/[id]/file", verb: "GET", label: "read a project file", url: (r) => `/api/projects/${r.projectId}/file?path=secret.txt`, params: (r) => ({ id: r.projectId }) },
  { route: "/api/projects/[id]/changes", verb: "GET", label: "read a project's changes", url: (r) => `/api/projects/${r.projectId}/changes`, params: (r) => ({ id: r.projectId }) },
  { route: "/api/projects/[id]/changes", verb: "POST", label: "revert a project's changes", url: (r) => `/api/projects/${r.projectId}/changes`, params: (r) => ({ id: r.projectId }), body: () => ({ action: "reject", path: "secret.txt" }), owner: "reaches-handler" },
  { route: "/api/projects/[id]/preview", verb: "GET", label: "see a project's preview links", url: (r) => `/api/projects/${r.projectId}/preview`, params: (r) => ({ id: r.projectId }) },
  { route: "/api/projects/[id]/preview", verb: "POST", label: "start or stop a project's dev server", url: (r) => `/api/projects/${r.projectId}/preview`, params: (r) => ({ id: r.projectId }), body: () => ({ action: "stop" }) },
  { route: "/api/conversations/[id]/rewind", verb: "POST", label: "rewind someone's conversation", url: (r) => `/api/conversations/${r.conversationId}/rewind`, params: (r) => ({ id: r.conversationId }), body: () => ({ messageId: 1, code: false, conversation: true }), owner: "reaches-handler" },
  { route: "/api/projects/[id]/zip", verb: "GET", label: "download a project as a zip", url: (r) => `/api/projects/${r.projectId}/zip`, params: (r) => ({ id: r.projectId }) },
  { route: "/api/runs/[id]", verb: "GET", label: "follow a conversation's agent run", url: (r) => `/api/runs/${r.conversationId}?from=0`, params: (r) => ({ id: r.conversationId }) },
  { route: "/api/runs/[id]/stop", verb: "POST", label: "stop a conversation's agent run", url: (r) => `/api/runs/${r.conversationId}/stop`, params: (r) => ({ id: r.conversationId }), body: () => ({}) },
  { route: "/api/skills/[id]", verb: "GET", label: "read a skill", url: (r) => `/api/skills/${r.skillId}`, params: (r) => ({ id: r.skillId }) },
  { route: "/api/skills/[id]", verb: "PUT", label: "overwrite a skill", url: (r) => `/api/skills/${r.skillId}`, params: (r) => ({ id: r.skillId }), body: () => ({ markdown: "---\nname: victim-playbook\ndescription: pwned\n---\npwned" }) },
  { route: "/api/skills/[id]", verb: "DELETE", label: "delete a skill", url: (r) => `/api/skills/${r.skillId}`, params: (r) => ({ id: r.skillId }) },
  { route: "/api/skills/[id]/update", verb: "POST", label: "update a skill from GitHub", url: (r) => `/api/skills/${r.skillId}/update`, params: (r) => ({ id: r.skillId }), body: () => ({}), owner: "reaches-handler" },
  { route: "/api/skills/draft", verb: "POST", label: "draft a skill from someone's conversation", url: () => "/api/skills/draft", body: (r) => ({ conversationId: r.conversationId }), owner: "reaches-handler" },
  { route: "/api/projects/[id]/exec", verb: "POST", label: "run a command in a project", url: (r) => `/api/projects/${r.projectId}/exec`, params: (r) => ({ id: r.projectId }), body: () => ({ command: "echo pwned > pwned.txt" }) },
  { route: "/api/chat", verb: "POST", label: "start a task in someone's project", url: () => "/api/chat", body: (r) => ({ mode: "agent", projectId: r.projectId, message: "cat secret.txt" }) },
  { route: "/api/systems/[id]", verb: "GET", label: "read a design system", url: (r) => `/api/systems/${r.systemId}`, params: (r) => ({ id: r.systemId }) },
  { route: "/api/systems/[id]", verb: "PATCH", label: "overwrite a design system", url: (r) => `/api/systems/${r.systemId}`, params: (r) => ({ id: r.systemId }), body: () => ({ system: { name: "pwned", colors: { background: "#000000", surface: "#111111", primary: "#ff0000", secondary: "#00ff00", accent: "#0000ff", text: "#ffffff" }, typography: { heading: "Inter", body: "Inter" } } }) },
  { route: "/api/systems/[id]", verb: "DELETE", label: "delete a design system", url: (r) => `/api/systems/${r.systemId}`, params: (r) => ({ id: r.systemId }) },
  { route: "/api/systems/[id]/export", verb: "GET", label: "export a design system", url: (r) => `/api/systems/${r.systemId}/export?format=tokens`, params: (r) => ({ id: r.systemId }) },
  { route: "/api/systems/[id]/export", verb: "GET", label: "download a design system", url: (r) => `/api/systems/${r.systemId}/export?format=react&download=1`, params: (r) => ({ id: r.systemId }) },
  { route: "/api/design/[id]/[action]", verb: "GET", label: "open the visual editor", url: (r) => `/api/design/${r.designId}/editor`, params: (r) => ({ id: r.designId, action: "editor" }) },
  { route: "/api/design/[id]/[action]", verb: "POST", label: "visually edit a design", url: (r) => `/api/design/${r.designId}/patch`, params: (r) => ({ id: r.designId, action: "patch" }), body: () => ({ patches: [{ op: "set_color", key: "primary", value: "#ff0000" }] }) },
  { route: "/api/design/[id]/[action]", verb: "POST", label: "apply a design system", url: (r) => `/api/design/${r.designId}/system`, params: (r) => ({ id: r.designId, action: "system" }), body: (r) => ({ systemId: r.systemId }) },
  { route: "/api/design", verb: "POST", label: "start a design from someone's system", url: () => "/api/design", body: (r) => ({ message: "a page", systemId: r.systemId }), owner: [200] },
  { route: "/api/systems", verb: "POST", label: "make a system from someone's design", url: () => "/api/systems", body: (r) => ({ from: "design", designId: r.designId }) },
  // list endpoints: scoped to the caller, never to a requested id
  { route: "/api/systems", verb: "GET", label: "list design systems", url: () => "/api/systems", listing: true },
  { route: "/api/projects", verb: "GET", label: "list projects", url: () => "/api/projects", listing: true },
  { route: "/api/design", verb: "GET", label: "list designs", url: () => "/api/design", listing: true },
  { route: "/api/providers", verb: "GET", label: "list providers", url: () => "/api/providers", listing: true },
  // id carried in the body
  { route: "/api/chat", verb: "POST", label: "chat into a conversation", url: () => "/api/chat", body: (r) => ({ conversationId: r.conversationId, message: "hello" }), owner: [200] },
  { route: "/api/chat", verb: "POST", label: "truncate a conversation", url: () => "/api/chat", body: (r) => ({ conversationId: r.conversationId, message: "hello", truncateFrom: 1 }), owner: [400] },
  { route: "/api/design", verb: "POST", label: "edit a design", url: () => "/api/design", body: (r) => ({ designId: r.designId, message: "make it blue" }), owner: [200] },
  { route: "/api/providers", verb: "POST", label: "overwrite a provider", url: () => "/api/providers", body: (r) => ({ id: r.profileId, kind: "custom", model: "pwned", baseUrl: "https://attacker.example/v1", apiKey: "sk-attacker-123456789" }) },
  { route: "/api/providers/test", verb: "POST", label: "test with someone's saved key", url: () => "/api/providers/test", body: (r) => ({ profileId: r.profileId, model: "m" }), owner: "reaches-handler" },
  { route: "/api/runners/[id]", verb: "DELETE", label: "remove someone's runner", url: (r) => `/api/runners/${r.runnerId}`, params: (r) => ({ id: r.runnerId }) },
  { route: "/api/billing/orders/[id]", verb: "GET", label: "read someone's plan order", url: (r) => `/api/billing/orders/${r.orderId}`, params: (r) => ({ id: r.orderId }) },
  { route: "/api/billing/orders/[id]", verb: "POST", label: "cancel someone's checkout", url: (r) => `/api/billing/orders/${r.orderId}`, params: (r) => ({ id: r.orderId }), body: () => ({ action: "cancel" }) },
  { route: "/api/providers/models", verb: "POST", label: "list models with someone's saved key", url: () => "/api/providers/models", body: (r) => ({ profileId: r.profileId }), owner: "reaches-handler" },
];

/** Routes that mention ids/paths but are deliberately not per-user resources. Each needs a reason. */
export const EXEMPT: Record<string, string> = {
  "/api/agent/approve": "approval ids are single-use, in-memory and keyed by (user, id); a stolen id answers 410 (covered in api.test.ts)",
  "/api/auth/oauth/[provider]/start": "[provider] names a login provider (google|github), not a user-owned resource",
  "/api/auth/oauth/[provider]/callback": "[provider] names a login provider; the callback is bound to the browser by a state cookie (see login.test.ts)",
  "/api/preview/[token]/[[...path]]": "a capability URL with no session: [token] is HMAC-signed, expires, and is bound to one user's project folder; forged, altered or expired tokens get 403 (see alive-ui / preview tests)",
  "/api/runner/jobs": "called by a Morphie Runner with its own token, not a session; job ids are random, single-use, and only reach the Coordinator of the account that made the runner (see runners.test.ts)",
  "/api/account/identities/[provider]": "[provider] names a login provider (google|github); the route only ever touches the caller's own identities (see login.test.ts)",
};

/** Everything A owns, as one comparable value. */
export async function snapshot(a: Actor): Promise<string> {
  const { listConversations, getMessages } = await import("@/server/conversations");
  const { listDocuments } = await import("@/server/rag");
  const { listMemories } = await import("@/server/memory");
  const { listProfiles } = await import("@/server/profiles");
  const { listFiles, readFile } = await import("@/server/workspace");
  const convs = await listConversations(a);
  return JSON.stringify({
    convs, messages: await Promise.all(convs.map((c) => getMessages(a, c.id))),
    designs: await Promise.all((await svc.listDesigns(a)).map(async (d) => ({ ...d, state: (await svc.getDesign(a, d.id)).design }))),
    docs: await listDocuments(a), memories: await listMemories(a), profiles: await listProfiles(a),
    files: await Promise.all((await listFiles(a)).map(async (f) => [f.path, await readFile(a, f.path)])),
    systems: await (await import("@/server/design/systems")).listSystems(a),
    skills: (await (await import("@/server/data/skills")).listSkillRows(a)).map((r) => [r.name, r.markdown, r.updated_at]),
    projects: await Promise.all((await (await import("@/server/data/projects")).listProjects(a)).map(async (p) => ({ ...p, files: await new LocalSandbox(a.userId, p.id).list("", 3) }))),
  });
}
