import { addMessage, createConversation } from "@/server/conversations";
import type { Actor } from "@/server/auth/actor";

export { createConversation };
export async function addMessageForTest(a: Actor, conversationId: string): Promise<void> {
  await addMessage(a, conversationId, "user", "my private question");
  await addMessage(a, conversationId, "assistant", "my private answer");
}
