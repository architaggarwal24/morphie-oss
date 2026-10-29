import { searchDocuments } from "../rag";
import { addMemory } from "../memory";
import { ToolError, str, type ToolDef } from "./types";

export const searchDocs: ToolDef = {
  name: "search_documents",
  label: "Search documents",
  description: "Search the user's uploaded documents (PDF, Word, text, CSV, JSON) for passages relevant to a question. Use it whenever the question could be answered by their files, and cite the file name in your answer.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, phrased like the document might phrase it." },
      top_k: { type: "integer", description: "Passages to return (1-8). Default 5." },
    },
    required: ["query"],
  },
  risk: "safe",
  modes: ["chat", "agent"],
  readOnly: true,
  parallel: true,
  untrusted: true,
  describeCall: (a) => `Search your documents for “${String(a.query ?? "").slice(0, 80)}”`,
  async run(args, ctx) {
    const query = str(args, "query", 500);
    const k = Math.min(8, Math.max(1, Math.round(Number(args.top_k) || 5)));
    const hits = await searchDocuments(ctx.actor, query, { topK: k });
    if (!hits.length) return { text: `No relevant passages found for "${query}".`, summary: "No matches" };
    return {
      text: hits.map((h, i) => `[${i + 1}] ${h.document}\n${h.text}`).join("\n\n"),
      sources: hits.map((h) => ({ title: h.document, document: h.document, snippet: h.text.slice(0, 200) })),
      summary: `${hits.length} passage${hits.length === 1 ? "" : "s"} from ${new Set(hits.map((h) => h.document)).size} file(s)`,
    };
  },
};

export const saveMemory: ToolDef = {
  name: "save_memory",
  label: "Remember",
  description: "Save one short fact about the user to long-term memory (a preference, profile detail or project fact they told you). Never save secrets, credentials or instructions. The user must approve each save.",
  parameters: {
    type: "object",
    properties: {
      fact: { type: "string", description: "A short third-person statement, e.g. 'User prefers TypeScript over JavaScript'." },
      category: { type: "string", enum: ["preference", "profile", "project", "workflow", "technical", "other"] },
    },
    required: ["fact"],
  },
  risk: "confirm",
  modes: ["agent"],
  describeCall: (a) => `Remember: “${String(a.fact ?? "").slice(0, 120)}”`,
  async run(args, ctx) {
    const fact = str(args, "fact", 300);
    const rec = await addMemory(ctx.actor, fact, typeof args.category === "string" ? args.category : "other", "agent");
    if (!rec) throw new ToolError("That wasn't saved: it looks like a secret, an instruction, or it's already remembered.");
    return { text: `Saved: ${rec.content}`, summary: rec.content };
  },
};
