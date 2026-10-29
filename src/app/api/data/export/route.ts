import { getConversation, getMessages, listConversations } from "@/server/conversations";
import { getDesign, listDesigns } from "@/server/design/service";
import { listSystems, loadSystem } from "@/server/design/systems";
import { route } from "@/server/http";
import { listMemories } from "@/server/memory";
import { listDocuments } from "@/server/rag";
import { listProfiles } from "@/server/profiles";
import { getSettings } from "@/server/settings";
import { listFiles, readFile } from "@/server/workspace";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A portable JSON copy of your data. API keys and header values are never included. */
export const GET = route({ auth: "user" }, async (c) => {
  const conversations = await Promise.all((await listConversations(c.actor)).map(async (conv) => ({ ...conv, messages: await getMessages(c.actor, conv.id) })));
  const designs = await Promise.all((await listDesigns(c.actor)).map((d) => getDesign(c.actor, d.id)));
  const files = await listFiles(c.actor);
  const data = {
    exportedAt: new Date().toISOString(),
    settings: await getSettings(c.actor),
    providers: (await listProfiles(c.actor)).profiles.map(({ id, kind, label, model, baseUrl }) => ({ id, kind, label, model, baseUrl })),
    conversations,
    memories: await listMemories(c.actor),
    documents: (await listDocuments(c.actor)).map(({ name, kind, size }) => ({ name, kind, size })),
    designs: designs.map((s) => ({ id: s.id, name: s.name, design: s.design, systemId: s.systemId ?? null })),
    designSystems: await Promise.all((await listSystems(c.actor)).map(async (x) => ({ id: x.id, system: await loadSystem(c.actor, x.id) }))),
    workspace: await Promise.all(files.map(async (f) => ({ path: f.path, content: await readFile(c.actor, f.path) }))),
  };
  return new Response(JSON.stringify(data, null, 2), { headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="morphie-export.json"' } });
});
