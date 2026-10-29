import type { ChatRequest, ChatResult, Provider } from "@/server/providers/types";

export type Step = Partial<ChatResult> | ((req: ChatRequest) => Partial<ChatResult>);

/** A provider that replays a script, recording what the agent sent it. */
export class Scripted implements Provider {
  kind = "scripted"; label = "Scripted"; model = "test"; nativeTools = true;
  requests: ChatRequest[] = [];
  constructor(private script: Step[]) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    const r = typeof next === "function" ? next(req) : next;
    const out = { content: "", toolCalls: [], ...r } as ChatResult;
    if (out.content) req.onText?.(out.content);
    return out;
  }
  async listModels() { return [{ id: "test" }]; }
}

export const call = (name: string, args: Record<string, unknown>, id = `c_${name}_${Math.random().toString(36).slice(2, 6)}`) => ({ id, name, arguments: args });
