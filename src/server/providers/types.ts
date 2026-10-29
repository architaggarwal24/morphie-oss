export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Set when the model produced arguments that weren't valid JSON. */
  error?: string;
}

export interface ImagePart { mime: "image/png" | "image/jpeg" | "image/webp"; /** base64, no data: prefix */ data: string }

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Images for a user message (only sent to models marked as vision-capable). */
  images?: ImagePart[];
  /**
   * For the system message: where the part that never changes ends. Providers with explicit prompt caching (Anthropic)
   * put a cache breakpoint there; for the rest it's just a hint that the stable prefix comes first.
   */
  cacheSplit?: number;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Tool name for role "tool" (needed by Gemini). */
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** A tool call's arguments as they stream in (so the UI can say "Writing src/App.tsx…" before the call is complete). */
  onToolDelta?: (d: { index: number; name: string; args: string }) => void;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  reasoning?: string;
  /** input includes cached tokens; `cached` is how many of them were served from the provider's prompt cache. */
  usage?: { input: number; output: number; cached?: number };
  finishReason?: string;
}

export interface ProviderModel { id: string; label?: string }

export interface Provider {
  readonly kind: string;
  readonly label: string;
  readonly model: string;
  /** false → callers must use prompt-based tool calling. */
  readonly nativeTools: boolean;
  /** Accepts images in user messages. */
  readonly vision?: boolean;
  /** Context window in tokens, when known (used to decide when to compact). */
  readonly contextWindow?: number;
  chat(req: ChatRequest): Promise<ChatResult>;
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>;
}

export class ProviderError extends Error {
  constructor(message: string, public status?: number, public retryable = false) {
    super(message);
  }
}
